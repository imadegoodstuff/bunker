// Launchpad end-to-end: a token is launched, bought from inside the shielded
// pool, claimed into its own pool, sold back privately, and the trading fees
// are harvested into holder yield. No buyer wallet appears anywhere.
//   node scripts/launch-e2e.mjs [--rpc …] [--keypair …]
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  ShieldedWallet, MerkleTree, assetId, initializeIx, createPoolIx, configPda, treePda, poolPda, decodePool, decodeTree,
  amountForBurn, amountForMint, sharesForDeposit, sharesForWithdraw, staticAddresses, PROGRAM_ID, createLookupTable, fetchLookupTable, buildV0, TOKEN_2022_PROGRAM_ID,
  LAUNCH_PROGRAM_ID, launchpadPda, curvePda, intakePda, intakeAta, claimAta, claimKeypair, decodeCurve, decodeLaunchpad, decodeTokenMetadata,
  defaultLaunchpadParams, initLaunchpadIx, launchIx, harvestIx, exitData, exitAccounts, EXIT_BUY, EXIT_SELL,
  fetchClaimRents, quotePrivateBuy, quotePrivateSell, buyReserve, claimShieldAccounts, closeTokenAccountIx, launchLookupTableIxs, lookupTableCovers, spotPrice,
  voteIx, rolled, policy, epochOf, migrateIx, ammMigratePda, raydium, TOKEN_PROGRAM_ID, associatedTokenAddress,
} from "../sdk/dist/index.js";

const { values } = parseArgs({ options: { rpc: { type: "string", default: "http://127.0.0.1:8899" }, keypair: { type: "string", default: "keypairs/deployer.json" } } });
const conn = new Connection(values.rpc, "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(values.keypair, "utf8"))));
const artifacts = {
  transact2x2: { wasm: "circuits/build/transact2x2/transact2x2_js/transact2x2.wasm", zkey: "circuits/build/transact2x2/transact2x2_dev.zkey" },
  transact4x2: { wasm: "circuits/build/transact4x2/transact4x2_js/transact4x2.wasm", zkey: "circuits/build/transact4x2/transact4x2_dev.zkey" },
};
const SOL = SystemProgram.programId;
const solAsset = assetId(SOL);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const fmt = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(4) + " SOL";
const fmtT = (t, d = 6) => (Number(t) / 10 ** d).toLocaleString("en-US", { maximumFractionDigits: 2 });
const assert = (c, m) => { if (!c) throw new Error(`ASSERT: ${m}`); };

let tables = [];
async function send(ixs, signers, label, { cu } = {}) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const tx = buildV0(signers[0].publicKey, ixs, blockhash, tables, { cuLimit: cu ?? 1_400_000 });
  tx.sign(signers);
  const size = tx.serialize().length;
  try {
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(JSON.stringify(res.value.err));
    const meta = (await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 })).meta;
    log(`${label}: ok  ${size}B  cu=${meta.computeUnitsConsumed}`);
    return { sig, meta };
  } catch (e) {
    console.error(`${label}: FAILED`, e.message.split("\n")[0]);
    const logs = e.logs ?? (typeof e.getLogs === "function" ? await e.getLogs(conn).catch(() => undefined) : undefined)
      ?? (await conn.simulateTransaction(tx, { sigVerify: false })).value.logs;
    if (logs) console.error(logs.join("\n"));
    throw e;
  }
}
const expectFail = async (p, re, label) => {
  try { await p; } catch (e) { if (re.test(e.message) || re.test(String(e.logs ?? ""))) { log(`${label}: rejected as expected`); return; } throw e; }
  throw new Error(`${label}: should have failed`);
};

// --- actors
const alice = Keypair.generate(); // funds her shielded balance publicly once; never touches the token
const relayer = Keypair.generate();
const treasury = Keypair.generate();
const agents = [0, 1, 2, 3].map(() => Keypair.generate()); // four fee-policy voters, one model each in production
for (const k of [alice, relayer, ...agents]) {
  await sendAndConfirmTransaction(conn, new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: k.publicKey, lamports: 40 * LAMPORTS_PER_SOL })), [payer]);
}
const seed = new Uint8Array(32).fill(42);
const aliceW = await ShieldedWallet.fromSeed(seed);

// --- vault + launchpad
if (!(await conn.getAccountInfo(configPda()))) await send([initializeIx(payer.publicKey, payer.publicKey)], [payer], "vault: initialize");
if (!(await conn.getAccountInfo(poolPda(SOL)))) await send([createPoolIx(payer.publicKey, SOL, 100_000n * BigInt(LAMPORTS_PER_SOL))], [payer], "vault: create SOL pool");
const params = defaultLaunchpadParams(treasury.publicKey, agents.map((a) => a.publicKey));
if (!(await conn.getAccountInfo(launchpadPda()))) await send([initLaunchpadIx(payer.publicKey, params)], [payer], "launchpad: initialise");
const lp = decodeLaunchpad(new Uint8Array((await conn.getAccountInfo(launchpadPda())).data));
assert(lp.tradeFeeBps === 100 && lp.vaultProgram.equals(PROGRAM_ID) && lp.curveSupply === params.curveSupply, "launchpad decoded");
assert(lp.agents.every((a, i) => a.equals(agents[i].publicKey)), "launchpad records the four agent keys");
await expectFail(send([initLaunchpadIx(payer.publicKey, params)], [payer], "launchpad: second initialise"), /0x2\b|AlreadyInitialized/, "launchpad is write-once");

// --- 1. launch: the frozen lookup table in one transaction, then mint + curve + shielded pool in a second, paid by a public wallet (the creator)
const mint = Keypair.generate();
const meta = { name: "Shielded Test", symbol: "SHT", uri: "https://scash.example/sht.json" };
const alt = launchLookupTableIxs(payer.publicKey, mint.publicKey, await conn.getSlot("finalized"));
await send(alt.ixs, [payer], `lookup table for ${meta.symbol}`);
await send([launchIx(payer.publicKey, mint.publicKey, meta, alt.table)], [payer, mint], `launch ${meta.symbol}`);
const mintInfo = await conn.getAccountInfo(mint.publicKey);
assert(mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID), "mint is Token-2022");
assert(mintInfo.data[46] === 0, "no freeze authority (COption tag at 46)");
assert(mintInfo.data[0] === 0, "mint authority revoked (COption tag at 0)");
const md = decodeTokenMetadata(new Uint8Array(mintInfo.data));
assert(md && md.name === meta.name && md.symbol === meta.symbol && md.uri === meta.uri, `metadata on the mint: ${JSON.stringify(md)}`);
const tokenAsset = assetId(mint.publicKey);
const tokenPool = async () => decodePool(new Uint8Array((await conn.getAccountInfo(poolPda(mint.publicKey))).data));
const curve = async () => decodeCurve(new Uint8Array((await conn.getAccountInfo(curvePda(mint.publicKey))).data));
let c = await curve();
assert(c.realToken === params.curveSupply && c.virtualToken === params.virtualToken && c.realSol === 0n && !c.graduated, "fresh curve state");
assert((await tokenPool()).totalShares === 0n, "token pool exists and is empty");
assert(c.lookupTable.equals(alt.table), "curve records its lookup table");
log(`curve: ${fmtT(c.realToken)} ${meta.symbol} for sale, spot ${(spotPrice(c, 6) / LAMPORTS_PER_SOL).toExponential(3)} SOL/token`);

// --- 1b. fee policy: three agents vote (median 200 bps / 7000), a stranger and an out-of-bounds vote are refused
const voteEpoch = epochOf(BigInt(await conn.getSlot("confirmed")));
await send([voteIx(agents[0].publicKey, mint.publicKey, 150, 6000)], [agents[0]], "agent 0 votes 1.5 % / 60 %");
await send([voteIx(agents[1].publicKey, mint.publicKey, 200, 7000)], [agents[1]], "agent 1 votes 2.0 % / 70 %");
await send([voteIx(agents[2].publicKey, mint.publicKey, 300, 10000)], [agents[2]], "agent 2 votes 3.0 % / 100 %");
await expectFail(send([voteIx(relayer.publicKey, mint.publicKey, 200, 7000)], [relayer], "stranger votes"), /0x10\b|NotAgent/, "only the four agents can vote");
await expectFail(
  send([{ programId: LAUNCH_PROGRAM_ID, keys: voteIx(agents[3].publicKey, mint.publicKey, 100, 5000).keys, data: Buffer.from(new Uint8Array([7, 0x2d, 0x01, 0x88, 0x13])) }], [agents[3]], "agent 3 votes 3.01 %"),
  /0xe\b|BadParams/, "a vote above the hard cap is refused",
);
c = await curve();
assert(c.votes[0].feeBps === 150 && c.votes[1].holderBps === 7000 && c.votes[2].feeBps === 300 && c.votes[3].slot === 0n, "votes recorded per agent");
assert(c.tradeFeeBps === 100 && c.holderShareBps === 5000, "votes do not move the fee inside the epoch they were cast");
const slotNow = BigInt(await conn.getSlot("confirmed"));
log(`fee now ${c.tradeFeeBps} bps; the epoch after ${voteEpoch} will step to ${rolled(c, (voteEpoch + 1n) * policy.EPOCH_SLOTS).tradeFeeBps} bps (slot ${slotNow}, epoch ${epochOf(slotNow)})`);

// --- lookup tables: the relayer's (vault statics, SOL pool) and the token's own frozen one, found via the curve
const relayerTable = await fetchLookupTable(conn, await createLookupTable(conn, payer, staticAddresses([{ mint: SOL }], undefined, relayer.publicKey)));
await new Promise((r) => setTimeout(r, 1500));
const tokenTable = await fetchLookupTable(conn, c.lookupTable);
assert(tokenTable.state.authority === undefined, "token table is frozen (no authority)");
assert(lookupTableCovers(tokenTable.state.addresses, mint.publicKey), "token table holds the launch statics");
tables = [await fetchLookupTable(conn, relayerTable.key), tokenTable];

const tree = new MerkleTree(26);
await tree.whenReady();
const chainTree = async () => decodeTree(new Uint8Array((await conn.getAccountInfo(treePda())).data));
if ((await chainTree()).nextIndex !== 0n) throw new Error("this script expects an empty tree; run on a fresh validator");
const apply = async (built, asset) => {
  for (let i = 0; i < 2; i++) {
    const idx = await tree.insert(built.proof.outCommitments[i]);
    await aliceW.scan({ index: idx, commitment: built.proof.outCommitments[i], ciphertext: built.ext.ciphertexts[i] }, asset);
  }
  aliceW.markSpent(built.consumedNullifiers);
};
const solPool = async () => decodePool(new Uint8Array((await conn.getAccountInfo(poolPda(SOL))).data));

// --- 2. alice shields 30 SOL (the only public act she ever performs)
let built = await aliceW.buildTransact({
  asset: solAsset, mint: SOL, pool: await solPool(), tree, chainTree: await chainTree(), artifacts, kind: "shield", amount: 30n * BigInt(LAMPORTS_PER_SOL),
  relayer: alice.publicKey, relayerDest: alice.publicKey, relayerFee: 0n, payer: alice.publicKey, depositor: alice.publicKey,
});
await send([built.instruction], [alice], "alice: shield 30 SOL");
await apply(built, solAsset);

// --- 3. there is no public route onto the curve, and nothing to migrate before graduation
await expectFail(send([{ programId: LAUNCH_PROGRAM_ID, keys: [{ pubkey: curvePda(mint.publicKey), isSigner: false, isWritable: true }], data: Buffer.from(new Uint8Array([5, ...new Uint8Array(16)])) }], [relayer], "public buy"), /error: 0x0(?![0-9a-f])|InvalidInstruction/, "curve is shielded-only: tag 5 is unassigned");
await expectFail(send([migrateIx(mint.publicKey, treasury.publicKey)], [relayer], "migrate before graduation"), /0x12\b|NotMigratable/, "migration waits for graduation");

// --- 4. private buy: unshield 2 SOL to the curve, tokens land at a throwaway claim key
const rents = await fetchClaimRents(conn);
const claimBudget = 3_000_000n; // the claim's own tx fee plus slack; anything left stays with the claim key
const relayerFee = 2_000_000n;
const buyAmount = 2n * BigInt(LAMPORTS_PER_SOL);
// what the vault will actually move: shares are rounded up, then burned at the pool rate
const sp0 = await solPool();
const delivered = amountForBurn(sp0, sharesForWithdraw(sp0, buyAmount)) - relayerFee;
const claim1 = claimKeypair(seed, 0n);
// quote against the fee the program will charge in the slot the trade lands in (the SDK mirrors `roll`)
const q = quotePrivateBuy(rolled(c, BigInt(await conn.getSlot("confirmed"))), delivered, rents, claimBudget);
log(`quote: ${fmt(delivered)} delivered → reserve ${fmt(q.reserve)}, fee ${fmt(q.fee)}, net ${fmt(q.net)} → ${fmtT(q.out)} ${meta.symbol}`);
built = await aliceW.buildTransact({
  asset: solAsset, mint: SOL, pool: await solPool(), tree, chainTree: await chainTree(), artifacts, kind: "unshield", amount: buyAmount,
  recipient: intakePda(mint.publicKey), relayer: relayer.publicKey, relayerDest: relayer.publicKey, relayerFee, payer: relayer.publicKey,
  exitTarget: LAUNCH_PROGRAM_ID, exitData: exitData(EXIT_BUY, claim1.publicKey, claimBudget, q.out),
  exitAccounts: exitAccounts(EXIT_BUY, mint.publicKey, claim1.publicKey, relayer.publicKey),
});
const relayerBefore = await conn.getBalance(relayer.publicKey);
await send([built.instruction], [relayer], "alice: private buy (relayed; vault → curve → claim key)");
await apply(built, solAsset);
c = await curve();
const claimTok = BigInt((await conn.getTokenAccountBalance(claimAta(claim1.publicKey, mint.publicKey))).value.amount);
const claimLamports = BigInt(await conn.getBalance(claim1.publicKey));
log(`claim key holds ${fmtT(claimTok)} ${meta.symbol} and ${fmt(claimLamports)}; curve real_sol=${fmt(c.realSol)} fees=${fmt(c.feesAccrued)} buys=${c.buys}`);
assert(claimTok === q.out, `tokens at claim ${claimTok} == quote ${q.out}`);
assert(claimLamports === rents.claimRent + 2n * rents.nullifierRent + claimBudget, "claim key funded with exactly rent + nullifier rents + budget");
assert(c.realSol === q.net && c.feesAccrued === q.fee && c.realToken === params.curveSupply - q.out, "curve books match the quote");
assert(BigInt(await conn.getBalance(intakePda(mint.publicKey))) === rents.claimRent, "intake keeps only its rent");
const relayerAfter = await conn.getBalance(relayer.publicKey);
log(`relayer net: ${fmt(BigInt(relayerAfter - relayerBefore))} (fee ${fmt(relayerFee)} minus 2 nullifier rents, tx fee; ATA rent reimbursed)`);

// --- 5. claim: the claim key shields its whole token balance into the token's pool — an ordinary vault shield, self-paid
let tp = await tokenPool();
const shieldShares = sharesForDeposit(tp, claimTok);
const shieldAmount = amountForMint(tp, shieldShares);
assert(shieldAmount <= claimTok, "shield amount fits the balance");
const claimShield = await aliceW.buildTransact({
  asset: tokenAsset, mint: mint.publicKey, pool: tp, tree, chainTree: await chainTree(), artifacts, kind: "shield", amount: claimTok,
  ...claimShieldAccounts(claim1.publicKey, mint.publicKey),
});
await send([claimShield.instruction, closeTokenAccountIx(claimAta(claim1.publicKey, mint.publicKey), relayer.publicKey, claim1.publicKey)], [claim1], "claim: shield tokens into the SHT pool (signed by the claim key only)");
await apply(claimShield, tokenAsset);
tp = await tokenPool();
assert(aliceW.balance(tokenAsset) === shieldShares, `alice holds ${shieldShares} SHT shares privately`);
assert(tp.totalIn === shieldAmount, "token pool total_in == shielded amount");
assert((await conn.getAccountInfo(claimAta(claim1.publicKey, mint.publicKey))) === null, "claim ATA closed");
log(`alice now privately holds ${fmtT(amountForBurn(tp, aliceW.balance(tokenAsset)))} ${meta.symbol}; claim key left with ${fmt(BigInt(await conn.getBalance(claim1.publicKey)))}`);

// --- 6. harvest: fee → protocol treasury + bought-back tokens donated to the SHT pool (holders' rate rises)
const rateBefore = amountForBurn(tp, 1_000_000n);
await send([harvestIx(mint.publicKey, treasury.publicKey)], [relayer], "harvest");
c = await curve();
tp = await tokenPool();
const rateAfter = amountForBurn(tp, 1_000_000n);
const treasuryBal = BigInt(await conn.getBalance(treasury.publicKey));
log(`treasury got ${fmt(treasuryBal)}; SHT pool rate ${rateBefore} → ${rateAfter} per 1e6 shares; fees left ${fmt(c.feesAccrued)}`);
assert(treasuryBal === q.fee - (q.fee * 5000n) / 10_000n, "protocol share is half the fee");
assert(rateAfter > rateBefore, "holders' share rate rose");
assert(c.feesAccrued === 0n, "fees fully harvested");
await expectFail(send([harvestIx(mint.publicKey, treasury.publicKey)], [relayer], "harvest again"), /0xc|Nothing/, "nothing to harvest twice");

// --- 7. private sell: unshield half the tokens to the curve, SOL lands at a second claim key
const claim2 = claimKeypair(seed, 1n);
const sellShares = aliceW.balance(tokenAsset) / 2n;
const sellAmount = amountForBurn(tp, sellShares);
const sellDelivered = amountForBurn(tp, sharesForWithdraw(tp, sellAmount));
// the vault's own fee would be in SHT, which no relayer prices: the relayer is tipped in SOL out of the proceeds instead
const relayerTip = 2_000_000n;
const sq = quotePrivateSell(rolled(c, BigInt(await conn.getSlot("confirmed"))), sellDelivered, relayerTip);
log(`sell quote: ${fmtT(sellDelivered)} ${meta.symbol} -> ${fmt(sq.out)} after fee ${fmt(sq.fee)} and tip ${fmt(relayerTip)}`);
built = await aliceW.buildTransact({
  asset: tokenAsset, mint: mint.publicKey, tokenProgram: TOKEN_2022_PROGRAM_ID, pool: tp, tree, chainTree: await chainTree(), artifacts, kind: "unshield", amount: sellAmount,
  recipient: intakeAta(mint.publicKey), relayer: relayer.publicKey, relayerDest: relayer.publicKey, relayerFee: 0n, payer: relayer.publicKey,
  exitTarget: LAUNCH_PROGRAM_ID, exitData: exitData(EXIT_SELL, claim2.publicKey, claimBudget, sq.out, relayerTip),
  exitAccounts: exitAccounts(EXIT_SELL, mint.publicKey, claim2.publicKey, relayer.publicKey),
});
const relayerBeforeSell = BigInt(await conn.getBalance(relayer.publicKey));
await send([built.instruction], [relayer], "alice: private sell (relayed; vault → curve → claim key)");
await apply(built, tokenAsset);
c = await curve();
const claim2Lamports = BigInt(await conn.getBalance(claim2.publicKey));
assert(claim2Lamports === sq.out, `SOL at claim key ${claim2Lamports} == quote ${sq.out}`);
assert(c.sells === 1n, "sell counted");
const relayerSellDelta = BigInt(await conn.getBalance(relayer.publicKey)) - relayerBeforeSell;
assert(relayerSellDelta > relayerTip - 2n * rents.nullifierRent - 20_000n && relayerSellDelta < relayerTip, `relayer received the tip net of rents/fee (${relayerSellDelta})`);
log(`claim key 2 holds ${fmt(claim2Lamports)}; curve real_sol=${fmt(c.realSol)}`);

// --- 8. claim the SOL back into the shielded SOL pool
const solBefore = aliceW.balance(solAsset);
const sp = await solPool();
const solShieldAmount = claim2Lamports - 2n * rents.nullifierRent - rents.claimRent - 50_000n; // keep rent-exempt minimum + fee slack behind
const solShield = await aliceW.buildTransact({
  asset: solAsset, mint: SOL, pool: sp, tree, chainTree: await chainTree(), artifacts, kind: "shield", amount: solShieldAmount,
  ...claimShieldAccounts(claim2.publicKey, SOL),
});
await send([solShield.instruction], [claim2], "claim: shield SOL back into the SOL pool (signed by the claim key only)");
await apply(solShield, solAsset);
assert(aliceW.balance(solAsset) > solBefore, "alice's shielded SOL grew");
log(`alice shielded SOL: ${fmt(amountForBurn(await solPool(), aliceW.balance(solAsset)))}`);

// --- 9. a wrong-origin exit call is refused: a direct call to the launch program with exit-shaped data
await expectFail(
  send([{ programId: LAUNCH_PROGRAM_ID, keys: exitAccounts(EXIT_BUY, mint.publicKey, claim1.publicKey, relayer.publicKey), data: Buffer.from(new Uint8Array(57)) }], [relayer], "direct exit-shaped call"),
  /error: 0x0(?![0-9a-f])|InvalidInstruction/, "exit path is CPI-only",
);

// --- 10. the fee policy rolls at the epoch boundary exactly as the SDK predicts
{
  const before = await curve();
  const boundary = (voteEpoch + 1n) * policy.EPOCH_SLOTS;
  let slot = BigInt(await conn.getSlot("confirmed"));
  const waitMs = Number(boundary - slot) * 100; // CI runs this validator with short slots; locally this may take a few minutes
  if (slot < boundary) log(`waiting for fee epoch ${voteEpoch + 1n} (slot ${boundary}, ≈${Math.ceil(waitMs / 1000)} s)`);
  while (slot < boundary) { await new Promise((r) => setTimeout(r, 1000)); slot = BigInt(await conn.getSlot("confirmed")); }
  await send([voteIx(agents[3].publicKey, mint.publicKey, 50, 5000)], [agents[3]], "agent 3 votes 0.5 % / 50 % (rolls the epoch first)");
  const after = await curve();
  const expected = rolled(before, slot);
  assert(after.tradeFeeBps === expected.tradeFeeBps && after.holderShareBps === expected.holderShareBps, `program and SDK agree after the roll: ${after.tradeFeeBps}/${after.holderShareBps} vs ${expected.tradeFeeBps}/${expected.holderShareBps}`);
  // one bounded step per epoch towards the medians (200 bps / 7000): the fee can only be 200 or, if two boundaries passed, the median itself
  assert([200, 300].includes(after.tradeFeeBps) && [6000, 7000].includes(after.holderShareBps) && after.tradeFeeBps - before.tradeFeeBps <= policy.FEE_STEP_BPS * Number(after.settledEpoch - before.settledEpoch), `bounded steps towards the median: fee ${after.tradeFeeBps} bps, holder share ${after.holderShareBps}`);
  assert(after.votes[3].feeBps === 50, "the late vote is recorded for the next epoch");
  log(`fee policy rolled: ${before.tradeFeeBps} → ${after.tradeFeeBps} bps, holder share ${before.holderShareBps} → ${after.holderShareBps} (epoch ${after.settledEpoch})`);
}

// --- 11. graduation at 20 SOL: the buy that crosses the line takes the last tokens, pays only for them, and the curve freezes
let gradFees, gradHolderBps, gradRealSol, vaultBefore;
{
  c = await curve();
  const claim3 = claimKeypair(seed, 2n);
  const gradBuy = 25n * BigInt(LAMPORTS_PER_SOL); // more than the curve has left to sell
  const sp3 = await solPool();
  const delivered3 = amountForBurn(sp3, sharesForWithdraw(sp3, gradBuy)) - relayerFee;
  const gq = quotePrivateBuy(rolled(c, BigInt(await conn.getSlot("confirmed"))), delivered3, rents, claimBudget);
  assert(gq.out === c.realToken && gq.refund > 0n, `the crossing buy is capped to the ${fmtT(c.realToken)} tokens left and refunds ${fmt(gq.refund)}`);
  log(`graduation buy: ${fmt(delivered3)} delivered → ${fmtT(gq.out)} ${meta.symbol} for ${fmt(gq.net)} (+ fee ${fmt(gq.fee)}), ${fmt(gq.refund)} refunded`);
  built = await aliceW.buildTransact({
    asset: solAsset, mint: SOL, pool: sp3, tree, chainTree: await chainTree(), artifacts, kind: "unshield", amount: gradBuy,
    recipient: intakePda(mint.publicKey), relayer: relayer.publicKey, relayerDest: relayer.publicKey, relayerFee, payer: relayer.publicKey,
    exitTarget: LAUNCH_PROGRAM_ID, exitData: exitData(EXIT_BUY, claim3.publicKey, claimBudget, gq.out),
    exitAccounts: exitAccounts(EXIT_BUY, mint.publicKey, claim3.publicKey, relayer.publicKey),
  });
  await send([built.instruction], [relayer], "alice: private buy that sells the curve out (relayed)");
  await apply(built, solAsset);
  c = await curve();
  assert(c.graduated && c.realToken === 0n, "curve graduated: sold out");
  assert(c.realSol >= 19_900_000_000n && c.realSol <= 20_100_000_000n, `≈20 SOL raised (${fmt(c.realSol)})`);
  const claim3Lamports = BigInt(await conn.getBalance(claim3.publicKey));
  assert(claim3Lamports === rents.claimRent + 2n * rents.nullifierRent + claimBudget + gq.refund, `refund landed at the claim key (${fmt(claim3Lamports)})`);
  assert(BigInt((await conn.getTokenAccountBalance(claimAta(claim3.publicKey, mint.publicKey))).value.amount) === gq.out, "last tokens at the claim key");
  log(`graduated at ${fmt(c.realSol)}; ${fmt(c.feesAccrued)} of fees still on the curve; ${c.buys} buys / ${c.sells} sells`);
  gradFees = c.feesAccrued; gradHolderBps = c.holderShareBps; gradRealSol = c.realSol;
  vaultBefore = BigInt((await conn.getTokenAccountBalance(c.tokenVault)).value.amount);
  assert(vaultBefore === params.totalSupply - params.curveSupply, "the vault keeps exactly the reserved supply for the AMM");

  // frozen: votes, harvest and further private trades are refused; alice's notes stay unspent
  await expectFail(send([voteIx(agents[0].publicKey, mint.publicKey, 100, 5000)], [agents[0]], "vote after graduation"), /0x11\b|Migrated/, "no fee left for the agents to set");
  await expectFail(send([harvestIx(mint.publicKey, treasury.publicKey)], [relayer], "harvest after graduation"), /0x11\b|Migrated/, "the last fees travel with the curve to the AMM");
  const claim4 = claimKeypair(seed, 3n);
  const late = await aliceW.buildTransact({
    asset: solAsset, mint: SOL, pool: await solPool(), tree, chainTree: await chainTree(), artifacts, kind: "unshield", amount: 1n * BigInt(LAMPORTS_PER_SOL),
    recipient: intakePda(mint.publicKey), relayer: relayer.publicKey, relayerDest: relayer.publicKey, relayerFee, payer: relayer.publicKey,
    exitTarget: LAUNCH_PROGRAM_ID, exitData: exitData(EXIT_BUY, claim4.publicKey, claimBudget, 0n),
    exitAccounts: exitAccounts(EXIT_BUY, mint.publicKey, claim4.publicKey, relayer.publicKey),
  });
  await expectFail(send([late.instruction], [relayer], "private buy after graduation"), /0x11\b|Migrated/, "the curve no longer trades; the whole unshield reverts");
}

// --- 12. migration: the curve becomes a Raydium CP-Swap pool with its SOL and the reserved supply; the LP is burned
{
  const treasuryBefore = BigInt(await conn.getBalance(treasury.publicKey));
  const pool = raydium.poolState(mint.publicKey);
  await send([migrateIx(mint.publicKey, treasury.publicKey)], [relayer], "migrate: curve → Raydium CP-Swap pool (permissionless, sent by the relayer)");
  c = await curve();
  assert(c.ammPool && c.ammPool.equals(pool), "curve records the pool");
  assert(c.realSol === 0n && c.realToken === 0n && c.feesAccrued === 0n, "curve emptied");
  const poolAcc = await conn.getAccountInfo(pool);
  assert(poolAcc && poolAcc.owner.equals(raydium.CP_SWAP_PROGRAM_ID), "pool state owned by CP-Swap");
  const { token0, wsolFirst } = raydium.ordered(mint.publicKey);
  const bal = async (a) => BigInt((await conn.getTokenAccountBalance(a)).value.amount);
  const v0 = await bal(raydium.vault(pool, token0));
  const v1 = await bal(raydium.vault(pool, wsolFirst ? mint.publicKey : raydium.WSOL_MINT));
  const [solV, tokV] = wsolFirst ? [v0, v1] : [v1, v0];
  const holder = (gradFees * BigInt(gradHolderBps)) / 10_000n;
  const protocol = gradFees - holder;
  assert(solV === gradRealSol + holder - 150_000_000n - 100_000_000n, `pool SOL = raised + holder share of the last fees − Raydium's 0.15 SOL − 0.1 SOL rent reserve (${fmt(solV)})`);
  assert(tokV === vaultBefore, `pool tokens = the reserved supply (${fmtT(tokV)})`);
  assert((await bal(c.tokenVault)) === 0n, "curve vault empty");
  assert((await conn.getTokenSupply(raydium.lpMint(pool))).value.amount === "0", "every LP token was burned; nobody can pull the liquidity");
  const mig = ammMigratePda(mint.publicKey);
  assert((await conn.getBalance(mig)) === 0 && (await conn.getAccountInfo(associatedTokenAddress(mig, raydium.WSOL_MINT, TOKEN_PROGRAM_ID))) === null && (await conn.getAccountInfo(claimAta(mig, mint.publicKey))) === null, "the migrate PDA and its token accounts are gone");
  const treasuryDelta = BigInt(await conn.getBalance(treasury.publicKey)) - treasuryBefore;
  assert(treasuryDelta >= protocol + 20_000_000n && treasuryDelta <= protocol + 100_000_000n, `treasury got the protocol share plus the unused rent reserve (${fmt(treasuryDelta)})`);
  assert(BigInt(await conn.getBalance(curvePda(mint.publicKey))) === BigInt(await conn.getMinimumBalanceForRentExemption(352)), "curve holds only its rent");
  await expectFail(send([migrateIx(mint.publicKey, treasury.publicKey)], [relayer], "migrate again"), /0x11\b|Migrated/, "migration happens once");
  const price = Number(solV) / Number(tokV);
  log(`pool ${pool.toBase58()}: ${fmt(solV)} + ${fmtT(tokV)} ${meta.symbol} (${(price * 1e6 / LAMPORTS_PER_SOL).toExponential(3)} SOL/${meta.symbol}), LP supply 0 — trades at ${raydium.swapUrl(mint.publicKey)}`);
}

// --- 13. what is public
const sigs = await conn.getSignaturesForAddress(LAUNCH_PROGRAM_ID, { limit: 40 });
const buyers = new Set();
for (const s of sigs) {
  const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  for (const k of tx.transaction.message.staticAccountKeys) buyers.add(k.toBase58());
}
assert(!buyers.has(alice.publicKey.toBase58()), "alice's wallet never appears in any launchpad transaction");
log(`alice's public key appears in ${sigs.length} launchpad transactions: 0 — only relayer, curve PDAs and two throwaway claim keys do`);
log("LAUNCH E2E PASSED");
process.exit(0);
