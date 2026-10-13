// Phase-2 ceremony tooling. Every command keeps ceremony/transcript.json in
// sync so the whole chain is checkable by anyone, offline, from the repo.
//
//   node ceremony.mjs init                                   coordinator: _0000.zkey per circuit + transcript
//   node ceremony.mjs contribute --circuit C --in a.zkey --out b.zkey --name "handle"
//   node ceremony.mjs verify     --circuit C --zkey b.zkey   full check of one zkey against r1cs + ptau + transcript
//   node ceremony.mjs beacon     --circuit C --in a.zkey --out final.zkey --hash <solana blockhash hex> --slot N
//   node ceremony.mjs check      [--fetch]                   transcript self-consistency (+ download and verify latest)
//
// The transcript records, per circuit: the r1cs blake2b (so a contributor can
// prove they contributed to *this* circuit), the hash of every zkey in the
// chain, each contribution hash as snarkjs prints it, and where the files are
// hosted. CI runs `check --fetch` on every push.
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const repo = resolve(root, "..");
const PTAU = join(root, "ptau", "ppot_0080_16.ptau");
const PTAU_SHA256 = "ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9";
const TRANSCRIPT = join(repo, "ceremony", "transcript.json");
const CONTRIB_DIR = join(repo, "ceremony", "contributions");
const CIRCUITS = ["transact2x2", "transact4x2"];

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    in: { type: "string" }, out: { type: "string" }, name: { type: "string" },
    hash: { type: "string" }, slot: { type: "string" }, iters: { type: "string", default: "10" },
    circuit: { type: "string" }, zkey: { type: "string" }, fetch: { type: "boolean", default: false },
    url: { type: "string" },
  },
});
const cmd = positionals[0];

const commands = { init, contribute, verify, beacon, check };
if (!commands[cmd]) {
  console.error("usage: ceremony.mjs init|contribute|verify|beacon|check ...");
  process.exit(2);
}
await commands[cmd]();
process.exit(0);

// ---------------------------------------------------------------------------

async function init() {
  if (existsSync(TRANSCRIPT)) throw new Error(`${TRANSCRIPT} exists; refusing to restart the ceremony`);
  await checkPtau();
  const t = {
    version: 1,
    status: "open",
    phase1: { file: "pot28_0080/ppot_0080_16.ptau", sha256: PTAU_SHA256,
      source: "Perpetual Powers of Tau (PSE), BN254, 2^16" },
    opened: new Date().toISOString(),
    circuits: {},
  };
  for (const name of CIRCUITS) {
    const r1cs = r1csPath(name);
    const info = await snarkjs.r1cs.info(r1cs);
    const out = join(root, "build", name, `${name}_0000.zkey`);
    console.log(`[init] ${name}: ${info.nConstraints} constraints, computing _0000.zkey`);
    await snarkjs.zKey.newZKey(r1cs, PTAU, out);
    t.circuits[name] = {
      constraints: Number(info.nConstraints),
      publicInputs: Number(info.nPubInputs) + Number(info.nOutputs),
      r1csBlake2b: await blake2b(r1cs),
      initialZkeyBlake2b: await blake2b(out),
      contributions: [],
      beacon: null,
    };
  }
  saveTranscript(t);
  console.log(`[init] wrote ${TRANSCRIPT}`);
}

async function contribute() {
  const t = loadTranscript();
  const circuit = need("circuit"), inFile = need("in"), outFile = need("out");
  const c = t.circuits[circuit] ?? fail(`unknown circuit ${circuit}`);
  if (t.status !== "open") fail(`ceremony is ${t.status}`);
  const inHash = await blake2b(inFile);
  const expected = c.contributions.length ? c.contributions.at(-1).zkeyBlake2b : c.initialZkeyBlake2b;
  if (inHash !== expected) fail(`--in is not the latest zkey in the transcript\n  have ${inHash}\n  want ${expected}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question("Type some random text (mixed with OS entropy): ");
  rl.close();
  const name = values.name ?? "anonymous";
  const hash = await snarkjs.zKey.contribute(inFile, outFile, name, randomBytes(64).toString("hex") + typed, console);
  const entry = {
    index: c.contributions.length + 1,
    name,
    date: new Date().toISOString(),
    inputZkeyBlake2b: inHash,
    zkeyBlake2b: await blake2b(outFile),
    contributionHash: hex(hash),
    url: values.url ?? null,
  };
  c.contributions.push(entry);
  saveTranscript(t);
  mkdirSync(CONTRIB_DIR, { recursive: true });
  const att = join(CONTRIB_DIR, `${String(entry.index).padStart(4, "0")}-${circuit}-${slug(name)}.md`);
  writeFileSync(att, attestation(circuit, entry, basename(outFile)));
  console.log(`\ncontribution #${entry.index} to ${circuit}\n  hash   ${entry.contributionHash}\n  zkey   ${entry.zkeyBlake2b}\n  wrote  ${att}\n`);
  console.log("Next: upload the zkey, put its URL in the transcript entry, sign the attestation file, open a PR, and wipe this machine's state.");
}

async function verify() {
  const t = loadTranscript();
  const circuit = need("circuit"), zkey = need("zkey");
  const ok = await verifyAgainstTranscript(t, circuit, zkey);
  console.log(ok ? "ZKEY OK" : "ZKEY INVALID");
  if (!ok) process.exit(1);
}

async function beacon() {
  const t = loadTranscript();
  const circuit = need("circuit"), inFile = need("in"), outFile = need("out"), hashHex = need("hash");
  const c = t.circuits[circuit] ?? fail(`unknown circuit ${circuit}`);
  if (!/^[0-9a-f]{64}$/i.test(hashHex)) fail("--hash must be a 32-byte hex string (a Solana blockhash, base58-decoded)");
  const inHash = await blake2b(inFile);
  const expected = c.contributions.length ? c.contributions.at(-1).zkeyBlake2b : c.initialZkeyBlake2b;
  if (inHash !== expected) fail("--in is not the latest zkey in the transcript");
  const hash = await snarkjs.zKey.beacon(inFile, outFile, "beacon", hashHex, Number(values.iters), console);
  c.beacon = {
    slot: values.slot ? Number(values.slot) : null,
    blockhashHex: hashHex.toLowerCase(),
    iterationsExp: Number(values.iters),
    inputZkeyBlake2b: inHash,
    finalZkeyBlake2b: await blake2b(outFile),
    contributionHash: hex(hash),
    date: new Date().toISOString(),
    url: values.url ?? null,
  };
  const vk = await snarkjs.zKey.exportVerificationKey(outFile);
  c.verificationKeySha256 = createHash("sha256").update(JSON.stringify(vk)).digest("hex");
  if (Object.values(t.circuits).every((x) => x.beacon)) t.status = "finalized";
  saveTranscript(t);
  console.log(`\nfinal zkey ${c.beacon.finalZkeyBlake2b}\nvk sha256  ${c.verificationKeySha256}`);
}

async function check() {
  const t = loadTranscript();
  let bad = 0;
  const say = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) bad++; };
  say(["open", "closed", "finalized"].includes(t.status), `status ${t.status}`);
  say(t.phase1?.sha256 === PTAU_SHA256, "phase-1 ptau pinned to the setup-dev hash");
  for (const name of CIRCUITS) {
    const c = t.circuits[name];
    say(!!c, `${name} present`);
    if (!c) continue;
    if (existsSync(r1csPath(name))) {
      const h = await blake2b(r1csPath(name));
      say(h === c.r1csBlake2b, `${name} r1cs rebuilt from source hashes to the transcript value`);
    } else console.log(`skip ${name} r1cs not built locally (npm run -w circuits build)`);
    let prev = c.initialZkeyBlake2b;
    for (const e of c.contributions) {
      say(e.inputZkeyBlake2b === prev, `${name} #${e.index} chains from the previous zkey`);
      say(/^[0-9a-f]{128}$/.test(e.contributionHash), `${name} #${e.index} has a 64-byte contribution hash`);
      say(/^[0-9a-f]{128}$/.test(e.zkeyBlake2b), `${name} #${e.index} has a zkey hash`);
      const att = join(CONTRIB_DIR, `${String(e.index).padStart(4, "0")}-${name}-${slug(e.name)}.md`);
      say(existsSync(att), `${name} #${e.index} attestation file ${basename(att)}`);
      prev = e.zkeyBlake2b;
    }
    if (c.beacon) {
      say(c.beacon.inputZkeyBlake2b === prev, `${name} beacon chains from the last contribution`);
      say(!!c.beacon.slot && !!c.beacon.blockhashHex, `${name} beacon names its Solana slot and blockhash`);
    }
    if (values.fetch) {
      const last = c.beacon ?? c.contributions.at(-1);
      if (!last?.url) { console.log(`skip ${name} nothing hosted yet`); continue; }
      const file = join(root, "build", name, `${name}_latest.zkey`);
      mkdirSync(dirname(file), { recursive: true });
      console.log(`     downloading ${last.url}`);
      const res = await fetch(last.url);
      if (!res.ok || !res.body) { say(false, `${name} download ${res.status}`); continue; }
      await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
      await checkPtau();
      say(await verifyAgainstTranscript(t, name, file), `${name} hosted zkey verifies against r1cs, ptau and the transcript chain`);
    }
  }
  console.log(bad ? `\n${bad} problem(s)` : "\ntranscript consistent");
  if (bad) process.exit(1);
}

// ---------------------------------------------------------------------------

async function verifyAgainstTranscript(t, circuit, zkey) {
  const c = t.circuits[circuit] ?? fail(`unknown circuit ${circuit}`);
  const fileHash = await blake2b(zkey);
  const chain = [...c.contributions.map((e) => e.contributionHash)];
  if (c.beacon) chain.push(c.beacon.contributionHash);
  const expectedFile = c.beacon ? c.beacon.finalZkeyBlake2b : c.contributions.length ? c.contributions.at(-1).zkeyBlake2b : c.initialZkeyBlake2b;
  let ok = true;
  if (fileHash !== expectedFile) { console.log(`zkey blake2b ${fileHash}\n  transcript  ${expectedFile}`); ok = false; }
  // snarkjs prints every contribution hash while verifying; capture and compare.
  const lines = [];
  const logger = { info: (m) => lines.push(String(m)), debug: () => {}, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)), log: (m) => lines.push(String(m)) };
  const sound = await snarkjs.zKey.verifyFromR1cs(r1csPath(circuit), PTAU, zkey, logger);
  if (!sound) { console.log("snarkjs: zkey does not verify against r1cs + ptau"); ok = false; }
  const printed = lines.join("\n").match(/contribution #\d+[^\n]*\n((?:\t\t[0-9a-f ]+\n?){4})/g) ?? [];
  const hashes = printed.map((blk) => blk.split("\n").slice(1).join(" ").replace(/\s+/g, ""));
  if (hashes.length !== chain.length) { console.log(`zkey has ${hashes.length} contribution(s), transcript lists ${chain.length}`); ok = false; }
  for (let i = 0; i < Math.min(hashes.length, chain.length); i++) {
    if (hashes[i] !== chain[i]) { console.log(`contribution #${i + 1} hash differs\n  zkey       ${hashes[i]}\n  transcript ${chain[i]}`); ok = false; }
  }
  if (ok) console.log(`${circuit}: ${chain.length} contribution(s) match the transcript; zkey verifies`);
  return ok;
}

async function checkPtau() {
  if (!existsSync(PTAU)) fail(`ptau missing: run npm run -w circuits setup:dev once to download it`);
  const h = createHash("sha256");
  await pipeline(createReadStream(PTAU), h);
  const d = h.digest("hex");
  if (d !== PTAU_SHA256) fail(`ptau sha256 ${d} != ${PTAU_SHA256}`);
}

async function blake2b(file) {
  const h = createHash("blake2b512");
  await pipeline(createReadStream(file), h);
  return h.digest("hex");
}

function r1csPath(name) { return join(root, "build", name, `${name}.r1cs`); }
function hex(u8) { return Buffer.from(u8).toString("hex"); }
function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "anonymous"; }
function need(k) { return values[k] ?? fail(`--${k} required`); }
function fail(m) { console.error(m); process.exit(1); }
function loadTranscript() { if (!existsSync(TRANSCRIPT)) fail("no ceremony/transcript.json; run init"); return JSON.parse(readFileSync(TRANSCRIPT, "utf8")); }
function saveTranscript(t) { mkdirSync(dirname(TRANSCRIPT), { recursive: true }); writeFileSync(TRANSCRIPT, JSON.stringify(t, null, 2) + "\n"); }

function attestation(circuit, e, file) {
  return `# Contribution #${e.index} to ${circuit}

- participant: ${e.name}
- date: ${e.date}
- input zkey blake2b: \`${e.inputZkeyBlake2b}\`
- output zkey (\`${file}\`) blake2b: \`${e.zkeyBlake2b}\`
- contribution hash: \`${e.contributionHash}\`

I ran \`node circuits/scripts/ceremony.mjs contribute\` from a clean checkout at
the commit that pins the r1cs hash in \`ceremony/transcript.json\`, mixed my own
entropy into the prompt, and destroyed the machine state afterwards.

<!-- Sign this file (gpg --clearsign, or paste a signature from a key tied to
     the handle above) and add a link to a public post of the contribution
     hash. Then open a PR adding this file and the transcript entry. -->
`;
}
