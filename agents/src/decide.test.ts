import test from "node:test";
import assert from "node:assert/strict";
import { parseDecision, shouldSend, snap } from "./decide.js";

test("snap puts any pair on the program's grid and never outside the bounds", () => {
  assert.deepEqual(snap(0, 0), { feeBps: 50, holderBps: 5000 });
  assert.deepEqual(snap(10_000, 10_000_000), { feeBps: 300, holderBps: 10000 });
  assert.deepEqual(snap(120, 6400), { feeBps: 150, holderBps: 6000 });
  assert.deepEqual(snap(199, 7500), { feeBps: 150, holderBps: 8000 }); // 199 is nearer 150 than 250
  assert.deepEqual(snap(NaN, NaN), { feeBps: 50, holderBps: 5000 });
});

test("parseDecision reads the JSON a model returns, including when wrapped in prose or percentages", () => {
  assert.deepEqual(parseDecision('Sure. {"fee_bps": 250, "holder_bps": 7000, "reason": "Sell pressure  spiked."}'), { feeBps: 250, holderBps: 7000, reason: "Sell pressure spiked." });
  assert.deepEqual(parseDecision('```json\n{"fee_pct": 1, "holder_pct": 90}\n```'), { feeBps: 150, holderBps: 9000, reason: "" });
  assert.equal(parseDecision("I cannot decide."), null);
  assert.equal(parseDecision('{"fee_bps": "abc", "holder_bps": 5000}'), null);
  assert.equal(parseDecision('{"fee_bps": 100, "holder_bps": 6000, "reason": "' + "x".repeat(500) + '"}')!.reason.length, 200);
});

test("shouldSend skips an unchanged vote that is still fresh, re-sends once it is half way to expiry or differs", () => {
  const d = { feeBps: 150, holderBps: 6000, reason: "" };
  assert.equal(shouldSend({ feeBps: 0, holderBps: 0, slot: 0n }, d, 100n), true, "never voted");
  assert.equal(shouldSend({ feeBps: 150, holderBps: 6000, slot: 1000n }, d, 1500n), false, "same and fresh");
  assert.equal(shouldSend({ feeBps: 150, holderBps: 6000, slot: 1000n }, d, 2800n), true, "same but half the TTL has passed");
  assert.equal(shouldSend({ feeBps: 250, holderBps: 6000, slot: 1000n }, d, 1500n), true, "differs");
});
