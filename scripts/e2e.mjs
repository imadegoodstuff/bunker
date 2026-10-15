// End-to-end protocol test against a live EVM (a Hardhat node by default).
//   node scripts/e2e.mjs [--rpc http://127.0.0.1:8545] [--deployments contracts/deployments/31337.json] [--spawn]
// With --spawn (default when no --rpc) a Hardhat node is started, the contracts
// deployed to it with contracts/scripts/deploy.cjs, and everything torn down.
//
// Protocol v2 flow: Alice shields 1 BNB → the relayer drains the queue →
// privately sends 0.4 BNB to Bob (relayer paid with a private fee note) → Bob
// unshields 0.25 BNB to a fresh address (the recipient receives the exact amount)
// → donate() raises the share rate → replay fails → Bob registers his shielded
// address under an EOA and Alice pays the EOA → launchpad: launch, a private buy
// whose tokens come back as an open note in the same tx, a private sell whose BNB
// comes back the same way, agents vote and the fee rolls, an exact-size
// graduation buy, migrate to the AMM → a private PancakeSwap swap through SwapExit.
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createPublicClient, createWalletClient, http, parseEther, formatEther, decodeEventLog, getAddress } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import {
  ShieldedWallet, MerkleTree, assetId, encodeAddress, decodeAddress, addressToBytes, addressFromBytes, amountForBurn, readPool, readLastRoot, readInsertedIndex, readNextIndex, readRegistry,
  NATIVE_TOKEN, ShieldedPoolAbi, LaunchpadAbi, LaunchTokenAbi, exitData, swapExitData, EXIT_BUY, EXIT_SELL, readCurve, readParams, quotePrivateBuy, quotePrivateSell,
  voteCall, rollPolicyCall, migrateCall, launchCall, drainCall, registerCall, contractErrorName, worstFeeBps, policy, PROTOCOL_VERSION,
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
const deployer = acct(0), alice = acct(1), relayer = acct(2), treasury = acct(7), bobEoa = acct(8);
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
if ((dep.protocolVersion ?? 1) !== PROTOCOL_VERSION) throw new Error(`deployment is protocol v${dep.protocolVersion ?? 1}, SDK is v${PROTOCOL_VERSION}`);
const POOL = getAddress(dep.pool), LAUNCHPAD = getAddress(dep.launchpad), SWAP_EXIT = getAddress(dep.swapExit);
const chain = { ...hardhat, id: dep.chainId };
const pub = createPublicClient({ chain, transport: http(rpc) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(rpc) });

const artifacts = {
  transact2x3: { wasm: "circuits/build/transact2x3/transact2x3_js/transact2x3.wasm", zkey: "circuits/build/transact2x3/transact2x3_dev.zkey" },
  transact4x3: { wasm: "circuits/build/transact4x3/transact4x3_js/transact4x3.wasm", zkey: "circuits/build/transact4x3/transact4x3_dev.zkey" },
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
async function expectRevert(account, call, name, label) {
  try {
    await pub.simulateContract({ ...call, account });
  } catch (e) {
    const got = contractErrorName(e);
    if (got !== name) throw new Error(`${label}: expected ${name}, got ${got ?? e.shortMessage ?? e.message}`);
    log(`${label}: rejected as expected (${name})`);
    return;
  }
  throw new Error(`${label}: was accepted`);
}

// --- actors: three shielded wallets; the relayer has one too, for its fee notes
const aliceW = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(1));
const bobW = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(2));
const relayerW = await ShieldedWallet.fromSeed(new Uint8Array(32).fill(3));
const wallets = [aliceW, bobW, relayerW];
const bobAddr = encodeAddress(bobW.bjj, bobW.address(), "tbunker");
const relayerAddr = relayerW.address();
log("bob shielded address:", bobAddr);
await wallet(deployer).sendTransaction({ to: alice.address, value: parseEther("10") }).then((h) => pub.waitForTransactionReceipt({ hash: h }));

// Local mirror of every leaf (what the indexer serves in production): the tree
// holds the inserted prefix, `leaves` everything the chain has queued.
const tree = new MerkleTree(26);
await tree.whenReady();
const leaves = [];
const hex2b = (h) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));
const decodeAll = (rc) => rc.logs.map((l) => { try { return decodeEventLog({ abi: ShieldedPoolAbi, ...l }); } catch { return null; } }).filter(Boolean);
async function syncInserted() {
  const inserted = await readInsertedIndex(pub, POOL);
  while (tree.size < Math.min(inserted, leaves.length)) await tree.insert(leaves[tree.size]);
  for (const w of wallets) w.markInserted(tree.size);
  if (tree.size === inserted && (await readLastRoot(pub, POOL)) !== (await tree.root())) throw new Error("local root != chain root");
}
const applyReceipt = async (rc, built) => {
  const evs = decodeAll(rc);
  const tx = evs.find((e) => e.eventName === "Transact");
  if (!tx) throw new Error("no Transact event");
  const asset = assetId(tx.args.token);
  const cms = tx.args.commitments;
  const cts = [tx.args.ciphertext0, tx.args.ciphertext1, tx.args.ciphertext2].map(hex2b);
  for (let i = 0; i < 3; i++) {
    const idx = Number(tx.args.firstIndex) + i;
    if (idx !== leaves.length) throw new Error(`leaf index mismatch: ${idx} vs ${leaves.length}`);
    leaves.push(cms[i]);
    if (cts[i].length) for (const w of wallets) await w.scan({ index: idx, commitment: cms[i], ciphertext: cts[i] }, asset);
  }
  for (const on of evs.filter((e) => e.eventName === "OpenNote")) {
    const idx = Number(on.args.index);
    if (idx !== leaves.length) throw new Error("open note index mismatch");
    leaves.push(on.args.commitment);
    for (const w of wallets) await w.scanOpenNote({ index: idx, commitment: on.args.commitment, shares: on.args.shares, ownerHash: on.args.ownerHash, ciphertext: hex2b(on.args.ciphertext) }, assetId(on.args.token));
  }
  if (built) for (const w of wallets) w.markSpent(built.consumedNullifiers);
  await syncInserted();
  const next = await readNextIndex(pub, POOL);
  if (next !== leaves.length) throw new Error(`nextIndex ${next} != local ${leaves.length}`);
  log(`leaves: ${leaves.length} on chain, ${tree.size} in the tree (${leaves.length - tree.size} queued)`);
};
/** The relayer as keeper: fold the queue into the tree. */
async function drain(label = "drain") {
  const rc = await send(relayer, drainCall(POOL), label);
  const ev = decodeAll(rc).find((e) => e.eventName === "Drain");
  if (!ev) throw new Error("no Drain event");
  await syncInserted();
  if (ev.args.newRoot !== (await tree.root())) throw new Error("Drain root != local root");
  log(`drained ${ev.args.count} leaves from ${ev.args.fromIndex}; root matches`);
}
const G = 10n ** 9n; // 1 unit = 1 gwei in the BNB pool
const bal = async (w, token, asset) => amountForBurn(await readPool(pub, POOL, token), w.balance(asset));

// --- 1. Alice shields 1 BNB; the note is queued until a drain
let p = await readPool(pub, POOL, NATIVE_TOKEN);
if (p.unit !== G) throw new Error("BNB pool unit must be 1 gwei");
let built = await aliceW.buildTransact({ asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "shield", amount: parseEther("1") / G });
log(`shield proof built (${built.proof.circuit}), value ${fmt(built.call.value)}`);
let rc = await send(alice, built.call, "shield 1 BNB");
await applyReceipt(rc, built);
if (aliceW.balance(bnbAsset) !== 0n || aliceW.queuedBalance(bnbAsset) === 0n) throw new Error("fresh shield should be queued, not spendable");
log(`alice: spendable 0, queued ${fmt(amountForBurn(p, aliceW.queuedBalance(bnbAsset)) * G)}`);
await expectRevert(relayer, drainCall(POOL, 0), "NothingQueued", "drain(0)");
await drain("drain after shield");
log("alice shielded balance:", fmt((await bal(aliceW, NATIVE_TOKEN, bnbAsset)) * G));

// --- 2. Alice privately sends 0.4 BNB to Bob; the relayer's 0.002 BNB fee is a private note to the relayer's shielded address
p = await readPool(pub, POOL, NATIVE_TOKEN);
const fee = parseEther("0.002") / G;
built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "send", amount: parseEther("0.4") / G,
  to: decodeAddress(bobW.bjj, bobAddr).address, relayerAddress: relayerAddr, relayerFee: fee, memo: new TextEncoder().encode("invoice #42"),
});
if (built.call.args[3] !== 0n) throw new Error("a private send must have publicAmount 0 (the fee stays in the pool)");
rc = await send(relayer, built.call, "private send 0.4 BNB → bob (relayed)");
await applyReceipt(rc, built);
await drain();
const bobNote = bobW.spendable(bnbAsset)[0];
log("bob received note:", fmt(amountForBurn(await readPool(pub, POOL, NATIVE_TOKEN), bobNote.value) * G), "memo:", new TextDecoder().decode(bobNote.memo ?? new Uint8Array()).replace(/\0+$/, ""));
const relayerFeeNote = relayerW.spendable(bnbAsset)[0];
if (!relayerFeeNote || amountForBurn(await readPool(pub, POOL, NATIVE_TOKEN), relayerFeeNote.value) !== fee) throw new Error("relayer did not receive its fee note");
log("relayer fee note:", fmt(fee * G), "(private; nothing left the pool)");

// --- 3. Bob unshields 0.25 BNB to a fresh address; the recipient gets exactly 0.25, the fee is another note
p = await readPool(pub, POOL, NATIVE_TOKEN);
built = await bobW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "unshield", amount: parseEther("0.25") / G,
  recipient: bobPublic.address, relayerAddress: relayerAddr, relayerFee: fee,
});
const replay = built.call;
rc = await send(relayer, built.call, "unshield 0.25 BNB → fresh address (relayed)");
await applyReceipt(rc, built);
const got = await pub.getBalance({ address: bobPublic.address });
log("fresh address received:", fmt(got));
if (got !== parseEther("0.25")) throw new Error("recipient should receive the exact amount");

// --- 4. donate 0.1 BNB: every shielded balance grows, no new notes
await drain();
const before = await bal(aliceW, NATIVE_TOKEN, bnbAsset);
await send(deployer, { address: POOL, abi: ShieldedPoolAbi, functionName: "donate", args: [NATIVE_TOKEN, parseEther("0.1") / G], value: parseEther("0.1") }, "donate 0.1 BNB");
const after = await bal(aliceW, NATIVE_TOKEN, bnbAsset);
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

// --- 6. registry: Bob publishes his shielded address under an EOA; Alice pays the EOA privately
await expectRevert(bobEoa, registerCall(POOL, new Uint8Array(42)), "BadAddress", "register 42 bytes");
await send(bobEoa, registerCall(POOL, addressToBytes(bobW.bjj, bobW.address())), "bob registers bunker address under his EOA");
const reg = await readRegistry(pub, POOL, bobEoa.address);
const resolved = addressFromBytes(bobW.bjj, reg);
p = await readPool(pub, POOL, NATIVE_TOKEN);
const bobBefore = bobW.totalBalance(bnbAsset);
built = await aliceW.buildTransact({ asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "send", amount: parseEther("0.05") / G, to: resolved, relayerAddress: relayerAddr, relayerFee: fee });
rc = await send(relayer, built.call, "alice pays bob's EOA privately (resolved via registry)");
await applyReceipt(rc, built);
if (bobW.totalBalance(bnbAsset) <= bobBefore) throw new Error("bob did not receive the registry payment");
await send(bobEoa, registerCall(POOL, new Uint8Array(0)), "bob clears his registry entry");
if ((await readRegistry(pub, POOL, bobEoa.address)) !== null) throw new Error("registry not cleared");

// ======================= launchpad =======================
const params = await readParams(pub, LAUNCHPAD);
log(`launchpad: fee ${params.tradeFeeBps} bps, graduation ${fmt(params.graduationWei)}, virtual ${fmt(params.virtualBnb)}, agents ${params.agents.length}`);
rc = await send(deployer, launchCall(LAUNCHPAD, "Bunker Test", "BNKT", "ipfs://bunker-test"), "launch BNKT");
const launchEv = rc.logs.map((l) => { try { return decodeEventLog({ abi: LaunchpadAbi, ...l }); } catch { return null; } }).find((e) => e && e.eventName === "Launch");
const TOKEN = getAddress(launchEv.args.token);
const tokenAsset = assetId(TOKEN);
const tokenPool = await readPool(pub, POOL, TOKEN);
if (!tokenPool.exists || tokenPool.unit !== 1n) throw new Error("token pool not created with unit 1");
log(`token ${TOKEN}, pool unit ${tokenPool.unit}`);

// --- 7. Alice buys privately: exit 0.5 BNB into the launchpad, the tokens come back as an open note in the same tx
await drain();
let curve = await readCurve(pub, LAUNCHPAD, TOKEN);
const buyIn = parseEther("0.5");
const worst = worstFeeBps(curve, await pub.getBlockNumber());
const q = quotePrivateBuy({ ...curve, tradeFeeBps: worst }, buyIn);
const minOut = (q.out * 995n) / 1000n;
p = await readPool(pub, POOL, NATIVE_TOKEN);
built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "exit", amount: buyIn / G,
  relayerAddress: relayerAddr, relayerFee: fee, exitTarget: LAUNCHPAD, exitData: exitData(EXIT_BUY, TOKEN, minOut), reshield: { token: TOKEN },
});
if (!built.reshieldNote) throw new Error("no reshield note");
rc = await send(relayer, built.call, `private buy ${fmt(buyIn)} → open note`);
await applyReceipt(rc, built);
const openEv = decodeAll(rc).find((e) => e.eventName === "OpenNote");
if (!openEv) throw new Error("no OpenNote event");
if (openEv.args.shares < minOut) throw new Error("open note below minOut");
const poolTokens = await pub.readContract({ address: TOKEN, abi: LaunchTokenAbi, functionName: "balanceOf", args: [POOL] });
log(`open note: ${Number(openEv.args.shares) / 1e6} BNKT (quote ${Number(q.out) / 1e6}); pool holds ${Number(poolTokens) / 1e6}`);
if (aliceW.queuedBalance(tokenAsset) !== openEv.args.shares) throw new Error("alice does not see her open note");
await drain();
log(`alice shielded BNKT: ${Number(await bal(aliceW, TOKEN, tokenAsset)) / 1e6}`);
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
log(`curve: real ${fmt(curve.realBnb)}, fees ${fmt(curve.feesAccrued)}, tokens left ${Number(curve.realToken) / 1e6}`);

// --- 8. Alice sells half privately: exit tokens into the launchpad, the BNB comes back as an open note
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
const sellAmount = aliceW.balance(tokenAsset) / 2n;
const tokenFee = sellAmount / 100n; // the relayer takes its fee in the token being sold
const sellUnits = amountForBurn(await readPool(pub, POOL, TOKEN), sellAmount);
const sq = quotePrivateSell({ ...curve, tradeFeeBps: worstFeeBps(curve, await pub.getBlockNumber()) }, sellUnits);
p = await readPool(pub, POOL, TOKEN);
const bnbBefore = aliceW.totalBalance(bnbAsset);
built = await aliceW.buildTransact({
  asset: tokenAsset, poolAddress: POOL, token: TOKEN, pool: p, tree, artifacts, kind: "exit", amount: sellUnits,
  relayerAddress: relayerAddr, relayerFee: tokenFee, exitTarget: LAUNCHPAD, exitData: exitData(EXIT_SELL, TOKEN, (sq.out * 995n) / 1000n), reshield: { token: NATIVE_TOKEN },
});
rc = await send(relayer, built.call, `private sell ${Number(sellUnits) / 1e6} BNKT → open note`);
await applyReceipt(rc, built);
const sellEv = decodeAll(rc).find((e) => e.eventName === "OpenNote");
log(`open note: ${fmt(amountForBurn(await readPool(pub, POOL, NATIVE_TOKEN), sellEv.args.shares) * G)} (quote ${fmt(sq.out)})`);
if (aliceW.totalBalance(bnbAsset) <= bnbBefore) throw new Error("sell proceeds not credited");
if (relayerW.totalBalance(tokenAsset) === 0n) throw new Error("relayer did not get its token fee note");
await drain();
log(`alice shielded BNB now ${fmt((await bal(aliceW, NATIVE_TOKEN, bnbAsset)) * G)}`);

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

// --- 10. harvest, then an exact-size graduation buy, then migrate
await send(deployer, { address: LAUNCHPAD, abi: LaunchpadAbi, functionName: "harvest", args: [TOKEN] }, "harvest fees → treasury");
await wallet(deployer).sendTransaction({ to: alice.address, value: parseEther("10") }).then((h) => pub.waitForTransactionReceipt({ hash: h }));
p = await readPool(pub, POOL, NATIVE_TOKEN);
built = await aliceW.buildTransact({ asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "shield", amount: parseEther("8") / G });
rc = await send(alice, built.call, "shield 8 BNB");
await applyReceipt(rc, built);
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
const gq = quotePrivateBuy({ ...curve, tradeFeeBps: worstFeeBps(curve, await pub.getBlockNumber()) }, parseEther("7"));
if (!gq.overshoots) throw new Error("7 BNB should overshoot the curve");
p = await readPool(pub, POOL, NATIVE_TOKEN);
await drain("drain before graduation buy"); // alice's 8 BNB is queued until then
const sized = gq.maxIn / G + 2n; // round up to whole units, plus one for the pool's share rounding (within the curve's slack)
built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "exit", amount: sized,
  relayerAddress: relayerAddr, relayerFee: fee, exitTarget: LAUNCHPAD, exitData: exitData(EXIT_BUY, TOKEN, 0n), reshield: { token: TOKEN },
});
rc = await send(relayer, built.call, `graduation buy ${fmt(sized * G)} (maxIn ${fmt(gq.maxIn)})`);
await applyReceipt(rc, built);
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
if (!curve.graduated) throw new Error("curve should have graduated");
log(`graduated: real ${fmt(curve.realBnb)}, tokens left ${curve.realToken}`);
await send(deployer, migrateCall(LAUNCHPAD, TOKEN), "migrate → PancakeSwap pair");
curve = await readCurve(pub, LAUNCHPAD, TOKEN);
if (!curve.ammPair) throw new Error("no pair recorded");
log(`pair ${curve.ammPair}; treasury ${fmt(await pub.getBalance({ address: treasury.address }))}`);

// --- 11. a private swap on the AMM through SwapExit: BNB → BNKT, proceeds back as an open note
await drain();
const WBNB = getAddress(dep.wbnb ?? (await pub.readContract({ address: SWAP_EXIT, abi: [{ type: "function", name: "wbnb", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }], functionName: "wbnb" })));
p = await readPool(pub, POOL, NATIVE_TOKEN);
const tokBefore = aliceW.totalBalance(tokenAsset);
built = await aliceW.buildTransact({
  asset: bnbAsset, poolAddress: POOL, token: NATIVE_TOKEN, pool: p, tree, artifacts, kind: "exit", amount: parseEther("0.1") / G,
  relayerAddress: relayerAddr, relayerFee: fee, exitTarget: SWAP_EXIT, exitData: swapExitData([WBNB, TOKEN], 1n), reshield: { token: TOKEN },
});
rc = await send(relayer, built.call, "private swap 0.1 BNB → BNKT on the AMM");
await applyReceipt(rc, built);
const swapEv = decodeAll(rc).find((e) => e.eventName === "OpenNote");
if (!swapEv || aliceW.totalBalance(tokenAsset) <= tokBefore) throw new Error("swap proceeds not credited");
log(`swap open note: ${Number(swapEv.args.shares) / 1e6} BNKT`);
await drain("final drain");

log("E2E PASSED");
stop(0);
