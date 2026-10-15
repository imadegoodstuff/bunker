import test from "node:test";
import assert from "node:assert/strict";
import { parseDecision, shouldSend, snap } from "./decide.js";

test("snap puts any fee on the 25 bps grid inside 0–500", () => {
  assert.equal(snap(0), 0);
  assert.equal(snap(10_000), 500);
  assert.equal(snap(120), 125);
  assert.equal(snap(187), 175); // 187 is nearer 175 than 200
  assert.equal(snap(-40), 0);
  assert.equal(snap(NaN), 0);
});

test("parseDecision reads the JSON a model returns, including when wrapped in prose or percentages", () => {
  assert.deepEqual(parseDecision('Sure. {"fee_bps": 250, "holder_bps": 7000, "reason": "Sell pressure  spiked."}'), { feeBps: 250, reason: "Sell pressure spiked." });
  assert.deepEqual(parseDecision('```json\n{"fee_pct": 1.1}\n```'), { feeBps: 100, reason: "" });
  assert.deepEqual(parseDecision('{"fee_bps": 0, "reason": "calm"}'), { feeBps: 0, reason: "calm" });
  assert.deepEqual(parseDecision('{"fee_bps": 900}')!.feeBps, 500);
  assert.equal(parseDecision("I cannot decide."), null);
  assert.equal(parseDecision('{"fee_bps": "abc"}'), null);
  assert.equal(parseDecision('{"fee_bps": 100, "reason": "' + "x".repeat(500) + '"}')!.reason.length, 200);
});

test("shouldSend skips an unchanged vote that is still fresh, re-sends once it is half way to expiry or differs", () => {
  const d = { feeBps: 150, reason: "" };
  assert.equal(shouldSend({ feeBps: 0, blockNumber: 0n }, d, 100n), true, "never voted");
  assert.equal(shouldSend({ feeBps: 150, blockNumber: 1000n }, d, 1100n), false, "same and fresh");
  assert.equal(shouldSend({ feeBps: 150, blockNumber: 1000n }, d, 1160n), true, "same but half the TTL (160 blocks) has passed");
  assert.equal(shouldSend({ feeBps: 250, blockNumber: 1000n }, d, 1050n), true, "differs");
});
