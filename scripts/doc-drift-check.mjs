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
const facts = [
  { doc: "SECURITY.md", re: new RegExp(`refuses anything under \\*\\*${minBits}\\*\\*`), what: `passphrase floor ${minBits} bits` },
  { doc: "SECURITY.md", re: new RegExp(`\\|\\s*${minBits}\\s*\\|\\s*(${Math.floor(years(minBits))}|${Math.ceil(years(minBits))}) years`), what: `${minBits} bits → ≈${years(minBits).toFixed(1)} years in the table` },
  { doc: "SECURITY.md", re: new RegExp(`\\|\\s*${strongBits}\\s*\\|`), what: `${strongBits}-bit row in the table` },
  { doc: "SECURITY.md", re: /scrypt at N=2¹⁵/, what: "scrypt parameters" },
  { doc: "SPEC.md", re: /128-root ring/, what: "ring size" },
  { doc: "SPEC.md", re: /currently builds `v0` transactions/, what: "client transaction format" },
  { doc: "SECURITY.md", re: /re-syncs and re-proves once/, what: "automatic re-prove on stale root" },
  { doc: "SECURITY.md", re: /idempotent on nullifiers/, what: "relayer idempotency" },
  { doc: "SECURITY.md", re: /`null` and thrown errors both defer|`null`.*defer/, what: "indexer defers null" },
  { doc: "audit/KNOWN_ISSUES.md", re: /Devnet deployment/, what: "devnet deployment status" },
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
