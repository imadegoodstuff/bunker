// Shared deploy helpers (Hardhat + ethers v6).
const poseidonPkg = require("poseidon-solidity");

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Poseidon(reduce(BE("bunker_empty"))): the tree's empty leaf (sdk/src/merkle.ts). */
async function emptyLeaf() {
  const { buildPoseidon } = require("circomlibjs");
  const poseidon = await buildPoseidon();
  const bytes = new TextEncoder().encode("bunker_empty");
  let x = 0n;
  for (const b of bytes) x = (x << 8n) | BigInt(b);
  return poseidon.F.toObject(poseidon([x % FIELD]));
}

/**
 * Deploy a poseidon-solidity library through the deterministic deployment
 * proxy so it lands at the same address on every EVM (PoseidonT3 is
 * 0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93). No-op if it is already there.
 */
async function ensurePoseidon(ethers, name, log = () => {}) {
  const { proxy } = poseidonPkg;
  const lib = poseidonPkg[name];
  const provider = ethers.provider;
  if ((await provider.getCode(lib.address)) !== "0x") {
    log(`${name} already at ${lib.address}`);
    return lib.address;
  }
  const [sender] = await ethers.getSigners();
  if ((await provider.getCode(proxy.address)) === "0x") {
    log("deploying deterministic proxy");
    const bal = await provider.getBalance(proxy.from);
    if (bal < BigInt(proxy.gas)) {
      await (await sender.sendTransaction({ to: proxy.from, value: BigInt(proxy.gas) - bal })).wait();
    }
    await (await provider.broadcastTransaction(proxy.tx)).wait();
  }
  log(`deploying ${name}`);
  await (await sender.sendTransaction({ to: proxy.address, data: lib.data, gasLimit: 6_000_000 })).wait();
  if ((await provider.getCode(lib.address)) === "0x") throw new Error(`${name} deploy failed`);
  return lib.address;
}
const ensurePoseidonT3 = (ethers, log) => ensurePoseidon(ethers, "PoseidonT3", log);

/** Deploy the whole protocol. `opts.router` defaults to a MockPancakeRouter on local chains. */
async function deployAll(ethers, opts = {}) {
  const log = opts.log || (() => {});
  const [deployer] = await ethers.getSigners();
  const poseidon = await ensurePoseidonT3(ethers, log);
  const poseidonT6 = await ensurePoseidon(ethers, "PoseidonT6", log);

  const V2 = await ethers.getContractFactory("Transact2x3Verifier");
  const v2 = await V2.deploy();
  await v2.waitForDeployment();
  log(`Transact2x3Verifier ${await v2.getAddress()}`);
  const V4 = await ethers.getContractFactory("Transact4x3Verifier");
  const v4 = await V4.deploy();
  await v4.waitForDeployment();
  log(`Transact4x3Verifier ${await v4.getAddress()}`);

  const leaf = await emptyLeaf();
  const Pool = await ethers.getContractFactory("ShieldedPool", { libraries: { PoseidonT3: poseidon, PoseidonT6: poseidonT6 } });
  const guardian = opts.guardian || deployer.address;
  const nativeCap = opts.nativeTvlCap ?? ethers.MaxUint256;
  const pool = await Pool.deploy(await v2.getAddress(), await v4.getAddress(), guardian, leaf, nativeCap);
  await pool.waitForDeployment();
  log(`ShieldedPool ${await pool.getAddress()}`);

  let router = opts.router;
  if (!router) {
    const R = await ethers.getContractFactory("MockPancakeRouter");
    const r = await R.deploy();
    await r.waitForDeployment();
    router = await r.getAddress();
    log(`MockPancakeRouter ${router}`);
  }
  const params = { ...defaultParams(opts), router };
  const LP = await ethers.getContractFactory("Launchpad");
  const launchpad = await LP.deploy(await pool.getAddress(), params);
  await launchpad.waitForDeployment();
  log(`Launchpad ${await launchpad.getAddress()}`);
  const SE = await ethers.getContractFactory("SwapExit");
  const swapExit = await SE.deploy(await pool.getAddress(), router);
  await swapExit.waitForDeployment();
  log(`SwapExit ${await swapExit.getAddress()}`);

  return { poseidon, poseidonT6, verifier2x3: await v2.getAddress(), verifier4x3: await v4.getAddress(), pool, launchpad, swapExit, router, params, emptyLeaf: leaf };
}

/**
 * Launchpad parameters. Curve supply 793.1M of 1B tokens (6 decimals); the
 * virtual BNB is chosen so the curve sells out exactly at the graduation
 * threshold: x·y = (x+G)·(y−S) ⇒ x = G·(y−S)/S.
 */
function defaultParams(opts = {}) {
  const decimals = 6;
  const totalSupply = 1_000_000_000n * 10n ** BigInt(decimals);
  const curveSupply = 793_100_000n * 10n ** BigInt(decimals);
  const virtualToken = 1_073_000_000n * 10n ** BigInt(decimals);
  const graduationWei = opts.graduationWei ?? 6n * 10n ** 18n;
  const virtualBnb = opts.virtualBnb ?? (graduationWei * (virtualToken - curveSupply)) / curveSupply;
  if (!opts.agents || opts.agents.length !== 4) throw new Error("4 agents required");
  return {
    treasury: opts.treasury,
    tradeFeeBps: opts.tradeFeeBps ?? 100,
    virtualBnb,
    virtualToken,
    curveSupply,
    totalSupply,
    graduationWei,
    decimals,
    agents: opts.agents,
    router: opts.router,
  };
}

module.exports = { FIELD, emptyLeaf, ensurePoseidon, ensurePoseidonT3, deployAll, defaultParams };
