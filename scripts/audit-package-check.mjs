// Keeps audit/INVARIANTS.md honest: every `path::name` in a *test* column must
// point at a file that exists and contains `name` (a Rust test fn, a node:test
// title, a logged string, or a CI step fragment). Fails CI otherwise.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const md = readFileSync(join(repo, "audit", "INVARIANTS.md"), "utf8");

const rows = md.split("\n").filter((l) => /^\|\s*[A-Z]+\d+\s*\|/.test(l));
if (rows.length < 20) { console.error(`only ${rows.length} invariant rows parsed; table format changed?`); process.exit(1); }

let bad = 0, manual = 0, checked = 0;
const cache = new Map();
const read = (p) => { if (!cache.has(p)) cache.set(p, existsSync(p) ? readFileSync(p, "utf8") : null); return cache.get(p); };

for (const row of rows) {
  const cells = row.split("|").map((c) => c.trim());
  const [, id, , , test] = cells;
  if (test.startsWith("manual")) { manual++; continue; }
  const m = test.match(/^`([^`]+?)::(.+)`$/);
  if (!m) { console.error(`${id}: test cell is neither manual nor \`path::name\`: ${test}`); bad++; continue; }
  const [, path, name] = m;
  const src = read(join(repo, path));
  if (src === null) { console.error(`${id}: ${path} does not exist`); bad++; continue; }
  if (!src.includes(name)) { console.error(`${id}: ${path} does not contain "${name}"`); bad++; continue; }
  checked++;
}
console.log(`invariants: ${checked} test references verified, ${manual} marked manual, ${bad} broken`);
if (bad) process.exit(1);
