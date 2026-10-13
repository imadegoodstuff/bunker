// Migration end-to-end: move a shielded balance from the OLD vault into a NEW
// vault through scash_migrator, with no user-held public key on the path.
//   node scripts/migrate-e2e.mjs [--rpc …] [--keypair …] --new-vault <program id>
// The new vault is the same program binary loaded under a second program id
// (what a real re-deployment looks like to the client).
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ShieldedWallet, MerkleTree, assetId, initializeIx, createPoolIx, configPda, treePda, poolPda, decodePool, decodeTree,
  amountForBurn, amountForMint, sharesForDeposit, staticAddresses, createLookupTable, fetchLookupTable, buildV0,
  MIGRATOR_PROGRAM_ID, migratePda, stageInstructions, executeIx, STAGING_HEADER,
} from "../sdk/dist/index.js";

const { values } = parseArgs({
  options: {
    rpc: { type: "string", default: "http://127.0.0.1:8899" },
    keypair: { type: "string", default: "keypairs/deployer.json" },
    "new-vault": { type: "string" },
  },
});
if (!values["new-vault"]) throw new Error("--new-vault <program id> required");
const NEW = new PublicKey(values["new-vault"]);
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

let table;
async function send(ixs, signers, label) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = buildV0(signers[0].publicKey, ixs, blockhash, table);
  tx.sign(signers);
  const size = tx.serialize().length;
  try {
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(JSON.stringify(res.value.err));
    const meta = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).meta;
    log(`${label}: ok  ${size}B  cu=${meta.computeUnitsConsumed}`);
    return sig;
  } catch (e) {
    console.error(`${label}: FAILED`, e.message.split("\n")[0]);
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => undefined) : undefined)
      ?? (await conn.simulateTransaction(tx, { sigVerify: false })).value.logs;
    if (logs) console.error(logs.join("\n"));
    throw e;
  }
}

// --- actors
const alice = Keypair.generate();
const relayer = Keypair.generate();
const refund = Keypair.generate(); // receives dust after migration; a fresh key, publishes nothing new
for (const k of [alice, relayer]) {
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: 5 * LAMPORTS_PER_SOL })), [payer]);
}
const aliceW = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(77));

// --- both vaults initialised
for (const [pid, name] of [[undefined, "old"], [NEW, "new"]]) {
  if (!(await conn.getAccountInfo(configPda(pid)))) await send([initializeIx(payer.publicKey, payer.publicKey, pid)], [payer], `${name} vault: initialize`);
  if (!(await conn.getAccountInfo(poolPda(SOL, pid)))) await send([createPoolIx(payer.publicKey, SOL, 1000n * BigInt(LAMPORTS_PER_SOL), undefined, pid)], [payer], `${name} vault: create SOL pool`);
}
const addrs = [...staticAddresses([{ mint: SOL }], undefined, relayer.publicKey), ...staticAddresses([{ mint: SOL }], NEW, relayer.publicKey), MIGRATOR_PROGRAM_ID];
const seen = new Set();
const tableAddr = await createLookupTable(conn, payer, addrs.filter((a) => (seen.has(a.toBase58()) ? false : seen.add(a.toBase58()))));
await new Promise((r) => setTimeout(r, 1500));
table = await fetchLookupTable(conn, tableAddr);
const pool = async (pid) => decodePool(new Uint8Array((await conn.getAccountInfo(poolPda(SOL, pid))).data));
const chainTree = async (pid) => decodeTree(new Uint8Array((await conn.getAccountInfo(treePda(pid))).data));
const oldTree = new MerkleTree(26);
const newTree = new MerkleTree(26);
await oldTree.whenReady();
await newTree.whenReady();
// local mirrors start from whatever the chain has (the e2e may have run before us)
for (const [tree, pid] of [[oldTree, undefined], [newTree, NEW]]) {
  const ct = await chainTree(pid);
  if (ct.nextIndex !== 0n) throw new Error("this script expects empty trees; run on a fresh validator or extend it to sync from the indexer");
}
const apply = async (tree, built, wallets) => {
  for (let i = 0; i < 2; i++) {
    const idx = await tree.insert(built.proof.outCommitments[i]);
    for (const w of wallets) await w.scan({ index: idx, commitment: built.proof.outCommitments[i], ciphertext: built.ext.ciphertexts[i] }, asset);
  }
  for (const w of wallets) w.markSpent(built.consumed);
};

// --- 1. alice shields 1 SOL into the OLD vault
let built = await aliceW.buildTransact({
  asset, mint: SOL, pool: await pool(), tree: oldTree, chainTree: await chainTree(), artifacts, kind: "shield", amount: 1n * BigInt(LAMPORTS_PER_SOL),
  relayer: alice.publicKey, relayerDest: alice.publicKey, relayerFee: 0n, payer: alice.publicKey, depositor: alice.publicKey,
});
await send([built.instruction], [alice], "old vault: shield 1 SOL");
await apply(oldTree, built, [aliceW]);
log("alice old-vault balance:", fmt(amountForBurn(await pool(), aliceW.balance(asset))));

// --- 2. stage the NEW-vault shield, paid for by the migration PDA
const staging = Keypair.generate();
const pda = migratePda(staging.publicKey);
const unshieldAmount = 500_000_000n;
const relayerFee = 2_000_000n;
const arriving = unshieldAmount - relayerFee; // what the PDA will hold
const rentForNullifiers = 2n * BigInt(await conn.getMinimumBalanceForRentExemption(1));
const shieldAmount = arriving - rentForNullifiers - 1_000_000n; // margin; dust is refunded
const newPool = await pool(NEW);
const shares = sharesForDeposit(newPool, shieldAmount);
log(`migrating ${fmt(unshieldAmount)}: PDA receives ${fmt(arriving)}, shields ${fmt(amountForMint(newPool, shares))} (${shares} shares), rest refunded`);

// a fresh wallet state for the new vault is just the same keys scanning a different tree
const aliceNew = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(77));
const staged = await aliceNew.buildTransact({
  asset, mint: SOL, pool: newPool, tree: newTree, chainTree: await chainTree(NEW), artifacts, kind: "shield", amount: shieldAmount,
  relayer: pda, relayerDest: pda, relayerFee: 0n, payer: pda, depositor: pda, depositorSource: pda, programId: NEW,
});
const payload = new Uint8Array(staged.instruction.data);
const rent = await conn.getMinimumBalanceForRentExemption(STAGING_HEADER + payload.length);
const { create, init, writes } = stageInstructions({ authority: alice.publicKey, staging: staging.publicKey, target: NEW, refund: refund.publicKey, payload, rentLamports: rent });
await send([create, init], [alice, staging], `stage: create + init (${payload.length}-byte shield for the new vault)`);
for (const [i, w] of writes.entries()) await send([w], [alice], `stage: write chunk ${i + 1}/${writes.length}`);

// --- 3. unshield from the OLD vault straight to the migration PDA (relayer-paid)
built = await aliceW.buildTransact({
  asset, mint: SOL, pool: await pool(), tree: oldTree, chainTree: await chainTree(), artifacts, kind: "unshield", amount: unshieldAmount, recipient: pda,
  relayer: relayer.publicKey, relayerDest: relayer.publicKey, relayerFee, payer: relayer.publicKey,
});
await send([built.instruction], [relayer], "old vault: unshield → migration PDA (relayed)");
await apply(oldTree, built, [aliceW]);
const pdaBal = BigInt(await conn.getBalance(pda));
log("PDA holds:", fmt(pdaBal));
if (pdaBal !== arriving) throw new Error(`PDA balance ${pdaBal} != expected ${arriving}`);

// --- 4. anyone executes: the PDA signs the staged shield into the NEW vault
const exec = executeIx({ staging: staging.publicKey, refund: refund.publicKey, targetIx: staged.instruction });
await send([exec], [relayer], "migrator: execute (relayer, permissionless)");
await apply(newTree, staged, [aliceNew]);

// --- 5. verify
const np = await pool(NEW);
const newBal = aliceNew.balance(asset);
log("alice new-vault balance:", fmt(amountForBurn(np, newBal)), `(${newBal} shares)`);
if (newBal !== shares) throw new Error(`new-vault shares ${newBal} != ${shares}`);
if (np.totalIn !== amountForMint(newPool, shares)) throw new Error("new pool total_in mismatch");
if ((await conn.getBalance(pda)) !== 0) throw new Error("PDA not emptied");
if (await conn.getAccountInfo(staging.publicKey)) throw new Error("staging not closed");
const refunded = BigInt(await conn.getBalance(refund.publicKey));
log("refund received:", fmt(refunded), "(dust + staging rent)");
if (refunded < arriving - amountForMint(newPool, shares) - rentForNullifiers) throw new Error("refund too small");
const op = await pool();
log(`old pool: in=${fmt(op.totalIn)} out=${fmt(op.totalOut)}; new pool: in=${fmt(np.totalIn)} out=${fmt(np.totalOut)}`);
log("MIGRATION E2E PASSED");
process.exit(0);
