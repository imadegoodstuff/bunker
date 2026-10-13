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
    if (batch.length === 0) return;
    batch.reverse(); // oldest first
    for (let i = 0; i < batch.length; i += 50) {
      const chunk = batch.slice(i, i + 50);
      const txs = await this.conn.getParsedTransactions(
        chunk.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0, commitment: "confirmed" }
      );
      txs.forEach((tx, j) => {
        if (tx && !tx.meta?.err) this.ingest(chunk[j].signature, tx);
      });
      this.db.setMeta("last_signature", chunk[chunk.length - 1].signature);
    }
    console.log(`[scanner] ingested ${batch.length} tx, commitments=${this.db.count()}`);
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
