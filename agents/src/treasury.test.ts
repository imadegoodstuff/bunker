import test from "node:test";
import assert from "node:assert/strict";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { applyTransfers, pickHolders, shouldBuyBack, spend, splitAirdrop, topUps, DEAD, ZERO } from "./treasury.js";

const k = () => privateKeyToAccount(generatePrivateKey()).address;

test("topUps refuels the emptiest keys first, only below half the float, and never beyond what is spare", () => {
  const [a, b, c] = [k(), k(), k()];
  const float = 30_000_000n;
  const ups = topUps([{ key: a, wei: 20_000_000n }, { key: b, wei: 1_000_000n }, { key: c, wei: 10_000_000n }], float, 100_000_000n);
  assert.deepEqual(ups.map((u) => [u.key, u.wei]), [[b, 29_000_000n], [c, 20_000_000n]]);
  // too little spare: the first one that does not fit stops the list
  assert.deepEqual(topUps([{ key: b, wei: 0n }, { key: c, wei: 10_000_000n }], float, 35_000_000n).map((u) => u.key), [b]);
  assert.deepEqual(topUps([{ key: a, wei: 15_000_000n }], float, 100n), []);
});

test("shouldBuyBack fires on average once per meanMinutes; spend takes 25–100 % of the surplus", () => {
  assert.equal(shouldBuyBack(0.0001, 60_000, 240), true);
  assert.equal(shouldBuyBack(0.01, 60_000, 240), false); // 1/240 ≈ 0.0042
  assert.equal(shouldBuyBack(0, 60_000, 0), false);
  assert.equal(spend(1_000n, 0), 250n);
  assert.equal(spend(1_000n, 0.999999), 999n);
  assert.equal(spend(-5n, 0.5), 0n);
});

test("applyTransfers folds mints, transfers and burns into balances and drops empty ones", () => {
  const [a, b] = [k(), k()];
  const bal = applyTransfers(new Map(), [
    { from: ZERO, to: a, value: 100n },
    { from: a, to: b, value: 40n },
    { from: b, to: DEAD, value: 10n },
    { from: a, to: ZERO, value: 60n },
  ]);
  assert.equal(bal.get(a.toLowerCase()), undefined);
  assert.equal(bal.get(b.toLowerCase()), 30n);
  assert.equal(bal.get(DEAD.toLowerCase()), 10n);
});

test("pickHolders keeps wallets only, drops the treasury, dead and contracts, largest first, capped; splitAirdrop is pro rata with floor", () => {
  const treasury = k();
  const pair = k();
  const [w1, w2, w3] = [k(), k(), k()];
  const all = [
    { owner: pair, amount: 1_000_000n },
    { owner: treasury, amount: 500n },
    { owner: w1, amount: 100n },
    { owner: w2, amount: 300n },
    { owner: w3, amount: 0n },
    { owner: DEAD, amount: 5_000n },
  ];
  const isContract = (a: string) => a === pair;
  const picked = pickHolders(all, [treasury], 10, isContract);
  assert.deepEqual(picked.map((h) => h.owner), [w2, w1]);
  assert.deepEqual(pickHolders(all, [treasury], 1, isContract).map((h) => h.owner), [w2]);
  const drops = splitAirdrop(1_001n, picked);
  assert.deepEqual(drops.map((d) => d.amount), [750n, 250n]); // 1001 × 300/400 = 750.75 → 750, 1001 × 100/400 = 250.25 → 250
  assert.deepEqual(splitAirdrop(10n, []), []);
});
