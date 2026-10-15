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
 * Deploy PoseidonT3 through the deterministic deployment proxy so it lands at
 * the same address on every EVM (0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93).
 * No-op if it is already there (it is, on most chains).
 */
async function ensurePoseidonT3(ethers, log = () => {}) {
  const { proxy, PoseidonT3 } = poseidonPkg;
  const provider = ethers.provider;
  if ((await provider.getCode(PoseidonT3.address)) !== "0x") {
    log(`PoseidonT3 already at ${PoseidonT3.address}`);
    return PoseidonT3.address;
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
  log("deploying PoseidonT3");
  await (await sender.sendTransaction({ to: proxy.address, data: PoseidonT3.data, gasLimit: 6_000_000 })).wait();
  if ((await provider.getCode(PoseidonT3.address)) === "0x") throw new Error("PoseidonT3 deploy failed");
  return PoseidonT3.address;
}

/** Deploy the whole protocol. `opts.router` defaults to a MockPancakeRouter on local chains. */
async function deployAll(ethers, opts = {}) {
  const log = opts.log || (() => {});
  const [deployer] = await ethers.getSigners();
  const poseidon = await ensurePoseidonT3(ethers, log);

  const V2 = await ethers.getContractFactory("Transact2x2Verifier");
  const v2 = await V2.deploy();
  await v2.waitForDeployment();
  log(`Transact2x2Verifier ${await v2.getAddress()}`);
  const V4 = await ethers.getContractFactory("Transact4x2Verifier");
  const v4 = await V4.deploy();
  await v4.waitForDeployment();
  log(`Transact4x2Verifier ${await v4.getAddress()}`);

  const leaf = await emptyLeaf();
  const Pool = await ethers.getContractFactory("ShieldedPool", { libraries: { PoseidonT3: poseidon } });
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

  return { poseidon, verifier2x2: await v2.getAddress(), verifier4x2: await v4.getAddress(), pool, launchpad, router, params, emptyLeaf: leaf };
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

module.exports = { FIELD, emptyLeaf, ensurePoseidonT3, deployAll, defaultParams };
