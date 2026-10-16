import { DatabaseSync } from "node:sqlite";

export class Db {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      -- one row per leaf; kind 'open' = a note the pool minted for exit proceeds (shares and owner hash public)
      CREATE TABLE IF NOT EXISTS commitments (
        idx INTEGER PRIMARY KEY,
        commitment TEXT NOT NULL,
        token TEXT,
        ciphertext BLOB NOT NULL,
        tx_hash TEXT NOT NULL,
        block INTEGER NOT NULL,
        block_time INTEGER,
        kind TEXT NOT NULL DEFAULT 'note',
        shares TEXT,
        owner_hash TEXT
      );
      -- drains: the tree's inserted prefix after each batch
      CREATE TABLE IF NOT EXISTS drains (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        from_idx INTEGER NOT NULL,
        count INTEGER NOT NULL,
        root TEXT NOT NULL,
        block INTEGER NOT NULL,
        block_time INTEGER,
        PRIMARY KEY (tx_hash, log_index)
      );
      -- EOA -> shielded address registry (latest value per owner; empty = cleared)
      CREATE TABLE IF NOT EXISTS registry (
        owner TEXT PRIMARY KEY,
        shielded_address TEXT,
        tx_hash TEXT NOT NULL,
        block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS out_ciphertexts (
        tx_hash TEXT NOT NULL,
        first_idx INTEGER PRIMARY KEY,
        ciphertext BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS nullifiers (
        nullifier TEXT PRIMARY KEY,
        tx_hash TEXT NOT NULL,
        block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roots (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        root TEXT NOT NULL UNIQUE,
        next_index INTEGER NOT NULL,
        tx_hash TEXT NOT NULL,
        block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flows (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        kind TEXT NOT NULL,
        token TEXT NOT NULL,
        amount TEXT NOT NULL,
        block INTEGER NOT NULL,
        block_time INTEGER,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS flows_token_block ON flows(token, block);
      -- launchpad: one row per launched token, updated by every curve event
      CREATE TABLE IF NOT EXISTS launches (
        token TEXT PRIMARY KEY,
        creator TEXT NOT NULL,
        name TEXT NOT NULL,
        symbol TEXT NOT NULL,
        uri TEXT NOT NULL,
        decimals INTEGER NOT NULL,
        virtual_bnb TEXT NOT NULL,
        virtual_token0 TEXT NOT NULL,
        curve_supply TEXT NOT NULL,
        total_supply TEXT NOT NULL,
        graduation_wei TEXT NOT NULL,
        real_bnb TEXT NOT NULL DEFAULT '0',
        real_token TEXT NOT NULL,
        virtual_token TEXT NOT NULL,
        graduated INTEGER NOT NULL DEFAULT 0,
        buys INTEGER NOT NULL DEFAULT 0,
        sells INTEGER NOT NULL DEFAULT 0,
        bnb_volume TEXT NOT NULL DEFAULT '0',
        fees_to_treasury TEXT NOT NULL DEFAULT '0',
        amm_pair TEXT,
        amm_bnb TEXT,
        amm_tokens TEXT,
        tx_hash TEXT NOT NULL,
        block INTEGER NOT NULL,
        block_time INTEGER,
        last_block INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trades (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        token TEXT NOT NULL,
        side TEXT NOT NULL,
        bnb TEXT NOT NULL,
        fee TEXT NOT NULL,
        tokens TEXT NOT NULL,
        block INTEGER NOT NULL,
        block_time INTEGER,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS trades_token_block ON trades(token, block);
      -- fee policy: agent votes ("vote", agent 0-3) and epoch rolls ("roll") per launched token
      CREATE TABLE IF NOT EXISTS fee_events (
        tx_hash TEXT NOT NULL,
        log_index INTEGER NOT NULL,
        token TEXT NOT NULL,
        kind TEXT NOT NULL,
        agent INTEGER,
        fee_bps INTEGER NOT NULL,
        epoch INTEGER,
        block INTEGER NOT NULL,
        block_time INTEGER,
        PRIMARY KEY (tx_hash, log_index)
      );
      CREATE INDEX IF NOT EXISTS fee_events_token_block ON fee_events(token, block);
      -- one row per Transact event: who sent it and which association-set root (if any) its proof was made against.
      -- The association set is derived from this (see asp.ts): a shield's outputs are vouched for when the depositor
      -- is clean; a non-shield's outputs when it proved its inputs against a root this indexer had published.
      CREATE TABLE IF NOT EXISTS transacts (
        tx_hash TEXT NOT NULL,
        first_idx INTEGER PRIMARY KEY,
        sender TEXT NOT NULL,
        public_amount TEXT NOT NULL,
        asp_root TEXT NOT NULL,
        block INTEGER NOT NULL
      );
    `);
    // v2.1: a private send publishes no asset, so the token column became nullable. SQLite cannot relax NOT NULL in
    // place; a database created before this version is rebuilt from the chain (the scan is cheap and idempotent).
    const col = (this.db.prepare("PRAGMA table_info(commitments)").all() as { name: string; notnull: number }[]).find((c) => c.name === "token");
    if (col && col.notnull) {
      this.db.exec("DROP TABLE commitments; DROP TABLE out_ciphertexts; DROP TABLE drains; DROP TABLE roots; DROP TABLE nullifiers; DROP TABLE flows; DELETE FROM meta WHERE k = 'last_block'");
      this.db.exec(`
        CREATE TABLE commitments (
          idx INTEGER PRIMARY KEY, commitment TEXT NOT NULL, token TEXT, ciphertext BLOB NOT NULL, tx_hash TEXT NOT NULL, block INTEGER NOT NULL, block_time INTEGER,
          kind TEXT NOT NULL DEFAULT 'note', shares TEXT, owner_hash TEXT
        );
        CREATE TABLE out_ciphertexts (tx_hash TEXT NOT NULL, first_idx INTEGER PRIMARY KEY, ciphertext BLOB NOT NULL);
        CREATE TABLE drains (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, from_idx INTEGER NOT NULL, count INTEGER NOT NULL, root TEXT NOT NULL, block INTEGER NOT NULL, block_time INTEGER, PRIMARY KEY (tx_hash, log_index));
        CREATE TABLE roots (seq INTEGER PRIMARY KEY AUTOINCREMENT, root TEXT NOT NULL UNIQUE, next_index INTEGER NOT NULL, tx_hash TEXT NOT NULL, block INTEGER NOT NULL);
        CREATE TABLE nullifiers (nullifier TEXT PRIMARY KEY, tx_hash TEXT NOT NULL, block INTEGER NOT NULL);
        CREATE TABLE flows (tx_hash TEXT NOT NULL, log_index INTEGER NOT NULL, kind TEXT NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, block INTEGER NOT NULL, block_time INTEGER, PRIMARY KEY (tx_hash, log_index));
        CREATE INDEX IF NOT EXISTS flows_token_block ON flows(token, block);
      `);
    }
  }

  getMeta(k: string): string | undefined {
    const r = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined;
    return r?.v;
  }
  setMeta(k: string, v: string) {
    this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  // ---- pool

  insertCommitment(idx: number, commitment: string, token: string | null, ciphertext: Uint8Array, txHash: string, block: number, blockTime: number | null) {
    this.db
      .prepare("INSERT OR IGNORE INTO commitments(idx, commitment, token, ciphertext, tx_hash, block, block_time) VALUES(?,?,?,?,?,?,?)")
      .run(idx, commitment, token, ciphertext, txHash, block, blockTime);
  }
  insertTransact(txHash: string, firstIdx: number, sender: string, publicAmount: string, aspRoot: string, block: number) {
    this.db.prepare("INSERT OR IGNORE INTO transacts(tx_hash, first_idx, sender, public_amount, asp_root, block) VALUES(?,?,?,?,?,?)").run(txHash, firstIdx, sender, publicAmount, aspRoot, block);
  }
  /** Every Transact in leaf order, joined with the leaves it produced (incl. open notes of the same tx). */
  transacts() {
    return this.db.prepare("SELECT tx_hash, first_idx, sender, public_amount, asp_root, block FROM transacts ORDER BY first_idx").all() as {
      tx_hash: string; first_idx: number; sender: string; public_amount: string; asp_root: string; block: number;
    }[];
  }
  /** Leaf index → commitment for every leaf, in order. */
  allLeaves() {
    return this.db.prepare("SELECT idx, commitment, tx_hash, kind FROM commitments ORDER BY idx").all() as { idx: number; commitment: string; tx_hash: string; kind: string }[];
  }
  commitmentByHex(commitment: string) {
    return this.db.prepare("SELECT idx, tx_hash FROM commitments WHERE commitment = ?").get(commitment) as { idx: number; tx_hash: string } | undefined;
  }
  insertOpenNote(idx: number, commitment: string, token: string, shares: string, ownerHash: string, ciphertext: Uint8Array, txHash: string, block: number, blockTime: number | null) {
    this.db
      .prepare("INSERT OR IGNORE INTO commitments(idx, commitment, token, ciphertext, tx_hash, block, block_time, kind, shares, owner_hash) VALUES(?,?,?,?,?,?,?,'open',?,?)")
      .run(idx, commitment, token, ciphertext, txHash, block, blockTime, shares, ownerHash);
  }
  insertDrain(txHash: string, logIndex: number, fromIdx: number, count: number, root: string, block: number, blockTime: number | null) {
    this.db.prepare("INSERT OR IGNORE INTO drains(tx_hash, log_index, from_idx, count, root, block, block_time) VALUES(?,?,?,?,?,?,?)").run(txHash, logIndex, fromIdx, count, root, block, blockTime);
  }
  /** Latest drain = the chain's inserted prefix as far as we have scanned. */
  insertedIndex(): number {
    const r = this.db.prepare("SELECT from_idx + count AS n FROM drains ORDER BY block DESC, log_index DESC LIMIT 1").get() as { n: number } | undefined;
    return r?.n ?? 0;
  }
  setRegistry(owner: string, shieldedAddress: string | null, txHash: string, block: number) {
    this.db
      .prepare("INSERT INTO registry(owner, shielded_address, tx_hash, block) VALUES(?,?,?,?) ON CONFLICT(owner) DO UPDATE SET shielded_address = CASE WHEN excluded.block >= registry.block THEN excluded.shielded_address ELSE registry.shielded_address END, tx_hash = excluded.tx_hash, block = MAX(registry.block, excluded.block)")
      .run(owner, shieldedAddress, txHash, block);
  }
  registry(owner: string) {
    return this.db.prepare("SELECT owner, shielded_address, block FROM registry WHERE owner = ?").get(owner) as { owner: string; shielded_address: string | null; block: number } | undefined;
  }
  insertOutCiphertext(txHash: string, firstIdx: number, ciphertext: Uint8Array) {
    if (ciphertext.length === 0) return;
    this.db.prepare("INSERT OR IGNORE INTO out_ciphertexts(tx_hash, first_idx, ciphertext) VALUES(?,?,?)").run(txHash, firstIdx, ciphertext);
  }
  insertNullifier(nf: string, txHash: string, block: number) {
    this.db.prepare("INSERT OR IGNORE INTO nullifiers(nullifier, tx_hash, block) VALUES(?,?,?)").run(nf, txHash, block);
  }
  insertRoot(root: string, nextIndex: number, txHash: string, block: number) {
    this.db.prepare("INSERT OR IGNORE INTO roots(root, next_index, tx_hash, block) VALUES(?,?,?,?)").run(root, nextIndex, txHash, block);
  }
  insertFlow(txHash: string, logIndex: number, kind: string, token: string, amount: string, block: number, blockTime: number | null) {
    this.db.prepare("INSERT OR IGNORE INTO flows(tx_hash, log_index, kind, token, amount, block, block_time) VALUES(?,?,?,?,?,?,?)").run(txHash, logIndex, kind, token, amount, block, blockTime);
  }

  commitments(from: number, limit: number) {
    return this.db
      .prepare("SELECT idx, commitment, token, ciphertext, tx_hash, block, block_time, kind, shares, owner_hash FROM commitments WHERE idx >= ? ORDER BY idx LIMIT ?")
      .all(from, limit) as { idx: number; commitment: string; token: string | null; ciphertext: Uint8Array; tx_hash: string; block: number; block_time: number | null; kind: string; shares: string | null; owner_hash: string | null }[];
  }
  outCiphertexts(fromIdx: number, limit: number) {
    return this.db
      .prepare("SELECT tx_hash, first_idx, ciphertext FROM out_ciphertexts WHERE first_idx >= ? ORDER BY first_idx LIMIT ?")
      .all(fromIdx, limit) as { tx_hash: string; first_idx: number; ciphertext: Uint8Array }[];
  }
  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM commitments").get() as { n: number }).n;
  }
  hasNullifier(nf: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM nullifiers WHERE nullifier = ?").get(nf);
  }
  nullifiersSince(block: number, limit: number) {
    return this.db.prepare("SELECT nullifier, tx_hash, block FROM nullifiers WHERE block >= ? ORDER BY block LIMIT ?").all(block, limit) as {
      nullifier: string; tx_hash: string; block: number;
    }[];
  }
  latestRoots(n: number) {
    return this.db.prepare("SELECT root, next_index, tx_hash, block FROM roots ORDER BY seq DESC LIMIT ?").all(n) as {
      root: string; next_index: number; tx_hash: string; block: number;
    }[];
  }
  stats(sinceBlock: number) {
    return this.db
      .prepare("SELECT token, kind, COUNT(*) AS n, SUM(CAST(amount AS INTEGER)) AS total FROM flows WHERE block >= ? AND kind IN ('shield','unshield','donate') GROUP BY token, kind")
      .all(sinceBlock) as { token: string; kind: string; n: number; total: number }[];
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

  // ---- launchpad

  insertLaunch(l: {
    token: string; creator: string; name: string; symbol: string; uri: string; decimals: number; virtualBnb: string; virtualToken: string; curveSupply: string;
    totalSupply: string; graduationWei: string; txHash: string; block: number; blockTime: number | null;
  }) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO launches(token, creator, name, symbol, uri, decimals, virtual_bnb, virtual_token0, curve_supply, total_supply, graduation_wei,
           real_token, virtual_token, tx_hash, block, block_time, last_block) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(l.token, l.creator, l.name, l.symbol, l.uri, l.decimals, l.virtualBnb, l.virtualToken, l.curveSupply, l.totalSupply, l.graduationWei, l.curveSupply, l.virtualToken, l.txHash, l.block, l.blockTime, l.block);
  }
  /** A buy or sell: records the trade and, if it is newer than what we have, the curve state it left behind. */
  insertTrade(t: { txHash: string; logIndex: number; token: string; side: "buy" | "sell"; bnb: string; fee: string; tokens: string; realBnb: string; realToken: string; virtualToken: string; block: number; blockTime: number | null }) {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO trades(tx_hash, log_index, token, side, bnb, fee, tokens, block, block_time) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(t.txHash, t.logIndex, t.token, t.side, t.bnb, t.fee, t.tokens, t.block, t.blockTime);
    if (r.changes === 0) return;
    this.db
      .prepare(
        `UPDATE launches SET buys = buys + ?, sells = sells + ?, bnb_volume = CAST(CAST(bnb_volume AS INTEGER) + CAST(? AS INTEGER) AS TEXT),
           real_bnb = CASE WHEN ? >= last_block THEN ? ELSE real_bnb END,
           real_token = CASE WHEN ? >= last_block THEN ? ELSE real_token END,
           virtual_token = CASE WHEN ? >= last_block THEN ? ELSE virtual_token END,
           last_block = MAX(last_block, ?) WHERE token = ?`
      )
      .run(t.side === "buy" ? 1 : 0, t.side === "sell" ? 1 : 0, t.bnb, t.block, t.realBnb, t.block, t.realToken, t.block, t.virtualToken, t.block, t.token);
  }
  insertHarvest(txHash: string, logIndex: number, token: string, amount: string, block: number, blockTime: number | null) {
    const r = this.db.prepare("INSERT OR IGNORE INTO flows(tx_hash, log_index, kind, token, amount, block, block_time) VALUES(?,?,?,?,?,?,?)").run(txHash, logIndex, "harvest", token, amount, block, blockTime);
    if (r.changes === 0) return;
    this.db.prepare("UPDATE launches SET fees_to_treasury = CAST(CAST(fees_to_treasury AS INTEGER) + CAST(? AS INTEGER) AS TEXT) WHERE token = ?").run(amount, token);
  }
  markGraduated(token: string, realBnb: string, realToken: string) {
    this.db.prepare("UPDATE launches SET graduated = 1, real_bnb = ?, real_token = ? WHERE token = ?").run(realBnb, realToken, token);
  }
  /** The curve moved to a PancakeSwap pair: it holds nothing any more, the pair holds `bnbIn` wei and `tokensIn` base units. */
  markMigrated(token: string, pair: string, bnbIn: string, tokensIn: string) {
    this.db
      .prepare("UPDATE launches SET graduated = 1, amm_pair = ?, amm_bnb = ?, amm_tokens = ?, real_bnb = '0', real_token = '0' WHERE token = ?")
      .run(pair, bnbIn, tokensIn, token);
  }
  insertFeeEvent(e: { txHash: string; logIndex: number; token: string; kind: "vote" | "roll"; agent: number | null; feeBps: number; block: number; blockTime: number | null; epoch?: number }) {
    this.db
      .prepare("INSERT OR IGNORE INTO fee_events(tx_hash, log_index, token, kind, agent, fee_bps, epoch, block, block_time) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(e.txHash, e.logIndex, e.token, e.kind, e.agent, e.feeBps, e.epoch ?? null, e.block, e.blockTime);
  }
  feeEvents(token: string, limit: number) {
    return this.db.prepare("SELECT * FROM fee_events WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT ?").all(token, limit) as Record<string, unknown>[];
  }
  launches(limit: number, offset: number) {
    return this.db.prepare("SELECT * FROM launches ORDER BY block DESC LIMIT ? OFFSET ?").all(limit, offset) as Record<string, unknown>[];
  }
  launch(token: string) {
    return this.db.prepare("SELECT * FROM launches WHERE token = ?").get(token) as Record<string, unknown> | undefined;
  }
  trades(token: string, limit: number, beforeBlock?: number) {
    return this.db
      .prepare("SELECT tx_hash, side, bnb, fee, tokens, block, block_time FROM trades WHERE token = ? AND block < ? ORDER BY block DESC, log_index DESC LIMIT ?")
      .all(token, beforeBlock ?? Number.MAX_SAFE_INTEGER, limit) as { tx_hash: string; side: string; bnb: string; fee: string; tokens: string; block: number; block_time: number | null }[];
  }
}
