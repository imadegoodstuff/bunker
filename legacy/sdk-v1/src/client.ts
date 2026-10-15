// One object that connects to a deployed BUNKER: chain, indexer, relayer,
// agents and proving artifacts. Amounts cross this API in wei / token base
// units; the pool's internal units and shares stay inside.
//
//   const bunker = await BunkerClient.connect({ seed });
//   await bunker.sync();
//   await bunker.shield(NATIVE_TOKEN, parseEther("0.01"), { account });
//   await bunker.send(NATIVE_TOKEN, parseEther("0.005"), "bunker1…");
//   await bunker.unshield(NATIVE_TOKEN, parseEther("0.004"), "0xRecipient");
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseEventLogs, type Account, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc as bscChain, bscTestnet, hardhat, type Chain } from "viem/chains";
import { AgentsApi, ApiError, IndexerApi, RelayerApi, type LaunchRow, type RelayJob, type RelayerInfo } from "./api.js";
import { STALE_ROOT_ERRORS } from "./errors.js";
import type { EvmAddress } from "./extdata.js";
import { decodeAddress, encodeAddress, seedFromBackup, seedFromSignature, seedToBackup, SPENDING_KEY_MESSAGE } from "./keys.js";
import {
  EXIT_BUY, EXIT_SELL, claimKey, exitData, launchCall, quotePrivateBuy, quotePrivateSell, readCurve, readParams, rolled, worstFeeBps,
  LaunchpadAbi, type CurveState, type LaunchpadParams,
} from "./launch.js";
import { IERC20MetadataAbi, ShieldedPoolAbi } from "./abi/index.js";
import { MerkleTree } from "./merkle.js";
import { NATIVE_TOKEN, assetId } from "./note.js";
import { amountForBurn, amountForMint, readLastRoot, readNextIndex, readPool, sharesForDeposit, sharesForWithdraw, toUnits, transactCallToJson, NATIVE_UNIT, type PoolState, type TransactCall } from "./pool.js";
import type { CircuitArtifacts, CircuitName } from "./prover.js";
import { ShieldedWallet, type BuiltTransact } from "./wallet.js";
import { bsc, type NetworkConfig, type NetworkName, networks } from "./networks.js";

export type Token = EvmAddress | "BNB";

/** Anything that can sign a public transaction: a viem account, a raw private key, or a wallet client (browser wallet). */
export type Signer = Account | Hex | WalletClient;

export interface ConnectOptions {
  /** `"bsc"` (default) or a full config; individual fields can be overridden with `overrides` */
  network?: NetworkName | NetworkConfig;
  overrides?: Partial<NetworkConfig>;
  /** The 32-byte spending seed. Derive it with `BunkerClient.seedFromSignature` or restore it with `BunkerClient.seedFromBackup`. */
  seed: Uint8Array;
  /** Proving artifacts, if the caller wants to supply them (bytes or URLs). Default: fetched from `network.artifactsUrl` and cached in memory. */
  artifacts?: Partial<Record<CircuitName, CircuitArtifacts>>;
  /** Progress callback while artifacts download. */
  onArtifactProgress?: (p: { circuit: CircuitName; loaded: number; total: number }) => void;
}

export type TxStage = "proving" | "relaying" | "confirming" | "done";
export interface TxEvent { stage: TxStage; message?: string; txHash?: string; releaseAt?: number }

export interface RelayOptions {
  /** Relayer fee in the pool's units; defaults to the relayer's published policy for the token. */
  fee?: bigint;
  /** UTF-8 memo encrypted to the recipient (private sends only). */
  memo?: string;
  onEvent?: (e: TxEvent) => void;
}

export interface Balance { token: EvmAddress; shares: bigint; amount: bigint; decimals: number; notes: number }

export interface TradeResult { tradeTxHash: string; claimTxHash?: string; claimKey: EvmAddress; nonce: number; status: "claimed" | "empty" }

/** Wei a private buy leaves at the claim key for its own gas (the unused part stays there as dust). */
export const DEFAULT_CLAIM_BUDGET = 3_000_000_000_000_000n; // 0.003 BNB
const CLAIM_GAS = 1_500_000n;
export const DEFAULT_SLIPPAGE_BPS = 100n;

export class BunkerClient {
  readonly network: NetworkConfig;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly indexer: IndexerApi;
  readonly relayer: RelayerApi;
  readonly agents: AgentsApi;
  readonly wallet: ShieldedWallet;
  readonly tree: MerkleTree;
  readonly launchpad: Launchpad;

  private readonly seed: Uint8Array;
  private syncedTo = 0;
  private syncing: Promise<void> | null = null;
  private pools = new Map<string, PoolState>();
  /** asset id (decimal string) -> token address, for every token that has a commitment */
  private seenTokens = new Map<string, EvmAddress>();
  private relayerInfo?: RelayerInfo;
  private readonly artifacts: Partial<Record<CircuitName, CircuitArtifacts>>;
  private readonly artifactLoads: Partial<Record<CircuitName, Promise<CircuitArtifacts>>> = {};
  private readonly onArtifactProgress?: ConnectOptions["onArtifactProgress"];

  private constructor(network: NetworkConfig, seed: Uint8Array, wallet: ShieldedWallet, tree: MerkleTree, o: ConnectOptions) {
    this.network = network;
    this.chain = chainFor(network);
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(network.rpcUrl, { batch: true }) });
    this.indexer = new IndexerApi(network.indexerUrl);
    this.relayer = new RelayerApi(network.relayerUrl);
    this.agents = new AgentsApi(network.agentsUrl);
    this.wallet = wallet;
    this.tree = tree;
    this.seed = seed;
    this.artifacts = { ...(o.artifacts ?? {}) };
    this.onArtifactProgress = o.onArtifactProgress;
    this.launchpad = new Launchpad(this);
  }

  // ---- construction & keys

  static async connect(o: ConnectOptions): Promise<BunkerClient> {
    const base = typeof o.network === "string" ? networks[o.network] : (o.network ?? bsc);
    const network = { ...base, ...(o.overrides ?? {}) };
    if (o.seed.length !== 32) throw new Error("seed must be 32 bytes");
    const wallet = await ShieldedWallet.fromSeed(o.seed);
    const tree = new MerkleTree(26);
    await tree.whenReady();
    return new BunkerClient(network, o.seed, wallet, tree, o);
  }

  /** The message a user signs once with their EOA to derive the spending seed (same text the web app uses). */
  static readonly SPENDING_KEY_MESSAGE = SPENDING_KEY_MESSAGE;
  /** Seed from an EIP-191 signature of `SPENDING_KEY_MESSAGE` plus the user's passphrase. */
  static seedFromSignature(signature: Hex | Uint8Array, passphrase = "", opts?: { allowEmpty?: boolean }) {
    const bytes = typeof signature === "string" ? hexToBytes(signature) : signature;
    return seedFromSignature(bytes, passphrase, opts);
  }
  static seedToBackup = seedToBackup;
  static seedFromBackup = seedFromBackup;
  /** A fresh random seed (keep the backup string: it is the only way to see or spend these notes). */
  static randomSeed(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }

  /** This wallet's shielded address (`bunker1…`). Hand it out to receive private payments. */
  address(): string { return encodeAddress(this.wallet.bjj, this.wallet.address(), this.network.chainId === 56 ? "bunker" : "tbunker"); }
  backup(): string { return seedToBackup(this.seed); }

  // ---- state

  /**
   * Pull every new commitment from the indexer, decrypt ours, rebuild the
   * tree, drop spent notes. Safe to call repeatedly; concurrent calls share one pass.
   */
  sync(): Promise<void> {
    if (!this.syncing) this.syncing = this.syncPass().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async syncPass() {
    const ids = new Map<string, bigint>();
    const idFor = (t: string) => {
      const k = t.toLowerCase();
      let id = ids.get(k);
      if (id === undefined) { id = assetId(k); ids.set(k, id); this.seenTokens.set(id.toString(), getAddress(k)); }
      return id;
    };
    let from = this.syncedTo;
    for (;;) {
      const page = await this.indexer.commitments(from, 1000);
      for (const row of page.items) {
        const cm = BigInt("0x" + row.commitment);
        if (row.index === this.tree.size) await this.tree.insert(cm);
        await this.wallet.scan({ index: row.index, commitment: cm, ciphertext: b64ToBytes(row.ciphertext) }, idFor(row.token));
      }
      from = page.next;
      this.syncedTo = from;
      if (page.items.length < 1000) break;
    }
    const nfs = await this.indexer.nullifiers(0);
    this.wallet.markSpent(nfs.map((n) => BigInt("0x" + n.nullifier)));
    const [next, chainRoot] = await Promise.all([readNextIndex(this.publicClient, this.network.pool), readLastRoot(this.publicClient, this.network.pool)]);
    if (next === this.tree.size && chainRoot !== (await this.tree.root())) throw new Error("local tree root does not match the chain; the indexer may be lagging or corrupt");
  }

  /** Keep syncing until the local tree has every leaf the chain has (the indexer trails the chain by a few seconds). */
  async syncUntilCaughtUp(timeoutMs = 60_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      await this.sync();
      const next = await readNextIndex(this.publicClient, this.network.pool);
      if (this.tree.size >= next || Date.now() - t0 > timeoutMs) return;
      await sleep(2000);
    }
  }

  /** Pool state for a token, cached; `refresh` re-reads the chain. */
  async pool(token: Token, refresh = false): Promise<PoolState> {
    const t = norm(token);
    const have = this.pools.get(t.toLowerCase());
    if (have && !refresh) return have;
    const p = await readPool(this.publicClient, this.network.pool, t);
    if (!p.exists) throw new Error(`no shielded pool for ${t}`);
    this.pools.set(t.toLowerCase(), p);
    return p;
  }

  /** Shielded balance of a token in wei / base units (after `sync`). */
  async balance(token: Token = "BNB"): Promise<Balance> {
    const t = norm(token);
    const pool = await this.pool(t, true);
    const shares = this.wallet.balance(assetId(t.toLowerCase()));
    return { token: t, shares, amount: amountForBurn(pool, shares) * pool.unit, decimals: pool.decimals, notes: this.wallet.spendable(assetId(t.toLowerCase())).length };
  }

  /** Balances for every token this wallet holds notes of. */
  async balances(): Promise<Balance[]> {
    // asset ids are hashes; every token with a commitment was seen during sync
    const held = new Set<string>();
    for (const n of this.wallet.notes.values()) held.add(n.asset.toString());
    const out: Balance[] = [];
    for (const [id, t] of this.seenTokens) if (held.has(id)) out.push(await this.balance(t));
    return out;
  }

  async relayerInfoCached(refresh = false): Promise<RelayerInfo> {
    if (!this.relayerInfo || refresh) this.relayerInfo = await this.relayer.info();
    return this.relayerInfo;
  }

  /** The relayer fee (in wei / base units of `token`) for moving `amount` out of the pool, per the relayer's published policy. */
  async relayerFee(token: Token, amount: bigint): Promise<bigint> {
    const t = norm(token);
    const pool = await this.pool(t);
    const units = toUnits(amount, pool.unit);
    return (await this.feeUnits(t, units)) * pool.unit;
  }

  /** @internal relayer fee in pool units */
  async feeUnits(token: EvmAddress, units: bigint): Promise<bigint> {
    const info = await this.relayerInfoCached();
    let policy = info.fees.find((f) => f.token.toLowerCase() === token.toLowerCase());
    if (!policy) {
      const q = await this.relayer.asset(token);
      if (!q.supported || !q.fee) throw new Error(q.reason ?? "relayer does not support this asset");
      policy = { token, min: q.fee.min, bps: q.fee.bps };
    }
    const pct = (units * BigInt(policy.bps)) / 10_000n;
    return pct > BigInt(policy.min) ? pct : BigInt(policy.min);
  }

  // ---- proving

  async loadArtifacts(circuit: CircuitName): Promise<CircuitArtifacts> {
    const have = this.artifacts[circuit];
    if (have) return have;
    const running = this.artifactLoads[circuit];
    if (running) return running;
    const base = this.network.artifactsUrl.replace(/\/$/, "");
    const p = (async () => {
      const [wasm, zkey] = await Promise.all([
        fetchBytes(`${base}/${circuit}.wasm`, () => undefined),
        fetchBytes(`${base}/${circuit}.zkey`, (loaded, total) => this.onArtifactProgress?.({ circuit, loaded, total })),
      ]);
      const a = { wasm, zkey };
      this.artifacts[circuit] = a;
      return a;
    })();
    this.artifactLoads[circuit] = p;
    return p;
  }

  private async allArtifacts(): Promise<Record<CircuitName, CircuitArtifacts>> {
    const [a, b] = await Promise.all([this.loadArtifacts("transact2x2"), this.loadArtifacts("transact4x2")]);
    return { transact2x2: a, transact4x2: b };
  }

  // ---- shield (public tx, paid by the depositor)

  /**
   * Build the `transact` call that deposits `amount` (wei / base units) into
   * your own shielded address. ERC-20s must be approved to the pool first.
   */
  async buildShield(token: Token, amount: bigint, o: { to?: string; sender: EvmAddress }): Promise<BuiltTransact> {
    const t = norm(token);
    const pool = await this.pool(t, true);
    const units = toUnits(amount, pool.unit);
    if (units <= 0n) throw new Error("amount too small for this pool's unit");
    await this.sync();
    return this.wallet.buildTransact({
      asset: assetId(t.toLowerCase()), poolAddress: this.network.pool, token: t, pool, tree: this.tree, artifacts: await this.allArtifacts(),
      kind: "shield", amount: units, to: o.to ? decodeAddress(this.wallet.bjj, o.to).address : undefined,
      // a shield pays its own gas; the sender stands in as "relayer" with a zero fee
      relayer: o.sender, relayerFee: 0n,
    });
  }

  /**
   * Shield from a public account: opens the token's pool if this is its first
   * shield, approves the ERC-20 if needed, proves, sends, waits for the
   * receipt, re-syncs. Returns the tx hash. `to` defaults to your own address.
   */
  async shield(token: Token, amount: bigint, o: { signer: Signer; to?: string; onEvent?: (e: TxEvent) => void }): Promise<Hex> {
    const t = norm(token);
    const wc = this.walletClientFor(o.signer);
    const sender = wc.account?.address;
    if (!sender) throw new Error("signer has no account");
    let pool = await readPool(this.publicClient, this.network.pool, t);
    if (!pool.exists) {
      if (t === NATIVE_TOKEN) throw new Error("BNB pool not found on chain");
      const decimals = await this.publicClient.readContract({ address: t, abi: IERC20MetadataAbi, functionName: "decimals" });
      o.onEvent?.({ stage: "confirming", message: "opening the pool (one-time)" });
      const h = await this.write(wc, { address: this.network.pool, abi: ShieldedPoolAbi, functionName: "createPool", args: [t, Math.max(0, Number(decimals) - 9), (1n << 256n) - 1n] });
      await this.waitOk(h);
      pool = await this.pool(t, true);
    }
    if (t !== NATIVE_TOKEN) {
      const units = toUnits(amount, pool.unit);
      const need = amountForMint(pool, sharesForDeposit(pool, units)) * pool.unit;
      const allowance = await this.publicClient.readContract({ address: t, abi: IERC20MetadataAbi, functionName: "allowance", args: [sender, this.network.pool] });
      if (allowance < need) {
        o.onEvent?.({ stage: "confirming", message: "approving the token" });
        await this.waitOk(await this.write(wc, { address: t, abi: IERC20MetadataAbi, functionName: "approve", args: [this.network.pool, need] }));
      }
    }
    o.onEvent?.({ stage: "proving", message: "generating proof" });
    const built = await this.buildShield(t, amount, { to: o.to, sender });
    try {
      o.onEvent?.({ stage: "confirming", message: "sending transaction" });
      const hash = await this.write(wc, built.call);
      await this.waitOk(hash);
      o.onEvent?.({ stage: "done", txHash: hash });
      await this.syncUntilCaughtUp().catch(() => undefined);
      return hash;
    } catch (e) {
      this.wallet.release(built.consumed);
      throw e;
    }
  }

  // ---- private send / unshield (through the relayer)

  /** Pay `amount` to another shielded address. Nothing public links sender and recipient. */
  send(token: Token, amount: bigint, to: string, o: RelayOptions = {}): Promise<Hex> {
    return this.relayed(norm(token), amount, "send", { ...o, to });
  }

  /** Withdraw `amount` to a public address. The relayer pays gas and takes its fee from the amount. */
  unshield(token: Token, amount: bigint, recipient: EvmAddress, o: RelayOptions = {}): Promise<Hex> {
    return this.relayed(norm(token), amount, "unshield", { ...o, recipient: getAddress(recipient) });
  }

  /** Withdraw into a contract that implements `IBunkerExit` (what the launchpad trades use). */
  exit(token: Token, amount: bigint, target: EvmAddress, data: Uint8Array, o: RelayOptions = {}): Promise<Hex> {
    return this.relayed(norm(token), amount, "unshield", { ...o, recipient: getAddress(target), exit: { target: getAddress(target), data } });
  }

  private async relayed(token: EvmAddress, amount: bigint, kind: "send" | "unshield", o: RelayOptions & { to?: string; recipient?: EvmAddress; exit?: { target: EvmAddress; data: Uint8Array } }): Promise<Hex> {
    const info = await this.relayerInfoCached(true);
    if (o.exit && !info.launchpad) throw new Error("this relayer does not forward exits");
    const pool = await this.pool(token, true);
    const units = toUnits(amount, pool.unit);
    if (units <= 0n) throw new Error("amount too small for this pool's unit");
    const fee = o.fee ?? (await this.feeUnits(token, units));
    const relayerKey = getAddress(info.relayer);
    await this.sync();
    let consumed: bigint[] = [];
    let accepted = false;
    try {
      const build = async () => {
        o.onEvent?.({ stage: "proving", message: "generating proof" });
        const built = await this.wallet.buildTransact({
          asset: assetId(token.toLowerCase()), poolAddress: this.network.pool, token, pool, tree: this.tree, artifacts: await this.allArtifacts(),
          kind, amount: units,
          to: o.to ? decodeAddress(this.wallet.bjj, o.to).address : undefined,
          recipient: o.recipient,
          relayer: relayerKey, relayerFee: fee,
          memo: o.memo ? new TextEncoder().encode(o.memo) : undefined,
          exitTarget: o.exit?.target, exitData: o.exit?.data,
        });
        consumed = built.consumed;
        o.onEvent?.({ stage: "relaying", message: "handing the proof to the relayer" });
        return this.relayer.relay(transactCallToJson(built.call));
      };
      let job: { id: string; releaseAt: number };
      try {
        job = await build();
      } catch (e) {
        // the root we proved against fell out of the 128-root ring: re-sync and prove once more
        if (!isStaleRoot(e)) throw e;
        this.wallet.release(consumed);
        consumed = [];
        await this.sync();
        job = await build();
      }
      accepted = true;
      o.onEvent?.({ stage: "confirming", message: "queued at the relayer", releaseAt: job.releaseAt });
      const txHash = await this.waitForJob(job.id);
      o.onEvent?.({ stage: "done", txHash });
      await this.syncUntilCaughtUp().catch(() => undefined);
      return txHash;
    } catch (e) {
      if (accepted) {
        await this.sync().catch(() => undefined);
        this.wallet.release(consumed.filter((cm) => !this.wallet.isSpent(cm)));
      } else this.wallet.release(consumed);
      throw e;
    }
  }

  /** Poll a relayer job until it confirms; resolves with the tx hash, rejects on failure. */
  async waitForJob(id: string, pollMs = 2500): Promise<Hex> {
    let errors = 0;
    for (;;) {
      await sleep(pollMs);
      let st: RelayJob;
      try { st = await this.relayer.job(id); errors = 0; } catch (e) {
        if (++errors < 48) continue;
        throw new Error(`lost contact with the relayer: ${(e as Error).message}`);
      }
      if (st.status === "confirmed" && st.txHash) return st.txHash as Hex;
      if (st.status === "failed") {
        if (st.txHash) {
          const rc = await this.publicClient.getTransactionReceipt({ hash: st.txHash as Hex }).catch(() => null);
          if (rc?.status === "success") return st.txHash as Hex;
        }
        throw new Error(st.error ?? "the relayer could not land the transaction");
      }
    }
  }

  // ---- helpers used by the launchpad

  /** @internal */
  async write(signer: Signer, call: TransactCall | { address: EvmAddress; abi: any; functionName: string; args: readonly unknown[]; value?: bigint }, extra: { gas?: bigint; gasPrice?: bigint } = {}): Promise<Hex> {
    const wc = this.walletClientFor(signer);
    const account = wc.account;
    if (!account) throw new Error("signer has no account");
    return wc.writeContract({ ...(call as any), account, chain: this.chain, ...extra });
  }

  /** @internal */
  async waitOk(hash: Hex): Promise<void> {
    const rc = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error(`transaction ${hash} reverted`);
  }

  /** @internal */
  walletClientFor(signer: Signer): WalletClient {
    if (typeof signer === "string") return createWalletClient({ account: privateKeyToAccount(signer), chain: this.chain, transport: http(this.network.rpcUrl) });
    if ("writeContract" in signer) return signer as WalletClient;
    return createWalletClient({ account: signer as Account, chain: this.chain, transport: http(this.network.rpcUrl) });
  }

  /** @internal */
  get spendingSeed(): Uint8Array { return this.seed; }
}

// ---- launchpad

export interface BuyOptions { claimBudget?: bigint; slippageBps?: bigint; onEvent?: (e: TxEvent) => void; /** claim-key nonce; defaults to the next unused one */ nonce?: number }
export interface SellOptions { slippageBps?: bigint; onEvent?: (e: TxEvent) => void; nonce?: number }

export class Launchpad {
  private nextNonce = 0;
  constructor(private readonly c: BunkerClient) {}

  get address(): EvmAddress { return this.c.network.launchpad; }

  /** Tokens launched so far, newest first, as the indexer lists them (name, symbol, curve, volume, graduation). */
  list(limit = 100): Promise<LaunchRow[]> { return this.c.indexer.launches(limit); }
  params(): Promise<LaunchpadParams> { return readParams(this.c.publicClient, this.address); }

  /** The curve as it stands at the current block (fee policy rolled forward). */
  async curve(token: EvmAddress): Promise<CurveState & { block: bigint; worstFeeBps: number }> {
    const t = getAddress(token);
    const [stored, block] = await Promise.all([readCurve(this.c.publicClient, this.address, t), this.c.publicClient.getBlockNumber()]);
    if (!stored) throw new Error("curve not found");
    return { ...rolled(stored, block), block, worstFeeBps: worstFeeBps(stored, block) };
  }

  /** Quote a private buy: tokens received for `bnbWei` spent from the shielded BNB balance. */
  async quoteBuy(token: EvmAddress, bnbWei: bigint, claimBudget = DEFAULT_CLAIM_BUDGET) {
    const [curve, pool] = await Promise.all([this.curve(token), this.c.pool("BNB", true)]);
    const units = toUnits(bnbWei, pool.unit);
    const fee = await this.c.feeUnits(NATIVE_TOKEN, units);
    const delivered = deliveredFor(pool, units) - fee * pool.unit;
    return { ...quotePrivateBuy({ ...curve, tradeFeeBps: curve.worstFeeBps }, delivered, claimBudget, 0n), relayerFeeWei: fee * pool.unit, curve };
  }

  /** Quote a private sell: BNB received for `tokens` (base units) spent from the shielded token balance. */
  async quoteSell(token: EvmAddress, tokens: bigint) {
    const t = getAddress(token);
    const [curve, pool, info] = await Promise.all([this.curve(t), this.c.pool(t, true), this.c.relayerInfoCached()]);
    const bnbPolicy = info.fees.find((f) => f.token.toLowerCase() === NATIVE_TOKEN);
    if (!bnbPolicy) throw new Error("relayer has no BNB policy");
    const tip = BigInt(bnbPolicy.min) * NATIVE_UNIT;
    const delivered = deliveredFor(pool, toUnits(tokens, pool.unit));
    return { ...quotePrivateSell({ ...curve, tradeFeeBps: curve.worstFeeBps }, delivered, tip), relayerTipWei: tip, curve };
  }

  /**
   * Launch a token: uploads metadata to the indexer, sends `launch` from a
   * public account. Returns the token address.
   */
  async launch(input: { name: string; symbol: string; description?: string; image: string; header?: string }, signer: Signer): Promise<EvmAddress> {
    const hosted = await this.c.indexer.uploadMeta(input);
    const hash = await this.c.write(signer, launchCall(this.address, input.name, input.symbol, hosted.uri));
    const rc = await this.c.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error("the launch transaction reverted");
    const ev = parseEventLogs({ abi: LaunchpadAbi, logs: rc.logs, eventName: "Launch" })[0];
    if (!ev) throw new Error("no Launch event in the receipt");
    return getAddress(ev.args.token);
  }

  /**
   * Buy `token` privately with `bnbWei` of shielded BNB. The pool pays the
   * launchpad through its exit hook, the tokens land on a throwaway claim key
   * derived from your seed, and `claim` shields them back to you.
   */
  async buy(token: EvmAddress, bnbWei: bigint, o: BuyOptions = {}): Promise<TradeResult> {
    const t = getAddress(token);
    const budget = o.claimBudget ?? DEFAULT_CLAIM_BUDGET;
    const q = await this.quoteBuy(t, bnbWei, budget);
    if (q.curve.graduated) throw new Error("this curve has graduated; it trades on PancakeSwap now");
    const minOut = q.out - (q.out * (o.slippageBps ?? DEFAULT_SLIPPAGE_BPS)) / 10_000n;
    const nonce = o.nonce ?? this.nextNonce++;
    const ck = claimKey(this.c.spendingSeed, BigInt(nonce));
    const tradeTxHash = await this.c.exit("BNB", bnbWei, this.address, exitData(EXIT_BUY, t, ck.address, minOut, budget, 0n), { onEvent: o.onEvent });
    const claim = await this.claim(nonce, t, "buy");
    return { tradeTxHash, ...claim, claimKey: ck.address, nonce };
  }

  /** Sell `tokens` (base units) of shielded `token` back to the curve; the BNB is claimed back into the pool. */
  async sell(token: EvmAddress, tokens: bigint, o: SellOptions = {}): Promise<TradeResult> {
    const t = getAddress(token);
    const q = await this.quoteSell(t, tokens);
    if (q.curve.graduated) throw new Error("this curve has graduated; it trades on PancakeSwap now");
    const minOut = q.out - (q.out * (o.slippageBps ?? DEFAULT_SLIPPAGE_BPS)) / 10_000n;
    const nonce = o.nonce ?? this.nextNonce++;
    const ck = claimKey(this.c.spendingSeed, BigInt(nonce));
    const tradeTxHash = await this.c.exit(t, tokens, this.address, exitData(EXIT_SELL, t, ck.address, minOut, 0n, q.relayerTipWei), { fee: 0n, onEvent: o.onEvent });
    const claim = await this.claim(nonce, t, "sell");
    return { tradeTxHash, ...claim, claimKey: ck.address, nonce };
  }

  /**
   * Shield whatever a trade left on claim key `nonce` back into your wallet.
   * Idempotent: returns `"empty"` when there is nothing to claim. Use it to
   * recover after a crash between the trade and its claim.
   */
  async claim(nonce: number, token: EvmAddress, kind: "buy" | "sell"): Promise<{ status: "claimed" | "empty"; claimTxHash?: Hex }> {
    const ck = claimKey(this.c.spendingSeed, BigInt(nonce));
    const account = privateKeyToAccount(ck.privateKey);
    const pc = this.c.publicClient;
    const gasPrice = await pc.getGasPrice();
    await this.c.sync();
    let built: BuiltTransact;
    if (kind === "buy") {
      const t = getAddress(token);
      const bal = await pc.readContract({ address: t, abi: IERC20MetadataAbi, functionName: "balanceOf", args: [account.address] });
      if (bal === 0n) return { status: "empty" };
      // the launchpad pre-approves the pool for the claim key, so no approve is needed here
      built = await this.c.buildShield(t, bal, { sender: account.address });
    } else {
      const wei = await pc.getBalance({ address: account.address });
      const keep = (CLAIM_GAS * gasPrice * 12n) / 10n;
      if (wei <= keep + NATIVE_UNIT) return { status: "empty" };
      built = await this.c.buildShield("BNB", wei - keep, { sender: account.address });
    }
    try {
      const hash = await this.c.write(account, built.call, { gas: CLAIM_GAS, gasPrice });
      await this.c.waitOk(hash);
      await this.c.syncUntilCaughtUp().catch(() => undefined);
      return { status: "claimed", claimTxHash: hash };
    } catch (e) {
      this.c.wallet.release(built.consumed);
      throw e;
    }
  }

  /** Sweep every claim key from nonce 0 to `upTo` that still holds something. */
  async recover(upTo = 32): Promise<TradeResult[]> {
    const out: TradeResult[] = [];
    const tokens = await this.list(200);
    for (let nonce = 0; nonce < upTo; nonce++) {
      const ck = claimKey(this.c.spendingSeed, BigInt(nonce));
      const wei = await this.c.publicClient.getBalance({ address: ck.address });
      if (wei > NATIVE_UNIT * 2n) {
        const r = await this.claim(nonce, NATIVE_TOKEN, "sell");
        if (r.status === "claimed") out.push({ tradeTxHash: "", claimTxHash: r.claimTxHash, claimKey: ck.address, nonce, status: "claimed" });
      }
      for (const l of tokens) {
        const bal = await this.c.publicClient.readContract({ address: getAddress(l.token), abi: IERC20MetadataAbi, functionName: "balanceOf", args: [ck.address] });
        if (bal === 0n) continue;
        const r = await this.claim(nonce, getAddress(l.token), "buy");
        if (r.status === "claimed") out.push({ tradeTxHash: "", claimTxHash: r.claimTxHash, claimKey: ck.address, nonce, status: "claimed" });
      }
    }
    if (upTo > this.nextNonce) this.nextNonce = upTo;
    return out;
  }
}

// ---- internals

const ZERO: EvmAddress = "0x0000000000000000000000000000000000000000";

function norm(token: Token): EvmAddress { return token === "BNB" ? NATIVE_TOKEN : getAddress(token); }

/** What the pool pays out for a withdrawal of `units`, after the shares round trip, in wei. */
export function deliveredFor(pool: PoolState, units: bigint): bigint {
  const u = pool.totalShares === 0n ? units : amountForBurn(pool, sharesForWithdraw(pool, units));
  return u * pool.unit;
}

function chainFor(n: NetworkConfig): Chain {
  const base = n.chainId === 56 ? bscChain : n.chainId === 97 ? bscTestnet : n.chainId === 31337 ? hardhat : defineChain({ id: n.chainId, name: n.name, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [n.rpcUrl] } } });
  return { ...base, rpcUrls: { default: { http: [n.rpcUrl] } } };
}

function isStaleRoot(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const ce = (e.body as { contractError?: string } | undefined)?.contractError;
  return !!ce && (STALE_ROOT_ERRORS as readonly string[]).includes(ce);
}

function hexToBytes(h: Hex): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64ToBytes(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchBytes(url: string, onChunk: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    onChunk(n, total);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
