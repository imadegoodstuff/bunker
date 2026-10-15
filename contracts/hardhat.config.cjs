require("@nomicfoundation/hardhat-toolbox");

const deployer = process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  paths: { sources: "./contracts", tests: "./test", artifacts: "./artifacts", cache: "./cache" },
  networks: {
    hardhat: { chainId: 31337, allowUnlimitedContractSize: false },
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    bsc: { url: process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org", chainId: 56, accounts: deployer },
    bscTestnet: { url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545", chainId: 97, accounts: deployer },
  },
  etherscan: { apiKey: process.env.BSCSCAN_API_KEY || "" },
  mocha: { timeout: 600_000 },
};
