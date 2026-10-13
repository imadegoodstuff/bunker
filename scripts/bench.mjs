// Throughput and root-window measurements against a live cluster.
//   node scripts/bench.mjs [--rpc http://127.0.0.1:8899] [--keypair keypairs/deployer.json] [--n 140] [--out bench.json]
//
// What it measures, and why:
//   1. Proving latency for transact2x2 and transact4x2 in Node (lower bound for the browser).
//   2. Throughput under contention: N independent shields from N distinct
//      depositors are built against one root and fired concurrently. Every
//      transact writes the single Tree PDA, so the runtime serialises them;
//      the per-slot landing histogram shows what that lock costs.
//   3. Root window: a proof built against root R0 is submitted after N >= 128
//      further transacts have landed (R0 evicted from the 128-root ring) and
//      must be rejected with UnknownRoot; one built when the ring still holds
//      its root must land. This pins the window to the implementation.
//
// Numbers from solana-test-validator are a single-node ceiling for the tree
// lock, not a mainnet forecast. The JSON report is uploaded as a CI artifact
// and summarised in SECURITY.md §7.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ShieldedWallet, MerkleTree, assetId, initializeIx, createPoolIx, configPda, treePda, poolPda, decodePool, decodeTree,
  staticAddresses, createLookupTable, fetchLookupTable, buildV0, groupHash, freshRandomness, noteCommitment, prove, encryptNote,
  extDataHash, NO_EXIT, ROOT_HISTORY,
} from "../sdk/dist/index.js";

const { values } = parseArgs({
  options: {
    rpc: { type: "string", default: "http://127.0.0.1:8899" },
    keypair: { type: "string", default: "keypairs/deployer.json" },
    n: { type: "string", default: "140" },
    out: { type: "string", default: "bench.json" },
  },
});
const N = Number(values.n);
const conn = new Connection(values.rpc, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(values.keypair, "utf8"))));
const artifacts = {
  transact2x2: { wasm: "circuits/build/transact2x2/transact2x2_js/transact2x2.wasm", zkey: "circuits/build/transact2x2/transact2x2_dev.zkey" },
  transact4x2: { wasm: "circuits/build/transact4x2/transact4x2_js/transact4x2.wasm", zkey: "circuits/build/transact4x2/transact4x2_dev.zkey" },
};
const SOL = SystemProgram.programId;
const asset = assetId(SOL);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s[s.length - 1], mean: s.reduce((a, b) => a + b, 0) / s.length };
};
const report = { startedAt: new Date().toISOString(), rpc: values.rpc, n: N, rootHistory: ROOT_HISTORY };

// --- protocol init
if (!(await conn.getAccountInfo(configPda()))) {
  await sendAndConfirmTransaction(conn, new Transaction().add(initializeIx(payer.publicKey, payer.publicKey)), [payer]);
}
if (!(await conn.getAccountInfo(poolPda(SOL)))) {
  await sendAndConfirmTransaction(conn, new Transaction().add(createPoolIx(payer.publicKey, SOL, 100_000n * BigInt(LAMPORTS_PER_SOL))), [payer]);
}
const tableAddr = await createLookupTable(conn, payer, staticAddresses([{ mint: SOL }], undefined, payer.publicKey));
await new Promise((r) => setTimeout(r, 1500));
const table = await fetchLookupTable(conn, tableAddr);
const pool = async () => decodePool(new Uint8Array((await conn.getAccountInfo(poolPda(SOL))).data));
const chainTree = async () => decodeTree(new Uint8Array((await conn.getAccountInfo(treePda())).data));
const tree = new MerkleTree(26);
await tree.whenReady();
const wallet = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(9));

// --- 1. proving latency
{
  const self = wallet.address();
  const gd = groupHash(wallet.bjj, self.d);
  const mk = (v) => ({ asset, value: v, gd, pkd: self.pkd, ...freshRandomness() });
  const outs = [mk(1000n), mk(0n)];
  const c = outs.map((o) => encryptNote(wallet.bjj, self, o, undefined, false).ciphertext);
  const ext = { recipient: payer.publicKey, relayer: payer.publicKey, relayerFee: 0n, exitTarget: NO_EXIT, exitData: new Uint8Array(0), ciphertexts: c, outCiphertext: new Uint8Array(0) };
  const base = { spend: wallet.spend, fvk: wallet.fvk, root: await tree.root(), asset, publicAmount: 1000n, extDataHash: extDataHash(ext), aspRoot: 0n, outputs: outs, dummyPath: tree.dummyPath(), self: { gd, pkd: self.pkd } };
  const t2 = [];
  for (let i = 0; i < 5; i++) { const t = performance.now(); await prove({ ...base, inputs: [] }, artifacts); t2.push(performance.now() - t); }
  report.proveMs = { transact2x2: stats(t2) };
  log("prove transact2x2 ms:", JSON.stringify(report.proveMs.transact2x2));
}

// --- 2. build N shields from N distinct depositors against one root
log(`funding ${N} depositors`);
const depositors = Array.from({ length: N }, () => Keypair.generate());
for (let i = 0; i < N; i += 18) {
  const tx = new Transaction();
  for (const k of depositors.slice(i, i + 18)) tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: LAMPORTS_PER_SOL / 10 }));
  await sendAndConfirmTransaction(conn, tx, [payer]);
}
const p0 = await pool();
const ct0 = await chainTree();
log(`building ${N} shield proofs against root index ${ct0.rootIndex}`);
const built = [];
const buildMs = [];
for (let i = 0; i < N; i++) {
  const t = performance.now();
  built.push(await wallet.buildTransact({
    asset, mint: SOL, pool: p0, tree, chainTree: ct0, artifacts, kind: "shield", amount: 10_000_000n,
    relayer: depositors[i].publicKey, relayerDest: depositors[i].publicKey, relayerFee: 0n, payer: depositors[i].publicKey, depositor: depositors[i].publicKey,
  }));
  buildMs.push(performance.now() - t);
  if (i % 20 === 19) log(`  ${i + 1}/${N}`);
}
report.buildMs = stats(buildMs);

// a stale-root candidate: same root R0, submitted only after the ring has moved on
const staleProbe = built.pop();
const freshProbeIndex = built.length - 1; // submitted last in the burst, while R0 is still in the ring

// --- 3. fire everything at once
log(`submitting ${built.length} transacts concurrently`);
const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
const slotBefore = await conn.getSlot();
const tStart = performance.now();
const sigs = await Promise.all(built.map(async (b, i) => {
  const tx = buildV0(depositors[i].publicKey, [b.instruction], blockhash, table);
  tx.sign([depositors[i]]);
  try {
    return { i, sig: await conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 5 }) };
  } catch (e) {
    return { i, err: e.message.split("\n")[0] };
  }
}));
const sendMs = performance.now() - tStart;
const results = await Promise.all(sigs.map(async (s) => {
  if (!s.sig) return { ...s, ok: false };
  const r = await conn.confirmTransaction({ signature: s.sig, blockhash, lastValidBlockHeight }, "confirmed").catch((e) => ({ value: { err: e.message } }));
  if (r.value.err) return { ...s, ok: false, err: JSON.stringify(r.value.err) };
  const tx = await conn.getTransaction(s.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  return { ...s, ok: true, slot: tx.slot, cu: tx.meta.computeUnitsConsumed };
}));
const landMs = performance.now() - tStart;
const ok = results.filter((r) => r.ok);
const slots = ok.map((r) => r.slot);
const hist = {};
for (const s of slots) hist[s - slotBefore] = (hist[s - slotBefore] ?? 0) + 1;
report.throughput = {
  submitted: built.length,
  landed: ok.length,
  failed: results.filter((r) => !r.ok).map((r) => r.err).slice(0, 5),
  submitWallMs: Math.round(sendMs),
  allConfirmedWallMs: Math.round(landMs),
  slotsSpanned: slots.length ? Math.max(...slots) - Math.min(...slots) + 1 : 0,
  perSlot: stats(Object.values(hist)),
  perSlotHistogram: hist,
  cu: stats(ok.map((r) => r.cu)),
  txPerSecondObserved: +(ok.length / (landMs / 1000)).toFixed(2),
};
log("throughput:", JSON.stringify({ ...report.throughput, perSlotHistogram: undefined, failed: undefined }));
const ct1 = await chainTree();
report.ringAdvanced = (Number(ct1.rootIndex) - Number(ct0.rootIndex) + ROOT_HISTORY) % ROOT_HISTORY;
log(`ring advanced ${report.ringAdvanced} roots (ROOT_HISTORY=${ROOT_HISTORY}), leaves now ${ct1.nextIndex}`);

// --- 4. root window: R0 must be gone after >= ROOT_HISTORY transacts
{
  const i = depositors.length - 1;
  const { blockhash: bh } = await conn.getLatestBlockhash();
  const tx = buildV0(depositors[i].publicKey, [staleProbe.instruction], bh, table);
  tx.sign([depositors[i]]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false });
  const rejected = !!sim.value.err;
  // The ring slot named by root_index now holds a newer root, so the proof's
  // public input no longer matches: the vault reports InvalidProof (custom 7),
  // not UnknownRoot. Clients treat both as "re-sync and re-prove".
  const custom = sim.value.err?.InstructionError?.[1]?.Custom;
  const asInvalidProof = custom === 7;
  // The ring records one root per transaction, so R0 is evicted after exactly
  // ROOT_HISTORY later transactions landed (the concurrent batch itself).
  report.rootWindow = {
    transactsLandedSinceR0: ok.length,
    expectedEvicted: ok.length >= ROOT_HISTORY,
    rejected,
    rejectedAsInvalidProof: asInvalidProof,
    simulationError: sim.value.err ?? null,
    freshProbeLanded: results.find((r) => r.i === freshProbeIndex)?.ok ?? false,
    landedCapEqualsRootHistory: ok.length === ROOT_HISTORY,
  };
  log("root window:", JSON.stringify(report.rootWindow));
  if (ok.length >= ROOT_HISTORY && !rejected) throw new Error("stale root was accepted after the ring moved past it");
  if (ok.length < ROOT_HISTORY && rejected) throw new Error(`root evicted after only ${ok.length} transacts (< ROOT_HISTORY)`);
}

// --- 5. a model the reader can apply: expiry probability vs rate and delay
// P(expire) = P(more than ROOT_HISTORY-1 other transacts land during prove+queue delay)
// For a Poisson arrival rate λ (tx/s) and delay d (s): P = P(Poisson(λ d) >= ROOT_HISTORY).
const poissonTail = (lambda, k) => { let p = Math.exp(-lambda), sum = p; for (let i = 1; i < k; i++) { p *= lambda / i; sum += p; } return Math.max(0, 1 - sum); };
report.expiryModel = {};
for (const d of [5, 30, 60, 120]) {
  report.expiryModel[`delay_${d}s`] = {};
  for (const rate of [0.1, 0.5, 1, 2, 5]) report.expiryModel[`delay_${d}s`][`${rate}_tx_per_s`] = +poissonTail(rate * d, ROOT_HISTORY).toExponential(2);
}

const fp = await pool();
report.turnstile = { totalIn: fp.totalIn.toString(), totalOut: fp.totalOut.toString(), totalAssets: fp.totalAssets.toString() };
report.finishedAt = new Date().toISOString();
writeFileSync(values.out, JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
log("wrote", values.out);
console.log("\n## bench summary\n");
console.log(`- prove transact2x2 (Node): p50 ${Math.round(report.proveMs.transact2x2.p50)} ms, p90 ${Math.round(report.proveMs.transact2x2.p90)} ms`);
console.log(`- ${report.throughput.landed}/${report.throughput.submitted} concurrent transacts landed in ${report.throughput.slotsSpanned} slots; per-slot p50 ${report.throughput.perSlot.p50}, max ${report.throughput.perSlot.max}; CU mean ${Math.round(report.throughput.cu.mean)}`);
console.log(`- observed ${report.throughput.txPerSecondObserved} tx/s end-to-end on a single test validator (tree lock serialises every transact)`);
console.log(`- root window: ${report.rootWindow.transactsLandedSinceR0} transacts landed against R0 (ROOT_HISTORY=${ROOT_HISTORY}); stale proof afterwards ${report.rootWindow.rejected ? `rejected (${report.rootWindow.rejectedAsInvalidProof ? "InvalidProof: ring slot reused" : JSON.stringify(report.rootWindow.simulationError)})` : "still accepted"}; fresh probe landed: ${report.rootWindow.freshProbeLanded}`);
process.exit(0);
