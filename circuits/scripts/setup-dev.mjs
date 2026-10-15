// Development-only Groth16 setup: downloads a Hermez Powers of Tau file,
// runs a single local phase-2 contribution and exports the verification key.
//
// NEVER use these keys in production. Production keys come from the public
// multi-party ceremony described in ceremony/README.md.
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import * as snarkjs from "snarkjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const build = join(root, "build");
const ptauDir = join(root, "ptau");
mkdirSync(ptauDir, { recursive: true });

const circuits = process.argv.slice(2).length ? process.argv.slice(2) : ["transact2x3", "transact4x3"];

// A single, pinned Powers of Tau file. The dev VK compiled into the program is
// derived from (r1cs, ptau, fixed entropy); if any of the three changes the
// on-chain verifier rejects every proof, so the ptau is pinned by SHA-256
// rather than "whatever mirror answered first".
const PTAU = {
  16: {
    url: "https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_16.ptau",
    sha256: "ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9",
  },
  17: {
    url: "https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_17.ptau",
    sha256: "f807e065fde53f72f4bf4d57140fab85b26daa6cc95bdfec7cce93622b3a367c",
  },
};

async function sha256File(file) {
  const { createHash } = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const h = createHash("sha256");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

async function ptauFor(power) {
  const pin = PTAU[power];
  if (!pin) throw new Error(`no pinned ptau for 2^${power}; add it to setup-dev.mjs`);
  const file = join(ptauDir, `ppot_0080_${power}.ptau`);
  if (!(existsSync(file) && statSync(file).size > 1_000_000)) {
    console.log(`[setup] downloading ${pin.url}`);
    const res = await fetch(pin.url);
    if (!res.ok || !res.body) throw new Error(`ptau download failed: ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  }
  const digest = await sha256File(file);
  if (digest !== pin.sha256) {
    throw new Error(`ptau checksum mismatch for ${file}: ${digest} != ${pin.sha256}`);
  }
  console.log(`[setup] ptau 2^${power} sha256=${digest}`);
  return file;
}

function powerFor(nConstraints) {
  let p = 1;
  while (2 ** p < nConstraints + 1) p++;
  return Math.max(p, 12);
}

for (const name of circuits) {
  const dir = join(build, name);
  const r1cs = join(dir, `${name}.r1cs`);
  if (!existsSync(r1cs)) throw new Error(`run build first: ${r1cs} missing`);
  const info = await snarkjs.r1cs.info(r1cs);
  const power = powerFor(Number(info.nConstraints));
  const ptau = await ptauFor(power);
  const zkey0 = join(dir, `${name}_0000.zkey`);
  const zkey = join(dir, `${name}_dev.zkey`);
  console.log(`[setup] ${name}: ${info.nConstraints} constraints -> ptau 2^${power}`);
  await snarkjs.zKey.newZKey(r1cs, ptau, zkey0);
  // Deterministic on purpose: DEV keys must be reproducible so that the VK
  // compiled into the program matches a zkey rebuilt anywhere (CI, laptops).
  // `zKey.contribute` always mixes in OS randomness, so we use a *beacon*
  // step with a fixed, public hash instead. Anyone can derive the toxic
  // waste, which is exactly why these keys are never used on mainnet
  // (see ceremony/README.md).
  const beacon = process.env.SCASH_DEV_BEACON ?? "73636173682d6465762d626561636f6e2d6e6f742d666f722d70726f64756374"; // "scash-dev-beacon-not-for-product" as hex
  await snarkjs.zKey.beacon(zkey0, zkey, "scash dev beacon", beacon, 10);
  const vk = await snarkjs.zKey.exportVerificationKey(zkey);
  const { writeFileSync, rmSync } = await import("node:fs");
  writeFileSync(join(dir, `${name}_vk.json`), JSON.stringify(vk, null, 2));
  rmSync(zkey0, { force: true });
  console.log(`[setup] ${name}: wrote ${zkey}`);
}
process.exit(0);
