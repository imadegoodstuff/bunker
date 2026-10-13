import { test } from "node:test";
import assert from "node:assert/strict";
import { pickPriorityFee, PriorityFeeOracle } from "./fees.js";

const s = (...fees: number[]) => fees.map((prioritizationFee, slot) => ({ slot, prioritizationFee }));

test("pickPriorityFee: p75 of recent samples, clamped to [floor, cap]; no samples means the floor", () => {
  assert.equal(pickPriorityFee([], 100, 50_000), 100);
  // 150 slots, 100 of them at zero: the median says 0, the p75 says what the busiest quarter paid.
  const mixed = [...Array(100).fill(0), ...Array(50).fill(2_000)];
  assert.equal(pickPriorityFee(s(...mixed), 0, 50_000), 2_000);
  // a lone spike in an otherwise idle window is not a market
  assert.equal(pickPriorityFee(s(...Array(149).fill(0), 1_000_000), 0, 50_000), 0);
  // all zero: pay the floor, not zero, if the operator set one
  assert.equal(pickPriorityFee(s(0, 0, 0, 0), 500, 50_000), 500);
  // spike: capped
  assert.equal(pickPriorityFee(s(1, 2, 3, 10_000_000), 0, 20_000), 20_000);
  // garbage samples are ignored
  assert.equal(pickPriorityFee(s(NaN, -5, 300, 300), 0, 50_000), 300);
  assert.throws(() => pickPriorityFee([], 10, 5), /cap 5 below floor 10/);
});

test("oracle: starts at the floor, follows the RPC, keeps the last good price when the RPC fails", async () => {
  let fees: { slot: number; prioritizationFee: number }[] | Error = s(0, 0, 1_000, 1_000);
  const conn = { getRecentPrioritizationFees: async () => { if (fees instanceof Error) throw fees; return fees; } };
  const o = new PriorityFeeOracle(conn, { floor: 100, cap: 20_000, refreshMs: 60_000 });
  assert.equal(o.current(), 100);
  assert.equal(o.info().source, "floor");
  assert.equal(await o.refresh(), 1_000);
  assert.equal(o.info().source, "recent");
  fees = new Error("429 Too Many Requests");
  assert.equal(await o.refresh(), 1_000, "a failed refresh must not reset the price");
  assert.equal(o.info().lastError, "429 Too Many Requests");
  fees = s(50_000, 50_000);
  assert.equal(await o.refresh(), 20_000, "cap bounds the exposure to a spike");
  assert.equal(o.info().lastError, null);
});
