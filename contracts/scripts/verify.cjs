// Verify the deployed sources on BscScan from deployments/<chainId>.json.
//   BSCSCAN_API_KEY=… npx hardhat run scripts/verify.cjs --network bsc
// Idempotent: already-verified contracts are reported and skipped.
const hre = require("hardhat");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

async function verify(address, constructorArguments, extra = {}) {
  try {
    await hre.run("verify:verify", { address, constructorArguments, ...extra });
    console.log(`verified ${address}`);
  } catch (e) {
    if (/already verified/i.test(String(e.message))) console.log(`already verified ${address}`);
    else throw e;
  }
}

async function main() {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const d = JSON.parse(readFileSync(join(__dirname, "..", "deployments", `${chainId}.json`), "utf8"));
  const p = d.params;
  const pool = await hre.ethers.getContractAt("ShieldedPool", d.pool);
  const guardian = d.guardian ?? (await pool.guardian());
  const nativeCap = d.nativeTvlCap ?? (await pool.pools("0x0000000000000000000000000000000000000000")).tvlCap;
  await verify(d.verifier2x2, []);
  await verify(d.verifier4x2, []);
  await verify(d.pool, [d.verifier2x2, d.verifier4x2, guardian, d.emptyLeaf, nativeCap], { libraries: { PoseidonT3: d.poseidonT3 } });
  await verify(d.launchpad, [
    d.pool,
    {
      treasury: p.treasury,
      tradeFeeBps: p.tradeFeeBps,
      virtualBnb: p.virtualBnb,
      virtualToken: p.virtualToken,
      curveSupply: p.curveSupply,
      totalSupply: p.totalSupply,
      graduationWei: p.graduationWei,
      decimals: p.decimals,
      agents: p.agents,
      router: p.router,
    },
  ]);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
