// The scanner must survive transactions the RPC refuses to decode (a `v1`
// transaction on an RPC that caps at v0, a transient decode error) without
// stalling and without losing the leaves those transactions carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import { Db } from "./db.js";
import { Scanner, DEGRADED_AFTER_MS } from "./scanner.js";
import { contiguousPrefix } from "./paging.js";

const PROGRAM = new PublicKey("89TrDDtwYTkrvxGmfYnSz6EbA1muGStuPBFUt3Dvd8WR");
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const bytes32 = (fill: number) => new Uint8Array(32).fill(fill);

/** A parsed transaction whose only content is one `transact` event starting at leaf `first`. */
function transactTx(first: number, slot: number) {
  const idx = new Uint8Array(8);
  new DataView(idx.buffer).setBigUint64(0, BigInt(first), true);
  const parts = [
    new TextEncoder().encode("transact"), idx, bytes32(first + 1), bytes32(first + 2), bytes32(0xa0), bytes32(0xa1), bytes32(0xb0), bytes32(first + 9),
  ];
  return {
    slot,
    blockTime: 1_700_000_000 + slot,
    meta: { err: null, logMessages: [`Program data: ${parts.map(b64).join(" ")}`] },
    transaction: { message: { instructions: [] } },
  };
}

/**
 * Fake RPC. `history` is newest-first like getSignaturesForAddress. Signatures
 * in `undecodable` make the batch call throw and the single call throw, the
 * way an RPC capped at v0 answers for a v1 transaction (-32015), until the set
 * is cleared.
 */
function fakeConnection(history: { sig: string; tx: ReturnType<typeof transactTx> }[], undecodable: Set<string>, missing: Set<string> = new Set()) {
  // `missing`: the RPC answers null for these (it has the signature in history but no transaction data yet).
  const lookup = (sig: string) => (missing.has(sig) ? null : history.find((h) => h.sig === sig)?.tx ?? null);
  const calls = { batch: 0, single: 0 };
  const conn = {
    async getSignaturesForAddress(_p: PublicKey, o: { before?: string; limit: number }) {
      let list = history.map((h) => ({ signature: h.sig }));
      if (o.before) list = list.slice(list.findIndex((s) => s.signature === o.before) + 1);
      return list.slice(0, o.limit);
    },
    async getParsedTransactions(sigs: string[], o: { maxSupportedTransactionVersion: number }) {
      calls.batch++;
      assert.equal(o.maxSupportedTransactionVersion, 1, "scanner must opt in to every transaction version");
      if (sigs.some((s) => undecodable.has(s))) throw new Error("-32015 Transaction version (1) is not supported by the requesting client");
      return sigs.map((s) => lookup(s));
    },
    async getParsedTransaction(sig: string) {
      calls.single++;
      if (undecodable.has(sig)) throw new Error("-32015 Transaction version (1) is not supported by the requesting client");
      return lookup(sig);
    },
  };
  return { conn: conn as unknown as Connection, calls };
}

test("an undecodable transaction defers its leaves instead of stalling the scan, and they land once it decodes", async () => {
  const db = new Db(":memory:");
  // Oldest -> newest: s1 (leaves 0,1), s2 = v1 tx (leaves 2,3), s3 (leaves 4,5)
  const history = [
    { sig: "s3", tx: transactTx(4, 103) },
    { sig: "s2", tx: transactTx(2, 102) },
    { sig: "s1", tx: transactTx(0, 101) },
  ];
  const undecodable = new Set(["s2"]);
  const { conn, calls } = fakeConnection(history, undecodable);
  const scanner = new Scanner(conn, db, PROGRAM, 0);

  await scanner.tick();
  // The scan position moved past the bad transaction...
  assert.equal(db.getMeta("last_signature"), "s3");
  assert.deepEqual(scanner.skipped(), ["s2"]);
  assert.equal(calls.batch, 1);
  assert.equal(calls.single, 3, "batch failure falls back to one call per signature");
  // ...its neighbours were indexed...
  assert.equal(db.count(), 4);
  // ...and a wallet paging from 0 is only shown the contiguous prefix [0,1], never [4,5] across the hole.
  const page = contiguousPrefix(db.commitments(0, 100), 0);
  assert.deepEqual(page.map((r) => r.idx), [0, 1]);
  assert.deepEqual(contiguousPrefix(db.commitments(2, 100), 2), []);

  // Still undecodable on the next tick: nothing new, still deferred, no leaf lost.
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), ["s2"]);
  assert.equal(db.count(), 4);

  // The RPC learns v1 (upgrade / maxSupportedTransactionVersion honoured): the deferred tx lands on the next tick.
  undecodable.clear();
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), []);
  assert.equal(db.count(), 6);
  assert.deepEqual(contiguousPrefix(db.commitments(0, 100), 0).map((r) => r.idx), [0, 1, 2, 3, 4, 5]);
  // Roots and out-ciphertexts for the deferred transaction are present too.
  assert.ok(db.db.prepare("SELECT 1 FROM out_ciphertexts WHERE signature = 's2'").get());
  assert.ok(db.db.prepare("SELECT 1 FROM roots WHERE signature = 's2'").get());

  // A later transaction after recovery is ingested normally with one batch call.
  history.unshift({ sig: "s4", tx: transactTx(6, 104) });
  const before = calls.batch;
  await scanner.tick();
  assert.equal(calls.batch, before + 1);
  assert.equal(db.count(), 8);
  assert.equal(db.getMeta("last_signature"), "s4");
});

test("a confirmed signature whose transaction the RPC returns as null is deferred, not dropped, and lands exactly once", async () => {
  const db = new Db(":memory:");
  const history = [
    { sig: "s3", tx: transactTx(4, 103) },
    { sig: "s2", tx: transactTx(2, 102) },
    { sig: "s1", tx: transactTx(0, 101) },
  ];
  const missing = new Set(["s2"]);
  const { conn, calls } = fakeConnection(history, new Set(), missing);
  const scanner = new Scanner(conn, db, PROGRAM, 0);

  // Batch succeeds (no throw) but carries a null in the middle.
  await scanner.tick();
  assert.equal(calls.batch, 1);
  assert.equal(db.getMeta("last_signature"), "s3");
  assert.equal(db.count(), 4);
  assert.deepEqual(scanner.skipped(), ["s2"], "null must enter the retry queue");
  assert.equal(scanner.deferred()[0].lastReason, "rpc returned null");
  assert.deepEqual(contiguousPrefix(db.commitments(0, 100), 0).map((r) => r.idx), [0, 1]);

  // Still null on retry: stays queued, attempts counted, nothing dropped.
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), ["s2"]);
  assert.equal(scanner.deferred()[0].attempts, 2);
  assert.equal(scanner.degraded(), false);
  assert.equal(scanner.degraded(Date.now() + 11 * 60 * 1000), true, "an old deferral flips the health flag");

  // RPC catches up: leaves 2,3 are written once; a further tick does not duplicate anything.
  missing.clear();
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), []);
  assert.equal(db.count(), 6);
  assert.deepEqual(contiguousPrefix(db.commitments(0, 100), 0).map((r) => r.idx), [0, 1, 2, 3, 4, 5]);
  await scanner.tick();
  assert.equal(db.count(), 6);
  assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM roots WHERE signature = 's2'").get() as { n: number }).n, 1);
});

test("a deferred signature that comes back null on retry is kept, not evicted", async () => {
  const db = new Db(":memory:");
  const history = [{ sig: "s2", tx: transactTx(2, 102) }, { sig: "s1", tx: transactTx(0, 101) }];
  const undecodable = new Set(["s2"]);
  const missing = new Set<string>();
  const { conn } = fakeConnection(history, undecodable, missing);
  const scanner = new Scanner(conn, db, PROGRAM, 0);
  await scanner.tick(); // s2 deferred because the RPC threw
  assert.deepEqual(scanner.skipped(), ["s2"]);
  // Now the RPC stops throwing but answers null instead
  undecodable.clear();
  missing.add("s2");
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), ["s2"], "null on retry must not evict the signature");
  missing.clear();
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), []);
  assert.equal(db.count(), 4);
});

test("deferred signatures survive a restart: a new Scanner on the same database resumes the retries", async () => {
  const db = new Db(":memory:");
  const history = [{ sig: "s2", tx: transactTx(2, 102) }, { sig: "s1", tx: transactTx(0, 101) }];
  const missing = new Set(["s2"]);
  const { conn } = fakeConnection(history, new Set(), missing);
  const first = new Scanner(conn, db, PROGRAM, 0);
  await first.tick();
  assert.deepEqual(first.skipped(), ["s2"]);
  first.stop();

  // "Restart": fresh Scanner instance, same SQLite file (meta table persisted the queue).
  const second = new Scanner(conn, db, PROGRAM, 0);
  assert.deepEqual(second.skipped(), ["s2"], "queue is read back from the database, not from memory");
  assert.equal(second.db.getMeta("last_signature"), "s2");
  missing.clear();
  await second.tick();
  assert.deepEqual(second.skipped(), []);
  assert.equal(db.count(), 4);
});

test("a transaction that never becomes readable raises the degraded flag and stays listed, instead of being forgotten", async () => {
  const db = new Db(":memory:");
  const history = [{ sig: "s1", tx: transactTx(0, 101) }];
  const missing = new Set(["s1"]);
  const { conn } = fakeConnection(history, new Set(), missing);
  const scanner = new Scanner(conn, db, PROGRAM, 0);
  for (let i = 0; i < 5; i++) await scanner.tick();
  const [d] = scanner.deferred();
  assert.equal(d.signature, "s1");
  assert.ok(d.attempts >= 5, `attempts counted (${d.attempts})`);
  assert.equal(d.lastReason, "rpc returned null");
  // Not degraded yet (fresh), degraded once older than the threshold — this is what /health turns into a 503.
  assert.equal(scanner.degraded(d.since + 60_000), false);
  assert.equal(scanner.degraded(d.since + DEGRADED_AFTER_MS + 1), true);
  // Still queued: the operator can fix the RPC and the leaves will land.
  missing.clear();
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), []);
  assert.equal(db.count(), 2);
});

test("a fallback endpoint supplies what the primary returns as null, in the same tick, without a deferral", async () => {
  const db = new Db(":memory:");
  const history = [
    { sig: "s3", tx: transactTx(4, 103) },
    { sig: "s2", tx: transactTx(2, 102) },
    { sig: "s1", tx: transactTx(0, 101) },
  ];
  const primary = fakeConnection(history, new Set(), new Set(["s2"]));
  const fallback = fakeConnection(history, new Set());
  const scanner = new Scanner([primary.conn, fallback.conn], db, PROGRAM, 0);

  await scanner.tick();
  assert.deepEqual(scanner.skipped(), [], "nothing to defer: the fallback had it");
  assert.equal(db.count(), 6);
  assert.equal(primary.calls.batch, 1, "the batch still goes to the primary");
  assert.equal(fallback.calls.batch, 0, "the fallback is only asked per signature");
  assert.equal(fallback.calls.single, 1, "and only for the signature the primary could not return");
  assert.deepEqual(scanner.recoveredVia, [0, 1]);
  assert.deepEqual(contiguousPrefix(db.commitments(0, 100), 0).map((r) => r.idx), [0, 1, 2, 3, 4, 5]);
});

test("an endpoint that throws on every call is skipped: history comes from the fallback, and the deferred queue drains through it", async () => {
  const db = new Db(":memory:");
  const history = [{ sig: "s2", tx: transactTx(2, 102) }, { sig: "s1", tx: transactTx(0, 101) }];
  const down = {
    getSignaturesForAddress: async () => { throw new Error("503 Service Unavailable"); },
    getParsedTransactions: async () => { throw new Error("503 Service Unavailable"); },
    getParsedTransaction: async () => { throw new Error("503 Service Unavailable"); },
  } as unknown as Connection;
  const fallbackMissing = new Set(["s2"]);
  const fallback = fakeConnection(history, new Set(), fallbackMissing);
  const scanner = new Scanner([down, fallback.conn], db, PROGRAM, 0);

  await scanner.tick();
  // The primary never answered; the scan still advanced using the fallback's history.
  assert.equal(db.getMeta("last_signature"), "s2");
  assert.equal(db.count(), 2);
  // s2 is null on the only working endpoint: deferred with the *null* reason, not the primary's error.
  assert.deepEqual(scanner.skipped(), ["s2"]);
  assert.equal(scanner.deferred()[0].lastReason, "rpc returned null");

  fallbackMissing.clear();
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), []);
  assert.equal(db.count(), 4);
  assert.equal(scanner.recoveredVia[1], 2, "both s1 and s2 were supplied by the fallback");
});

test("with every endpoint failing, a deferred signature is kept and the reason is the last error", async () => {
  const db = new Db(":memory:");
  const history = [{ sig: "s1", tx: transactTx(0, 101) }];
  const a = fakeConnection(history, new Set(["s1"]));
  const b = fakeConnection(history, new Set(["s1"]));
  const scanner = new Scanner([a.conn, b.conn], db, PROGRAM, 0);
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), ["s1"]);
  await scanner.tick();
  assert.deepEqual(scanner.skipped(), ["s1"]);
  assert.match(scanner.deferred()[0].lastReason, /-32015/);
  assert.equal(scanner.deferred()[0].attempts, 2);
});

test("contiguousPrefix stops at the first hole and respects `from`", () => {
  const rows = [{ idx: 5 }, { idx: 6 }, { idx: 8 }, { idx: 9 }];
  assert.deepEqual(contiguousPrefix(rows, 5).map((r) => r.idx), [5, 6]);
  assert.deepEqual(contiguousPrefix(rows, 4), []);
  assert.deepEqual(contiguousPrefix([], 0), []);
});

test("launchpad events: a launch row is created and every trade/harvest/graduate updates it; replays are idempotent", () => {
  const db = new Db(":memory:");
  const scanner = new Scanner([fakeConnection([], new Set()).conn], db, PROGRAM, 0);
  const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
  const te = new TextEncoder();
  const mint = bytes32(7);
  const mintB58 = new PublicKey(mint).toBase58();
  const line = (parts: Uint8Array[]) => `Program data: ${parts.map(b64).join(" ")}`;
  const tx = (slot: number, logs: string[]) => ({ slot, blockTime: 1_700_000_000 + slot, meta: { err: null, logMessages: logs }, transaction: { message: { instructions: [] } } });
  const launch = line([te.encode("launch"), mint, te.encode("Shielded Test"), te.encode("SHT"), te.encode("https://x/y.json"), u64(30n * 10n ** 9n), u64(1_073_000_000_000_000n), u64(793_100_000_000_000n), u64(10n ** 15n), u64(85n * 10n ** 9n), new Uint8Array([6])]);
  const buy = line([te.encode("curve_buy"), mint, u64(1_980_000_000n), u64(20_000_000n), u64(60_000_000_000_000n), u64(1_980_000_000n), u64(733_100_000_000_000n), u64(1_013_000_000_000_000n), new Uint8Array([1])]);
  const harvest = line([te.encode("harvest"), mint, u64(10_000_000n), u64(10_000_000n), u64(300_000_000_000n)]);
  const sell = line([te.encode("curve_sell"), mint, u64(900_000_000n), u64(9_000_000n), u64(30_000_000_000_000n), u64(1_080_000_000n), u64(763_100_000_000_000n), u64(1_043_000_000_000_000n), new Uint8Array([1])]);
  const grad = line([te.encode("graduate"), mint, u64(85_000_000_000n), u64(0n)]);

  scanner.ingest("L", tx(10, [launch]) as never);
  scanner.ingest("B", tx(11, [buy]) as never);
  scanner.ingest("H", tx(12, [harvest]) as never);
  scanner.ingest("S", tx(13, [sell]) as never);
  scanner.ingest("B", tx(11, [buy]) as never); // replay: no double counting
  let l = db.launch(mintB58)!;
  assert.equal(l.symbol, "SHT");
  assert.equal(l.decimals, 6);
  assert.equal(l.buys, 1);
  assert.equal(l.sells, 1);
  assert.equal(l.sol_volume, String(1_980_000_000n + 900_000_000n));
  assert.equal(l.real_sol, "1080000000", "state follows the newest trade");
  assert.equal(l.fees_to_treasury, "10000000");
  assert.equal(l.tokens_donated, "300000000000");
  assert.equal(l.graduated, 0);
  scanner.ingest("G", tx(14, [grad]) as never);
  l = db.launch(mintB58)!;
  assert.equal(l.graduated, 1);
  assert.equal(l.real_token, "0");
  assert.equal(l.amm_pool, null);
  const pool = bytes32(8);
  const migrate = line([te.encode("migrate"), mint, pool, u64(19_750_000_000n), u64(206_900_000_000_000n), u64(2_021_000_000_000n)]);
  scanner.ingest("M", tx(15, [migrate]) as never);
  l = db.launch(mintB58)!;
  assert.equal(l.amm_pool, new PublicKey(pool).toBase58());
  assert.equal(l.amm_sol, "19750000000");
  assert.equal(l.amm_tokens, "206900000000000");
  assert.equal(l.real_sol, "0");
  const trades = db.trades(mintB58, 10);
  assert.deepEqual(trades.map((t) => t.side), ["sell", "buy"]);
  assert.equal(trades[0].private, 1);
  assert.equal(db.launches(10, 0).length, 1);
});
test("fee policy events: agent votes and epoch rolls are recorded per token and replays are idempotent", () => {
  const db = new Db(":memory:");
  const scanner = new Scanner([fakeConnection([], new Set()).conn], db, PROGRAM, 0, new PublicKey(bytes32(9)));
  const u64 = (n: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, n, true); return b; };
  const u16 = (n: number) => new Uint8Array([n & 0xff, n >> 8]);
  const te = new TextEncoder();
  const mint = bytes32(7);
  const mintB58 = new PublicKey(mint).toBase58();
  const line = (parts: Uint8Array[]) => `Program data: ${parts.map(b64).join(" ")}`;
  const tx = (slot: number, logs: string[]) => ({ slot, blockTime: 1_700_000_000 + slot, meta: { err: null, logMessages: logs }, transaction: { message: { instructions: [] } } });
  const vote = (agent: number, fee: number, holder: number, slot: bigint) => line([te.encode("fee_vote"), mint, new Uint8Array([agent]), u16(fee), u16(holder), u64(slot)]);
  const roll = line([te.encode("fee_roll"), mint, u16(200), u16(6000), u64(3n)]);
  scanner.ingest("V0", tx(100, [vote(0, 150, 6000, 100n)]) as never);
  scanner.ingest("V1", tx(101, [vote(1, 300, 10000, 101n)]) as never);
  scanner.ingest("V1", tx(101, [vote(1, 300, 10000, 101n)]) as never); // replay
  scanner.ingest("R", tx(2700, [roll, vote(3, 50, 5000, 2700n)]) as never); // a vote that rolled the epoch first logs both
  const ev = db.feeEvents(mintB58, 10);
  assert.deepEqual(ev.map((e) => [e.kind, e.agent, e.fee_bps, e.holder_bps, e.epoch]), [["roll", null, 200, 6000, 3], ["vote", 3, 50, 5000, null], ["vote", 1, 300, 10000, null], ["vote", 0, 150, 6000, null]]);
});
