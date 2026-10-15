// Deploy BUNKER to the configured network.
//   TREASURY=0x.. AGENTS=0x..,0x..,0x..,0x.. [GUARDIAN=0x..] [ROUTER=0x..] [GRADUATION_BNB=6] [FEE_BPS=100]
//   npx hardhat run scripts/deploy.cjs --network bsc
// Writes deployments/<chainId>.json (addresses + params + start block) for the services and the app.
const hre = require("hardhat");
const { writeFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { deployAll } = require("./lib.cjs");

const ROUTERS = {
  56: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap V2 mainnet
  97: "0xD99D1c33F9fC3444f8101754aBC46c52416550D1", // PancakeSwap V2 testnet
};

async function main() {
  const { ethers } = hre;
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const [deployer] = await ethers.getSigners();
  const agents = (process.env.AGENTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (agents.length !== 4) throw new Error("AGENTS must list four addresses");
  const treasury = process.env.TREASURY;
  if (!treasury) throw new Error("TREASURY required");
  const router = process.env.ROUTER || ROUTERS[chainId];
  const graduationWei = process.env.GRADUATION_BNB ? ethers.parseEther(process.env.GRADUATION_BNB) : undefined;
  const tradeFeeBps = process.env.FEE_BPS ? Number(process.env.FEE_BPS) : undefined;

  console.log(`deployer ${deployer.address} on chain ${chainId}, balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);
  const startBlock = await ethers.provider.getBlockNumber();
  const d = await deployAll(ethers, { agents, treasury, router, guardian: process.env.GUARDIAN, graduationWei, tradeFeeBps, log: console.log });

  const out = {
    chainId,
    startBlock,
    deployer: deployer.address,
    protocolVersion: 2,
    poseidonT3: d.poseidon,
    poseidonT6: d.poseidonT6,
    verifier2x3: d.verifier2x3,
    verifier4x3: d.verifier4x3,
    pool: await d.pool.getAddress(),
    launchpad: await d.launchpad.getAddress(),
    swapExit: await d.swapExit.getAddress(),
    router: d.router,
    wbnb: await (await ethers.getContractAt(["function WETH() view returns (address)"], d.router)).WETH(),
    emptyLeaf: d.emptyLeaf.toString(),
    // constructor inputs, kept so scripts/verify.cjs can reproduce them after the guardian changes them
    guardian: process.env.GUARDIAN || deployer.address,
    nativeTvlCap: ethers.MaxUint256.toString(),
    params: Object.fromEntries(Object.entries(d.params).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
  };
  const dir = join(__dirname, "..", "deployments");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${chainId}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
