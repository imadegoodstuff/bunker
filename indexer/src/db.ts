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
      -- launchpad: one row per launched token, updated by every curve event
      CREATE TABLE IF NOT EXISTS launches (
        mint TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        uri TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        virtual_sol TEXT NOT NULL,
        virtual_token0 TEXT NOT NULL,
        curve_supply TEXT NOT NULL,
        total_supply TEXT NOT NULL,
        graduation_lamports TEXT NOT NULL,
        real_sol TEXT NOT NULL DEFAULT '0',
        real_token TEXT NOT NULL,
        virtual_token TEXT NOT NULL,
        graduated INTEGER NOT NULL DEFAULT 0,
        buys INTEGER NOT NULL DEFAULT 0,
        sells INTEGER NOT NULL DEFAULT 0,
        sol_volume TEXT NOT NULL DEFAULT '0',
        fees_to_treasury TEXT NOT NULL DEFAULT '0',
        tokens_donated TEXT NOT NULL DEFAULT '0',
        signature TEXT NOT NULL,
        slot INTEGER NOT NULL,
        block_time INTEGER,
        last_slot INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        signature TEXT NOT NULL,
        mint TEXT NOT NULL,
        side TEXT NOT NULL,
        sol TEXT NOT NULL,
        fee TEXT NOT NULL,
        tokens TEXT NOT NULL,
        private INTEGER NOT NULL,
        slot INTEGER NOT NULL,
        block_time INTEGER,
        PRIMARY KEY (signature, mint, side)
      );
      CREATE INDEX IF NOT EXISTS trades_mint_slot ON trades(mint, slot);
      -- fee policy: agent votes ("vote", agent 0-3) and epoch rolls ("roll") per launched token
      CREATE TABLE IF NOT EXISTS fee_events (
        signature TEXT NOT NULL,
        mint TEXT NOT NULL,
        kind TEXT NOT NULL,
        agent INTEGER,
        fee_bps INTEGER NOT NULL,
        holder_bps INTEGER NOT NULL,
        epoch INTEGER,
        slot INTEGER NOT NULL,
        block_time INTEGER,
        PRIMARY KEY (signature, mint, kind)
      );
      CREATE INDEX IF NOT EXISTS fee_events_mint_slot ON fee_events(mint, slot);
    `);
    // added after the first deployments: the Raydium pool a graduated curve migrated to
    const cols = (this.db.prepare("PRAGMA table_info(launches)").all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes("amm_pool")) this.db.exec("ALTER TABLE launches ADD COLUMN amm_pool TEXT");
    if (!cols.includes("amm_sol")) this.db.exec("ALTER TABLE launches ADD COLUMN amm_sol TEXT");
    if (!cols.includes("amm_tokens")) this.db.exec("ALTER TABLE launches ADD COLUMN amm_tokens TEXT");
  }

  insertFeeEvent(e: { signature: string; mint: string; kind: "vote" | "roll"; agent: number | null; feeBps: number; holderBps: number; slot: number; blockTime: number | null; epoch?: number }) {
    this.db
      .prepare("INSERT OR IGNORE INTO fee_events(signature, mint, kind, agent, fee_bps, holder_bps, epoch, slot, block_time) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(e.signature, e.mint, e.kind, e.agent, e.feeBps, e.holderBps, e.epoch ?? null, e.slot, e.blockTime);
  }
  feeEvents(mint: string, limit: number) {
    return this.db.prepare("SELECT * FROM fee_events WHERE mint = ? ORDER BY slot DESC, kind LIMIT ?").all(mint, limit) as Record<string, unknown>[];
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
  // ---- launchpad

  insertLaunch(l: {
    mint: string; name: string; symbol: string; uri: string; decimals: number; virtualSol: string; virtualToken: string; curveSupply: string;
    totalSupply: string; graduationLamports: string; signature: string; slot: number; blockTime: number | null;
  }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO launches(mint, name, symbol, uri, decimals, virtual_sol, virtual_token0, curve_supply, total_supply, graduation_lamports,
           real_token, virtual_token, signature, slot, block_time, last_slot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(l.mint, l.name, l.symbol, l.uri, l.decimals, l.virtualSol, l.virtualToken, l.curveSupply, l.totalSupply, l.graduationLamports, l.curveSupply, l.virtualToken, l.signature, l.slot, l.blockTime, l.slot);
  }
  /** A buy or sell: records the trade and, if it is newer than what we have, the curve state it left behind. */
  insertTrade(t: { signature: string; mint: string; side: "buy" | "sell"; sol: string; fee: string; tokens: string; isPrivate: boolean; realSol: string; realToken: string; virtualToken: string; slot: number; blockTime: number | null }) {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO trades(signature, mint, side, sol, fee, tokens, private, slot, block_time) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(t.signature, t.mint, t.side, t.sol, t.fee, t.tokens, t.isPrivate ? 1 : 0, t.slot, t.blockTime);
    if (r.changes === 0) return;
    this.db
      .prepare(
        `UPDATE launches SET buys = buys + ?, sells = sells + ?, sol_volume = CAST(CAST(sol_volume AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
           real_sol = CASE WHEN ? >= last_slot THEN ? ELSE real_sol END,
           real_token = CASE WHEN ? >= last_slot THEN ? ELSE real_token END,
           virtual_token = CASE WHEN ? >= last_slot THEN ? ELSE virtual_token END,
           last_slot = MAX(last_slot, ?) WHERE mint = ?`
      )
      .run(t.side === "buy" ? 1 : 0, t.side === "sell" ? 1 : 0, t.sol, t.slot, t.realSol, t.slot, t.realToken, t.slot, t.virtualToken, t.slot, t.mint);
  }
  insertHarvest(signature: string, mint: string, protocol: string, donated: string) {
    const r = this.db.prepare("INSERT OR IGNORE INTO flows(signature, kind, mint, amount, slot, block_time) VALUES(?,?,?,?,0,NULL)").run(signature, "harvest", mint, protocol);
    if (r.changes === 0) return;
    this.db
      .prepare(
        `UPDATE launches SET fees_to_treasury = CAST(CAST(fees_to_treasury AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
           tokens_donated = CAST(CAST(tokens_donated AS INTEGER) + CAST(? AS INTEGER) AS TEXT) WHERE mint = ?`
      )
      .run(protocol, donated, mint);
  }
  markGraduated(mint: string, realSol: string, realToken: string) {
    this.db.prepare("UPDATE launches SET graduated = 1, real_sol = ?, real_token = ? WHERE mint = ?").run(realSol, realToken, mint);
  }
  /** The curve moved to a Raydium pool: it holds nothing any more, the pool holds `solIn` lamports and `tokensIn` base units. */
  markMigrated(mint: string, pool: string, solIn: string, tokensIn: string) {
    this.db
      .prepare("UPDATE launches SET graduated = 1, amm_pool = ?, amm_sol = ?, amm_tokens = ?, real_sol = '0', real_token = '0' WHERE mint = ?")
      .run(pool, solIn, tokensIn, mint);
  }
  launches(limit: number, offset: number) {
    return this.db.prepare("SELECT * FROM launches ORDER BY slot DESC LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
  }
  launch(mint: string) {
    return this.db.prepare("SELECT * FROM launches WHERE mint = ?").get(mint) as Record<string, unknown> | undefined;
  }
  trades(mint: string, limit: number, beforeSlot?: number) {
    return this.db
      .prepare("SELECT signature, side, sol, fee, tokens, private, slot, block_time FROM trades WHERE mint = ? AND slot < ? ORDER BY slot DESC LIMIT ?")
      .all(mint, beforeSlot ?? Number.MAX_SAFE_INTEGER, limit) as { signature: string; side: string; sol: string; fee: string; tokens: string; private: number; slot: number; block_time: number | null }[];
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
