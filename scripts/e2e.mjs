// End-to-end protocol test against a live EVM (a Hardhat node by default).
//   node scripts/e2e.mjs [--rpc http://127.0.0.1:8545] [--deployments contracts/deployments/31337.json] [--spawn]
// With --spawn (default when no --rpc) a Hardhat node is started, the contracts
// deployed to it with contracts/scripts/deploy.cjs, and everything torn down.
//
// Flow: Alice shields 1 BNB → privately sends 0.4 BNB to Bob (relayer-paid,
// fee from the note) → Bob unshields 0.25 BNB to a fresh address → donate()
// raises the share rate → replay fails → launchpad: launch, private buy through
// the exit hook, claim shields the tokens, private sell, claim shields the BNB,
// agents vote and the fee rolls, a graduation-sized buy, migrate to the AMM.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, decodeEventLog, getAddress } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import {
  ShieldedWallet, MerkleTree, assetId, encodeAddress, decodeAddress, amountForBurn, readPool, readLastRoot, NATIVE_TOKEN, ZERO_ADDRESS,
  ShieldedPoolAbi, LaunchpadAbi, LaunchTokenAbi, claimKey, exitData, EXIT_BUY, EXIT_SELL, readCurve, readParams, quotePrivateBuy, quotePrivateSell,
  voteCall, rollPolicyCall, migrateCall, launchCall, contractErrorName, worstFeeBps, policy,
} from "../sdk/dist/index.js";

const { values } = parseArgs({
  options: {
    rpc: { type: "string" },
    deployments: { type: "string", default: "contracts/deployments/31337.json" },
    spawn: { type: "boolean", default: false },
  },
});
const spawnNode = values.spawn || !values.rpc;
const rpc = values.rpc ?? "http://127.0.0.1:8545";
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const fmt = (wei) => Number(formatEther(wei)).toFixed(5) + " BNB";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// Hardhat's default accounts
const MNEMONIC = "test test test test test test test test test test test junk";
const acct = (i) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const deployer = acct(0), alice = acct(1), relayer = acct(2), treasury = acct(7);
const agents = [3, 4, 5, 6].map(acct);
const bobPublic = privateKeyToAccount("0x" + "42".repeat(32));

let node;
if (spawnNode) {
  log("starting hardhat node");
  node = spawn(npx, ["hardhat", "node", "--port", "8545"], { cwd: "contracts", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  await new Promise((resolve, reject) => {
    node.stdout.on("data", (d) => { if (/Started HTTP/.test(d.toString())) resolve(); });
    node.on("exit", (c) => reject(new Error(`hardhat node exited ${c}`)));
    setTimeout(() => reject(new Error("hardhat node did not start")), 60_000);
  });
  log("deploying");
  execFileSync(npx, ["hardhat", "run", "scripts/deploy.cjs", "--network", "localhost"], {
    cwd: "contracts", stdio: "inherit", shell: process.platform === "win32",
    env: { ...process.env, AGENTS: agents.map((a) => a.address).join(","), TREASURY: treasury.address, GRADUATION_BNB: "6" },
  });
}
const stop = (code) => {
  if (node) {
    // on Windows the shell wrapper would be killed but not the node behind it
    if (process.platform === "win32") { try { execFileSync("taskkill", ["/pid", String(node.pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* gone */ } }
    else node.kill();
  }
  process.exit(code);
};
process.on("uncaughtException", (e) => { console.error(e); stop(1); });
process.on("unhandledRejection", (e) => { console.error(e); stop(1); });

if (!existsSync(values.deployments)) throw new Error(`no deployments file at ${values.deployments}`);
const dep = JSON.parse(readFileSync(values.deployments, "utf8"));
const POOL = getAddress(dep.pool), LAUNCHPAD = getAddress(dep.launchpad);
const chain = { ...hardhat, id: dep.chainId };
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(rpc) });

const artifacts = {
  transact2x2: { wasm: "circuits/build/transact2x2/transact2x2_js/transact2x2.wasm", zkey: "circuits/build/transact2x2/transact2x2_dev.zkey" },
  transact4x2: { wasm: "circuits/build/transact4x2/transact4x2_js/transact4x2.wasm", zkey: "circuits/build/transact4x2/transact4x2_dev.zkey" },
};
const bnbAsset = assetId(NATIVE_TOKEN);

async function send(account, call, label) {
  const w = wallet(account);
  try {
    const { request } = await pub.simulateContract({ ...call, account });
    const hash = await w.writeContract(request);
    const rc = await pub.waitForTransactionReceipt({ hash });
    if (rc.status !== "success") throw new Error("reverted");
    log(`${label}: ok  gas=${rc.gasUsed}  tx=${hash.slice(0, 14)}…`);
    return rc;
  } catch (e) {
    const name = contractErrorName(e);
    console.error(`${label}: FAILED ${name ?? ""} ${String(e.shortMessage ?? e.message).split("\n")[0]}`);
    throw e;
  }
}

// --- actors
const aliceW = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(1));
const bobW = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(2));
const bobAddr = encodeAddress(bobW.bjj, bobW.address(), "tbunker");
log("bob shielded address:", bobAddr);
await wallet(deployer).sendTransaction({ to: alice.address, value: parseEther("10") }).then((h) => pub.waitForTransactionReceipt({ hash: h }));

// Local tree mirror shared by both wallets (what the indexer serves in production).
const tree = new MerkleTree(26);
await tree.whenReady();
const assets = new Set([bnbAsset]);
const applyReceipt = async (rc, built) => {
  const ev = rc.logs.map((l) => { try { return decodeEventLog({ abi: ShieldedPoolAbi, ...l }); } catch { return null; } }).find((e) => e && e.eventName === "Transact");
  if (!ev) throw new Error("no Transact event");
  const asset = assetId(ev.args.token);
  const cms = [ev.args.commitment0, ev.args.commitment1];
  const cts = [ev.args.ciphertext0, ev.args.ciphertext1].map((h) => Uint8Array.from(Buffer.from(h.slice(2), "hex")));
  for (let i = 0; i < 2; i++) {
    const idx = await tree.insert(cms[i]);
    if (idx !== Number(ev.args.firstIndex) + i) throw new Error("leaf index mismatch");
    for (const w of [aliceW, bobW]) await w.scan({ index: idx, commitment: cms[i], ciphertext: cts[i] }, asset);
  }
  if (built) for (const w of [aliceW, bobW]) w.markSpent(built.consumedNullifiers);
  const chainRoot = await readLastRoot(pub, POOL);
  if (chainRoot !== (await tree.root())) throw new Error("local root != chain root");
  if (chainRoot !== ev.args.newRoot) throw new Error("event root != chain root");
  log(`tree ok: ${tree.size} leaves, root matches chain`);
};
const G = 10n ** 9n; // 1 unit = 1 gwei in the BNB pool

// --- 1. Alice shields 1 BNB
let p = await readPool(pub, POOL, NATIVE_TOKEN);
if (p.unit !== G) throw new Error("BNB pool unit must be 1 gwei");
let built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "shield", amount: parseEther("1") / G,
  relayer: alice.address, relayerFee: 0n,
});
log(`shield proof built (${built.proof.circuit}), value ${fmt(built.call.value)}`);
let rc = await send(alice, built.call, "shield 1 BNB");
await applyReceipt(rc, built);
log("alice shielded balance:", fmt(amountForBurn(await readPool(pub, POOL, NATIVE_TOKEN), aliceW.balance(bnbAsset)) * G));

// --- 2. Alice privately sends 0.4 BNB to Bob; relayer pays gas, fee 0.002 BNB comes out of the note
p = await readPool(pub, POOL, NATIVE_TOKEN);
const fee = parseEther("0.002") / G;
built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "send", amount: parseEther("0.4") / G,
  to: decodeAddress(bobW.bjj, bobAddr).address, relayer: relayer.address, relayerFee: fee, memo: new TextEncoder().encode("invoice #42"),
});
const relayerBefore = await pub.getBalance({ address: relayer.address });
rc = await send(relayer, built.call, "private send 0.4 BNB → bob (relayed)");
await applyReceipt(rc, built);
const bobNote = bobW.spendable(bnbAsset)[0];
log("bob received note:", fmt(amountForBurn(await readPool(pub, POOL, NATIVE_TOKEN), bobNote.value) * G), "memo:", new TextDecoder().decode(bobNote.memo ?? new Uint8Array()).replace(/\0+$/, ""));
log("relayer net:", fmt((await pub.getBalance({ address: relayer.address })) - relayerBefore), "(fee minus gas)");

// --- 3. Bob unshields 0.25 BNB to a fresh address via the relayer
p = await readPool(pub, POOL, NATIVE_TOKEN);
built = await bobW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "unshield", amount: parseEther("0.25") / G,
  recipient: bobPublic.address, relayer: relayer.address, relayerFee: fee,
});
const replay = built.call;
rc = await send(relayer, built.call, "unshield 0.25 BNB → fresh address (relayed)");
await applyReceipt(rc, built);
log("fresh address received:", fmt(await pub.getBalance({ address: bobPublic.address })));

// --- 4. donate 0.1 BNB: every shielded balance grows, no new notes
const before = amountForBurn(await readPool(pub, POOL, NATIVE_TOKEN), aliceW.balance(bnbAsset));
await send(deployer, { address: POOL, abi: ShieldedPoolAbi, functionName: "donate", args: [NATIVE_TOKEN, parseEther("0.1") / G], value: parseEther("0.1") }, "donate 0.1 BNB");
const after = amountForBurn(await readPool(pub, POOL, NATIVE_TOKEN), aliceW.balance(bnbAsset));
log(`alice balance after donate: ${fmt(before * G)} → ${fmt(after * G)} (+${fmt((after - before) * G)})`);

// --- 5. double-spend must fail
try {
  await pub.simulateContract({ ...replay, account: relayer });
  throw new Error("replay was accepted!");
} catch (e) {
  if (/replay was accepted/.test(e.message)) throw e;
  const name = contractErrorName(e);
  if (name !== "NullifierSpent" && name !== "UnknownRoot") throw new Error(`unexpected replay error ${name}`);
  log(`replay rejected as expected (${name})`);
}
const fp = await readPool(pub, POOL, NATIVE_TOKEN);
log(`turnstile: total_in=${fmt(fp.totalIn * G)} total_out=${fmt(fp.totalOut * G)} assets=${fmt(fp.totalAssets * G)} shares=${fp.totalShares}`);
if (fp.totalOut > fp.totalIn) throw new Error("turnstile violated");

// ======================= launchpad =======================
const params = await readParams(pub, LAUNCHPAD);
log(`launchpad: fee ${params.tradeFeeBps} bps, graduation ${fmt(params.graduationWei)}, virtual ${fmt(params.virtualBnb)}, agents ${params.agents.length}`);
rc = await send(deployer, launchCall(LAUNCHPAD, "Bunker Test", "BNKT", "ipfs://bunker-test"), "launch BNKT");
const launchEv = rc.logs.map((l) => { try { return decodeEventLog({ abi: LaunchpadAbi, ...l }); } catch { return null; } }).find((e) => e && e.eventName === "Launch");
const TOKEN = getAddress(launchEv.args.token);
const tokenAsset = assetId(TOKEN);
assets.add(tokenAsset);
const tokenPool = await readPool(pub, POOL, TOKEN);
if (!tokenPool.exists || tokenPool.unit !== 1n) throw new Error("token pool not created with unit 1");
log(`token ${TOKEN}, pool unit ${tokenPool.unit}`);

// --- 6. Alice buys privately: unshield 0.5 BNB into the launchpad with a claim key
let curve = await readCurve(pub, LAUNCHPAD, TOKEN);
const budget = parseEther("0.003"), tip = parseEther("0.0005");
const buyIn = parseEther("0.5");
const claim1 = claimKey(aliceW.spend.sk, 1n);
const block = await pub.getBlockNumber();
const worst = worstFeeBps(curve, block);
const q = quotePrivateBuy({ ...curve, tradeFeeBps: worst }, buyIn - fee * G, budget, tip);
const minOut = (q.out * 995n) / 1000n;
p = await readPool(pub, POOL, NATIVE_TOKEN);
built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "unshield", amount: buyIn / G,
  recipient: LAUNCHPAD, relayer: relayer.address, relayerFee: fee, exitTarget: LAUNCHPAD,
  exitData: exitData(EXIT_BUY, TOKEN, claim1.address, minOut, budget, tip),
});
rc = await send(relayer, built.call, `private buy ${fmt(buyIn)} → claim key`);
await applyReceipt(rc, built);
const claimTokens = await pub.readContract({ address: TOKEN, abi: LaunchTokenAbi, functionName: "balanceOf", args: [claim1.address] });
const claimBnb = await pub.getBalance({ address: claim1.address });
log(`claim key holds ${Number(claimTokens) / 1e6} BNKT and ${fmt(claimBnb)} for gas (quote ${Number(q.out) / 1e6})`);
if (claimTokens < minOut || claimBnb !== budget) throw new Error("claim key underfunded");
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
log(`curve: real ${fmt(curve.realBnb)}, fees ${fmt(curve.feesAccrued)}, tokens left ${Number(curve.realToken) / 1e6}`);

// --- 7. the claim key shields its tokens into Alice's shielded balance (no approve: LaunchToken pre-approves the pool)
const claimAccount = privateKeyToAccount(claim1.privateKey);
p = await readPool(pub, POOL, TOKEN);
built = await aliceW.buildTransact({
  asset: tokenAsset, poolAddress: POOL, token: TOKEN, pool: p, tree, artifacts, kind: "shield", amount: claimTokens,
  relayer: claim1.address, relayerFee: 0n,
});
rc = await send(claimAccount, built.call, "claim: shield tokens");
await applyReceipt(rc, built);
log(`alice shielded BNKT: ${Number(amountForBurn(await readPool(pub, POOL, TOKEN), aliceW.balance(tokenAsset))) / 1e6}; claim key left with ${fmt(await pub.getBalance({ address: claim1.address }))}`);

// --- 8. Alice sells half privately: unshield tokens into the launchpad, BNB lands at a second claim key
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
const sellAmount = aliceW.balance(tokenAsset) / 2n;
const sellUnits = amountForBurn(await readPool(pub, POOL, TOKEN), sellAmount);
const sq = quotePrivateSell({ ...curve, tradeFeeBps: worstFeeBps(curve, await pub.getBlockNumber()) }, sellUnits, tip);
const claim2 = claimKey(aliceW.spend.sk, 2n);
p = await readPool(pub, POOL, TOKEN);
built = await aliceW.buildTransact({
  asset: tokenAsset, poolAddress: POOL, token: TOKEN, pool: p, tree, artifacts, kind: "unshield", amount: sellUnits,
  recipient: LAUNCHPAD, relayer: relayer.address, relayerFee: 0n, exitTarget: LAUNCHPAD,
  exitData: exitData(EXIT_SELL, TOKEN, claim2.address, (sq.out * 995n) / 1000n, budget, tip),
});
rc = await send(relayer, built.call, `private sell ${Number(sellUnits) / 1e6} BNKT → claim key`);
await applyReceipt(rc, built);
const claim2Bnb = await pub.getBalance({ address: claim2.address });
log(`claim key 2 holds ${fmt(claim2Bnb)} (quote ${fmt(sq.out)})`);
// the claim key shields its BNB back, keeping a little for gas
const claim2Account = privateKeyToAccount(claim2.privateKey);
p = await readPool(pub, POOL, NATIVE_TOKEN);
built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "shield", amount: (claim2Bnb - budget) / G,
  relayer: claim2.address, relayerFee: 0n,
});
rc = await send(claim2Account, built.call, "claim: shield BNB");
await applyReceipt(rc, built);
log(`alice shielded BNB now ${fmt(amountForBurn(await readPool(pub, POOL, NATIVE_TOKEN), aliceW.balance(bnbAsset)) * G)}`);

// --- 9. agents vote, the fee rolls one step per epoch
for (const [i, a] of agents.entries()) await send(a, voteCall(LAUNCHPAD, TOKEN, [300, 300, 200, 500][i]), `agent ${i} votes`);
const mine = (n) => pub.request({ method: "hardhat_mine", params: ["0x" + n.toString(16)] });
await mine(Number(policy.EPOCH_BLOCKS));
await send(deployer, rollPolicyCall(LAUNCHPAD, TOKEN), "roll policy");
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
if (curve.tradeFeeBps !== 200) throw new Error(`fee should have stepped to 200, is ${curve.tradeFeeBps}`);
await mine(Number(policy.EPOCH_BLOCKS));
await send(deployer, rollPolicyCall(LAUNCHPAD, TOKEN), "roll policy");
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
if (curve.tradeFeeBps !== 300) throw new Error(`fee should be at the median 300, is ${curve.tradeFeeBps}`);
log(`fee policy: ${curve.tradeFeeBps} bps after two epochs (median of 300/300/200/500)`);

// --- 10. harvest, then a graduation-sized buy, then migrate
await send(deployer, { address: LAUNCHPAD, abi: LaunchpadAbi, functionName: "harvest", args: [TOKEN] }, "harvest fees → treasury");
await wallet(deployer).sendTransaction({ to: alice.address, value: parseEther("10") }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
p = await readPool(pub, POOL, NATIVE_TOKEN);
built = await aliceW.buildTransact({ asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "shield", amount: parseEther("8") / G, relayer: alice.address, relayerFee: 0n });
rc = await send(alice, built.call, "shield 8 BNB");
await applyReceipt(rc, built);
const claim3 = claimKey(aliceW.spend.sk, 3n);
p = await readPool(pub, POOL, NATIVE_TOKEN);
const bigIn = parseEther("7");
built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "unshield", amount: bigIn / G,
  recipient: LAUNCHPAD, relayer: relayer.address, relayerFee: fee, exitTarget: LAUNCHPAD,
  exitData: exitData(EXIT_BUY, TOKEN, claim3.address, 0n, budget, tip),
});
rc = await send(relayer, built.call, `graduation buy ${fmt(bigIn)}`);
await applyReceipt(rc, built);
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
if (!curve.graduated) throw new Error("curve should have graduated");
log(`graduated: real ${fmt(curve.realBnb)}, tokens left ${curve.realToken}, refund at claim key ${fmt((await pub.getBalance({ address: claim3.address })) - budget)}`);
await send(deployer, migrateCall(LAUNCHPAD, TOKEN), "migrate → PancakeSwap pair");
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
if (!curve.ammPair) throw new Error("no pair recorded");
log(`pair ${curve.ammPair}; treasury ${fmt(await pub.getBalance({ address: treasury.address }))}`);

log("E2E PASSED");
stop(0);
