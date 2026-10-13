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
        if (tx === undefined) this.markSkipped(chunk[j].signature);
        else if (tx && !tx.meta?.err) this.ingest(chunk[j].signature, tx);
      });
      this.db.setMeta("last_signature", chunk[chunk.length - 1].signature);
    }
    console.log(`[scanner] ingested ${batch.length} tx, commitments=${this.db.count()}, skipped=${this.skipped().length}`);
  }

  /** Signatures the RPC could not return yet. Never dropped: retried on every tick until they decode. */
  skipped(): string[] {
    return JSON.parse(this.db.getMeta("skipped_signatures") ?? "[]") as string[];
  }
  private markSkipped(sig: string) {
    const s = this.skipped();
    if (!s.includes(sig)) {
      s.push(sig);
      this.db.setMeta("skipped_signatures", JSON.stringify(s));
    }
  }
  private async retrySkipped() {
    const s = this.skipped();
    if (s.length === 0) return;
    const remaining: string[] = [];
    for (const sig of s) {
      try {
        const tx = await this.conn.getParsedTransaction(sig, { maxSupportedTransactionVersion: 1, commitment: "confirmed" });
        if (tx === null) continue; // dropped / never landed: nothing to index
        if (!tx.meta?.err) this.ingest(sig, tx);
      } catch (e) {
        console.warn(`[scanner] still cannot decode ${sig}: ${(e as Error).message}`);
        remaining.push(sig);
      }
    }
    this.db.setMeta("skipped_signatures", JSON.stringify(remaining));
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
