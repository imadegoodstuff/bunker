// Deployed networks. Contract addresses mirror contracts/deployments/<chainId>.json
// (pinned by a test); service URLs are the hosted BUNKER infrastructure anyone
// may use, and every field can be overridden when constructing a client.
import type { EvmAddress } from "./extdata.js";

export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  pool: EvmAddress;
  launchpad: EvmAddress;
  /** block the contracts were deployed at; the indexer scans from here */
  startBlock: number;
  indexerUrl: string;
  relayerUrl: string;
  agentsUrl: string;
  /** where `transact2x2.{wasm,zkey}` and `transact4x2.{wasm,zkey}` are served */
  artifactsUrl: string;
  explorerUrl: string;
}

export const bsc: NetworkConfig = {
  name: "BNB Smart Chain",
  chainId: 56,
  rpcUrl: "https://bsc-dataseed.bnbchain.org",
  pool: "0xD327D391Ba9f5924F4fD82AB0cd23A2b4F5812bF",
  launchpad: "0x1A6b0e1Fc2CC10218a6d5e48b33442a1B9DFAaA6",
  startBlock: 127738817,
  indexerUrl: "https://bunker-indexer.fly.dev",
  relayerUrl: "https://bunker-relayer.fly.dev",
  agentsUrl: "https://bunker-agents.fly.dev",
  artifactsUrl: "https://bunkeronbnb.com/circuits",
  explorerUrl: "https://bscscan.com",
};

/** A local Hardhat node with `npm run -w contracts deploy:local` and the three services on their default ports. */
export const localhost = (addresses: { pool: EvmAddress; launchpad: EvmAddress; startBlock?: number }): NetworkConfig => ({
  name: "Hardhat",
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  pool: addresses.pool,
  launchpad: addresses.launchpad,
  startBlock: addresses.startBlock ?? 0,
  indexerUrl: "http://localhost:8788",
  relayerUrl: "http://localhost:8787",
  agentsUrl: "http://localhost:8789",
  artifactsUrl: "http://localhost:3000/circuits",
  explorerUrl: "",
});

export const networks = { bsc } as const;
export type NetworkName = keyof typeof networks;
