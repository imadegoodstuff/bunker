// Produces a real transact2x2 proof with the SDK and writes a fixture consumed
// by the Rust verifier test (programs/scash_vault/tests/verify_fixture.rs).
// Also benchmarks proving time in Node.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey } from "@solana/web3.js";
import {
  BabyJub, MerkleTree, ShieldedWallet, assetId, extDataHash, NO_EXIT, toHex, bigIntToBytesBE,
  groupHash, noteCommitment, randomField, prove, encryptNote,
} from "../../sdk/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const art = (name) => ({
  wasm: join(root, "build", name, `${name}_js`, `${name}.wasm`),
  zkey: join(root, "build", name, `${name}_dev.zkey`),
});
const artifacts = { transact2x2: art("transact2x2"), transact4x2: art("transact4x2") };

const wallet = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(42));
const bjj = await BabyJub.load();
const asset = assetId(new PublicKey("11111111111111111111111111111111"));
const tree = new MerkleTree(26);
await tree.whenReady();

// 1. shield 1_000 shares into a note for ourselves
const self = wallet.address();
const selfGd = groupHash(bjj, self.d);
const n0 = { asset, value: 1000n, gd: selfGd, pkd: self.pkd, rho: randomField(), rcm: randomField() };
const n1 = { asset, value: 0n, gd: selfGd, pkd: self.pkd, rho: randomField(), rcm: randomField() };
const c0 = encryptNote(bjj, self, n0, undefined, false);
const c1 = encryptNote(bjj, self, n1, undefined, false);
const ext = {
  recipient: PublicKey.default, relayer: PublicKey.default, relayerFee: 0n, exitTarget: NO_EXIT,
  exitData: new Uint8Array(0), ciphertexts: [c0.ciphertext, c1.ciphertext], outCiphertext: new Uint8Array(0),
};
const extHash = extDataHash(ext);

console.time("prove shield (2x2)");
const shield = await prove({
  spend: wallet.spend, fvk: wallet.fvk, root: await tree.root(), asset, publicAmount: 1000n,
  extDataHash: extHash, aspRoot: 0n, inputs: [], outputs: [n0, n1], dummyPath: tree.dummyPath(),
  self: { gd: selfGd, pkd: self.pkd },
}, artifacts);
console.timeEnd("prove shield (2x2)");

// 2. insert, then spend: unshield 400, change 600
const cm0 = await noteCommitment(n0);
const cm1 = await noteCommitment(n1);
if (cm0 !== shield.outCommitments[0] || cm1 !== shield.outCommitments[1]) throw new Error("commitment mismatch");
const pos0 = await tree.insert(cm0);
await tree.insert(cm1);
const change = { asset, value: 600n, gd: selfGd, pkd: self.pkd, rho: randomField(), rcm: randomField() };
const zero = { asset, value: 0n, gd: selfGd, pkd: self.pkd, rho: randomField(), rcm: randomField() };
const ext2 = { ...ext, relayerFee: 10n };
console.time("prove unshield (2x2)");
const spend = await prove({
  spend: wallet.spend, fvk: wallet.fvk, root: await tree.root(), asset, publicAmount: -400n,
  extDataHash: extDataHash(ext2), aspRoot: 0n,
  inputs: [{ note: { ...n0, commitment: cm0, position: pos0 }, path: await tree.path(pos0) }],
  outputs: [change, zero], dummyPath: tree.dummyPath(), self: { gd: selfGd, pkd: self.pkd },
}, artifacts);
console.timeEnd("prove unshield (2x2)");

const toFixture = (p) => ({
  circuit: p.circuit,
  raw: { proof: { pi_a: p.proof.piA.map(String), pi_b: p.proof.piB.map((r) => r.map(String)), pi_c: p.proof.piC.map(String) }, publicSignals: p.publicSignals.map(String) },
  proof: toHex(p.proofBytes),
  public_inputs: p.publicSignals.map((s) => toHex(bigIntToBytesBE(s))),
});
const out = join(root, "..", "programs", "scash_vault", "tests", "fixtures");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "transact2x2.json"), JSON.stringify({ shield: toFixture(shield), spend: toFixture(spend) }, null, 2));
console.log("wrote", join(out, "transact2x2.json"));
console.log("public signals (spend):", spend.publicSignals.length);
process.exit(0);
