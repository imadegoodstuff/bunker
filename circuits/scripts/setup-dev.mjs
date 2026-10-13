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

const circuits = process.argv.slice(2).length ? process.argv.slice(2) : ["transact2x2", "transact4x2"];

async function ptauFor(power) {
  const file = join(ptauDir, `powersOfTau28_hez_final_${power}.ptau`);
  if (existsSync(file) && statSync(file).size > 1_000_000) return file;
  const urls = [
    `https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_${power}.ptau`,
    `https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_${power}.ptau`,
    `https://pse-trusted-setup-ppot.s3.eu-central-1.amazonaws.com/pot28_0080/ppot_0080_${power}.ptau`,
  ];
  for (const url of urls) {
    console.log(`[setup] downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      console.log(`[setup] ${res.status}, trying next mirror`);
      continue;
    }
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    return file;
  }
  throw new Error("ptau download failed from all mirrors");
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
  await snarkjs.zKey.contribute(zkey0, zkey, "scash dev contribution", String(Date.now()));
  const vk = await snarkjs.zKey.exportVerificationKey(zkey);
  const { writeFileSync, rmSync } = await import("node:fs");
  writeFileSync(join(dir, `${name}_vk.json`), JSON.stringify(vk, null, 2));
  rmSync(zkey0, { force: true });
  console.log(`[setup] ${name}: wrote ${zkey}`);
}
process.exit(0);
