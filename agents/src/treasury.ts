/**
 * The agents' treasury: the launchpad's `treasury` is agent 0's own wallet, so
 * every trading tax the curves collect lands here. This module does three
 * things with it, all from the first agent key and all logged:
 *
 *  1. gas: keeps the other agent keys and the relayer topped up to a small
 *     float so voting, harvesting and relaying never stall for lack of BNB;
 *  2. buybacks: at random moments (on average once per `meanMinutes`) spends
 *     a random share of whatever exceeds the reserve on the BUNKER token
 *     through PancakeSwap V2; the reserve covers migrations and gas;
 *  3. disposal: each buyback is then, by coin flip, burned (sent to 0x…dead)
 *     or airdropped to the current holders pro rata (wallets only; contracts
 *     such as the PancakeSwap pair and the pool are skipped).
 *
 * Everything here is deterministic given the random draws, which are logged,
 * and nothing needs the owner: the pot funds itself from the tax. The pure
 * pieces (`topUps`, `pickHolders`, `splitAirdrop`, `shouldBuyBack`, `spend`,
 * `applyTransfers`) are unit-tested; the chain calls are thin wrappers.
 */
import { parseEventLogs, getAddress, type PublicClient, type WalletClient, type Account, type Chain, type Transport, type Hex } from "viem";
import { IERC20MetadataAbi, IPancakeRouter02Abi, type EvmAddress } from "@bunker/sdk";

export const DEAD = "0x000000000000000000000000000000000000dEaD" as const;
export const ZERO = "0x0000000000000000000000000000000000000000" as const;

export interface TreasuryConfig {
  /** the BUNKER token to buy back; undefined disables buybacks (gas top-ups still run) */
  token?: EvmAddress;
  /** the block the token was created in: holder balances are rebuilt from its Transfer logs from here */
  tokenStartBlock: bigint;
  /** PancakeSwap V2 router and WBNB */
  router: EvmAddress;
  wbnb: EvmAddress;
  /** wei kept back from buybacks (migrations and gas) */
  reserveWei: bigint;
  /** every funded key is topped up to this when it falls under half of it */
  floatWei: bigint;
  /** the keys the treasury keeps fuelled: agents 1–3 and the relayer */
  funded: EvmAddress[];
  /** mean minutes between buybacks; each tick draws independently */
  meanMinutes: number;
  tickMs: number;
  slippageBps: number;
  /** holders beyond the top N get nothing in an airdrop (one transfer each costs gas) */
  maxHolders: number;
  /** addresses never airdropped to besides the treasury (pool, launchpad, pair) */
  exclude: EvmAddress[];
}

export interface TopUp { key: EvmAddress; wei: bigint }

/** Which funded keys need BNB and how much, within what the treasury can spare. Lowest balance first. */
export function topUps(balances: { key: EvmAddress; wei: bigint }[], floatWei: bigint, spare: bigint): TopUp[] {
  const out: TopUp[] = [];
  let left = spare;
  for (const b of [...balances].sort((a, b) => (a.wei < b.wei ? -1 : a.wei > b.wei ? 1 : 0))) {
    if (b.wei >= floatWei / 2n) continue;
    const need = floatWei - b.wei;
    if (need > left) break;
    out.push({ key: b.key, wei: need });
    left -= need;
  }
  return out;
}

/** Bernoulli per tick so that buybacks happen on average once per `meanMinutes`. `rand` is in [0, 1). */
export function shouldBuyBack(rand: number, tickMs: number, meanMinutes: number): boolean {
  if (meanMinutes <= 0) return false;
  return rand < tickMs / (meanMinutes * 60_000);
}

/** A random 25–100 % of the surplus, so the size of a buyback is not predictable from the pot. */
export function spend(surplus: bigint, rand: number): bigint {
  if (surplus <= 0n) return 0n;
  const bps = 2_500 + Math.floor(rand * 7_500);
  return (surplus * BigInt(bps)) / 10_000n;
}

export interface Holder { owner: EvmAddress; amount: bigint }

/** Fold ERC-20 Transfer events into a balance map (mint from and burn to the zero address included). */
export function applyTransfers(balances: Map<string, bigint>, transfers: { from: string; to: string; value: bigint }[]) {
  for (const t of transfers) {
    const from = t.from.toLowerCase(), to = t.to.toLowerCase();
    if (from !== ZERO) balances.set(from, (balances.get(from) ?? 0n) - t.value);
    if (to !== ZERO) balances.set(to, (balances.get(to) ?? 0n) + t.value);
  }
  for (const [k, v] of balances) if (v <= 0n) balances.delete(k);
  return balances;
}

/**
 * The holders an airdrop goes to: wallets only (`isContract` says which
 * addresses have code), never the treasury or the excluded addresses, largest
 * first, at most `max`.
 */
export function pickHolders(all: Holder[], exclude: string[], max: number, isContract: (a: string) => boolean): Holder[] {
  const skip = new Set([...exclude, DEAD, ZERO].map((k) => k.toLowerCase()));
  return all
    .filter((h) => h.amount > 0n && !skip.has(h.owner.toLowerCase()) && !isContract(h.owner))
    .sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0))
    .slice(0, max);
}

/** Pro-rata split of `total` over the holders (floor; the dust stays in the treasury for the next round). */
export function splitAirdrop(total: bigint, holders: Holder[]): { owner: EvmAddress; amount: bigint }[] {
  const sum = holders.reduce((s, h) => s + h.amount, 0n);
  if (sum === 0n || total <= 0n) return [];
  return holders.map((h) => ({ owner: h.owner, amount: (total * h.amount) / sum })).filter((x) => x.amount > 0n);
}

// ---- chain side

export interface TreasuryEvent { kind: "topup" | "buyback" | "burn" | "airdrop" | "skip" | "error"; detail: string; txHash?: string }

const TRANSFER_ABI = [{ type: "event", name: "Transfer", inputs: [{ indexed: true, name: "from", type: "address" }, { indexed: true, name: "to", type: "address" }, { indexed: false, name: "value", type: "uint256" }] }] as const;

export class Treasury {
  private balances = new Map<string, bigint>();
  private scanned: bigint;
  private codeCache = new Map<string, boolean>();

  constructor(
    private publicClient: PublicClient,
    private wallet: WalletClient<Transport, Chain, Account>,
    private cfg: TreasuryConfig,
    private emit: (e: TreasuryEvent) => void,
    private rand: () => number = Math.random,
  ) {
    this.scanned = cfg.tokenStartBlock - 1n;
  }

  get address() {
    return this.wallet.account.address;
  }

  /** One pass: top-ups first, then maybe a buyback. Never throws; everything is reported through `emit`. */
  async tick(): Promise<void> {
    try {
      await this.fuel();
    } catch (e) {
      this.emit({ kind: "error", detail: `gas: ${(e as Error).message}` });
    }
    if (!this.cfg.token) return;
    try {
      await this.maybeBuyBack(this.cfg.token);
    } catch (e) {
      this.emit({ kind: "error", detail: `buyback: ${(e as Error).message}` });
    }
  }

  private async send(tx: Parameters<WalletClient<Transport, Chain, Account>["sendTransaction"]>[0]): Promise<Hex> {
    const hash = await this.wallet.sendTransaction(tx);
    const rc = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error(`${hash} reverted`);
    return hash;
  }
  private async write(args: Parameters<WalletClient<Transport, Chain, Account>["writeContract"]>[0]): Promise<Hex> {
    const hash = await this.wallet.writeContract(args);
    const rc = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error(`${hash} reverted`);
    return hash;
  }

  private async fuel(): Promise<void> {
    if (this.cfg.funded.length === 0) return;
    const [mine, ...others] = await Promise.all([this.address, ...this.cfg.funded].map((a) => this.publicClient.getBalance({ address: a })));
    // gas comes before the buyback reserve: the treasury keeps only its own float back when fuelling the others
    const spare = mine - this.cfg.floatWei;
    if (spare <= 0n) return;
    const ups = topUps(this.cfg.funded.map((key, i) => ({ key, wei: others[i] })), this.cfg.floatWei, spare);
    if (ups.length === 0) return;
    const hashes: Hex[] = [];
    for (const u of ups) hashes.push(await this.send({ to: u.key, value: u.wei }));
    this.emit({ kind: "topup", detail: ups.map((u) => `${u.key.slice(0, 8)}… +${fmtBnb(u.wei)} BNB`).join(", "), txHash: hashes[0] });
  }

  private async maybeBuyBack(token: EvmAddress): Promise<void> {
    const draw = this.rand();
    if (!shouldBuyBack(draw, this.cfg.tickMs, this.cfg.meanMinutes)) return;
    const balance = await this.publicClient.getBalance({ address: this.address });
    const surplus = balance - this.cfg.reserveWei;
    const amount = spend(surplus, this.rand());
    if (amount < 10n ** 16n) {
      this.emit({ kind: "skip", detail: `buyback drawn (${draw.toFixed(4)}) but only ${fmtBnb(surplus)} BNB above the ${fmtBnb(this.cfg.reserveWei)} BNB reserve` });
      return;
    }
    const txHash = await this.swap(token, amount);
    this.emit({ kind: "buyback", detail: `spent ${fmtBnb(amount)} BNB on ${token.slice(0, 8)}… via PancakeSwap`, txHash });
    await this.dispose(token);
  }

  /** BNB → token through the PancakeSwap V2 router, signed by the treasury key. */
  private async swap(token: EvmAddress, wei: bigint): Promise<Hex> {
    const path = [this.cfg.wbnb, token] as const;
    const amounts = await this.publicClient.readContract({ address: this.cfg.router, abi: IPancakeRouter02Abi, functionName: "getAmountsOut", args: [wei, [...path]] });
    const minOut = (amounts[1] * BigInt(10_000 - this.cfg.slippageBps)) / 10_000n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    return this.write({
      address: this.cfg.router, abi: IPancakeRouter02Abi, functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens",
      args: [minOut, [...path], this.address, deadline], value: wei,
    } as never);
  }

  /** Coin flip: burn everything the treasury holds of the token, or send it to the holders. */
  private async dispose(token: EvmAddress): Promise<void> {
    const [held, decimals] = await Promise.all([
      this.publicClient.readContract({ address: token, abi: IERC20MetadataAbi, functionName: "balanceOf", args: [this.address] }),
      this.publicClient.readContract({ address: token, abi: IERC20MetadataAbi, functionName: "decimals" }),
    ]);
    if (held === 0n) {
      this.emit({ kind: "skip", detail: "nothing to dispose of after the swap" });
      return;
    }
    const burn = async (why: string) => {
      const txHash = await this.write({ address: token, abi: IERC20MetadataAbi, functionName: "transfer", args: [DEAD, held] } as never);
      this.emit({ kind: "burn", detail: `${why}burned ${fmtUnits(held, Number(decimals))}`, txHash });
    };
    const flip = this.rand();
    if (flip < 0.5) return burn(`(flip ${flip.toFixed(3)}) `);
    const holders = await this.holders(token);
    const picked = pickHolders(holders, [this.address, ...this.cfg.exclude, token, this.cfg.router], this.cfg.maxHolders, (a) => this.codeCache.get(a.toLowerCase()) ?? false);
    const drops = splitAirdrop(held, picked);
    if (drops.length === 0) return burn("no eligible holders; ");
    const hashes: Hex[] = [];
    for (const d of drops) hashes.push(await this.write({ address: token, abi: IERC20MetadataAbi, functionName: "transfer", args: [d.owner, d.amount] } as never));
    this.emit({ kind: "airdrop", detail: `airdropped ${fmtUnits(held, Number(decimals))} to ${drops.length} holders in ${hashes.length} transactions (flip ${flip.toFixed(3)})`, txHash: hashes[0] });
  }

  /** Every holder of the token, from its Transfer logs (scanned incrementally and kept in memory). */
  async holders(token: EvmAddress): Promise<Holder[]> {
    const head = (await this.publicClient.getBlockNumber()) - 3n;
    const CHUNK = 2000n;
    for (let from = this.scanned + 1n; from <= head; from += CHUNK) {
      const to = from + CHUNK - 1n < head ? from + CHUNK - 1n : head;
      const logs = await this.publicClient.getLogs({ address: token, fromBlock: from, toBlock: to });
      const ev = parseEventLogs({ abi: TRANSFER_ABI, logs, eventName: "Transfer" });
      applyTransfers(this.balances, ev.map((e) => ({ from: e.args.from, to: e.args.to, value: e.args.value })));
      this.scanned = to;
    }
    const out: Holder[] = [];
    for (const [owner, amount] of this.balances) {
      if (!this.codeCache.has(owner)) {
        const code = await this.publicClient.getCode({ address: getAddress(owner) }).catch(() => undefined);
        this.codeCache.set(owner, !!code && code !== "0x");
      }
      out.push({ owner: getAddress(owner), amount });
    }
    return out;
  }
}

const fmtBnb = (wei: bigint) => (Number(wei) / 1e18).toFixed(4);
function fmtUnits(n: bigint, decimals: number): string {
  const s = n.toString().padStart(decimals + 1, "0");
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals).slice(0, 2)}` : s;
}
