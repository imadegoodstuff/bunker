#!/usr/bin/env node
// Dependency audit gate.
//
// Runs `npm audit` on production dependencies and fails on any advisory of
// moderate severity or above that is not explicitly allow-listed in
// `npm-audit-allow.json`. Every allow-list entry needs a reason; the point is
// that someone wrote down why the finding does not apply, and that a new
// advisory can never slide through silently.
//
// Fixable advisories are pinned via `overrides` in the root package.json; this
// script only exists for the ones upstream has not fixed.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const FAIL_AT = SEVERITIES.indexOf(process.env.AUDIT_LEVEL ?? "moderate");

const allow = JSON.parse(readFileSync(join(root, "npm-audit-allow.json"), "utf8"));
for (const e of allow) {
  if (!/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(e.id) || !e.package || !(e.reason?.length > 40)) {
    console.error(`npm-audit-allow.json: entry ${JSON.stringify(e.id)} needs a GHSA id, a package and a real reason`);
    process.exit(2);
  }
}
const allowed = new Map(allow.map((e) => [e.id, e]));

const res =
  process.platform === "win32"
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm audit --omit=dev --json"], { cwd: root, encoding: "utf8" })
    : spawnSync("npm", ["audit", "--omit=dev", "--json"], { cwd: root, encoding: "utf8" });
let report;
try {
  report = JSON.parse(res.stdout);
} catch {
  console.error(res.stdout, res.stderr);
  process.exit(2);
}
if (report.error) {
  console.error(report.error.summary ?? report.error);
  process.exit(2);
}

// Root-cause advisories only: `via` entries that are objects describe an
// advisory on the package itself; strings are just "depends on a vulnerable X".
const advisories = new Map();
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via ?? []) {
    if (typeof via !== "object") continue;
    const id = via.url?.split("/").pop();
    if (!id) continue;
    advisories.set(id, { id, name, severity: via.severity, title: via.title, url: via.url, fix: v.fixAvailable });
  }
}

let unexpected = 0;
const seen = new Set();
for (const a of [...advisories.values()].sort((x, y) => SEVERITIES.indexOf(y.severity) - SEVERITIES.indexOf(x.severity))) {
  const entry = allowed.get(a.id);
  const relevant = SEVERITIES.indexOf(a.severity) >= FAIL_AT;
  if (entry) {
    seen.add(a.id);
    if (entry.package !== a.name) {
      console.error(`  ✗ ${a.id} is allow-listed for ${entry.package} but was reported on ${a.name}`);
      unexpected++;
    } else {
      console.log(`  · ${a.id} ${a.name} [${a.severity}] allow-listed: ${entry.reason.split(".")[0]}.`);
    }
  } else if (relevant) {
    console.error(`  ✗ ${a.id} ${a.name} [${a.severity}] ${a.title}`);
    console.error(`      ${a.url}`);
    console.error(`      fix available: ${JSON.stringify(a.fix)}`);
    unexpected++;
  } else {
    console.log(`  - ${a.id} ${a.name} [${a.severity}] below threshold`);
  }
}
for (const id of allowed.keys()) {
  if (!seen.has(id)) console.log(`  ~ ${id} is allow-listed but no longer reported; remove it from npm-audit-allow.json`);
}

if (unexpected) {
  console.error(`\n${unexpected} advisory(ies) not covered by npm-audit-allow.json. Pin a fixed version via "overrides" in package.json, or add an entry with a written reason.`);
  process.exit(1);
}
console.log(`\naudit clean: ${advisories.size} root advisories, all allow-listed or below ${SEVERITIES[FAIL_AT]}.`);
