// Run circomspect over our own circuit sources and fail on any finding at
// WARNING level or above that is not explicitly allow-listed in
// circuits/circomspect-allow.json. circomspect only analyses templates in the
// files it is given, so the wrappers (transact2x2/4x2) are not enough.
//
//   node circuits/scripts/lint.mjs          (requires `cargo install circomspect`)
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const src = join(root, "src");
const files = ["transact.circom", "note.circom", "merkle.circom", "keys.circom"];
const allow = JSON.parse(readFileSync(join(root, "circomspect-allow.json"), "utf8"));

if (!existsSync(join(src, "circomlib", "circuits"))) {
  console.error("circomlib mirror missing; run `npm run -w circuits build` first");
  process.exit(2);
}

const outDir = join(tmpdir(), "bunker-circomspect");
mkdirSync(outDir, { recursive: true });
const sarifPath = join(outDir, "report.sarif");
rmSync(sarifPath, { force: true });

const r = spawnSync("circomspect", [...files, "-L", ".", "-l", "WARNING", "-s", sarifPath], { cwd: src, encoding: "utf8" });
if (r.error) {
  console.error("circomspect not found:", r.error.message);
  process.exit(2);
}
process.stdout.write(r.stdout);
process.stderr.write(r.stderr);

const sarif = JSON.parse(readFileSync(sarifPath, "utf8"));
const results = sarif.runs.flatMap((run) => run.results ?? []);
const unexpected = [];
for (const res of results) {
  const loc = res.locations?.[0]?.physicalLocation;
  const file = basename(loc?.artifactLocation?.uri ?? "");
  const text = res.message?.text ?? "";
  // The signal name lives in the location messages, not the headline.
  const detail = (res.locations ?? []).map((l) => l.message?.text ?? "").join(" ");
  const ok = allow.some((a) => a.ruleId === res.ruleId && a.file === file && (!a.signal || detail.includes(`\`${a.signal}\``)));
  if (!ok) unexpected.push({ ruleId: res.ruleId, file, line: loc?.region?.startLine, text });
}

if (unexpected.length) {
  console.error(`\ncircomspect: ${unexpected.length} finding(s) not in the allow-list:`);
  for (const u of unexpected) console.error(`  ${u.ruleId} ${u.file}:${u.line} ${u.text}`);
  process.exit(1);
}
console.log(`circomspect: ${results.length} finding(s), all allow-listed (${allow.length} rule(s)).`);
