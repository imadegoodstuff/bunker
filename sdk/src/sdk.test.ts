import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { encodeAbiParameters, encodeErrorResult } from "viem";
import { POOL_ERRORS, LAUNCH_ERRORS, contractErrorFromData, isStaleRootRejection } from "./errors.js";
import { ShieldedPoolAbi, LaunchpadAbi } from "./abi/index.js";
import { BabyJub, poseidon } from "./crypto.js";
import { spendingKeyFromSeed, fullViewingKey, newAddress, encodeAddress, decodeAddress, groupHash, seedFromSignature, seedToBackup, seedFromBackup, SPENDING_KEY_MESSAGE, SCALAR_MASK, passphraseStrength, expectedSecondsToCrack, PASSPHRASE_MIN_BITS } from "./keys.js";
import { encryptNote, tryDecryptNote, encryptOutgoing, decryptOutgoing, decryptNoteAsSender, NOTE_CIPHERTEXT_LEN, NOTE_CIPHERTEXT_LEN_NO_MEMO, MEMO_MAX } from "./encryption.js";
import { noteCommitment, nullifier, assetId, freshRandomness, noteRandomness, NATIVE_TOKEN, addressToBytes32 } from "./note.js";
import { MerkleTree, verifyPath, EMPTY_LEAF_PREIMAGE } from "./merkle.js";
import { ShieldedWallet } from "./wallet.js";
import { extDataHash, serializeExtData, deserializeExtData, NO_EXIT, ZERO_ADDRESS, EXT_DATA_ABI, extDataArg } from "./extdata.js";
import { encodePublicAmount, decodePublicAmount, P, BJJ_SUBGROUP_ORDER, toHex } from "./field.js";
import { proofArg, sharesForDeposit, amountForMint, amountForBurn, sharesForWithdraw, VIRTUAL_OFFSET, type PoolState } from "./pool.js";
import { claimKey, exitData, decodeExitData, EXIT_BUY, EXIT_SELL, rolled, policy, worstFeeBps, voteInBounds, curveBuy, curveBuyCapped, curveSell, quotePrivateBuy, quotePrivateSell, feeOf, feeOnNet, type CurveState } from "./launch.js";

const seed = new Uint8Array(32).fill(7);
const A1 = "0x1111111111111111111111111111111111111111" as const;
const A2 = "0x2222222222222222222222222222222222222222" as const;

test("key derivation is deterministic and ivk is a valid Baby Jubjub scalar", async () => {
  const a = spendingKeyFromSeed(seed);
  const b = spendingKeyFromSeed(seed);
  assert.equal(a.ask, b.ask);
  assert.equal(a.nsk, b.nsk);
  const fvk = await fullViewingKey(a);
  assert.equal(fvk.ak, await poseidon([a.ask]));
  assert.ok(1n << 250n < BJJ_SUBGROUP_ORDER && BJJ_SUBGROUP_ORDER < 1n << 251n);
  assert.equal(SCALAR_MASK, (1n << 250n) - 1n);
  for (let i = 0; i < 64; i++) {
    const s = new Uint8Array(32).fill(i);
    const { ivk } = await fullViewingKey(spendingKeyFromSeed(s));
    assert.ok(ivk < BJJ_SUBGROUP_ORDER, `ivk for seed ${i} exceeds l`);
  }
});

test("diversified addresses round-trip through bech32m (hrp bunker) and are unlinkable", async () => {
  const bjj = await BabyJub.load();
  const fvk = await fullViewingKey(spendingKeyFromSeed(seed));
  const a1 = newAddress(bjj, fvk.ivk);
  const a2 = newAddress(bjj, fvk.ivk);
  assert.notDeepEqual(a1.pkd, a2.pkd);
  assert.ok(bjj.inSubgroup(a1.pkd));
  const s = encodeAddress(bjj, a1);
  assert.ok(s.startsWith("bunker1"));
  assert.ok(encodeAddress(bjj, a1, "tbunker").startsWith("tbunker1"));
  const back = decodeAddress(bjj, s);
  assert.deepEqual(back.address.d, a1.d);
  assert.deepEqual(back.address.pkd, a1.pkd);
  const gd = groupHash(bjj, a1.d)!;
  assert.deepEqual(bjj.mulScalar(gd, fvk.ivk), a1.pkd);
});

test("asset ids: sha256('bunker_asset' || 32-byte address) mod p; BNB is address(0)", () => {
  const h = createHash("sha256").update(Buffer.from("bunker_asset")).update(Buffer.from(addressToBytes32(A1))).digest("hex");
  assert.equal(assetId(A1), BigInt("0x" + h) % P);
  assert.equal(addressToBytes32(NATIVE_TOKEN).every((b) => b === 0), true);
  assert.equal(toHex(addressToBytes32(A1)), "000000000000000000000000" + "11".repeat(20));
  assert.notEqual(assetId(A1), assetId(A2));
  assert.throws(() => assetId("0x123"));
});

test("note encryption: receiver decrypts with ivk, strangers cannot, sender recovers with ovk", async () => {
  const bjj = await BabyJub.load();
  const sender = spendingKeyFromSeed(new Uint8Array(32).fill(1));
  const receiverSk = spendingKeyFromSeed(new Uint8Array(32).fill(2));
  const stranger = await fullViewingKey(spendingKeyFromSeed(new Uint8Array(32).fill(3)));
  const receiver = await fullViewingKey(receiverSk);
  const to = newAddress(bjj, receiver.ivk);
  const gd = groupHash(bjj, to.d)!;
  const asset = assetId(NATIVE_TOKEN);
  const note = { asset, value: 1234n, gd, pkd: to.pkd, ...freshRandomness() };
  const memo = new TextEncoder().encode("hello");
  const { ciphertext, esk } = encryptNote(bjj, to, note, memo, true);
  assert.equal(ciphertext.length, NOTE_CIPHERTEXT_LEN_NO_MEMO + 64);
  assert.equal(NOTE_CIPHERTEXT_LEN, NOTE_CIPHERTEXT_LEN_NO_MEMO + MEMO_MAX);

  const got = tryDecryptNote(bjj, receiver.ivk, ciphertext);
  assert.ok(got);
  assert.equal(got!.plaintext.value, 1234n);
  assert.equal(got!.plaintext.rho, note.rho);
  assert.equal(got!.plaintext.rcm, note.rcm);
  assert.deepEqual(got!.plaintext.rseed, note.rseed);
  assert.deepEqual(noteRandomness(note.rseed), { rho: note.rho, rcm: note.rcm });
  assert.notEqual(note.rho, note.rcm);
  assert.ok(note.rho < P && note.rcm < P);
  assert.deepEqual(got!.plaintext.d, to.d);
  assert.equal(new TextDecoder().decode(got!.plaintext.memo.slice(0, 5)), "hello");
  assert.equal(tryDecryptNote(bjj, stranger.ivk, ciphertext), null);

  const cm = await noteCommitment(note);
  const oc = encryptOutgoing(bjj, sender.ovk, cm, to.pkd, esk);
  const rec = decryptOutgoing(bjj, sender.ovk, cm, oc);
  assert.ok(rec);
  assert.equal(rec!.esk, esk);
  const pt = decryptNoteAsSender(bjj, rec!.pkd, rec!.esk, ciphertext);
  assert.equal(pt!.value, 1234n);

  const small = encryptNote(bjj, to, note, undefined, false);
  assert.equal(small.ciphertext.length, NOTE_CIPHERTEXT_LEN_NO_MEMO);
  assert.ok(tryDecryptNote(bjj, receiver.ivk, small.ciphertext));
});

test("a g_d with a torsion component passes the circuit's small-order check but is never credited by the receiver", async () => {
  const bjj = await BabyJub.load();
  const T = bjj.mulScalar(bjj.generator, BJJ_SUBGROUP_ORDER);
  assert.ok(bjj.inCurve(T) && !bjj.isIdentity(T) && bjj.isIdentity(bjj.mulScalar(T, 8n)), "T has order dividing 8");
  const receiverSk = spendingKeyFromSeed(new Uint8Array(32).fill(9));
  const receiver = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(9));
  const fvk = await fullViewingKey(receiverSk);
  const to = receiver.address();
  const gd = groupHash(bjj, to.d)!;
  const gdTorsion = bjj.add(gd, T);
  assert.ok(!bjj.isIdentity(bjj.mulScalar(gdTorsion, 8n)));
  assert.ok(!bjj.inSubgroup(gdTorsion));
  const asset = assetId(NATIVE_TOKEN);

  const honest = { asset, value: 500n, gd, pkd: to.pkd, ...freshRandomness() };
  const honestCt = encryptNote(bjj, to, honest, undefined, false).ciphertext;
  assert.ok(await receiver.scan({ index: 0, commitment: await noteCommitment(honest), ciphertext: honestCt }, asset));

  const bad = { ...honest, gd: gdTorsion, ...freshRandomness() };
  const badCt = encryptNote(bjj, to, bad, undefined, false).ciphertext;
  assert.equal(await receiver.scan({ index: 1, commitment: await noteCommitment(bad), ciphertext: badCt }, asset), null);
  const wrongPkd = { ...honest, pkd: bjj.mulScalar(gd, fvk.ivk + 1n), ...freshRandomness() };
  const wrongCt = encryptNote(bjj, to, wrongPkd, undefined, false).ciphertext;
  assert.equal(await receiver.scan({ index: 2, commitment: await noteCommitment(wrongPkd), ciphertext: wrongCt }, asset), null);
});

test("a torsion component in epk cannot probe ivk mod 8 (cofactor-cleared key agreement)", async () => {
  const bjj = await BabyJub.load();
  const T = bjj.mulScalar(bjj.generator, BJJ_SUBGROUP_ORDER);
  const receiver = await fullViewingKey(spendingKeyFromSeed(new Uint8Array(32).fill(11)));
  const to = newAddress(bjj, receiver.ivk);
  const gd = groupHash(bjj, to.d)!;
  const note = { asset: assetId(NATIVE_TOKEN), value: 7n, gd, pkd: to.pkd, ...freshRandomness() };
  const { ciphertext, epk } = encryptNote(bjj, to, note, undefined, false);
  assert.ok(tryDecryptNote(bjj, receiver.ivk, ciphertext));
  const epkT = bjj.add(epk, T);
  const tampered = new Uint8Array(ciphertext);
  tampered.set(bjj.compress(epkT), 0);
  assert.equal(tryDecryptNote(bjj, receiver.ivk, tampered), null);
  for (let k = 0n; k < 8n; k++) {
    const ivkK = (receiver.ivk & ~7n) | k;
    assert.deepEqual(bjj.mulScalar(epkT, ivkK * 8n), bjj.mulScalar(epk, ivkK * 8n));
  }
});

test("merkle tree paths verify; empty leaf is Poseidon('bunker_empty')", async () => {
  const t = new MerkleTree(26);
  await t.whenReady();
  const leaves = [1n, 2n, 3n, 4n, 5n];
  for (const l of leaves) await t.insert(l);
  const root = await t.root();
  for (let i = 0; i < leaves.length; i++) assert.ok(await verifyPath(leaves[i], await t.path(i), root));
  assert.equal(t.dummyPath().elements.length, 26);
  assert.equal(t.emptyLeaf, await poseidon([EMPTY_LEAF_PREIMAGE]));
  let x = 0n;
  for (const b of new TextEncoder().encode("bunker_empty")) x = (x << 8n) | BigInt(b);
  assert.equal(EMPTY_LEAF_PREIMAGE, x % P);
});

test("ext data is abi.encode(tuple) and hashes like ShieldedPool.extDataHash", () => {
  const ext = {
    recipient: A1,
    relayer: A2,
    relayerFee: 12345n,
    exitTarget: NO_EXIT,
    exitData: new Uint8Array(0),
    ciphertext0: new Uint8Array(100).fill(0xab),
    ciphertext1: new Uint8Array(100).fill(0xcd),
    outCiphertext: new Uint8Array(40).fill(0xef),
  };
  const bytes = serializeExtData(ext);
  assert.equal("0x" + toHex(bytes), encodeAbiParameters(EXT_DATA_ABI, [extDataArg(ext)]));
  const back = deserializeExtData(bytes);
  assert.equal(back.relayerFee, 12345n);
  assert.deepEqual(back.ciphertext0, ext.ciphertext0);
  assert.equal(back.exitTarget, ZERO_ADDRESS);
  const h = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
  assert.equal(extDataHash(ext), BigInt("0x" + h) % P);
  assert.ok(extDataHash(ext) < P);
});

test("share math mirrors the contract", () => {
  const p: PoolState = { exists: true, decimals: 18, unit: 1n, totalShares: 1000n, totalAssets: 1500n, totalIn: 0n, totalOut: 0n, tvlCap: 0n };
  const V = VIRTUAL_OFFSET;
  assert.equal(sharesForDeposit(p, 777n), (777n * (p.totalShares + V)) / (p.totalAssets + V));
  const ts = p.totalShares + V;
  assert.equal(amountForMint(p, 500n), (500n * (p.totalAssets + V) + ts - 1n) / ts);
  assert.equal(amountForBurn(p, 500n), (500n * (p.totalAssets + V)) / ts);
  assert.ok(amountForMint(p, 500n) >= amountForBurn(p, 500n));
  assert.ok(sharesForWithdraw(p, 100n) >= sharesForDeposit(p, 100n));
});

test("proof argument order: B coordinates swapped as snarkjs' exportSolidityCallData does, nothing negated", () => {
  const g = { piA: [1n, 2n] as [bigint, bigint], piB: [[3n, 4n], [5n, 6n]] as [[bigint, bigint], [bigint, bigint]], piC: [7n, 8n] as [bigint, bigint] };
  const a = proofArg(g);
  assert.deepEqual([...a.a], [1n, 2n]);
  assert.deepEqual(a.b.map((r) => [...r]), [[4n, 3n], [6n, 5n]]);
  assert.deepEqual([...a.c], [7n, 8n]);
});

test("public amount encoding", () => {
  assert.equal(decodePublicAmount(encodePublicAmount(-5n)), -5n);
  assert.equal(decodePublicAmount(encodePublicAmount(5n)), 5n);
  assert.equal(encodePublicAmount(-1n), P - 1n);
});

test("nullifier depends on position", async () => {
  assert.notEqual(await nullifier(1n, 2n, 0), await nullifier(1n, 2n, 1));
});

test("seed derivation: passphrase changes the seed, backup round-trips", async () => {
  const sig = new Uint8Array(65).fill(3);
  await assert.rejects(seedFromSignature(sig), /allowEmpty/);
  await assert.rejects(seedFromSignature(sig, "   "), /allowEmpty/);
  const a = await seedFromSignature(sig, "", { allowEmpty: true });
  const b = await seedFromSignature(sig, "correct horse");
  const c = await seedFromSignature(sig, "correct horse");
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.deepEqual(b, c);
  assert.deepEqual(await seedFromSignature(sig, "caf\u00e9"), await seedFromSignature(sig, "cafe\u0301"));
  assert.deepEqual(seedFromBackup(seedToBackup(b)), b);
  assert.ok(seedToBackup(b).startsWith("bunkerseed1"));
  assert.throws(() => seedFromBackup("bunkerseed1zz"));
  assert.throws(() => seedFromBackup("scashseed1" + "00".repeat(32)));
  assert.ok(SPENDING_KEY_MESSAGE.includes("SPEND"));
  assert.ok(SPENDING_KEY_MESSAGE.includes("bunkeronbnb.com"));
});

test("note reservation: reserve hides a note, release restores it, markSpent removes it", async () => {
  const bjj = await BabyJub.load();
  const w = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(21));
  const to = w.address();
  const asset = assetId(NATIVE_TOKEN);
  const notes = [];
  for (let i = 0; i < 3; i++) {
    const n = { asset, value: 100n * BigInt(i + 1), gd: groupHash(bjj, to.d)!, pkd: to.pkd, ...freshRandomness() };
    const ct = encryptNote(bjj, to, n, undefined, false).ciphertext;
    const sn = await w.scan({ index: i, commitment: await noteCommitment(n), ciphertext: ct }, asset);
    assert.ok(sn);
    notes.push(sn);
  }
  assert.equal(w.balance(asset), 600n);
  const consumed = [notes[0].commitment, notes[1].commitment];
  w.reserve(consumed);
  assert.equal(w.balance(asset), 300n);
  assert.ok(w.isPending(notes[0].commitment) && !w.isPending(notes[2].commitment));
  w.release(consumed);
  assert.equal(w.balance(asset), 600n);
  w.reserve(consumed);
  w.markSpent([await nullifier(w.fvk.nk, notes[0].rho, 0), await nullifier(w.fvk.nk, notes[1].rho, 1)]);
  assert.ok(w.isSpent(notes[0].commitment) && !w.isSpent(notes[2].commitment));
  assert.equal(w.balance(asset), 300n);
  w.release(consumed.filter((c) => !w.isSpent(c)));
  assert.equal(w.balance(asset), 300n);
});

test("error tables list every custom error in the ABIs and decode revert data", () => {
  const abiErrors = (abi: readonly { type: string; name?: string }[]) => abi.filter((x) => x.type === "error").map((x) => x.name!).sort();
  assert.deepEqual([...POOL_ERRORS].sort(), abiErrors(ShieldedPoolAbi));
  assert.deepEqual([...LAUNCH_ERRORS].sort(), abiErrors(LaunchpadAbi));
  assert.equal(contractErrorFromData(encodeErrorResult({ abi: ShieldedPoolAbi, errorName: "UnknownRoot" })), "UnknownRoot");
  assert.equal(contractErrorFromData(encodeErrorResult({ abi: LaunchpadAbi, errorName: "Slippage" })), "Slippage");
  assert.equal(contractErrorFromData("0x12345678"), undefined);
  assert.equal(contractErrorFromData("0x"), undefined);
  assert.equal(contractErrorFromData(undefined), undefined);
  assert.equal(isStaleRootRejection({ error: "simulation failed", contractError: "UnknownRoot" }), true);
  assert.equal(isStaleRootRejection({ error: "simulation failed", contractError: "InvalidProof" }), true);
  assert.equal(isStaleRootRejection({ error: "simulation failed", contractError: "NullifierSpent" }), false);
  assert.equal(isStaleRootRejection(undefined), false);
});

test("claim keys are deterministic secp256k1 accounts, distinct per nonce and seed", () => {
  const k1 = claimKey(seed, 0n);
  const k2 = claimKey(seed, 0n);
  const k3 = claimKey(seed, 1n);
  const k4 = claimKey(new Uint8Array(32).fill(8), 0n);
  assert.equal(k1.privateKey, k2.privateKey);
  assert.equal(k1.address, k2.address);
  assert.notEqual(k1.address, k3.address);
  assert.notEqual(k1.address, k4.address);
  assert.match(k1.privateKey, /^0x[0-9a-f]{64}$/);
  assert.match(k1.address, /^0x[0-9a-fA-F]{40}$/);
});

test("exit data round-trips through abi encoding", () => {
  const d = exitData(EXIT_BUY, A1, A2, 123n, 2_000_000_000_000_000n, 500_000_000_000_000n);
  assert.equal(d.length, 6 * 32);
  assert.deepEqual(decodeExitData(d), { kind: 1, token: A1, claimKey: A2, minOut: 123n, claimBudget: 2_000_000_000_000_000n, relayerTip: 500_000_000_000_000n });
  assert.equal(decodeExitData(exitData(EXIT_SELL, A1, A2, 0n, 0n)).kind, 2);
});

test("fee policy mirror: median, quorum, one bounded step per epoch, votes count from the next epoch and expire", () => {
  const E = policy.EPOCH_BLOCKS;
  const base = (fee: number, settledEpoch: bigint): CurveState => ({
    token: A1, creator: A2, createdBlock: 1n, virtualBnb: 1n, virtualToken: 1n, realBnb: 0n, realToken: 1n, feesAccrued: 0n, graduated: false,
    tradeFeeBps: fee, settledEpoch, votes: [0, 1, 2, 3].map(() => ({ feeBps: 0, blockNumber: 0n })), ammPair: null, buys: 0n, sells: 0n, bnbVolume: 0n,
  });
  const v = (feeBps: number, blockNumber: bigint) => ({ feeBps, blockNumber });
  let c = base(100, 0n);
  c.votes[0] = v(500, 10n);
  assert.deepEqual([rolled(c, E + 1n).tradeFeeBps, rolled(c, E + 1n).settledEpoch], [100, 1n]);
  c = base(100, 0n);
  c.votes[0] = v(500, 10n); c.votes[1] = v(300, 20n); c.votes[2] = v(250, 30n);
  let r = rolled(c, E);
  assert.equal(r.tradeFeeBps, 200);
  r = rolled(r, E + 70n);
  assert.equal(r.tradeFeeBps, 200);
  r = rolled(r, 2n * E);
  assert.equal(r.tradeFeeBps, 300);
  r.votes = [v(0, 2n * E + 1n), v(0, 2n * E + 2n), v(0, 2n * E + 3n), v(0, 0n)];
  assert.equal(rolled(r, 3n * E).tradeFeeBps, 200);
  assert.equal(rolled(r, 5n * E).tradeFeeBps, 0);
  c = base(100, 1n);
  c.votes[0] = v(300, 2n * E + 1n); c.votes[1] = v(300, 2n * E + 2n);
  r = rolled(c, 2n * E + 10n);
  assert.equal(r.tradeFeeBps, 100);
  assert.equal(rolled(r, 3n * E).tradeFeeBps, 200);
  c = base(100, 1n);
  c.votes[0] = v(300, 10n); c.votes[1] = v(300, 20n);
  assert.equal(rolled(c, 100n * E).tradeFeeBps, 100);
  c = base(0, 0n);
  c.votes[0] = v(500, 10n); c.votes[1] = v(500, 20n);
  assert.equal(rolled(c, 3n * E).tradeFeeBps, 300);
  c = base(100, 0n);
  c.votes[0] = v(300, 10n); c.votes[1] = v(300, 20n);
  assert.equal(worstFeeBps(c, E - 10n, 60n), 200);
  assert.equal(worstFeeBps(c, E - 10n, 160n), 300);
  assert.equal(worstFeeBps(c, 10n, 60n), 100);
  assert.ok(voteInBounds(0) && voteInBounds(500) && !voteInBounds(501) && !voteInBounds(100.5));
});

test("curve math: k never decreases, capped buy sells out at graduation, quotes include budget and tip", () => {
  const dec = 10n ** 6n;
  const curveSupply = 793_100_000n * dec, virtualToken = 1_073_000_000n * dec, graduation = 6n * 10n ** 18n;
  const virtualBnb = (graduation * (virtualToken - curveSupply)) / curveSupply;
  const fresh = () => ({ virtualBnb, realBnb: 0n, virtualToken, realToken: curveSupply, tradeFeeBps: 100 });
  let r = fresh();
  const k0 = (r.virtualBnb + r.realBnb) * r.virtualToken;
  let s = 0x9e3779b97f4a7c15n;
  for (let i = 0; i < 2000; i++) {
    s ^= (s << 13n) & ((1n << 64n) - 1n); s ^= s >> 7n; s ^= (s << 17n) & ((1n << 64n) - 1n);
    if ((s & 3n) !== 0n || r.realBnb === 0n) {
      const bnb = 1n + (s % (5n * 10n ** 16n));
      try { const q = curveBuy(r, bnb); r = { ...r, realBnb: r.realBnb + bnb, virtualToken: q.virtualToken, realToken: r.realToken - q.out }; } catch { /* sold out / nothing */ }
    } else {
      const sold = curveSupply - r.realToken;
      if (sold > 0n) { const tok = 1n + (s % sold); try { const q = curveSell(r, tok); r = { ...r, realBnb: r.realBnb - q.out, virtualToken: q.virtualToken, realToken: r.realToken + tok }; } catch { /* reserve */ } }
    }
    assert.ok((r.virtualBnb + r.realBnb) * r.virtualToken >= k0);
  }
  const cap = curveBuyCapped(fresh(), 25n * 10n ** 18n);
  assert.equal(cap.out, curveSupply);
  assert.ok(cap.used > graduation - 10n ** 15n && cap.used < graduation + 10n ** 15n);
  const q = quotePrivateBuy(fresh(), 10n ** 18n, 2n * 10n ** 15n, 5n * 10n ** 14n);
  assert.equal(q.reserve, 25n * 10n ** 14n);
  assert.equal(q.fee, feeOf(10n ** 18n - q.reserve, 100));
  assert.equal(q.net, 10n ** 18n - q.reserve - q.fee);
  assert.equal(q.refund, 0n);
  const big = quotePrivateBuy(fresh(), 30n * 10n ** 18n, 0n, 0n);
  assert.equal(big.out, curveSupply);
  assert.ok(big.refund > 23n * 10n ** 18n);
  assert.equal(big.fee, feeOnNet(big.net, 100));
  const after = { ...fresh(), realBnb: q.net, virtualToken: curveBuy(fresh(), q.net).virtualToken, realToken: curveSupply - q.out };
  const sq = quotePrivateSell(after, q.out / 2n, 10n ** 14n);
  assert.equal(sq.out, sq.gross - sq.fee - 10n ** 14n);
  assert.ok(sq.gross < q.net);
  assert.throws(() => quotePrivateBuy(fresh(), 10n ** 15n, 10n ** 15n, 0n), /too small/);
});

test("passphrase strength: the time-to-crack arithmetic is 2^(b-1)/rate", () => {
  const day = 86400, year = 365 * day;
  assert.ok(Math.abs(expectedSecondsToCrack(40) / day - 63.6) < 0.1);
  assert.ok(Math.abs(expectedSecondsToCrack(PASSPHRASE_MIN_BITS) / year - 178) < 1);
  assert.ok(Math.abs(expectedSecondsToCrack(55) / year - 5708) < 10);
  assert.equal(expectedSecondsToCrack(0), 0);
});

test("passphrase strength: leaked, common-word and short inputs are weak; phrases are scored as phrases", () => {
  for (const weak of [
    "", "password", "Password1!", "correct horse battery staple", "correcthorsebatterystaple", "aaaaaaaaaaaaaaaaaaaa", "abcdefghijklmnopqrst",
    "12345678", "Tr0ub4d&", "Tr0ub4d&3xq!", "to the moon and back", "i love my dog so much", "bunker", "Bunker1!", "binance",
  ]) {
    const s = passphraseStrength(weak);
    assert.equal(s.level, "weak", `${JSON.stringify(weak)} scored ${s.bits}`);
    assert.ok(s.bits < PASSPHRASE_MIN_BITS);
  }
  assert.equal(passphraseStrength("password123").bits, 0);
  assert.equal(passphraseStrength("Solana!").bits, 0);
  assert.equal(passphraseStrength("bunker!").bits, 0);
  const sentence = passphraseStrength("the quick brown fox jumps over the lazy dog today");
  assert.ok(sentence.bits < 60, `sentence scored ${sentence.bits}`);
  assert.equal(passphraseStrength("Tr0ub4d&3xq!Lm").level, "fair");
  assert.equal(passphraseStrength("Tr0ub4d&3xq!Lm9#Vp").level, "strong");
  const five = passphraseStrength("velvet hydrant obelisk cinnamon quasar");
  assert.equal(five.level, "fair");
  assert.equal(five.bits, 55);
  assert.equal(passphraseStrength("velvet hydrant obelisk cinnamon quasar velvet hydrant").bits, 55);
  assert.equal(passphraseStrength("velvet hydrant obelisk cinnamon quasar lantern furrow").level, "strong");
  assert.equal(passphraseStrength("caf\u00e9 velours quasar").bits, passphraseStrength("cafe\u0301 velours quasar").bits);
});

test("networks.bsc mirrors contracts/deployments/56.json and services answer the hosted URLs", async () => {
  const { networks } = await import("./networks.js");
  const { readFileSync, existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const { resolve, dirname } = await import("node:path");
  const here = dirname(fileURLToPath(import.meta.url));
  const file = resolve(here, "../../contracts/deployments/56.json");
  if (!existsSync(file)) return; // published package: no repo around it
  const dep = JSON.parse(readFileSync(file, "utf8")) as { pool: string; launchpad: string; startBlock: number };
  assert.equal(networks.bsc.pool.toLowerCase(), dep.pool.toLowerCase());
  assert.equal(networks.bsc.launchpad.toLowerCase(), dep.launchpad.toLowerCase());
  assert.equal(networks.bsc.startBlock, dep.startBlock);
  assert.equal(networks.bsc.chainId, 56);
  for (const u of [networks.bsc.indexerUrl, networks.bsc.relayerUrl, networks.bsc.agentsUrl, networks.bsc.artifactsUrl]) assert.match(u, /^https:\/\//);
});

test("BunkerClient connects offline and derives a bunker1 address from a seed", async () => {
  const { BunkerClient } = await import("./client.js");
  const seed = new Uint8Array(32).fill(7);
  const c = await BunkerClient.connect({ seed });
  assert.equal(c.network.chainId, 56);
  assert.match(c.address(), /^bunker1[02-9ac-hj-np-z]+$/);
  assert.equal(BunkerClient.seedFromBackup(c.backup()).join(","), seed.join(","));
  assert.equal(c.tree.size, 0);
  await assert.rejects(BunkerClient.connect({ seed: new Uint8Array(31) }), /32 bytes/);
});
