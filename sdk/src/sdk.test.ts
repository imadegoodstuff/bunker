import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { VAULT_ERRORS, vaultErrorName, isStaleRootRejection } from "./errors.js";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { BabyJub, poseidon } from "./crypto.js";
import { spendingKeyFromSeed, fullViewingKey, newAddress, encodeAddress, decodeAddress, groupHash, seedFromSignature, seedToBackup, seedFromBackup, SPENDING_KEY_MESSAGE, SCALAR_MASK, passphraseStrength, expectedSecondsToCrack, PASSPHRASE_MIN_BITS } from "./keys.js";
import { encryptNote, tryDecryptNote, encryptOutgoing, decryptOutgoing, decryptNoteAsSender, NOTE_CIPHERTEXT_LEN, NOTE_CIPHERTEXT_LEN_NO_MEMO, MEMO_MAX, MEMO_BUCKET } from "./encryption.js";
import { transactIx } from "./program.js";
import { staticAddresses, buildV0, ataFor } from "./lookup.js";
import { noteCommitment, nullifier, assetId, freshRandomness, noteRandomness } from "./note.js";
import { MerkleTree, verifyPath } from "./merkle.js";
import { ShieldedWallet } from "./wallet.js";
import { extDataHash, serializeExtData, deserializeExtData, NO_EXIT } from "./extdata.js";
import { encodePublicAmount, decodePublicAmount, P, randomField, BJJ_SUBGROUP_ORDER } from "./field.js";

const seed = new Uint8Array(32).fill(7);

test("key derivation is deterministic and ivk is a valid Baby Jubjub scalar", async () => {
  const a = spendingKeyFromSeed(seed);
  const b = spendingKeyFromSeed(seed);
  assert.equal(a.ask, b.ask);
  assert.equal(a.nsk, b.nsk);
  const fvk = await fullViewingKey(a);
  assert.equal(fvk.ak, await poseidon([a.ask]));
  // 2^250 < l < 2^251: a 251-bit mask would not guarantee ivk < l, so the
  // mask is 250 bits and every derived ivk must be below the subgroup order.
  assert.ok(1n << 250n < BJJ_SUBGROUP_ORDER && BJJ_SUBGROUP_ORDER < 1n << 251n);
  assert.equal(SCALAR_MASK, (1n << 250n) - 1n);
  for (let i = 0; i < 64; i++) {
    const s = new Uint8Array(32).fill(i);
    const { ivk } = await fullViewingKey(spendingKeyFromSeed(s));
    assert.ok(ivk < BJJ_SUBGROUP_ORDER, `ivk for seed ${i} exceeds l`);
  }
});

test("diversified addresses round-trip through bech32m and are unlinkable", async () => {
  const bjj = await BabyJub.load();
  const fvk = await fullViewingKey(spendingKeyFromSeed(seed));
  const a1 = newAddress(bjj, fvk.ivk);
  const a2 = newAddress(bjj, fvk.ivk);
  assert.notDeepEqual(a1.pkd, a2.pkd);
  assert.ok(bjj.inSubgroup(a1.pkd));
  const s = encodeAddress(bjj, a1, "tscash");
  assert.ok(s.startsWith("tscash1"));
  const back = decodeAddress(bjj, s);
  assert.deepEqual(back.address.d, a1.d);
  assert.deepEqual(back.address.pkd, a1.pkd);
  // pk_d = [ivk] g_d
  const gd = groupHash(bjj, a1.d)!;
  assert.deepEqual(bjj.mulScalar(gd, fvk.ivk), a1.pkd);
});

test("note encryption: receiver decrypts with ivk, strangers cannot, sender recovers with ovk", async () => {
  const bjj = await BabyJub.load();
  const sender = spendingKeyFromSeed(new Uint8Array(32).fill(1));
  const receiverSk = spendingKeyFromSeed(new Uint8Array(32).fill(2));
  const stranger = await fullViewingKey(spendingKeyFromSeed(new Uint8Array(32).fill(3)));
  const receiver = await fullViewingKey(receiverSk);
  const to = newAddress(bjj, receiver.ivk);
  const gd = groupHash(bjj, to.d)!;
  const asset = assetId(new PublicKey("11111111111111111111111111111111"));
  const note = { asset, value: 1234n, gd, pkd: to.pkd, ...freshRandomness() };
  const memo = new TextEncoder().encode("hello");
  const { ciphertext, esk } = encryptNote(bjj, to, note, memo, true);
  assert.equal(ciphertext.length, NOTE_CIPHERTEXT_LEN_NO_MEMO + 64); // 5-byte memo → one 64-byte bucket
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
  // The circuit checks [8]·g_d ≠ O (not of small order), the same as Sapling;
  // it does not prove g_d ∈ prime-order subgroup. A point g_d' = g_d + T with
  // T of order 8 therefore satisfies the circuit. This test shows why that is
  // acceptable: the receiver re-derives g_d from the diversifier and
  // recomputes the commitment, so a note built on g_d' is refused and the
  // sender has only burned their own funds.
  const bjj = await BabyJub.load();
  const T = bjj.mulScalar(bjj.generator, BJJ_SUBGROUP_ORDER);
  assert.ok(bjj.inCurve(T) && !bjj.isIdentity(T) && bjj.isIdentity(bjj.mulScalar(T, 8n)), "T has order dividing 8");
  const receiverSk = spendingKeyFromSeed(new Uint8Array(32).fill(9));
  const receiver = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(9));
  const fvk = await fullViewingKey(receiverSk);
  const to = receiver.address();
  const gd = groupHash(bjj, to.d)!;
  const gdTorsion = bjj.add(gd, T);
  assert.ok(bjj.inCurve(gdTorsion));
  assert.ok(!bjj.isIdentity(bjj.mulScalar(gdTorsion, 8n)), "passes the circuit's [8]P ≠ O check");
  assert.ok(!bjj.inSubgroup(gdTorsion), "but is not in the prime-order subgroup");
  const asset = assetId(SystemProgram.programId);

  const honest = { asset, value: 500n, gd, pkd: to.pkd, ...freshRandomness() };
  const honestCt = encryptNote(bjj, to, honest, undefined, false).ciphertext;
  assert.ok(await receiver.scan({ index: 0, commitment: await noteCommitment(honest), ciphertext: honestCt }, asset), "honest note is credited");

  const bad = { ...honest, gd: gdTorsion, ...freshRandomness() };
  const badCt = encryptNote(bjj, to, bad, undefined, false).ciphertext;
  assert.equal(await receiver.scan({ index: 1, commitment: await noteCommitment(bad), ciphertext: badCt }, asset), null, "torsion g_d is refused");
  // and the same with a pk_d that is not [ivk]·g_d (a wrong recipient key)
  const wrongPkd = { ...honest, pkd: bjj.mulScalar(gd, fvk.ivk + 1n), ...freshRandomness() };
  const wrongCt = encryptNote(bjj, to, wrongPkd, undefined, false).ciphertext;
  assert.equal(await receiver.scan({ index: 2, commitment: await noteCommitment(wrongPkd), ciphertext: wrongCt }, asset), null, "wrong pk_d is refused");
});

test("a torsion component in epk cannot probe ivk mod 8 (cofactor-cleared key agreement)", async () => {
  // Attack without cofactor clearing: epk' = epk + T, key from [esk]pk_d + [k]T.
  // The recipient decrypts iff ivk ≡ k (mod 8), leaking three bits of ivk per
  // accepted note. With shared = [8·sk]·P the torsion vanishes on both sides,
  // so every such ciphertext decrypts to the same key as the honest one and
  // the sender learns nothing (and the tampered epk still fails the AEAD).
  const bjj = await BabyJub.load();
  const T = bjj.mulScalar(bjj.generator, BJJ_SUBGROUP_ORDER);
  const receiver = await fullViewingKey(spendingKeyFromSeed(new Uint8Array(32).fill(11)));
  const to = newAddress(bjj, receiver.ivk);
  const gd = groupHash(bjj, to.d)!;
  const note = { asset: assetId(SystemProgram.programId), value: 7n, gd, pkd: to.pkd, ...freshRandomness() };
  const { ciphertext, epk } = encryptNote(bjj, to, note, undefined, false);
  assert.ok(tryDecryptNote(bjj, receiver.ivk, ciphertext));
  // Replace epk by epk + T. If the receiver's shared secret depended on the
  // torsion part, some k in 0..7 would make a crafted ciphertext decrypt.
  const epkT = bjj.add(epk, T);
  const tampered = new Uint8Array(ciphertext);
  tampered.set(bjj.compress(epkT), 0);
  // The receiver derives its key from [8·ivk]·(epk+T) = [8·ivk]·epk: identical
  // secret, but the key also commits to the encoded epk, so the AEAD fails.
  assert.equal(tryDecryptNote(bjj, receiver.ivk, tampered), null);
  // Independent of ivk mod 8: the shared point computed from epk+T equals the
  // one from epk for *every* ivk residue, so there is no residue to learn.
  for (let k = 0n; k < 8n; k++) {
    const ivkK = (receiver.ivk & ~7n) | k;
    assert.deepEqual(bjj.mulScalar(epkT, ivkK * 8n), bjj.mulScalar(epk, ivkK * 8n));
  }
});

test("merkle tree paths verify and dummy path is well-formed", async () => {
  const t = new MerkleTree(26);
  await t.whenReady();
  const leaves = [1n, 2n, 3n, 4n, 5n];
  for (const l of leaves) await t.insert(l);
  const root = await t.root();
  for (let i = 0; i < leaves.length; i++) {
    assert.ok(await verifyPath(leaves[i], await t.path(i), root));
  }
  assert.equal(t.dummyPath().elements.length, 26);
  assert.equal(t.emptyLeaf, await poseidon([t["zeros"][0] === t.emptyLeaf ? (await import("./merkle.js")).EMPTY_LEAF_PREIMAGE : 0n]));
});

test("ext data serialization round-trips and hashes into the field", () => {
  const ext = {
    recipient: new PublicKey("11111111111111111111111111111111"),
    relayer: PublicKey.default,
    relayerFee: 42n,
    exitTarget: NO_EXIT,
    exitData: new Uint8Array([1, 2, 3]),
    ciphertexts: [new Uint8Array(10).fill(9), new Uint8Array(5).fill(8)],
    outCiphertext: new Uint8Array(3),
  };
  const bytes = serializeExtData(ext);
  const back = deserializeExtData(bytes);
  assert.equal(back.relayerFee, 42n);
  assert.deepEqual(back.ciphertexts[0], ext.ciphertexts[0]);
  assert.ok(extDataHash(ext) < P);
});

test("public amount encoding", () => {
  assert.equal(decodePublicAmount(encodePublicAmount(-5n)), -5n);
  assert.equal(decodePublicAmount(encodePublicAmount(5n)), 5n);
  assert.equal(encodePublicAmount(-1n), P - 1n);
});

test("nullifier depends on position", async () => {
  const a = await nullifier(1n, 2n, 0);
  const b = await nullifier(1n, 2n, 1);
  assert.notEqual(a, b);
});

test("seed derivation: passphrase changes the seed, backup round-trips", async () => {
  const sig = new Uint8Array(64).fill(3);
  const a = await seedFromSignature(sig);
  const b = await seedFromSignature(sig, "correct horse");
  const c = await seedFromSignature(sig, "correct horse");
  assert.equal(a.length, 32);
  assert.notDeepEqual(a, b);
  assert.deepEqual(b, c);
  // NFKC: composed and decomposed forms derive the same key
  assert.deepEqual(await seedFromSignature(sig, "caf\u00e9"), await seedFromSignature(sig, "cafe\u0301"));
  assert.deepEqual(seedFromBackup(seedToBackup(b)), b);
  assert.throws(() => seedFromBackup("scashseed1zz"));
  assert.ok(SPENDING_KEY_MESSAGE.includes("SPEND"));
});

test("vault error table matches programs/scash_vault/src/error.rs and classifies simulation errors", async () => {
  const src = await readFile(new URL("../../programs/scash_vault/src/error.rs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("pub enum VaultError"), src.indexOf("impl From<VaultError>"));
  const variants = [...body.matchAll(/^\s{4}([A-Z][A-Za-z0-9]*),\s*$/gm)].map((m) => m[1]);
  assert.deepEqual([...VAULT_ERRORS], variants, "SDK VAULT_ERRORS must list every VaultError variant in declaration order");

  assert.equal(vaultErrorName({ InstructionError: [0, { Custom: 5 }] }), "UnknownRoot");
  assert.equal(vaultErrorName({ InstructionError: [2, { Custom: 7 }] }), "InvalidProof");
  assert.equal(vaultErrorName({ InstructionError: [0, { Custom: 9 }] }), "NullifierSpent");
  assert.equal(vaultErrorName({ InstructionError: [0, { Custom: 999 }] }), undefined);
  assert.equal(vaultErrorName({ InstructionError: [0, "InvalidAccountData"] }), undefined);
  assert.equal(vaultErrorName("InsufficientFundsForFee"), undefined);
  assert.equal(vaultErrorName(null), undefined);

  assert.equal(isStaleRootRejection({ error: "simulation failed", vaultError: "UnknownRoot" }), true);
  assert.equal(isStaleRootRejection({ error: "simulation failed", vaultError: "InvalidProof" }), true);
  assert.equal(isStaleRootRejection({ error: "simulation failed", vaultError: "NullifierSpent" }), false);
  assert.equal(isStaleRootRejection({ error: "fee too low" }), false);
  assert.equal(isStaleRootRejection(undefined), false);
});

test("passphrase strength: the time-to-crack arithmetic is 2^(b-1)/rate", () => {
  const day = 86400, year = 365 * day;
  // 40 bits: 2^39 / 1e5 s ≈ 63.6 days, not millennia
  assert.ok(Math.abs(expectedSecondsToCrack(40) / day - 63.6) < 0.1);
  // 50 bits (the floor): ≈ 178 years
  assert.ok(Math.abs(expectedSecondsToCrack(PASSPHRASE_MIN_BITS) / year - 178) < 1);
  // 55 bits: ≈ 5.7k years
  assert.ok(Math.abs(expectedSecondsToCrack(55) / year - 5708) < 10);
  assert.equal(expectedSecondsToCrack(0), 0);
});

test("passphrase strength: leaked, common-word and short inputs are weak; phrases are scored as phrases", () => {
  for (const weak of [
    "", "password", "Password1!", "correct horse battery staple", "correcthorsebatterystaple", "aaaaaaaaaaaaaaaaaaaa", "abcdefghijklmnopqrst",
    "12345678", "Tr0ub4d&", "Tr0ub4d&3xq!", "to the moon and back", "i love my dog so much",
  ]) {
    const s = passphraseStrength(weak);
    assert.equal(s.level, "weak", `${JSON.stringify(weak)} scored ${s.bits}`);
    assert.ok(s.bits < PASSPHRASE_MIN_BITS);
  }
  // Leaked passwords score zero even with the usual suffix
  assert.equal(passphraseStrength("password123").bits, 0);
  assert.equal(passphraseStrength("Solana!").bits, 0);
  // A long sentence of common words must NOT be rescued by its character count
  const sentence = passphraseStrength("the quick brown fox jumps over the lazy dog today");
  assert.ok(sentence.bits < 60, `sentence scored ${sentence.bits}`);
  // 14 mixed characters clear the floor; 18 are strong
  assert.equal(passphraseStrength("Tr0ub4d&3xq!Lm").level, "fair");
  assert.equal(passphraseStrength("Tr0ub4d&3xq!Lm9#Vp").level, "strong");
  // Five uncommon words are fair, seven are strong; repeats do not count
  const five = passphraseStrength("velvet hydrant obelisk cinnamon quasar");
  assert.equal(five.level, "fair");
  assert.equal(five.bits, 55);
  assert.equal(passphraseStrength("velvet hydrant obelisk cinnamon quasar velvet hydrant").bits, 55);
  assert.equal(passphraseStrength("velvet hydrant obelisk cinnamon quasar lantern furrow").level, "strong");
  // NFKC-equivalent inputs get the same score
  assert.equal(passphraseStrength("caf\u00e9 velours quasar").bits, passphraseStrength("cafe\u0301 velours quasar").bits);
});

test("a relayed 2-in/2-out send with the maximum memo fits in one packet", async () => {
  // Real serialization of the real instruction, with a lookup table holding
  // the same static addresses the deployment uses. This is the test that
  // pins MEMO_MAX; the only approximation is the proof bytes.
  const payer = Keypair.generate().publicKey; // relayer
  const mint = SystemProgram.programId;
  const splMint = Keypair.generate().publicKey;
  const table = new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined,
      addresses: staticAddresses([{ mint }, { mint: splMint }], undefined, payer),
    },
  });
  const bjj = await BabyJub.load();
  const sk = spendingKeyFromSeed(seed);
  const fvk = await fullViewingKey(sk);
  const to = newAddress(bjj, fvk.ivk);
  const gd = groupHash(bjj, to.d)!;
  const asset = assetId(mint);
  const note = { asset, value: 1n, gd, pkd: to.pkd, ...freshRandomness() };
  const memo = new Uint8Array(MEMO_MAX).fill(0x61);
  const c0 = encryptNote(bjj, to, note, memo, true);
  const c1 = encryptNote(bjj, to, note, undefined, false);
  const out = encryptOutgoing(bjj, sk.ovk, 1n, to.pkd, c0.esk);
  const proof = {
    circuit: "transact2x2" as const,
    proof: { piA: [0n, 0n] as [bigint, bigint], piB: [[0n, 0n], [0n, 0n]] as [[bigint, bigint], [bigint, bigint]], piC: [0n, 0n] as [bigint, bigint] },
    publicSignals: [],
    proofBytes: new Uint8Array(256).fill(1),
    nullifiers: [randomField(), randomField()],
    outCommitments: [randomField(), randomField()],
  };
  // In a send, ext.recipient is the relayer's fee destination (see wallet.ts).
  const sizeFor = (m: PublicKey, feeDest: PublicKey, cts: Uint8Array[]) => {
    const ext = { recipient: feeDest, relayer: payer, relayerFee: 1_500_000n, exitTarget: NO_EXIT, exitData: new Uint8Array(0), ciphertexts: cts, outCiphertext: out };
    const ix = transactIx({ payer, mint: m, depositor: payer, depositorSource: payer, recipient: feeDest, relayerDest: feeDest }, proof, 7, -1n, 0n, ext);
    return buildV0(payer, [ix], "11111111111111111111111111111111", table).serialize().length;
  };
  const sol = sizeFor(mint, payer, [c0.ciphertext, c1.ciphertext]);
  const spl = sizeFor(splMint, ataFor(payer, splMint), [c0.ciphertext, c1.ciphertext]);
  assert.ok(sol <= 1232, `SOL send with ${MEMO_MAX}-byte memo serializes to ${sol} > 1232`);
  assert.ok(spl <= 1232, `SPL send with ${MEMO_MAX}-byte memo serializes to ${spl} > 1232`);
  // and one more bucket would not fit — documents why MEMO_MAX is what it is
  const bigger = new Uint8Array(c0.ciphertext.length + MEMO_BUCKET);
  const over = sizeFor(mint, payer, [bigger, c1.ciphertext]);
  assert.ok(over > 1232, `a ${MEMO_MAX + MEMO_BUCKET}-byte memo would still fit (${over}); MEMO_MAX can be raised`);
});
