import { test } from "node:test";
import assert from "node:assert/strict";
import { clampGasPrice, GasPriceOracle } from "./fees.js";

test("clampGasPrice: node price clamped to [floor, cap]; no sample means the floor", () => {
  assert.equal(clampGasPrice(undefined, 100n, 50_000n), 100n);
  assert.equal(clampGasPrice(2_000n, 0n, 50_000n), 2_000n);
  assert.equal(clampGasPrice(0n, 500n, 50_000n), 500n);
  assert.equal(clampGasPrice(10_000_000n, 0n, 20_000n), 20_000n);
  assert.equal(clampGasPrice(-5n, 0n, 50_000n), 0n);
  assert.throws(() => clampGasPrice(undefined, 10n, 5n), /cap 5 below floor 10/);
});

test("oracle: starts at the floor, follows the node, keeps the last good price when the RPC fails", async () => {
  let price: bigint | Error = 1_000n;
  const client = { getGasPrice: async () => { if (price instanceof Error) throw price; return price; } };
  const o = new GasPriceOracle(client, { floor: 100n, cap: 20_000n, refreshMs: 60_000 });
  assert.equal(o.current(), 100n);
  assert.equal(o.info().source, "floor");
  assert.equal(await o.refresh(), 1_000n);
  assert.equal(o.info().source, "node");
  price = new Error("429 Too Many Requests");
  assert.equal(await o.refresh(), 1_000n, "a failed refresh must not reset the price");
  assert.equal(o.info().lastError, "429 Too Many Requests");
  price = 50_000n;
  assert.equal(await o.refresh(), 20_000n, "cap bounds the exposure to a spike");
  assert.equal(o.info().lastError, null);
});
