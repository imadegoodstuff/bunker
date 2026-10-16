import { test } from "node:test";
import assert from "node:assert/strict";
import { SubmitQueue } from "./queue.js";
import type { TransactCall } from "@bunker/sdk";

const call = (validUntil = 0n) => ({ args: [{ nullifiers: [1n, 2n], outCommitments: [0n, 0n, 0n], ext: { validUntil } }] }) as unknown as TransactCall;
const opts = { minDelayMs: 0, maxDelayMs: 0, gasLimit: 1n, gasPrice: () => 0n, maxAttempts: 1, pool: "0x0000000000000000000000000000000000000000" as const };

test("a job's release never lands past its validUntil", () => {
  const q = new SubmitQueue(undefined, { ...opts, minDelayMs: 600_000, maxDelayMs: 600_000 });
  const soon = BigInt(Math.floor(Date.now() / 1000) + 120);
  const j = q.enqueue(call(soon), ["aa"]);
  assert.equal(j.validUntil, Number(soon));
  assert.ok(j.releaseAt <= Number(soon) * 1000 - 30_000, "released with 30 s to spare");
  const k = q.enqueue(call(), ["bb"]);
  assert.ok(k.releaseAt >= Date.now() + 599_000, "no deadline: the full random hold");
});

test("a second /relay carrying a nullifier of a live job resolves to that job; a failed job frees its nullifiers", () => {
  const q = new SubmitQueue(undefined, opts);
  const a = q.enqueue(call(), ["aa", "bb"]);
  assert.equal(q.findByNullifiers(["bb"])?.id, a.id, "same payment again → same job");
  assert.equal(q.findByNullifiers(["cc"]), undefined);
  assert.equal(q.findByNullifiers(["cc", "aa"])?.id, a.id);
  a.status = "confirmed";
  assert.equal(q.findByNullifiers(["aa"])?.id, a.id);
  a.status = "failed";
  assert.equal(q.findByNullifiers(["aa"]), undefined);
  const b = q.enqueue(call(), ["aa"]);
  assert.equal(q.findByNullifiers(["aa"])?.id, b.id);
  assert.equal(q.size(), 1);
});

test("keeper jobs: one live drain at a time, immediate release, not counted as queued transacts", () => {
  const q = new SubmitQueue(undefined, opts);
  const drainCall = { address: opts.pool, abi: [], functionName: "drain", args: [512] };
  const d1 = q.enqueueKeeper("drain", drainCall, 5n);
  const d2 = q.enqueueKeeper("drain", drainCall, 5n);
  assert.equal(d1.id, d2.id, "a second drain request joins the live one");
  assert.ok(d1.releaseAt <= Date.now());
  assert.equal(q.size(), 0);
  assert.equal(q.liveKeeper("drain")?.id, d1.id);
  d1.status = "confirmed";
  const d3 = q.enqueueKeeper("drain", drainCall, 5n);
  assert.notEqual(d3.id, d1.id);
});
