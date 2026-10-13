// Security documentation is audit input, so it must describe the code that is
// checked in, not the code of three fixes ago. This script fails CI when it
// does not:
//
//  1. Facts that have a single source of truth in code must appear in the docs
//     with the value the code has (constants are read from the source files,
//     not hard-coded here).
//  2. Phrases that described behaviour we have since changed may not appear
//     anywhere except in an explicit "earlier revision said" acknowledgement.
//  3. Every SECURITY.md section that records a fix must be reflected in
//     audit/KNOWN_ISSUES.md (either as an accepted risk or in "Fixed").
//
// Add a line here in the same commit as any security-relevant change. That is
// the maintenance rule the reviewer asked for, made executable.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(repo, p), "utf8");
const security = read("SECURITY.md");
const spec = read("SPEC.md");
const known = read("audit/KNOWN_ISSUES.md");
const docs = { "SECURITY.md": security, "SPEC.md": spec, "audit/KNOWN_ISSUES.md": known, "README.md": read("README.md") };

let failures = 0;
const fail = (msg) => { console.error(`doc-drift: ${msg}`); failures++; };
const constant = (file, name) => {
  const m = read(file).match(new RegExp(`export const ${name}\\s*=\\s*([0-9_]+(?:\\s*\\*\\*\\s*[0-9]+)?)`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return eval(m[1].replace(/_/g, ""));
};

// ---- 1. facts from code ------------------------------------------------------
const minBits = constant("sdk/src/keys.ts", "PASSPHRASE_MIN_BITS");
const strongBits = constant("sdk/src/keys.ts", "PASSPHRASE_STRONG_BITS");
const rate = constant("sdk/src/keys.ts", "PASSPHRASE_GUESSES_PER_SECOND");
const years = (bits) => Math.pow(2, bits - 1) / rate / (365 * 86400);
const cuPriceMax = (() => {
  const m = read("relayer/src/index.ts").match(/CU_PRICE_MAX \?\? ([0-9_]+)/);
  if (!m) throw new Error("CU_PRICE_MAX default not found in relayer/src/index.ts");
  return Number(m[1].replace(/_/g, ""));
})();
// launchpad facts: exit data length (processor.rs) and the graduation threshold (SDK defaults)
const exitDataLen = (() => {
  const m = read("programs/scash_launch/src/processor.rs").match(/pub const EXIT_DATA_LEN: usize = ([0-9 +]+);/);
  if (!m) throw new Error("EXIT_DATA_LEN not found");
  return eval(m[1]);
})();
const graduationSol = (() => {
  const m = read("sdk/src/launch.ts").match(/graduationLamports:\s*([0-9_]+)n/);
  if (!m) throw new Error("graduationLamports default not found in sdk/src/launch.ts");
  return Number(m[1].replace(/_/g, "")) / 1e9;
})();
// migration facts: the rent reserve (processor.rs) and the Raydium CP-Swap program id (amm.rs)
const migrationReserveSol = (() => {
  const m = read("programs/scash_launch/src/processor.rs").match(/pub const MIGRATION_RENT_RESERVE: u64 = ([0-9_]+);/);
  if (!m) throw new Error("MIGRATION_RENT_RESERVE not found");
  return Number(m[1].replace(/_/g, "")) / 1e9;
})();
const cpSwapId = (() => {
  const m = read("programs/scash_launch/src/amm.rs").match(/pub const CP_SWAP_PROGRAM_ID: Pubkey = solana_program::pubkey!\("([1-9A-HJ-NP-Za-km-z]+)"\)/);
  if (!m) throw new Error("CP_SWAP_PROGRAM_ID not found in amm.rs");
  if (!read("sdk/src/launch.ts").includes(`"${m[1]}"`)) fail(`SDK does not carry the CP-Swap program id ${m[1]} from amm.rs`);
  if (!read(".github/workflows/ci.yml").includes(`--clone-upgradeable-program ${m[1]}`)) fail(`CI validator does not clone the CP-Swap program ${m[1]}`);
  return m[1];
})();
// fee policy constants (programs/scash_launch/src/policy.rs)
const policyConst = (name) => {
  const m = read("programs/scash_launch/src/policy.rs").match(new RegExp(`pub const ${name}: u(?:size|\\d+) = ([0-9_]+(?: \\* EPOCH_SLOTS)?);`));
  if (!m) throw new Error(`${name} not found in policy.rs`);
  const expr = m[1].replace("EPOCH_SLOTS", "E").replace(/_/g, "");
  return eval(expr.includes("E") ? expr.replace("E", String(policyConst("EPOCH_SLOTS"))) : expr);
};
const epochSlots = policyConst("EPOCH_SLOTS");
const voteTtl = policyConst("VOTE_TTL_SLOTS");
const quorum = policyConst("QUORUM");
const feeMin = policyConst("FEE_MIN_BPS");
const feeMax = policyConst("FEE_MAX_BPS");
const facts = [
  { doc: "SPEC.md", re: new RegExp(`EPOCH_SLOTS = ${epochSlots} `), what: `fee epoch ${epochSlots} slots` },
  { doc: "SPEC.md", re: new RegExp(`VOTE_TTL_SLOTS = ${voteTtl} `), what: `vote TTL ${voteTtl} slots` },
  { doc: "SPEC.md", re: new RegExp(`QUORUM = ${quorum} `), what: `fee quorum ${quorum}` },
  { doc: "SPEC.md", re: new RegExp(`fee_bps\\s+∈ \\[${feeMin}, ${feeMax}\\]`), what: `fee bounds ${feeMin}–${feeMax} bps` },
  { doc: "SECURITY.md", re: new RegExp(`fee ${feeMin / 100}–${feeMax / 100} %`), what: `fee bounds in SECURITY §17` },
  { doc: "audit/KNOWN_ISSUES.md", re: /Fee policy is four agent keys with no brake/, what: "fee policy accepted risk" },
  { doc: "SPEC.md", re: new RegExp(`\\+ ${exitDataLen} of exit data`), what: `exit data is ${exitDataLen} bytes` },
  { doc: "SPEC.md", re: new RegExp(`graduation at ${graduationSol} SOL`), what: `graduation threshold ${graduationSol} SOL` },
  { doc: "SPEC.md", re: new RegExp(`create_pool_fee − ${migrationReserveSol} SOL`), what: `migration rent reserve ${migrationReserveSol} SOL` },
  { doc: "SECURITY.md", re: new RegExp(`A ${migrationReserveSol} SOL\\s+reserve`), what: `migration rent reserve in SECURITY §15` },
  { doc: "SPEC.md", re: /Raydium CP-Swap pool/, what: `migration target is Raydium CP-Swap (${cpSwapId})` },
  { doc: "audit/KNOWN_ISSUES.md", re: /Migration depends on Raydium CP-Swap/, what: "migration dependency accepted risk" },
  { doc: "SPEC.md", re: /empty dummy ciphertext and outgoing record/, what: "unshield omits dummy ciphertext and outgoing record" },
  { doc: "SECURITY.md", re: /refuses to run at the top level/, what: "launchpad exit refuses top-level calls" },
  { doc: "SECURITY.md", re: new RegExp(`refuses anything under \\*\\*${minBits}\\*\\*`), what: `passphrase floor ${minBits} bits` },
  { doc: "SECURITY.md", re: new RegExp(`\\|\\s*${minBits}\\s*\\|\\s*(${Math.floor(years(minBits))}|${Math.ceil(years(minBits))}) years`), what: `${minBits} bits → ≈${years(minBits).toFixed(1)} years in the table` },
  { doc: "SECURITY.md", re: new RegExp(`\\|\\s*${strongBits}\\s*\\|`), what: `${strongBits}-bit row in the table` },
  { doc: "SECURITY.md", re: /scrypt at N=2¹⁵/, what: "scrypt parameters" },
  { doc: "SPEC.md", re: /128-root ring/, what: "ring size" },
  { doc: "SPEC.md", re: /currently builds `v0` transactions/, what: "client transaction format" },
  { doc: "SECURITY.md", re: /re-syncs and re-proves once/, what: "automatic re-prove on stale root" },
  { doc: "SECURITY.md", re: /idempotent on nullifiers/, what: "relayer idempotency" },
  { doc: "SECURITY.md", re: /`null` and thrown errors both defer|`null`.*defer/, what: "indexer defers null" },
  { doc: "audit/KNOWN_ISSUES.md", re: /Mainnet deployment with development keys/, what: "mainnet deployment status" },
  { doc: "SECURITY.md", re: /upgrade authority is held, not burned/, what: "interim upgrade authority (mainnet beta)" },
  { doc: "SECURITY.md", re: /`RPC_URLS` takes a comma-separated list/, what: "indexer RPC failover" },
  { doc: "SECURITY.md", re: new RegExp("\\[CU_PRICE, CU_PRICE_MAX\\]` \\(defaults 0 and " + cuPriceMax.toLocaleString("en-US").replace(/,/g, " ")), what: `relayer priority fee cap ${cuPriceMax}` },
];
// scrypt N is also a code fact
if (!/N: 2 \*\* 15/.test(read("sdk/src/keys.ts"))) fail("scrypt N changed in keys.ts; update SECURITY.md §1 and this check");
for (const f of facts) if (!f.re.test(docs[f.doc])) fail(`${f.doc} no longer states: ${f.what} (${f.re})`);

// ---- 2. phrases that describe superseded behaviour --------------------------
// Each entry may appear only on a line that also contains one of the
// acknowledgement markers, i.e. inside "an earlier revision said …".
const ack = /earlier revision|That was wrong|said .* at 10⁵|Fixed, kept here for history|^\| .* \| .* \| `SECURITY\.md` §\d+ \|$/;
const stale = [
  /does not yet re-prove/i,
  /user must resubmit/i,
  /no v1 format/i,
  /there is no v1/i,
  /about 10 000 years/,
  /10,000 years/,
  /refuses anything under 40/,
  /logs and skips rather than stalls/i, // superseded by defer-and-retry in §10/§11 — allowed only in history
  /Planned for the app/,
  /Automatic RPC failover is not implemented/, // superseded by RPC_URLS in §14
  /transient program-owned token account/, // SPEC §11 before the launchpad: exits never worked that way
  /funds the relayer gas pool/, // SPEC §13 before the correction: Distribute splits vault/team only
  /public_buy|public_sell/, // the launchpad's public curve trades were removed: a graduated curve migrates to Raydium
  /graduation at 85 SOL|after 85 SOL|No liquidity migration/, // graduation is 20 SOL and migrates
  /public trading continues on the same curve/i,
];
for (const [name, text] of Object.entries(docs)) {
  text.split("\n").forEach((line, i) => {
    for (const re of stale) {
      if (re.test(line) && !ack.test(line)) fail(`${name}:${i + 1} contains superseded text ${re}: ${line.trim().slice(0, 100)}`);
    }
  });
}

// ---- 3. every fix section in SECURITY.md is mirrored in KNOWN_ISSUES --------
const sections = [...security.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
const last = Math.max(...sections);
for (let n = 9; n <= last; n++) {
  if (!new RegExp(`\`SECURITY\\.md\` §(\\d+[–-])?${n}\\b|§${n}\\b`).test(known)) fail(`audit/KNOWN_ISSUES.md does not reference SECURITY.md §${n}`);
}

if (failures) { console.error(`doc-drift: ${failures} problem(s)`); process.exit(1); }
console.log(`doc-drift: ${facts.length} code facts present, ${stale.length} superseded phrases absent, §9–§${last} mirrored in KNOWN_ISSUES`);
