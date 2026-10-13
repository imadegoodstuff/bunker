/**
 * The agents' treasury: the launchpad's `protocol_treasury` is agent 0's own
 * wallet, so every trading tax the curves collect lands here. This module does
 * three things with it, all from the first agent key and all logged:
 *
 *  1. gas: keeps the other agent keys and the relayer topped up to a small
 *     float so voting, harvesting and relaying never stall for lack of SOL;
 *  2. buybacks: at random moments (on average once per `meanMinutes`) spends
 *     a random share of whatever exceeds the reserve on the scash token through
 *     Jupiter; the reserve covers the next few Raydium migrations and gas;
 *  3. disposal: each buyback is then, by coin flip, burned or airdropped to the
 *     current holders of the scash token pro rata (wallets only; program-owned
 *     token accounts such as pool vaults are skipped).
 *
 * Everything here is deterministic given the random draws, which are logged,
 * and nothing needs the owner: the pot funds itself from the tax. The pure
 * pieces (`topUps`, `pickHolders`, `splitAirdrop`, `shouldBuyBack`, `spend`)
 * are unit-tested; the chain and HTTP calls are thin wrappers around them.
 */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";

export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export interface TreasuryConfig {
  /** the scash token to buy back; undefined disables buybacks (gas top-ups still run) */
  scashMint?: PublicKey;
  /** lamports kept back from buybacks (migrations cost 0.25 SOL each, votes and harvests a few thousand lamports) */
  reserveLamports: bigint;
  /** every funded key is topped up to this when it falls under half of it */
  floatLamports: bigint;
  /** the keys the treasury keeps fuelled: agents 1–3 and the relayer */
  funded: PublicKey[];
  /** mean minutes between buybacks; each tick draws independently */
  meanMinutes: number;
  tickMs: number;
  jupiterUrl: string;
  slippageBps: number;
  /** holders beyond the top N get nothing in an airdrop (one transfer each costs gas) */
  maxHolders: number;
}

export interface TopUp { key: PublicKey; lamports: bigint }

/** Which funded keys need SOL and how much, within what the treasury can spare. Lowest balance first. */
export function topUps(balances: { key: PublicKey; lamports: bigint }[], floatLamports: bigint, spare: bigint): TopUp[] {
  const out: TopUp[] = [];
  let left = spare;
  for (const b of [...balances].sort((a, b) => (a.lamports < b.lamports ? -1 : a.lamports > b.lamports ? 1 : 0))) {
    if (b.lamports >= floatLamports / 2n) continue;
    const need = floatLamports - b.lamports;
    if (need > left) break;
    out.push({ key: b.key, lamports: need });
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

export interface Holder { tokenAccount: PublicKey; owner: PublicKey; amount: bigint }

/**
 * The holders an airdrop goes to: wallets only (owners on the ed25519 curve;
 * PDAs are pools, vaults and escrows), never the treasury itself or the
 * excluded keys, largest first, at most `max`.
 */
export function pickHolders(all: Holder[], exclude: PublicKey[], max: number): Holder[] {
  const skip = new Set(exclude.map((k) => k.toBase58()));
  return all
    .filter((h) => h.amount > 0n && !skip.has(h.owner.toBase58()) && PublicKey.isOnCurve(h.owner.toBytes()))
    .sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0))
    .slice(0, max);
}

/** Pro-rata split of `total` over the holders (floor; the dust stays in the treasury for the next round). */
export function splitAirdrop(total: bigint, holders: Holder[]): { tokenAccount: PublicKey; amount: bigint }[] {
  const sum = holders.reduce((s, h) => s + h.amount, 0n);
  if (sum === 0n || total <= 0n) return [];
  return holders.map((h) => ({ tokenAccount: h.tokenAccount, amount: (total * h.amount) / sum })).filter((x) => x.amount > 0n);
}

// ---- chain side

function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ATA_PROGRAM)[0];
}

const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

/** SPL / Token-2022 `Burn` (same layout in both programs). */
export function burnIx(tokenProgram: PublicKey, account: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
    data: Buffer.concat([Buffer.from([8]), u64(amount)]),
  });
}

/** SPL / Token-2022 `TransferChecked`. */
export function transferCheckedIx(tokenProgram: PublicKey, src: PublicKey, mint: PublicKey, dst: PublicKey, owner: PublicKey, amount: bigint, decimals: number): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: src, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dst, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from([12]), u64(amount), Buffer.from([decimals])]),
  });
}

export interface TreasuryEvent { kind: "topup" | "buyback" | "burn" | "airdrop" | "skip" | "error"; detail: string; sig?: string }

export class Treasury {
  constructor(private conn: Connection, private payer: Keypair, private cfg: TreasuryConfig, private emit: (e: TreasuryEvent) => void, private rand: () => number = Math.random) {}

  /** One pass: top-ups first, then maybe a buyback. Never throws; everything is reported through `emit`. */
  async tick(): Promise<void> {
    try {
      await this.fuel();
    } catch (e) {
      this.emit({ kind: "error", detail: `gas: ${(e as Error).message}` });
    }
    if (!this.cfg.scashMint) return;
    try {
      await this.maybeBuyBack(this.cfg.scashMint);
    } catch (e) {
      this.emit({ kind: "error", detail: `buyback: ${(e as Error).message}` });
    }
  }

  private async fuel(): Promise<void> {
    if (this.cfg.funded.length === 0) return;
    const [mine, ...others] = await this.conn.getMultipleAccountsInfo([this.payer.publicKey, ...this.cfg.funded]);
    // gas comes before the buyback reserve: the treasury keeps only its own float back when fuelling the others
    const balance = BigInt(mine?.lamports ?? 0);
    const spare = balance - this.cfg.floatLamports;
    if (spare <= 0n) return;
    const ups = topUps(this.cfg.funded.map((key, i) => ({ key, lamports: BigInt(others[i]?.lamports ?? 0) })), this.cfg.floatLamports, spare);
    if (ups.length === 0) return;
    const tx = new Transaction();
    for (const u of ups) tx.add(SystemProgram.transfer({ fromPubkey: this.payer.publicKey, toPubkey: u.key, lamports: u.lamports }));
    const sig = await sendAndConfirmTransaction(this.conn, tx, [this.payer], { commitment: "confirmed" });
    this.emit({ kind: "topup", detail: ups.map((u) => `${u.key.toBase58().slice(0, 6)}… +${(Number(u.lamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`).join(", "), sig });
  }

  private async maybeBuyBack(mint: PublicKey): Promise<void> {
    const draw = this.rand();
    if (!shouldBuyBack(draw, this.cfg.tickMs, this.cfg.meanMinutes)) return;
    const balance = BigInt(await this.conn.getBalance(this.payer.publicKey, "confirmed"));
    const surplus = balance - this.cfg.reserveLamports;
    const amount = spend(surplus, this.rand());
    if (amount < 20_000_000n) {
      this.emit({ kind: "skip", detail: `buyback drawn (${draw.toFixed(4)}) but only ${(Number(surplus) / LAMPORTS_PER_SOL).toFixed(4)} SOL above the ${(Number(this.cfg.reserveLamports) / LAMPORTS_PER_SOL).toFixed(2)} SOL reserve` });
      return;
    }
    const sig = await this.swap(mint, amount);
    this.emit({ kind: "buyback", detail: `spent ${(Number(amount) / LAMPORTS_PER_SOL).toFixed(4)} SOL on ${mint.toBase58().slice(0, 6)}… via Jupiter`, sig });
    await this.dispose(mint);
  }

  /** SOL → mint through Jupiter's swap API, signed by the treasury key. */
  private async swap(mint: PublicKey, lamports: bigint): Promise<string> {
    const q = new URLSearchParams({ inputMint: WSOL.toBase58(), outputMint: mint.toBase58(), amount: lamports.toString(), slippageBps: String(this.cfg.slippageBps) });
    const quoteRes = await fetch(`${this.cfg.jupiterUrl}/quote?${q}`);
    if (!quoteRes.ok) throw new Error(`jupiter quote ${quoteRes.status}: ${(await quoteRes.text()).slice(0, 200)}`);
    const quote = await quoteRes.json();
    const swapRes = await fetch(`${this.cfg.jupiterUrl}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: this.payer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
      }),
    });
    if (!swapRes.ok) throw new Error(`jupiter swap ${swapRes.status}: ${(await swapRes.text()).slice(0, 200)}`);
    const { swapTransaction } = (await swapRes.json()) as { swapTransaction: string };
    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
    tx.sign([this.payer]);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    const bh = await this.conn.getLatestBlockhash("confirmed");
    const c = await this.conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    if (c.value.err) throw new Error(`swap ${sig} failed: ${JSON.stringify(c.value.err)}`);
    return sig;
  }

  /** Coin flip: burn everything the treasury holds of the token, or send it to the holders. */
  private async dispose(mint: PublicKey): Promise<void> {
    const mintInfo = await this.conn.getAccountInfo(mint, "confirmed");
    if (!mintInfo) throw new Error("mint not found");
    const tokenProgram = mintInfo.owner;
    const decimals = mintInfo.data[44];
    const mine = ata(this.payer.publicKey, mint, tokenProgram);
    const bal = await this.conn.getTokenAccountBalance(mine, "confirmed").catch(() => null);
    const held = BigInt(bal?.value.amount ?? "0");
    if (held === 0n) {
      this.emit({ kind: "skip", detail: "nothing to dispose of after the swap" });
      return;
    }
    const flip = this.rand();
    if (flip < 0.5) {
      const sig = await sendAndConfirmTransaction(this.conn, new Transaction().add(burnIx(tokenProgram, mine, mint, this.payer.publicKey, held)), [this.payer], { commitment: "confirmed" });
      this.emit({ kind: "burn", detail: `burned ${fmtUnits(held, decimals)} (flip ${flip.toFixed(3)})`, sig });
      return;
    }
    const holders = await this.holders(mint, tokenProgram);
    const picked = pickHolders(holders, [this.payer.publicKey], this.cfg.maxHolders);
    const drops = splitAirdrop(held, picked);
    if (drops.length === 0) {
      const sig = await sendAndConfirmTransaction(this.conn, new Transaction().add(burnIx(tokenProgram, mine, mint, this.payer.publicKey, held)), [this.payer], { commitment: "confirmed" });
      this.emit({ kind: "burn", detail: `no eligible holders; burned ${fmtUnits(held, decimals)}`, sig });
      return;
    }
    const sigs: string[] = [];
    for (let i = 0; i < drops.length; i += 12) {
      const tx = new Transaction();
      for (const d of drops.slice(i, i + 12)) tx.add(transferCheckedIx(tokenProgram, mine, mint, d.tokenAccount, this.payer.publicKey, d.amount, decimals));
      sigs.push(await sendAndConfirmTransaction(this.conn, tx, [this.payer], { commitment: "confirmed" }));
    }
    this.emit({ kind: "airdrop", detail: `airdropped ${fmtUnits(held, decimals)} to ${drops.length} holders in ${sigs.length} transactions (flip ${flip.toFixed(3)})`, sig: sigs[0] });
  }

  /** Every token account of the mint (owner and amount only), from the token program's account index. */
  private async holders(mint: PublicKey, tokenProgram: PublicKey): Promise<Holder[]> {
    const accounts = await this.conn.getProgramAccounts(tokenProgram, {
      commitment: "confirmed",
      dataSlice: { offset: 32, length: 40 },
      filters: [{ memcmp: { offset: 0, bytes: mint.toBase58() } }],
    });
    return accounts.map((a) => ({ tokenAccount: a.pubkey, owner: new PublicKey(a.account.data.subarray(0, 32)), amount: Buffer.from(a.account.data).readBigUInt64LE(32) }));
  }
}

function fmtUnits(n: bigint, decimals: number): string {
  const s = n.toString().padStart(decimals + 1, "0");
  return decimals ? `${s.slice(0, -decimals)}.${s.slice(-decimals).slice(0, 2)}` : s;
}
