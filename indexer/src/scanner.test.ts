// The scanner must survive transactions the RPC refuses to decode (a `v1`
// transaction on an RPC that caps at v0, a transient decode error) without
// stalling and without losing the leaves those transactions carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, PublicKey } from "@solana/web3.js";
import { Db } from "./db.js";
import { Scanner } from "./scanner.js";
import { contiguousPrefix } from "./paging.js";

const PROGRAM = new PublicKey("A827Zi2VyPGQrPrQsZMr66hbxp7AaG2NdBYkV8Cj2yoJ");
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
function fakeConnection(history: { sig: string; tx: ReturnType<typeof transactTx> }[], undecodable: Set<string>) {
  const lookup = (sig: string) => history.find((h) => h.sig === sig)?.tx ?? null;
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

test("contiguousPrefix stops at the first hole and respects `from`", () => {
  const rows = [{ idx: 5 }, { idx: 6 }, { idx: 8 }, { idx: 9 }];
  assert.deepEqual(contiguousPrefix(rows, 5).map((r) => r.idx), [5, 6]);
  assert.deepEqual(contiguousPrefix(rows, 4), []);
  assert.deepEqual(contiguousPrefix([], 0), []);
});
