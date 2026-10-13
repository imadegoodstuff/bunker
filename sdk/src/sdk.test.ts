import { test } from "node:test";
import assert from "node:assert/strict";
import { AddressLookupTableAccount, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { BabyJub, poseidon } from "./crypto.js";
import { spendingKeyFromSeed, fullViewingKey, newAddress, encodeAddress, decodeAddress, groupHash, seedFromSignature, seedToBackup, seedFromBackup, SPENDING_KEY_MESSAGE } from "./keys.js";
import { encryptNote, tryDecryptNote, encryptOutgoing, decryptOutgoing, decryptNoteAsSender, NOTE_CIPHERTEXT_LEN, NOTE_CIPHERTEXT_LEN_NO_MEMO, MEMO_MAX, MEMO_BUCKET } from "./encryption.js";
import { transactIx } from "./program.js";
import { staticAddresses, buildV0, ataFor } from "./lookup.js";
import { noteCommitment, nullifier, assetId, freshRandomness, noteRandomness } from "./note.js";
import { MerkleTree, verifyPath } from "./merkle.js";
import { extDataHash, serializeExtData, deserializeExtData, NO_EXIT } from "./extdata.js";
import { encodePublicAmount, decodePublicAmount, P, randomField } from "./field.js";

const seed = new Uint8Array(32).fill(7);

test("key derivation is deterministic and ivk fits 251 bits", async () => {
  const a = spendingKeyFromSeed(seed);
  const b = spendingKeyFromSeed(seed);
  assert.equal(a.ask, b.ask);
  assert.equal(a.nsk, b.nsk);
  const fvk = await fullViewingKey(a);
  assert.ok(fvk.ivk < 1n << 251n);
  assert.equal(fvk.ak, await poseidon([a.ask]));
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
