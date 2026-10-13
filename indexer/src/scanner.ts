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
  constructor(
    readonly conn: Connection,
    readonly db: Db,
    readonly programId: PublicKey,
    readonly intervalMs = 4000
  ) {}

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

  /** Walk backwards from the newest signature until we hit the last one we processed. */
  async tick() {
    const last = this.db.getMeta("last_signature");
    const batch: ConfirmedSignatureInfo[] = [];
    let before: string | undefined;
    outer: for (;;) {
      const page = await this.conn.getSignaturesForAddress(this.programId, { before, limit: 1000 }, "confirmed");
      if (page.length === 0) break;
      for (const s of page) {
        if (s.signature === last) break outer;
        batch.push(s);
      }
      before = page[page.length - 1].signature;
      if (page.length < 1000) break;
    }
    await this.retrySkipped();
    if (batch.length === 0) return;
    batch.reverse(); // oldest first
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
      this.db.setMeta("last_signature", chunk[chunk.length - 1].signature);
    }
    console.log(`[scanner] ingested ${batch.length} tx, commitments=${this.db.count()}, deferred=${this.deferred().length}`);
  }

  /**
   * Signatures whose transaction the RPC has not returned yet. Each is retried
   * on every tick until it decodes; nothing is ever dropped automatically,
   * because a deferred transaction can hold leaves and dropping it would leave
   * a permanent hole that `/commitments` would then (correctly) refuse to page
   * past. `/health` exposes this list and flips `degraded` once any entry is
   * older than DEGRADED_AFTER_MS so an operator can switch RPC or investigate.
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
      let tx: ParsedTransactionWithMeta | null;
      try {
        tx = await this.conn.getParsedTransaction(d.signature, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
      } catch (e) {
        remaining.push({ ...d, attempts: d.attempts + 1, lastReason: (e as Error).message });
        continue;
      }
      if (tx === null) {
        remaining.push({ ...d, attempts: d.attempts + 1, lastReason: "rpc returned null" });
        continue;
      }
      if (!tx.meta?.err) this.ingest(d.signature, tx);
      console.log(`[scanner] recovered ${d.signature} after ${d.attempts} attempts`);
    }
    for (const d of remaining) {
      if (Date.now() - d.since > DEGRADED_AFTER_MS) console.error(`[scanner] DEGRADED: ${d.signature} undecodable for ${Math.round((Date.now() - d.since) / 1000)}s (${d.lastReason})`);
    }
    this.saveDeferred(remaining);
  }

  /**
   * Anyone can send the program a transaction in any format, so the fetch must
   * accept every version the RPC knows (legacy, v0, v1 — SIMD-0385, live since
   * September 2026) and must never let one undecodable signature stall the
   * scan: a batch that fails is retried one signature at a time and the
   * offenders are recorded (`undefined` here → `skipped_signatures`) so the
   * scan position can move past them while they are retried on every later tick. A
   * skipped transaction is therefore delayed, never lost. Events are read from
   * program logs, so the transaction format does not matter to `ingest`.
   */
  private async fetchParsed(sigs: string[]): Promise<(ParsedTransactionWithMeta | null | undefined)[]> {
    const opts = { maxSupportedTransactionVersion: 1, commitment: "confirmed" as const };
    try {
      return await this.conn.getParsedTransactions(sigs, opts);
    } catch (e) {
      console.warn(`[scanner] batch fetch failed (${(e as Error).message}); retrying individually`);
    }
    const out: (ParsedTransactionWithMeta | null | undefined)[] = [];
    for (const sig of sigs) {
      try {
        out.push(await this.conn.getParsedTransaction(sig, opts));
      } catch (e) {
        console.warn(`[scanner] deferring ${sig}: ${(e as Error).message}`);
        out.push(undefined);
      }
    }
    return out;
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
      }
    }
  }
}
