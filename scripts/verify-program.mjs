#!/usr/bin/env node
// Compare the bytecode deployed under a program id with a locally built .so.
//
//   node scripts/verify-program.mjs <program-id> <path/to/program.so> [--rpc URL]
//   node scripts/verify-program.mjs <program-id> --hash-only [--rpc URL]
//
// For the upgradeable BPF loader the program account holds the ProgramData
// address; ProgramData is a 45-byte header (enum tag, deploy slot, upgrade
// authority option) followed by the ELF, zero-padded to the allocated size.
// The script hashes the on-chain ELF prefix of the local file's length,
// checks that every byte after it is zero, and prints both SHA-256 digests.
// Exit 0 on match, 1 on mismatch, 2 on usage/network error.
//
// Reproducibility: `cargo build-sbf` with the SOLANA_VERSION pinned in
// .github/workflows/ci.yml produces identical ELFs across machines; the `sbf`
// CI job uploads the artifacts and prints their digests so anyone can match
// the three numbers (CI artifact, local build, chain).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Connection, PublicKey } from "@solana/web3.js";

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const hashOnly = args.includes("--hash-only");
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--rpc");
const [programId, soPath] = positional;
if (!programId || (!soPath && !hashOnly)) {
  console.error("usage: verify-program.mjs <program-id> <program.so> [--rpc URL] | <program-id> --hash-only [--rpc URL]");
  process.exit(2);
}
const rpc = flag("--rpc", process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com");
const conn = new Connection(rpc, "confirmed");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const PROGRAMDATA_HEADER = 45;

const program = await conn.getAccountInfo(new PublicKey(programId));
if (!program) {
  console.error(`no account at ${programId} on ${rpc}`);
  process.exit(2);
}
let elf;
let deploySlot = null;
let authority = null;
if (program.owner.toBase58() === UPGRADEABLE_LOADER) {
  // Program account: u32 tag (2 = Program) + programdata pubkey
  const programData = new PublicKey(program.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData);
  if (!pd) {
    console.error(`programdata ${programData.toBase58()} missing`);
    process.exit(2);
  }
  deploySlot = Number(pd.data.readBigUInt64LE(4));
  authority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
  elf = pd.data.subarray(PROGRAMDATA_HEADER);
} else {
  // Non-upgradeable loaders store the ELF directly.
  elf = program.data;
}

const report = { programId, rpc, owner: program.owner.toBase58(), deploySlot, upgradeAuthority: authority, allocatedBytes: elf.length };

if (hashOnly) {
  // Strip trailing zero padding so the digest is of the ELF alone.
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end--;
  console.log(JSON.stringify({ ...report, elfBytes: end, onChainSha256: sha(elf.subarray(0, end)) }, null, 2));
  process.exit(0);
}

const local = readFileSync(soPath);
const onChainPrefix = elf.subarray(0, local.length);
const padding = elf.subarray(local.length);
const paddingIsZero = padding.every((b) => b === 0);
const localHash = sha(local);
const chainHash = sha(onChainPrefix);
const match = localHash === chainHash && paddingIsZero;
console.log(JSON.stringify({ ...report, localFile: soPath, localBytes: local.length, localSha256: localHash, onChainSha256: chainHash, paddingIsZero, match }, null, 2));
if (!match) {
  console.error(match ? "" : "MISMATCH: the deployed bytecode is not this file");
  process.exit(1);
}
