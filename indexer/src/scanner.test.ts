// The scanner must advance block range by block range, commit a range only
// when all of its logs are written, survive a failing endpoint by falling
// back, and ingest every pool/launchpad event idempotently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, getAbiItem, toHex, type Log, type Hex } from "viem";
import { ShieldedPoolAbi, LaunchpadAbi } from "@bunker/sdk";
import { Db } from "./db.js";
import { Scanner, DEGRADED_AFTER_MS, hex32, type ChainReader } from "./scanner.js";
import { contiguousPrefix } from "./paging.js";

const POOL = "0x1000000000000000000000000000000000000001" as const;
const LAUNCHPAD = "0x2000000000000000000000000000000000000002" as const;
const TOKEN = "0x3000000000000000000000000000000000000003" as const;
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const CLAIM = "0x4000000000000000000000000000000000000004" as const;

/** Build a raw log for `eventName` the way a node would return it. */
function log(address: `0x${string}`, abi: typeof ShieldedPoolAbi | typeof LaunchpadAbi, eventName: string, args: Record<string, unknown>, block: number, txHash: string, logIndex = 0): Log {
  const item = getAbiItem({ abi, name: eventName as never }) as { inputs: { name: string; type: string; indexed?: boolean }[] };
  const topics = encodeEventTopics({ abi, eventName: eventName as never, args: args as never } as never);
  const data = encodeAbiParameters(item.inputs.filter((i) => !i.indexed) as never, item.inputs.filter((i) => !i.indexed).map((i) => args[i.name]) as never);
  return { address, topics, data, blockNumber: BigInt(block), transactionHash: txHash as Hex, logIndex, blockHash: toHex(block, { size: 32 }), transactionIndex: 0, removed: false } as unknown as Log;
}
/** A v2 transact: three leaves, no root (roots come from Drain events). */
const transact = (first: number, block: number, tx: string, token: `0x${string}` = NATIVE) =>
  log(POOL, ShieldedPoolAbi, "Transact", { token, firstIndex: first, commitments: [BigInt(first + 1), BigInt(first + 2), BigInt(first + 3)], ciphertext0: "0xa0", ciphertext1: "0xa1", ciphertext2: "0xa2", outCiphertext: "0xb0" }, block, tx);
const drain = (from: number, count: number, block: number, tx: string, logIndex = 1) =>
  log(POOL, ShieldedPoolAbi, "Drain", { fromIndex: from, count, newRoot: BigInt(from + count + 1000), rootIndex: 1 }, block, tx, logIndex);

/** Fake RPC: a fixed log set, a head, and a set of block ranges on which getLogs throws. */
function fakeReader(logs: Log[], head: number, failing: Set<string> = new Set(), opts: { down?: boolean } = {}) {
  const calls = { getLogs: 0, getBlock: 0 };
  const reader: ChainReader = {
    async getBlockNumber() { if (opts.down) throw new Error("503 Service Unavailable"); return BigInt(head); },
    async getLogs({ fromBlock, toBlock }) {
      calls.getLogs++;
      if (opts.down) throw new Error("503 Service Unavailable");
      if (failing.has(`${fromBlock}-${toBlock}`)) throw new Error("-32005 limit exceeded");
      return logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
    },
    async getBlock({ blockNumber }) { calls.getBlock++; return { timestamp: 1_700_000_000n + blockNumber }; },
  };
  return { reader, calls };
}
const opts = { pool: POOL, launchpad: LAUNCHPAD, startBlock: 100, chunk: 2, confirmations: 1, launchDecimals: 6 };

test("scans from startBlock to head − confirmations in chunks, commits each range, and resumes from last_block", async () => {
  const db = new Db(":memory:");
  const logs = [transact(0, 101, "0xs1"), transact(3, 102, "0xs2"), drain(0, 6, 103, "0xd1"), transact(6, 105, "0xs3"), transact(9, 106, "0xs4"), drain(6, 6, 106, "0xd2")];
  const { reader, calls } = fakeReader(logs, 106);
  const scanner = new Scanner(reader, db, opts);
  await scanner.tick();
  assert.equal(scanner.lastBlock(), 105, "head 106 − 1 confirmation");
  assert.equal(calls.getLogs, 3, "100-101, 102-103, 104-105");
  assert.equal(db.count(), 9, "leaves 0-8; block 106 is not final yet");
  assert.deepEqual(contiguousPrefix(db.commitments(0, 100), 0).map((r) => r.idx), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(db.commitments(0, 1)[0].block_time, 1_700_000_101);
  assert.equal(db.commitments(0, 1)[0].kind, "note");
  assert.equal(db.insertedIndex(), 6, "the first drain folded leaves 0-5");
  // restart on the same database: picks up where it left off
  const { reader: r2, calls: c2 } = fakeReader(logs, 107);
  const second = new Scanner(r2, db, opts);
  await second.tick();
  assert.equal(c2.getLogs, 1, "only 106-106");
  assert.equal(db.count(), 12);
  assert.equal(db.insertedIndex(), 12);
  await second.tick();
  assert.equal(db.count(), 12, "replay is idempotent");
  assert.ok(db.db.prepare("SELECT 1 FROM out_ciphertexts WHERE tx_hash = '0xs2'").get());
  assert.equal((db.db.prepare("SELECT COUNT(*) AS n FROM roots").get() as { n: number }).n, 2, "one root per drain");
  assert.equal(db.latestRoots(1)[0].next_index, 12);
});

test("open notes and the registry are indexed", async () => {
  const db = new Db(":memory:");
  const scanner = new Scanner(fakeReader([], 0).reader, db, opts);
  await scanner.ingest([
    transact(0, 101, "0xs1"),
    log(POOL, ShieldedPoolAbi, "OpenNote", { token: TOKEN, index: 3, commitment: 99n, shares: 12345n, ownerHash: 777n, ciphertext: "0xcc" }, 101, "0xs1", 1),
    log(POOL, ShieldedPoolAbi, "Registered", { owner: CLAIM, shieldedAddress: "0x" + "ab".repeat(43) }, 102, "0xr1"),
  ]);
  const rows = contiguousPrefix(db.commitments(0, 10), 0);
  assert.equal(rows.length, 4);
  assert.equal(rows[3].kind, "open");
  assert.equal(rows[3].shares, "12345");
  assert.equal(rows[3].owner_hash, hex32(777n));
  assert.equal(rows[3].token, TOKEN);
  assert.equal(db.registry(CLAIM)?.shielded_address, "ab".repeat(43));
  // a later clear wins; an older event does not overwrite it
  await scanner.ingest([log(POOL, ShieldedPoolAbi, "Registered", { owner: CLAIM, shieldedAddress: "0x" }, 105, "0xr2")]);
  assert.equal(db.registry(CLAIM)?.shielded_address, null);
  await scanner.ingest([log(POOL, ShieldedPoolAbi, "Registered", { owner: CLAIM, shieldedAddress: "0x" + "cd".repeat(43) }, 103, "0xr3")]);
  assert.equal(db.registry(CLAIM)?.shielded_address, null);
});

test("a failing range stops the scan at the last committed block and is retried next tick; nothing is skipped", async () => {
  const db = new Db(":memory:");
  const logs = [transact(0, 101, "0xs1"), transact(3, 103, "0xs2"), transact(6, 105, "0xs3")];
  const failing = new Set(["102-103"]);
  const { reader } = fakeReader(logs, 106, failing);
  const scanner = new Scanner(reader, db, opts);
  await assert.rejects(scanner.tick(), /limit exceeded/);
  assert.equal(scanner.lastBlock(), 101, "the committed position is before the failed range");
  assert.equal(db.count(), 3);
  assert.equal(scanner.degraded(), false);
  assert.equal(scanner.degraded(Date.now() + DEGRADED_AFTER_MS + 1), true, "stuck long enough flips the health flag");
  failing.clear();
  await scanner.tick();
  assert.equal(db.count(), 9);
  assert.deepEqual(contiguousPrefix(db.commitments(0, 100), 0).map((r) => r.idx), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(scanner.degraded(Date.now() + DEGRADED_AFTER_MS + 1), false, "a successful tick clears it");
});

test("a fallback endpoint supplies the range the primary cannot, in the same tick", async () => {
  const db = new Db(":memory:");
  const logs = [transact(0, 101, "0xs1"), transact(3, 103, "0xs2")];
  const primary = fakeReader(logs, 104, new Set(["102-103"]));
  const fallback = fakeReader(logs, 104);
  const scanner = new Scanner([primary.reader, fallback.reader], db, opts);
  await scanner.tick();
  assert.equal(db.count(), 6);
  assert.equal(fallback.calls.getLogs, 1, "the fallback is only asked for the range the primary failed");
  assert.deepEqual(scanner.recoveredVia, [0, 1]);
});

test("an endpoint that is completely down is skipped: head and logs come from the fallback", async () => {
  const db = new Db(":memory:");
  const logs = [transact(0, 101, "0xs1")];
  const down = fakeReader([], 0, new Set(), { down: true });
  const fallback = fakeReader(logs, 102);
  const scanner = new Scanner([down.reader, fallback.reader], db, opts);
  await scanner.tick();
  assert.equal(db.count(), 3);
  assert.equal(scanner.lastBlock(), 101);
});

test("contiguousPrefix stops at the first hole and respects `from`", () => {
  const rows = [{ idx: 5 }, { idx: 6 }, { idx: 8 }, { idx: 9 }];
  assert.deepEqual(contiguousPrefix(rows, 5).map((r) => r.idx), [5, 6]);
  assert.deepEqual(contiguousPrefix(rows, 4), []);
  assert.deepEqual(contiguousPrefix([], 0), []);
});

test("pool events: nullifiers and flows are recorded per token; field elements are 32-byte hex", async () => {
  const db = new Db(":memory:");
  const scanner = new Scanner(fakeReader([], 0).reader, db, opts);
  await scanner.ingest([
    log(POOL, ShieldedPoolAbi, "Nullified", { nullifier: 7n }, 101, "0xn1"),
    log(POOL, ShieldedPoolAbi, "Shield", { token: NATIVE, amount: 1_000_000_000n }, 101, "0xn1", 1),
    log(POOL, ShieldedPoolAbi, "Unshield", { token: TOKEN, amount: 5n }, 102, "0xn2", 0),
    log(POOL, ShieldedPoolAbi, "Donate", { token: NATIVE, amount: 3n }, 102, "0xn2", 1),
  ]);
  assert.equal(db.hasNullifier(hex32(7n)), true);
  assert.equal(hex32(7n).length, 64);
  const s = db.stats(0);
  assert.deepEqual(s.map((r) => [r.token, r.kind, r.n, r.total]).sort(), [[NATIVE, "donate", 1, 3], [NATIVE, "shield", 1, 1_000_000_000], [TOKEN, "unshield", 1, 5]].sort());
});

test("launchpad events: a launch row is created and every trade/harvest/graduate/migrate updates it; replays are idempotent", async () => {
  const db = new Db(":memory:");
  const scanner = new Scanner(fakeReader([], 0).reader, db, opts);
  const launch = log(LAUNCHPAD, LaunchpadAbi, "Launch", { token: TOKEN, creator: CLAIM, name: "Bunker Test", symbol: "BKT", uri: "https://x/y.json", virtualBnb: 2n * 10n ** 18n, virtualToken: 1_073_000_000_000_000n, curveSupply: 793_100_000_000_000n, totalSupply: 10n ** 15n, graduationWei: 6n * 10n ** 18n }, 10, "0xL");
  const buy = log(LAUNCHPAD, LaunchpadAbi, "CurveBuy", { token: TOKEN, bnbIn: 10n ** 18n, fee: 10n ** 16n, tokensOut: 60_000_000_000_000n, realBnb: 10n ** 18n, realToken: 733_100_000_000_000n, virtualToken: 1_013_000_000_000_000n }, 11, "0xB");
  const harvest = log(LAUNCHPAD, LaunchpadAbi, "Harvest", { token: TOKEN, amount: 10n ** 16n }, 12, "0xH");
  const sell = log(LAUNCHPAD, LaunchpadAbi, "CurveSell", { token: TOKEN, bnbOut: 5n * 10n ** 17n, fee: 5n * 10n ** 15n, tokensIn: 30_000_000_000_000n, realBnb: 5n * 10n ** 17n, realToken: 763_100_000_000_000n, virtualToken: 1_043_000_000_000_000n }, 13, "0xS");
  const grad = log(LAUNCHPAD, LaunchpadAbi, "Graduate", { token: TOKEN, realBnb: 6n * 10n ** 18n, realToken: 0n }, 14, "0xG");
  await scanner.ingest([launch, buy, harvest, sell, buy]); // buy replayed: no double counting
  let l = db.launch(TOKEN)!;
  assert.equal(l.symbol, "BKT");
  assert.equal(l.creator, CLAIM);
  assert.equal(l.decimals, 6);
  assert.equal(l.buys, 1);
  assert.equal(l.sells, 1);
  assert.equal(l.bnb_volume, String(10n ** 18n + 5n * 10n ** 17n));
  assert.equal(l.real_bnb, String(5n * 10n ** 17n), "state follows the newest trade");
  assert.equal(l.fees_to_treasury, String(10n ** 16n));
  assert.equal(l.graduated, 0);
  await scanner.ingest([grad]);
  l = db.launch(TOKEN)!;
  assert.equal(l.graduated, 1);
  assert.equal(l.real_token, "0");
  assert.equal(l.amm_pair, null);
  const pair = "0x5000000000000000000000000000000000000005";
  await scanner.ingest([log(LAUNCHPAD, LaunchpadAbi, "Migrate", { token: TOKEN, pair, bnbIn: 6n * 10n ** 18n, tokensIn: 206_900_000_000_000n, liquidity: 2_021_000_000_000n }, 15, "0xM")]);
  l = db.launch(TOKEN)!;
  assert.equal(l.amm_pair, pair);
  assert.equal(l.amm_bnb, String(6n * 10n ** 18n));
  assert.equal(l.amm_tokens, "206900000000000");
  assert.equal(l.real_bnb, "0");
  const trades = db.trades(TOKEN, 10);
  assert.deepEqual(trades.map((t) => t.side), ["sell", "buy"]);
  assert.equal(db.launches(10, 0).length, 1);
});

test("fee policy events: agent votes and epoch rolls are recorded per token and replays are idempotent", async () => {
  const db = new Db(":memory:");
  const scanner = new Scanner(fakeReader([], 0).reader, db, opts);
  const vote = (agent: number, fee: number, block: number, tx: string, idx = 0) => log(LAUNCHPAD, LaunchpadAbi, "FeeVote", { token: TOKEN, agent, feeBps: fee, blockNumber: BigInt(block) }, block, tx, idx);
  const roll = log(LAUNCHPAD, LaunchpadAbi, "FeeRoll", { token: TOKEN, feeBps: 200, epoch: 3n }, 2700, "0xR", 0);
  await scanner.ingest([vote(0, 100, 100, "0xV0"), vote(1, 300, 101, "0xV1"), vote(1, 300, 101, "0xV1"), roll, vote(3, 0, 2700, "0xR", 1)]);
  const ev = db.feeEvents(TOKEN, 10);
  assert.deepEqual(ev.map((e) => [e.kind, e.agent, e.fee_bps, e.epoch]), [["vote", 3, 0, null], ["roll", null, 200, 3], ["vote", 1, 300, null], ["vote", 0, 100, null]]);
});
