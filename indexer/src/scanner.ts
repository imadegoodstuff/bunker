// Pulls confirmed transactions for the vault program, parses `sol_log_data`
// events ("Program data: <b64> <b64> ...") and writes them to the database.
import { Connection, PublicKey, type ParsedTransactionWithMeta, type ConfirmedSignatureInfo } from "@solana/web3.js";
import { Db } from "./db.js";

const td = new TextDecoder();

function u64le(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
  return x;
}
const pk = (b: Uint8Array) => new PublicKey(b).toBase58();
const u16le = (b: Uint8Array) => b[0] | (b[1] << 8);
function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export interface Deferred {
  signature: string;
  /** ms epoch of first deferral */
  since: number;
  attempts: number;
  lastReason: string;
}

/** A confirmed transaction the RPC still cannot return after this long is an incident, not lag. */
export const DEGRADED_AFTER_MS = 10 * 60 * 1000;

export class Scanner {
  private running = false;
  /** Primary first, then fallbacks. Every read that can fail over does so in this order. */
  readonly conns: Connection[];
  readonly conn: Connection;
  /** How many deferred or missing transactions each fallback endpoint has supplied (index 0 = primary). */
  readonly recoveredVia: number[];
  constructor(
    conn: Connection | Connection[],
    readonly db: Db,
    readonly programId: PublicKey,
    readonly intervalMs = 4000,
    /** the launchpad program, whose own history carries the agents' fee votes; undefined disables */
    readonly launchProgramId?: PublicKey
  ) {
    this.conns = Array.isArray(conn) ? conn : [conn];
    if (this.conns.length === 0) throw new Error("scanner needs at least one RPC connection");
    this.conn = this.conns[0];
    this.recoveredVia = this.conns.map(() => 0);
  }

  /** Run `f` against each endpoint in order until one answers; rethrow the last error if none does. */
  private async withFailover<T>(what: string, f: (c: Connection, i: number) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.conns.length; i++) {
      try {
        return await f(this.conns[i], i);
      } catch (e) {
        lastErr = e;
        if (i + 1 < this.conns.length) console.warn(`[scanner] ${what} failed on endpoint ${i} (${(e as Error).message}); trying endpoint ${i + 1}`);
      }
    }
    throw lastErr;
  }

  async start() {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        console.error("[scanner] tick failed:", (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, this.intervalMs));
    }
  }
  stop() {
    this.running = false;
  }

  /** Walk backwards from the newest signature of `address` until we hit the last one we processed under `metaKey`. */
  private async newSignatures(address: PublicKey, metaKey: string): Promise<ConfirmedSignatureInfo[]> {
    const last = this.db.getMeta(metaKey);
    const batch: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    outer: for (;;) {
      const page = await this.withFailover("getSignaturesForAddress", (c) => c.getSignaturesForAddress(address, { before, limit: 1000 }, "confirmed"));
      if (page.length === 0) break;
      for (const s of page) {
        if (s.signature === last) break outer;
        batch.push(s);
      }
      before = page[page.length - 1].signature;
      if (page.length < 1000) break;
    }
    return batch;
  }

  async tick() {
    // The vault's history covers every shield, send, unshield and every launchpad
    // trade (they are CPIs from the vault). Agent fee votes touch only the launch
    // program, so its history is walked too; `ingest` is idempotent per signature,
    // so a transaction present in both lists is harmless.
    const vault = await this.newSignatures(this.programId, "last_signature");
    const launch = this.launchProgramId ? await this.newSignatures(this.launchProgramId, "last_signature_launch") : [];
    await this.retrySkipped();
    if (vault.length === 0 && launch.length === 0) return;
    const seen = new Set<string>();
    const batch = [...vault, ...launch].reverse().filter((s) => !seen.has(s.signature) && seen.add(s.signature)); // oldest first
    batch.sort((a, b) => a.slot - b.slot);
    for (let i = 0; i < batch.length; i += 50) {
      const chunk = batch.slice(i, i + 50);
      const txs = await this.fetchParsed(chunk.map((s) => s.signature));
      txs.forEach((tx, j) => {
        // Every signature here came from getSignaturesForAddress at
        // `confirmed`, so the transaction exists. `null` (RPC has no data for
        // it yet) and `undefined` (RPC threw) are both "not now", never "never".
        if (tx === undefined || tx === null) this.defer(chunk[j].signature, tx === null ? "rpc returned null" : "rpc error");
        else if (!tx.meta?.err) this.ingest(chunk[j].signature, tx);
      });
    }
    if (vault.length) this.db.setMeta("last_signature", vault[0].signature);
    if (launch.length) this.db.setMeta("last_signature_launch", launch[0].signature);
    console.log(`[scanner] ingested ${batch.length} tx, commitments=${this.db.count()}, deferred=${this.deferred().length}`);
  }

  /**
   * Signatures whose transaction the RPC has not returned yet. Each is retried
   * on every tick until it decodes; nothing is ever dropped automatically,
   * because a deferred transaction can hold leaves and dropping it would leave
   * a permanent hole that `/commitments` would then (correctly) refuse to page
   * past. Each retry asks every configured endpoint (`RPC_URLS`), so a single
   * RPC that is behind or down is survived without anyone acting; `/health`
   * exposes this list and flips `degraded` once any entry is older than
   * DEGRADED_AFTER_MS, which now means *no* endpoint could return it.
   */
  deferred(): Deferred[] {
    return JSON.parse(this.db.getMeta("deferred_signatures") ?? "[]") as Deferred[];
  }
  /** Backwards-compatible view used by older callers and tests. */
  skipped(): string[] {
    return this.deferred().map((d) => d.signature);
  }
  degraded(now = Date.now()): boolean {
    return this.deferred().some((d) => now - d.since > DEGRADED_AFTER_MS);
  }
  private saveDeferred(list: Deferred[]) {
    this.db.setMeta("deferred_signatures", JSON.stringify(list));
  }
  private defer(sig: string, reason: string) {
    const list = this.deferred();
    const cur = list.find((d) => d.signature === sig);
    if (cur) {
      cur.attempts += 1;
      cur.lastReason = reason;
    } else {
      list.push({ signature: sig, since: Date.now(), attempts: 1, lastReason: reason });
    }
    this.saveDeferred(list);
    console.warn(`[scanner] deferring ${sig} (${reason})`);
  }
  private async retrySkipped() {
    const list = this.deferred();
    if (list.length === 0) return;
    const remaining: Deferred[] = [];
    for (const d of list) {
      // Every endpoint is asked, in order; a deferred signature is only kept
      // when none of them can return the transaction.
      const r = await this.fetchOne(d.signature);
      if (r instanceof Error) {
        remaining.push({ ...d, attempts: d.attempts + 1, lastReason: r.message });
        continue;
      }
      if (r === null) {
        remaining.push({ ...d, attempts: d.attempts + 1, lastReason: "rpc returned null" });
        continue;
      }
      if (!r.tx.meta?.err) this.ingest(d.signature, r.tx);
      console.log(`[scanner] recovered ${d.signature} after ${d.attempts} attempts via endpoint ${r.via}`);
    }
    for (const d of remaining) {
      if (Date.now() - d.since > DEGRADED_AFTER_MS) console.error(`[scanner] DEGRADED: ${d.signature} undecodable for ${Math.round((Date.now() - d.since) / 1000)}s (${d.lastReason})`);
    }
    this.saveDeferred(remaining);
  }

  private static readonly FETCH_OPTS = { maxSupportedTransactionVersion: 1, commitment: "confirmed" as const };

  /**
   * Anyone can send the program a transaction in any format, so the fetch must
   * accept every version the RPC knows (legacy, v0, v1 — SIMD-0385, live since
   * September 2026) and must never let one undecodable signature stall the
   * scan: a batch that fails is retried one signature at a time, each
   * signature the primary cannot return is asked of every fallback endpoint,
   * and whatever is still missing is recorded (`undefined`/`null` here →
   * `deferred_signatures`) so the scan position can move past it while it is
   * retried on every later tick. A deferred transaction is therefore delayed,
   * never lost. Events are read from program logs, so the transaction format
   * does not matter to `ingest`.
   */
  private async fetchParsed(sigs: string[]): Promise<(ParsedTransactionWithMeta | null | undefined)[]> {
    let out: (ParsedTransactionWithMeta | null | undefined)[];
    try {
      out = await this.conn.getParsedTransactions(sigs, Scanner.FETCH_OPTS);
    } catch (e) {
      console.warn(`[scanner] batch fetch failed (${(e as Error).message}); retrying individually`);
      out = sigs.map(() => undefined);
    }
    for (let i = 0; i < sigs.length; i++) {
      if (out[i]) continue;
      // Batch threw: start at the primary. Batch answered null: the primary has spoken, ask the fallbacks.
      const r = await this.fetchOne(sigs[i], out[i] === undefined ? 0 : 1);
      if (r instanceof Error) {
        console.warn(`[scanner] deferring ${sigs[i]}: ${r.message}`);
        out[i] = undefined;
      } else if (r === null) {
        out[i] = null;
      } else {
        out[i] = r.tx;
      }
    }
    return out;
  }

  /**
   * One signature against endpoints `start..`. Returns the transaction and the
   * endpoint that had it; `null` if every endpoint answered null (or there were
   * none to ask); an `Error` if every endpoint threw.
   */
  private async fetchOne(sig: string, start = 0): Promise<{ tx: ParsedTransactionWithMeta; via: number } | null | Error> {
    let outcome: null | Error = start > 0 ? null : new Error("no endpoint asked");
    for (let i = start; i < this.conns.length; i++) {
      try {
        const tx = await this.conns[i].getParsedTransaction(sig, Scanner.FETCH_OPTS);
        if (tx) {
          if (i > 0) {
            this.recoveredVia[i]++;
            console.log(`[scanner] ${sig}: endpoint ${i} supplied what ${i === 1 ? "endpoint 0" : `endpoints 0–${i - 1}`} could not`);
          }
          return { tx, via: i };
        }
        outcome = null; // a definite null beats an earlier error as the recorded reason
      } catch (e) {
        if (outcome !== null) outcome = e as Error;
      }
    }
    return outcome;
  }

  ingest(signature: string, tx: ParsedTransactionWithMeta) {
    const logs = tx.meta?.logMessages ?? [];
    const slot = tx.slot;
    const bt = tx.blockTime ?? null;
    // best-effort mint from the first vault instruction (account index 5 = mint)
    let mint = "unknown";
    for (const ix of tx.transaction.message.instructions) {
      if (ix.programId.equals(this.programId) && "accounts" in ix && ix.accounts.length > 5) {
        mint = ix.accounts[5].toBase58();
        break;
      }
    }
    for (const line of logs) {
      if (!line.startsWith("Program data: ")) continue;
      const parts = line.slice("Program data: ".length).split(" ").map((p) => Uint8Array.from(Buffer.from(p, "base64")));
      const tag = td.decode(parts[0]);
      switch (tag) {
        case "transact": {
          const [, idxB, cm0, cm1, ct0, ct1, outCt, root] = parts;
          const first = Number(u64le(idxB));
          this.db.insertCommitment(first, hex(cm0), ct0, signature, slot, bt);
          this.db.insertCommitment(first + 1, hex(cm1), ct1, signature, slot, bt);
          this.db.insertOutCiphertext(signature, first, outCt);
          this.db.insertRoot(hex(root), first + 2, signature, slot);
          break;
        }
        case "nullifier":
          this.db.insertNullifier(hex(parts[1]), signature, slot);
          break;
        case "shield":
        case "unshield":
        case "donate":
          this.db.insertFlow(signature, tag, mint, u64le(parts[1]).toString(), slot, bt);
          break;
        // --- launchpad events (the launch program is reached by CPI from the vault, or CPIs into it, so its
        // transactions are already in this program's signature history)
        case "launch": {
          const [, m, name, symbol, uri, vSol, vTok, curveSupply, totalSupply, grad, dec] = parts;
          if (parts.length < 11) break;
          this.db.insertLaunch({
            mint: pk(m), name: td.decode(name), symbol: td.decode(symbol), uri: td.decode(uri), decimals: dec[0],
            virtualSol: u64le(vSol).toString(), virtualToken: u64le(vTok).toString(), curveSupply: u64le(curveSupply).toString(),
            totalSupply: u64le(totalSupply).toString(), graduationLamports: u64le(grad).toString(), signature, slot, blockTime: bt,
          });
          break;
        }
        case "curve_buy":
        case "curve_sell": {
          const [, m, sol, fee, tokens, realSol, realToken, virtualToken, priv] = parts;
          if (parts.length < 9) break;
          this.db.insertTrade({
            signature, mint: pk(m), side: tag === "curve_buy" ? "buy" : "sell", sol: u64le(sol).toString(), fee: u64le(fee).toString(),
            tokens: u64le(tokens).toString(), isPrivate: priv[0] === 1, realSol: u64le(realSol).toString(), realToken: u64le(realToken).toString(),
            virtualToken: u64le(virtualToken).toString(), slot, blockTime: bt,
          });
          break;
        }
        case "harvest":
          if (parts.length >= 5) this.db.insertHarvest(signature, pk(parts[1]), u64le(parts[2]).toString(), u64le(parts[4]).toString());
          break;
        case "graduate":
          if (parts.length >= 4) this.db.markGraduated(pk(parts[1]), u64le(parts[2]).toString(), u64le(parts[3]).toString());
          break;
        // migrate(mint, pool, sol_in, token_in, lp_burned): the curve's liquidity moved to a Raydium CP-Swap pool
        case "migrate":
          if (parts.length >= 5) this.db.markMigrated(pk(parts[1]), pk(parts[2]), u64le(parts[3]).toString(), u64le(parts[4]).toString());
          break;
        // --- fee policy: an agent's vote, and the epoch roll that moved the effective fee
        case "fee_vote":
          if (parts.length >= 6) this.db.insertFeeEvent({ signature, mint: pk(parts[1]), kind: "vote", agent: parts[2][0], feeBps: u16le(parts[3]), holderBps: u16le(parts[4]), slot: Number(u64le(parts[5])), blockTime: bt });
          break;
        case "fee_roll":
          if (parts.length >= 5) this.db.insertFeeEvent({ signature, mint: pk(parts[1]), kind: "roll", agent: null, feeBps: u16le(parts[2]), holderBps: u16le(parts[3]), slot, blockTime: bt, epoch: Number(u64le(parts[4])) });
          break;
      }
    }
  }
}
