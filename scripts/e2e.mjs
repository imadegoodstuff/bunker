// End-to-end protocol test against a live cluster (local validator by default).
//   node scripts/e2e.mjs [--rpc http://127.0.0.1:8899] [--keypair keypairs/deployer.json]
// Flow: initialize → create SOL pool → Alice shields 1 SOL → Alice privately
// sends 0.4 SOL to Bob (relayer-paid, fee from the note) → Bob unshields 0.25 SOL
// to a fresh public key → donate() raises the share rate → turnstile checks.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Connection, Keypair, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ShieldedWallet, MerkleTree, assetId, encodeAddress, decodeAddress, initializeIx, createPoolIx, donateIx,
  configPda, treePda, poolPda, decodePool, decodeTree, amountForBurn, staticAddresses, createLookupTable, fetchLookupTable, buildV0,
} from "../sdk/dist/index.js";

const { values } = parseArgs({ options: { rpc: { type: "string", default: "http://127.0.0.1:8899" }, keypair: { type: "string", default: "keypairs/deployer.json" } } });
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
const fmt = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4) + " SOL";

let table; // address lookup table, created after the pool exists
async function send(ixs, signers, label) {
  try {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const tx = buildV0(signers[0].publicKey, ixs, blockhash, table);
    tx.sign(signers);
    const size = tx.serialize().length;
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(JSON.stringify(res.value.err));
    const meta = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).meta;
    log(`${label}: ok  ${size}B  cu=${meta.computeUnitsConsumed}  sig=${sig.slice(0, 16)}…`);
    return sig;
  } catch (e) {
    console.error(`${label}: FAILED`, e.message.split("\n")[0]);
    let logs = e.logs;
    if (!logs && typeof e.getLogs === "function") logs = await e.getLogs(conn).catch(() => undefined);
    if (!logs) {
      const { blockhash } = await conn.getLatestBlockhash();
      const tx = buildV0(signers[0].publicKey, ixs, blockhash, table);
      tx.sign(signers);
      logs = (await conn.simulateTransaction(tx, { sigVerify: false })).value.logs;
    }
    if (logs) console.error(logs.join("\n"));
    throw e;
  }
}

// --- actors
const alice = Keypair.generate();
const relayer = Keypair.generate();
const bobPublic = Keypair.generate();
for (const k of [alice, relayer]) {
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: 5 * LAMPORTS_PER_SOL })), [payer]);
}
const aliceW = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(1));
const bobW = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(2));
const bobAddr = encodeAddress(bobW.bjj, bobW.address(), "tscash");
log("bob shielded address:", bobAddr);

// --- protocol init
if (!(await conn.getAccountInfo(configPda()))) await send([initializeIx(payer.publicKey, payer.publicKey)], [payer], "initialize");
if (!(await conn.getAccountInfo(poolPda(SOL)))) await send([createPoolIx(payer.publicKey, SOL, 1000n * BigInt(LAMPORTS_PER_SOL))], [payer], "create SOL pool");
const tableAddr = await createLookupTable(conn, payer, staticAddresses([{ mint: SOL }], undefined, relayer.publicKey));
await new Promise((r) => setTimeout(r, 1500)); // tables become usable one slot after extension
table = await fetchLookupTable(conn, tableAddr);
log(`lookup table ${tableAddr.toBase58()} with ${table.state.addresses.length} addresses`);
const pool = async () => decodePool(new Uint8Array((await conn.getAccountInfo(poolPda(SOL))).data));
const chainTree = async () => decodeTree(new Uint8Array((await conn.getAccountInfo(treePda())).data));

// Local tree mirror shared by both wallets (what the indexer would serve).
const tree = new MerkleTree(26);
await tree.whenReady();
const applyOutputs = async (built) => {
  // ingest the two new leaves into the local tree and both wallets
  for (let i = 0; i < 2; i++) {
    const cm = built.proof.outCommitments[i];
    const idx = await tree.insert(cm);
    for (const w of [aliceW, bobW]) await w.scan({ index: idx, commitment: cm, ciphertext: built.ext.ciphertexts[i] }, asset);
  }
  for (const w of [aliceW, bobW]) w.markSpent(built.consumedNullifiers);
  const ct = await chainTree();
  if (ct.currentRoot !== (await tree.root())) throw new Error("local root != chain root");
  log(`tree ok: ${tree.size} leaves, root matches chain`);
};

// --- 1. Alice shields 1 SOL
let p = await pool();
let built = await aliceW.buildTransact({
  asset, mint: SOL, pool: p, tree, chainTree: await chainTree(), artifacts, kind: "shield", amount: 1n * BigInt(LAMPORTS_PER_SOL),
  relayer: alice.publicKey, relayerDest: alice.publicKey, relayerFee: 0n, payer: alice.publicKey, depositor: alice.publicKey,
});
log(`shield proof built (${built.proof.circuit})`);
await send([built.instruction], [alice], "shield 1 SOL");
await applyOutputs(built);
log("alice shielded balance:", fmt(amountForBurn(await pool(), aliceW.balance(asset))));

// --- 2. Alice privately sends 0.4 SOL to Bob; relayer pays, fee 0.002 SOL comes out of the note
p = await pool();
const fee = 2_000_000n;
built = await aliceW.buildTransact({
  asset, mint: SOL, pool: p, tree, chainTree: await chainTree(), artifacts, kind: "send", amount: 400_000_000n, to: decodeAddress(bobW.bjj, bobAddr).address,
  relayer: relayer.publicKey, relayerDest: relayer.publicKey, relayerFee: fee, payer: relayer.publicKey,
  memo: new TextEncoder().encode("invoice #42"),
});
const relayerBefore = await conn.getBalance(relayer.publicKey);
await send([built.instruction], [relayer], "private send 0.4 SOL → bob (relayed)");
await applyOutputs(built);
const bobNote = bobW.spendable(asset)[0];
log("bob received note:", fmt(amountForBurn(await pool(), bobNote.value)), "memo:", new TextDecoder().decode(bobNote.memo ?? new Uint8Array()).replace(/\0+$/, ""));
log("alice change:", fmt(amountForBurn(await pool(), aliceW.balance(asset))));
log("relayer net:", fmt(BigInt((await conn.getBalance(relayer.publicKey)) - relayerBefore), "(fee minus tx cost)"));

// --- 3. Bob unshields 0.25 SOL to a fresh public key via the relayer
p = await pool();
built = await bobW.buildTransact({
  asset, mint: SOL, pool: p, tree, chainTree: await chainTree(), artifacts, kind: "unshield", amount: 250_000_000n, recipient: bobPublic.publicKey,
  relayer: relayer.publicKey, relayerDest: relayer.publicKey, relayerFee: fee, payer: relayer.publicKey,
});
await send([built.instruction], [relayer], "unshield 0.25 SOL → fresh key (relayed)");
await applyOutputs(built);
log("fresh public key received:", fmt(await conn.getBalance(bobPublic.publicKey)));
log("bob shielded remainder:", fmt(amountForBurn(await pool(), bobW.balance(asset))));

// --- 4. donate 0.1 SOL: every shielded balance grows, no new notes
const before = amountForBurn(await pool(), aliceW.balance(asset));
await send([donateIx(payer.publicKey, payer.publicKey, SOL, 100_000_000n)], [payer], "donate 0.1 SOL");
const after = amountForBurn(await pool(), aliceW.balance(asset));
log(`alice balance after donate: ${fmt(before)} → ${fmt(after)} (+${fmt(after - before)}) with zero transactions from alice`);

// --- 5. double-spend must fail
try {
  await send([built.instruction], [relayer], "replay unshield (must fail)");
  throw new Error("replay was accepted!");
} catch (e) {
  if (/replay was accepted/.test(e.message)) throw e;
  log("replay rejected as expected");
}

const fp = await pool();
log(`turnstile: total_in=${fmt(fp.totalIn)} total_out=${fmt(fp.totalOut)} vault_assets=${fmt(fp.totalAssets)} shares=${fp.totalShares}`);
if (fp.totalOut > fp.totalIn) throw new Error("turnstile violated");
log("E2E PASSED");
process.exit(0);
