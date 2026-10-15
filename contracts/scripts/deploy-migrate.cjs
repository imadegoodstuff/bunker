// Deploy the v1 -> v2 migration bridge (MigrateExit) and record it in deployments/<chainId>.v1.json.
//   npx hardhat run scripts/deploy-migrate.cjs --network bsc
// Reads the v1 pool from <chainId>.v1.json and the v2 pool from <chainId>.json.
const hre = require("hardhat");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

async function main() {
  const { ethers } = hre;
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const dir = join(__dirname, "..", "deployments");
  const v1File = join(dir, `${chainId}.v1.json`);
  const v1 = JSON.parse(readFileSync(v1File, "utf8"));
  const v2 = JSON.parse(readFileSync(join(dir, `${chainId}.json`), "utf8"));
  if ((v2.protocolVersion ?? 1) !== 2) throw new Error(`${chainId}.json is not a protocol v2 deployment`);
  const [deployer] = await ethers.getSigners();
  console.log(`deployer ${deployer.address} on chain ${chainId}, balance ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} BNB`);
  console.log(`v1 pool ${v1.pool} -> v2 pool ${v2.pool}`);
  const bridge = await (await ethers.getContractFactory("MigrateExit")).deploy(v1.pool, v2.pool);
  await bridge.waitForDeployment();
  const address = await bridge.getAddress();
  const block = (await bridge.deploymentTransaction().wait()).blockNumber;
  console.log(`MigrateExit ${address} (block ${block})`);
  v1.migrateExit = address;
  v1.migrateExitBlock = block;
  v1.v2Pool = v2.pool;
  writeFileSync(v1File, JSON.stringify(v1, null, 2) + "\n");
  console.log(`wrote ${v1File}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
