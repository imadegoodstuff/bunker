import { test } from "node:test";
import assert from "node:assert/strict";
import { SubmitQueue } from "./queue.js";
import type { TransactCall } from "@bunker/sdk";

const call = () => ({ args: [{}, "0x0", 0n, 0n, 0n, "0x0", [1n, 2n], [0n, 0n], {}] }) as unknown as TransactCall;
const opts = { minDelayMs: 0, maxDelayMs: 0, gasLimit: 1n, gasPrice: () => 0n, maxAttempts: 1, pool: "0x0000000000000000000000000000000000000000" as const };

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
