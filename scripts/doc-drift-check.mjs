// Security documentation is audit input, so it must describe the code that is
// checked in, not the code of three fixes ago. This script fails CI when it
// does not:
//
//  1. Facts that have a single source of truth in code must appear in the docs
//     with the value the code has (constants are read from the Solidity and
//     TypeScript sources, not hard-coded here).
//  2. Phrases that described behaviour we have since changed (including the
//     whole Solana era) may not appear anywhere except in an explicit
//     "earlier revision said" acknowledgement or the "Fixed" history table.
//  3. Every SECURITY.md section from §9 on (launchpad, fee policy, deployment,
//     this check) must be reflected in audit/KNOWN_ISSUES.md.
//
// Add a line here in the same commit as any security-relevant change.
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

// ---- constants from code ------------------------------------------------------
const tsConst = (file, name) => {
  const m = read(file).match(new RegExp(`export const ${name}\\s*=\\s*([0-9_]+(?:\\s*\\*\\*\\s*[0-9]+)?)`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  return eval(m[1].replace(/_/g, ""));
};
const solConst = (file, name, env = {}) => {
  const m = read(file).match(new RegExp(`constant ${name}\\s*=\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found in ${file}`);
  let expr = m[1].replace(/\/\/.*$/, "").trim();
  for (const [k, v] of Object.entries(env)) expr = expr.replace(new RegExp(`\\b${k}\\b`, "g"), String(v));
  expr = expr.replace(/_/g, "").replace(/(\d+)e(\d+)/g, "($1*10**$2)");
  return eval(expr);
};
const envDefault = (file, name) => {
  const m = read(file).match(new RegExp(`process\\.env\\.${name} \\?\\? "?([0-9_]+)"?`));
  if (!m) throw new Error(`${name} default not found in ${file}`);
  return Number(m[1].replace(/_/g, ""));
};

const LP = "contracts/contracts/Launchpad.sol";
const SP = "contracts/contracts/ShieldedPool.sol";
const epochBlocks = solConst(LP, "EPOCH_BLOCKS");
const voteTtl = solConst(LP, "VOTE_TTL_BLOCKS", { EPOCH_BLOCKS: epochBlocks });
const quorum = solConst(LP, "QUORUM");
const catchup = solConst(LP, "MAX_CATCHUP_EPOCHS");
const feeMin = solConst(LP, "FEE_MIN_BPS");
const feeMax = solConst(LP, "FEE_MAX_BPS");
const feeStep = solConst(LP, "FEE_STEP_BPS");
const rootHistory = solConst(SP, "ROOT_HISTORY");
const virtualOffset = solConst(SP, "VIRTUAL_OFFSET");
const aspHistory = (() => {
  const m = read(SP).match(/struct AspRoots \{\s*uint256\[(\d+)\] roots;/);
  if (!m) throw new Error("AspRoots ring size not found in ShieldedPool.sol");
  return Number(m[1]);
})();
const minBits = tsConst("sdk/src/keys.ts", "PASSPHRASE_MIN_BITS");
const strongBits = tsConst("sdk/src/keys.ts", "PASSPHRASE_STRONG_BITS");
const rate = tsConst("sdk/src/keys.ts", "PASSPHRASE_GUESSES_PER_SECOND");
const years = (bits) => Math.pow(2, bits - 1) / rate / (365 * 86400);
const gasLimit = envDefault("relayer/src/index.ts", "GAS_LIMIT");
const gasCapGwei = envDefault("relayer/src/index.ts", "GAS_PRICE_CAP_GWEI");
const minDelay = envDefault("relayer/src/index.ts", "MIN_DELAY_MS");
const maxDelay = envDefault("relayer/src/index.ts", "MAX_DELAY_MS");
const pct = (bps) => (bps / 100).toString();

// ---- 1. facts the docs must state --------------------------------------------
const facts = [
  { doc: "SPEC.md", re: new RegExp(`EPOCH_BLOCKS = ${epochBlocks} `), what: `fee epoch ${epochBlocks} blocks` },
  { doc: "SPEC.md", re: new RegExp(`VOTE_TTL_BLOCKS = ${voteTtl} `), what: `vote TTL ${voteTtl} blocks` },
  { doc: "SPEC.md", re: new RegExp(`QUORUM = ${quorum} `), what: `fee quorum ${quorum}` },
  { doc: "SPEC.md", re: new RegExp(`MAX_CATCHUP_EPOCHS = ${catchup}`), what: `catch-up cap ${catchup} epochs` },
  { doc: "SPEC.md", re: new RegExp(`fee_bps ∈ \\[${feeMin}, ${feeMax}\\]`), what: `fee bounds ${feeMin}–${feeMax} bps` },
  { doc: "SPEC.md", re: new RegExp(`at most ${feeStep} bps toward the target per epoch`), what: `fee step ${feeStep} bps` },
  { doc: "SPEC.md", re: new RegExp(`E = block / ${epochBlocks}`), what: `epoch index formula uses ${epochBlocks}` },
  { doc: "SECURITY.md", re: new RegExp(`${feeStep}-bps step per ${epochBlocks}-block epoch, bounded ${pct(feeMin)}–${pct(feeMax)} %, quorum ${quorum}`), what: "fee policy summary in SECURITY §10" },
  { doc: "audit/KNOWN_ISSUES.md", re: new RegExp(`fee \\(${pct(feeMin)}–${pct(feeMax)} %\\)`), what: "fee bounds in KNOWN_ISSUES" },
  { doc: "audit/KNOWN_ISSUES.md", re: /Fee policy is four agent keys with no brake/, what: "fee policy accepted risk" },
  { doc: "SECURITY.md", re: /four agent keys, no brake/, what: "fee policy section title" },
  { doc: "SPEC.md", re: new RegExp(`last \\*\\*${rootHistory} roots\\*\\* \\(\`ROOT_HISTORY\`\\)`), what: `root ring size ${rootHistory}` },
  { doc: "SPEC.md", re: new RegExp(`${rootHistory}-root ring`), what: "ring size in the transact signature" },
  { doc: "README.md", re: new RegExp(`${rootHistory}-root ring`), what: "ring size in README" },
  { doc: "audit/KNOWN_ISSUES.md", re: new RegExp(`after ${rootHistory} later transactions`), what: "ring size in KNOWN_ISSUES" },
  { doc: "SPEC.md", re: new RegExp(`V = VIRTUAL_OFFSET = 10\\^${Math.log10(virtualOffset)}`), what: `virtual offset 10^${Math.log10(virtualOffset)}` },
  { doc: "SPEC.md", re: new RegExp(`last ${aspHistory} roots per provider`), what: `ASP ring ${aspHistory} per provider` },
  { doc: "SECURITY.md", re: new RegExp(`refuses anything under\\s+\\*\\*${minBits}\\*\\*`), what: `passphrase floor ${minBits} bits` },
  { doc: "SECURITY.md", re: new RegExp(`\\|\\s*${minBits}\\s*\\|\\s*(${Math.floor(years(minBits))}|${Math.ceil(years(minBits))}) years`), what: `${minBits} bits → ≈${years(minBits).toFixed(1)} years in the table` },
  { doc: "SECURITY.md", re: new RegExp(`\\|\\s*${strongBits}\\s*\\|`), what: `${strongBits}-bit row in the table` },
  { doc: "audit/KNOWN_ISSUES.md", re: new RegExp(`under ${minBits} bits`), what: "passphrase floor in KNOWN_ISSUES" },
  { doc: "SECURITY.md", re: /scrypt at N=2¹⁵/, what: "scrypt parameters" },
  { doc: "SECURITY.md", re: /re-syncs and re-proves once/, what: "automatic re-prove on stale root" },
  { doc: "SECURITY.md", re: /Idempotent on nullifiers/, what: "relayer idempotency" },
  { doc: "SECURITY.md", re: /`RPC_URLS` takes a comma-separated list/, what: "indexer RPC failover" },
  { doc: "SECURITY.md", re: /reports `degraded`/, what: "indexer degraded health" },
  { doc: "SECURITY.md", re: /max\(MIN_FEE_UNITS, GAS_LIMIT × GAS_PRICE_CAP × \(1 \+ COST_MARGIN_BPS\)\)/, what: "relayer fee floor formula" },
  { doc: "SECURITY.md", re: new RegExp(`defaults ${gasLimit.toLocaleString("en-US")} gas`), what: `relayer GAS_LIMIT ${gasLimit}` },
  { doc: "SECURITY.md", re: new RegExp(`${gasCapGwei} gwei`), what: `relayer gas price cap ${gasCapGwei} gwei` },
  { doc: "SECURITY.md", re: new RegExp(`${minDelay / 1000}–${maxDelay / 1000} s`), what: `relayer delay window ${minDelay / 1000}–${maxDelay / 1000} s` },
  { doc: "audit/KNOWN_ISSUES.md", re: new RegExp(`delay ≤ ${maxDelay / 1000} s`), what: "relayer delay in KNOWN_ISSUES" },
  { doc: "audit/KNOWN_ISSUES.md", re: /Mainnet deployment with development keys/, what: "mainnet deployment status" },
  { doc: "SECURITY.md", re: /verifiers are compiled from the \*\*development\*\* zkeys/, what: "dev keys on mainnet in SECURITY §11" },
  { doc: "SPEC.md", re: /agents\/src\/treasury\.ts/, what: "treasury module referenced from SPEC §13" },
  { doc: "SPEC.md", re: /PancakeSwap V2 router/, what: "migration target is PancakeSwap V2" },
  { doc: "audit/KNOWN_ISSUES.md", re: /Migration depends on PancakeSwap V2/, what: "migration dependency accepted risk" },
  { doc: "SECURITY.md", re: /`onExit` is pool-only/, what: "launchpad exit hook is pool-only" },
];
if (!/N: 2 \*\* 15/.test(read("sdk/src/keys.ts"))) fail("scrypt N changed in keys.ts; update SECURITY.md §1 and this check");
for (const f of facts) if (!f.re.test(docs[f.doc])) fail(`${f.doc} no longer states: ${f.what} (${f.re})`);

// ---- 2. phrases that describe superseded behaviour --------------------------
// Each entry may appear only on a line that also carries an acknowledgement
// marker, i.e. inside "an earlier revision said …" or the history table.
const ack = /earlier revision|That was wrong|Fixed, kept here for history|Solana-era|^\| .* \| .* \| (`SECURITY\.md` §\d+|audit\/INVARIANTS\.md|SPEC §\d+)[^|]*\|$/;
const stale = [
  /does not yet re-prove/i,
  /user must resubmit/i,
  /refuses anything under 40/,
  /logs and skips rather than stalls/i,
  /Automatic RPC failover is not implemented/,
  /public_buy|public_sell/,
  /public trading continues on the same curve/i,
  // Solana era: none of these exist on BSC
  /\bSOL\b|lamport|Raydium|CP-Swap|Solana|SPL token|Token-2022|lookup table|1,232-byte|compute unit|CU_PRICE|upgrade authority|scash/,
  /EPOCH_SLOTS|VOTE_TTL_SLOTS|per slot|one-minute epoch \(150 slots\)/,
  /graduation at 20 SOL|graduation at 85 SOL/,
];
for (const [name, text] of Object.entries(docs)) {
  text.split("\n").forEach((line, i) => {
    for (const re of stale) {
      if (re.test(line) && !ack.test(line)) fail(`${name}:${i + 1} contains superseded text ${re}: ${line.trim().slice(0, 100)}`);
    }
  });
}

// ---- 3. SECURITY §9.. mirrored in KNOWN_ISSUES --------------------------------
const sections = [...security.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
const last = Math.max(...sections);
for (let n = 9; n <= last; n++) {
  if (!new RegExp(`§${n}\\b`).test(known)) fail(`audit/KNOWN_ISSUES.md does not reference SECURITY.md §${n}`);
}

if (failures) { console.error(`doc-drift: ${failures} problem(s)`); process.exit(1); }
console.log(`doc-drift: ${facts.length} code facts present, ${stale.length} superseded phrases absent, §9–§${last} mirrored in KNOWN_ISSUES`);
