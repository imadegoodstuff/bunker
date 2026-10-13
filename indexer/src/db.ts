import { DatabaseSync } from "node:sqlite";

export class Db {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commitments (
        idx INTEGER PRIMARY KEY,
        commitment TEXT NOT NULL,
        ciphertext BLOB NOT NULL,
        signature TEXT NOT NULL,
        slot INTEGER NOT NULL,
        block_time INTEGER
      );
      CREATE TABLE IF NOT EXISTS out_ciphertexts (
        signature TEXT PRIMARY KEY,
        first_idx INTEGER NOT NULL,
        ciphertext BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nullifiers (
        nullifier TEXT PRIMARY KEY,
        signature TEXT NOT NULL,
        slot INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roots (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        root TEXT NOT NULL UNIQUE,
        next_index INTEGER NOT NULL,
        signature TEXT NOT NULL,
        slot INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flows (
        signature TEXT NOT NULL,
        kind TEXT NOT NULL,
        mint TEXT NOT NULL,
        amount TEXT NOT NULL,
        slot INTEGER NOT NULL,
        block_time INTEGER,
        PRIMARY KEY (signature, kind)
      );
      CREATE INDEX IF NOT EXISTS flows_mint_slot ON flows(mint, slot);
    `);
  }

  getMeta(k: string): string | undefined {
    const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined;
    return r?.v;
  }
  setMeta(k: string, v: string) {
    this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  insertCommitment(idx: number, commitment: string, ciphertext: Uint8Array, signature: string, slot: number, blockTime: number | null) {
    this.db
      .prepare("INSERT OR IGNORE INTO commitments(idx, commitment, ciphertext, signature, slot, block_time) VALUES(?,?,?,?,?,?)")
      .run(idx, commitment, ciphertext, signature, slot, blockTime);
  }
  insertOutCiphertext(signature: string, firstIdx: number, ciphertext: Uint8Array) {
    if (ciphertext.length === 0) return;
    this.db.prepare("INSERT OR IGNORE INTO out_ciphertexts(signature, first_idx, ciphertext) VALUES(?,?,?)").run(signature, firstIdx, ciphertext);
  }
  insertNullifier(nf: string, signature: string, slot: number) {
    this.db.prepare("INSERT OR IGNORE INTO nullifiers(nullifier, signature, slot) VALUES(?,?,?)").run(nf, signature, slot);
  }
  insertRoot(root: string, nextIndex: number, signature: string, slot: number) {
    this.db.prepare("INSERT OR IGNORE INTO roots(root, next_index, signature, slot) VALUES(?,?,?,?)").run(root, nextIndex, signature, slot);
  }
  insertFlow(signature: string, kind: string, mint: string, amount: string, slot: number, blockTime: number | null) {
    this.db.prepare("INSERT OR IGNORE INTO flows(signature, kind, mint, amount, slot, block_time) VALUES(?,?,?,?,?,?)").run(signature, kind, mint, amount, slot, blockTime);
  }

  commitments(from: number, limit: number) {
    return this.db
      .prepare("SELECT idx, commitment, ciphertext, signature, slot, block_time FROM commitments WHERE idx >= ? ORDER BY idx LIMIT ?")
      .all(from, limit) as { idx: number; commitment: string; ciphertext: Uint8Array; signature: string; slot: number; block_time: number | null }[];
  }
  outCiphertexts(fromIdx: number, limit: number) {
    return this.db
      .prepare("SELECT signature, first_idx, ciphertext FROM out_ciphertexts WHERE first_idx >= ? ORDER BY first_idx LIMIT ?")
      .all(fromIdx, limit) as { signature: string; first_idx: number; ciphertext: Uint8Array }[];
  }
  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM commitments").get() as { n: number }).n;
  }
  hasNullifier(nf: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM nullifiers WHERE nullifier = ?").get(nf);
  }
  nullifiersSince(slot: number, limit: number) {
    return this.db.prepare("SELECT nullifier, signature, slot FROM nullifiers WHERE slot >= ? ORDER BY slot LIMIT ?").all(slot, limit) as {
      nullifier: string; signature: string; slot: number;
    }[];
  }
  latestRoots(n: number) {
    return this.db.prepare("SELECT root, next_index, signature, slot FROM roots ORDER BY seq DESC LIMIT ?").all(n) as {
      root: string; next_index: number; signature: string; slot: number;
    }[];
  }
  stats(sinceSlot: number) {
    const rows = this.db
      .prepare("SELECT mint, kind, COUNT(*) AS n, SUM(CAST(amount AS INTEGER)) AS total FROM flows WHERE slot >= ? GROUP BY mint, kind")
      .all(sinceSlot) as { mint: string; kind: string; n: number; total: number }[];
    return rows;
  }
  dailyActivity(days: number) {
    return this.db
      .prepare(
        `SELECT date(block_time, 'unixepoch') AS day, COUNT(*) AS txs
         FROM commitments WHERE block_time IS NOT NULL AND block_time >= unixepoch('now', ?)
         GROUP BY day ORDER BY day`
      )
      .all(`-${days} days`) as { day: string; txs: number }[];
  }
}
