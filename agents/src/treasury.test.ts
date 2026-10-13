import test from "node:test";
import assert from "node:assert/strict";
import { Keypair, PublicKey } from "@solana/web3.js";
import { pickHolders, shouldBuyBack, spend, splitAirdrop, topUps } from "./treasury.js";

const k = () => Keypair.generate().publicKey;

test("topUps refuels the emptiest keys first, only below half the float, and never beyond what is spare", () => {
  const [a, b, c] = [k(), k(), k()];
  const float = 30_000_000n;
  const ups = topUps([{ key: a, lamports: 20_000_000n }, { key: b, lamports: 1_000_000n }, { key: c, lamports: 10_000_000n }], float, 100_000_000n);
  assert.deepEqual(ups.map((u) => [u.key.toBase58(), u.lamports]), [[b.toBase58(), 29_000_000n], [c.toBase58(), 20_000_000n]]);
  // too little spare: the first one that does not fit stops the list
  assert.deepEqual(topUps([{ key: b, lamports: 0n }, { key: c, lamports: 10_000_000n }], float, 35_000_000n).map((u) => u.key.toBase58()), [b.toBase58()]);
  assert.deepEqual(topUps([{ key: a, lamports: 15_000_000n }], float, 100n), []);
});

test("shouldBuyBack fires on average once per meanMinutes; spend takes 25–100 % of the surplus", () => {
  assert.equal(shouldBuyBack(0.0001, 60_000, 240), true);
  assert.equal(shouldBuyBack(0.01, 60_000, 240), false); // 1/240 ≈ 0.0042
  assert.equal(shouldBuyBack(0, 60_000, 0), false);
  assert.equal(spend(1_000n, 0), 250n);
  assert.equal(spend(1_000n, 0.999999), 999n);
  assert.equal(spend(-5n, 0.5), 0n);
});

test("pickHolders keeps wallets only, drops the treasury and PDAs, largest first, capped; splitAirdrop is pro rata with floor", () => {
  const treasury = k();
  const pda = PublicKey.findProgramAddressSync([Buffer.from("pool")], new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"))[0];
  const [w1, w2, w3] = [k(), k(), k()];
  const all = [
    { tokenAccount: k(), owner: pda, amount: 1_000_000n },
    { tokenAccount: k(), owner: treasury, amount: 500n },
    { tokenAccount: k(), owner: w1, amount: 100n },
    { tokenAccount: k(), owner: w2, amount: 300n },
    { tokenAccount: k(), owner: w3, amount: 0n },
  ];
  const picked = pickHolders(all, [treasury], 10);
  assert.deepEqual(picked.map((h) => h.owner.toBase58()), [w2.toBase58(), w1.toBase58()]);
  assert.deepEqual(pickHolders(all, [treasury], 1).map((h) => h.owner.toBase58()), [w2.toBase58()]);
  const drops = splitAirdrop(1_001n, picked);
  assert.deepEqual(drops.map((d) => d.amount), [750n, 250n]); // 1001 × 300/400 = 750.75 → 750, 1001 × 100/400 = 250.25 → 250
  assert.deepEqual(splitAirdrop(10n, []), []);
});
