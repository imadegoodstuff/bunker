// Adversarial witness tests for transact2x3.
//
// Each case starts from a witness that proves fine, applies exactly one
// tampering, and asserts that the circuit refuses to produce a witness
// (circom asserts on every `===` during witness generation, so a rejected
// witness means the tampered statement is unsatisfiable, not merely that the
// SDK declined to build it). The honest witness is proved once at the start so
// a broken build cannot make every case "pass" by failing for the wrong reason.
//
// Runs against the artifacts in circuits/build; `npm run -w circuits build`
// and `setup:dev` must have been run first (CI does both).

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { groth16 } from "snarkjs";
import {
  BabyJub, MerkleTree, ShieldedWallet, assetId, extDataHash, NO_EXIT, NO_RESHIELD, NATIVE_TOKEN, ZERO_ADDRESS,
  groupHash, noteCommitment, freshRandomness, encryptNote, buildWitnessInput, P,
} from "../../sdk/dist/index.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wasm = join(root, "build", "transact2x3", "transact2x3_js", "transact2x3.wasm");
const zkey = join(root, "build", "transact2x3", "transact2x3_dev.zkey");

const ORDER_TWO = [0n, P - 1n]; // (0, -1): the unique point of order 2 on a twisted Edwards curve

let honest; // { input, outputs, ... } for a 1-in / 3-out unshield
let bjj;

/** Commitment of output `j` with a different value, so value tamperings fail on balance/range, not on cm. */
async function cmWith(j, value) {
  return (await noteCommitment({ ...honest.params.outputs[j], value })).toString();
}

async function rejects(mutate, label) {
  const input = structuredClone(honest.input);
  mutate(input);
  await assert.rejects(groth16.fullProve(input, wasm, zkey), /Assert Failed|Error in template|not satisfied/i, `${label}: circuit accepted a tampered witness`);
}

before(async () => {
  assert.ok(existsSync(wasm) && existsSync(zkey), "circuit artifacts missing; run build + setup:dev");
  bjj = await BabyJub.load();
  const wallet = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(1));
  const stranger = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(2));
  const asset = assetId(NATIVE_TOKEN);
  const tree = new MerkleTree(26);
  await tree.whenReady();

  const self = wallet.address();
  const selfGd = groupHash(bjj, self.d);
  const other = stranger.address();
  const otherGd = groupHash(bjj, other.d);

  // one real note of 1000 in the tree
  const n0 = { asset, token: NATIVE_TOKEN, value: 1000n, gd: selfGd, pkd: self.pkd, ...freshRandomness() };
  const cm0 = await noteCommitment(n0);
  const pos0 = await tree.insert(cm0);

  // unshield 400 to the public, 590 change to self, a 10 fee note to the relayer (the stranger here)
  const change = { asset, token: NATIVE_TOKEN, value: 590n, gd: selfGd, pkd: self.pkd, ...freshRandomness() };
  const zero = { asset, token: NATIVE_TOKEN, value: 0n, gd: selfGd, pkd: self.pkd, ...freshRandomness() };
  const fee = { asset, token: NATIVE_TOKEN, value: 10n, gd: otherGd, pkd: other.pkd, ...freshRandomness() };
  const c0 = encryptNote(bjj, self, change, undefined, false);
  const c2 = encryptNote(bjj, other, fee, undefined, false);
  const ext = {
    recipient: ZERO_ADDRESS, exitTarget: NO_EXIT, exitData: new Uint8Array(0),
    ciphertext0: c0.ciphertext, ciphertext1: new Uint8Array(0), ciphertext2: c2.ciphertext, outCiphertext: new Uint8Array(0), reshield: NO_RESHIELD,
    validUntil: 0n, complianceData: new Uint8Array(0),
  };
  const params = {
    spend: wallet.spend, fvk: wallet.fvk, root: await tree.root(), asset, publicAmount: -400n,
    extDataHash: extDataHash(ext, 56, ZERO_ADDRESS), aspRoot: 0n,
    inputs: [{ note: { ...n0, commitment: cm0, position: pos0 }, path: await tree.path(pos0) }],
    outputs: [change, zero, fee], dummyPath: tree.dummyPath(), self: { gd: selfGd, pkd: self.pkd },
  };
  const built = await buildWitnessInput(params);
  honest = { ...built, params, other, otherGd, stranger, tree, n0, pos0 };

  // the honest witness must prove
  const { publicSignals } = await groth16.fullProve(honest.input, wasm, zkey);
  assert.equal(publicSignals.length, 10);
});

// ---- outputs ---------------------------------------------------------------

/** Commitment of output 0 with a different address, so address tamperings fail on the point checks, not on cm. */
async function cmWithAddress(gd, pkd) {
  return (await noteCommitment({ ...honest.params.outputs[0], gd, pkd })).toString();
}

test("output pk_d off the curve is rejected", async () => {
  const o = honest.params.outputs[0];
  const pkd = [o.pkd[0] + 1n, o.pkd[1]];
  const cm = await cmWithAddress(o.gd, pkd);
  await rejects((w) => { w.outPkd[0] = pkd.map(String); w.outCommitments[0] = cm; }, "pk_d off-curve");
});

test("output g_d off the curve is rejected", async () => {
  const o = honest.params.outputs[0];
  const gd = [o.gd[0], o.gd[1] + 1n];
  const cm = await cmWithAddress(gd, o.pkd);
  await rejects((w) => { w.outGd[0] = gd.map(String); w.outCommitments[0] = cm; }, "g_d off-curve");
});

test("output g_d of small order is rejected even though it is on the curve", async () => {
  const o = honest.params.outputs[0];
  for (const gd of [ORDER_TWO, [0n, 1n]]) {
    const cm = await cmWithAddress(gd, o.pkd);
    await rejects((w) => { w.outGd[0] = gd.map(String); w.outCommitments[0] = cm; }, `g_d ${gd[1] === 1n ? "identity" : "order 2"}`);
  }
});

test("output commitment that does not match the output note is rejected", async () => {
  await rejects((w) => { w.outCommitments[0] = (BigInt(w.outCommitments[0]) + 1n).toString(); }, "cm mismatch");
});

test("output value of 2^64 or more is rejected", async () => {
  // Balance holds in the field (590 + 2^64 and -2^64 mod p sum to 590) and
  // the commitments are recomputed, so only the 64-bit range check can fire.
  const v0 = 590n + (1n << 64n);
  const v1 = P - (1n << 64n);
  const [c0, c1] = await Promise.all([cmWith(0, v0), cmWith(1, v1)]);
  await rejects((w) => {
    w.outValue[0] = v0.toString();
    w.outValue[1] = v1.toString();
    w.outCommitments[0] = c0;
    w.outCommitments[1] = c1;
  }, "value range");
});

// ---- balance ---------------------------------------------------------------

test("creating value out of nothing is rejected", async () => {
  const c0 = await cmWith(0, 591n);
  await rejects((w) => { w.outValue[0] = "591"; w.outCommitments[0] = c0; }, "mint 1 unit");
});

test("changing the public amount without changing the notes is rejected", async () => {
  await rejects((w) => { w.publicAmount = (BigInt(w.publicAmount) + 1n).toString(); }, "public amount");
});

// ---- inputs ----------------------------------------------------------------

test("spending a note that belongs to someone else is rejected", async () => {
  await rejects((w) => {
    w.inGd[0] = honest.otherGd.map(String);
    w.inPkd[0] = honest.other.pkd.map(String);
  }, "foreign note");
});

test("a real input with a wrong Merkle root is rejected", async () => {
  await rejects((w) => { w.root = (BigInt(w.root) + 1n).toString(); }, "wrong root");
});

test("a real input with a tampered Merkle path is rejected", async () => {
  await rejects((w) => { w.inPathElements[0][3] = (BigInt(w.inPathElements[0][3]) + 1n).toString(); }, "path");
});

test("a nullifier that does not match (nk, rho, position) is rejected", async () => {
  await rejects((w) => { w.nullifiers[0] = (BigInt(w.nullifiers[0]) + 1n).toString(); }, "nullifier");
});

test("spending the same note twice in one transaction is rejected", async () => {
  // Input 1 becomes a copy of input 0 (valid path, valid ownership, valid
  // nullifier), and output 1 is rebuilt so the balance and commitment hold:
  // 1000 + 1000 - 400 = 590 + 1000 + 10. The only violated constraint left is
  // nullifier distinctness.
  const out1 = { ...honest.params.outputs[1], value: 1000n };
  const cm1 = (await noteCommitment(out1)).toString();
  await rejects((w) => {
    for (const k of ["inValue", "inGd", "inPkd", "inRho", "inRcm", "inPathElements", "inPathIndices", "inAspPathElements", "inAspPathIndices", "nullifiers"]) {
      w[k][1] = structuredClone(w[k][0]);
    }
    w.outValue[1] = "1000";
    w.outCommitments[1] = cm1;
  }, "double spend in one tx");
});

test("a dummy (zero-value) input cannot carry value", async () => {
  // Input 1 is the dummy with a zero path. Give it value, balance the
  // outputs and recompute the commitment: the Merkle check that is skipped
  // for zero-value inputs must now be enforced and fail.
  const c0 = await cmWith(0, 595n);
  await rejects((w) => {
    w.inValue[1] = "5";
    w.outValue[0] = "595";
    w.outCommitments[0] = c0;
  }, "dummy with value");
});

// ---- asset -----------------------------------------------------------------

test("when value crosses the boundary, the public asset must equal the notes' asset", async () => {
  await rejects((w) => { w.assetPublic = (BigInt(w.assetPublic) + 1n).toString(); }, "assetPublic != asset on an unshield");
  await rejects((w) => { w.assetPublic = "0"; }, "assetPublic = 0 on an unshield");
});

test("a private send (publicAmount = 0) proves with assetPublic = 0 and the asset hidden", async () => {
  // rebalance to a pure in-pool transfer: 1000 in = 990 to self + 10 fee, nothing public
  const input = structuredClone(honest.input);
  input.publicAmount = "0";
  input.assetPublic = "0";
  input.outValue[0] = "990";
  input.outCommitments[0] = await cmWith(0, 990n);
  const { publicSignals } = await groth16.fullProve(input, wasm, zkey);
  assert.equal(publicSignals[2], "0", "the asset is not among the public signals of a private send");
  // and the asset inside still has to be consistent across inputs and outputs: a foreign-asset output breaks its commitment
  const foreignCm = (await noteCommitment({ ...honest.params.outputs[0], value: 990n, asset: assetId("0x1111111111111111111111111111111111111111") })).toString();
  await assert.rejects(groth16.fullProve({ ...input, outCommitments: [foreignCm, input.outCommitments[1], input.outCommitments[2]] }, wasm, zkey), /Assert Failed|Error in template|not satisfied/i);
});

// ---- asp -------------------------------------------------------------------

test("with an association-set root, a real input needs a valid ASP path", async () => {
  await rejects((w) => { w.aspRoot = "12345"; }, "asp root without membership");
});
