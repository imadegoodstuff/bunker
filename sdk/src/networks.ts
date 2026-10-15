// Deployed networks. Contract addresses mirror contracts/deployments/<chainId>.json
// (pinned by a test); service URLs are the hosted BUNKER infrastructure anyone
// may use, and every field can be overridden when constructing a client.
import type { EvmAddress } from "./extdata.js";

export interface NetworkConfig {
  name: string;
  chainId: number;
  rpcUrl: string;
  /** protocol version of the pool at `pool` */
  protocolVersion: number;
  pool: EvmAddress;
  launchpad: EvmAddress;
  /** the private-swap exit hook (PancakeSwap V2), or null */
  swapExit: EvmAddress | null;
  /** WBNB, what a swap path uses for BNB */
  wbnb: EvmAddress;
  /** block the contracts were deployed at; the indexer scans from here */
  startBlock: number;
  indexerUrl: string;
  /** the relayer used when `relayerUrls` is empty */
  relayerUrl: string;
  /** every relayer the client may pick from (cheapest healthy one wins); anyone can run one and add theirs here */
  relayerUrls?: string[];
  agentsUrl: string;
  /** where `transact2x3.{wasm,zkey}` and `transact4x3.{wasm,zkey}` are served */
  artifactsUrl: string;
  explorerUrl: string;
}

export const bsc: NetworkConfig = {
  name: "BNB Smart Chain",
  chainId: 56,
  rpcUrl: "https://bsc-dataseed.bnbchain.org",
  protocolVersion: 2,
  pool: "0x0c5d2bB3867ADfea4506801df95Fd9895bda105a",
  launchpad: "0x3aBa205aEE7D6673F3EC640f9f79bDC48C8E093D",
  swapExit: "0x2E17431d3D7df13168522F03D71268bA73bDF6f8",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  startBlock: 127837374,
  indexerUrl: "https://bunker-indexer.fly.dev",
  relayerUrl: "https://bunker-relayer.fly.dev",
  relayerUrls: ["https://bunker-relayer.fly.dev"],
  agentsUrl: "https://bunker-agents.fly.dev",
  artifactsUrl: "https://bunkeronbnb.com/circuits",
  explorerUrl: "https://bscscan.com",
};

/** The protocol v1 deployment (two outputs, synchronous insertion, claim keys). Read-only from this SDK version. */
export const bscV1 = {
  pool: "0xD327D391Ba9f5924F4fD82AB0cd23A2b4F5812bF" as EvmAddress,
  launchpad: "0x1A6b0e1Fc2CC10218a6d5e48b33442a1B9DFAaA6" as EvmAddress,
  startBlock: 127738817,
};

/** A local Hardhat node with `npm run -w contracts deploy:local` and the three services on their default ports. */
export const localhost = (addresses: { pool: EvmAddress; launchpad: EvmAddress; swapExit?: EvmAddress; wbnb?: EvmAddress; startBlock?: number }): NetworkConfig => ({
  name: "Hardhat",
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  protocolVersion: 2,
  pool: addresses.pool,
  launchpad: addresses.launchpad,
  swapExit: addresses.swapExit ?? null,
  wbnb: addresses.wbnb ?? "0x0000000000000000000000000000000000000000",
  startBlock: addresses.startBlock ?? 0,
  indexerUrl: "http://localhost:8788",
  relayerUrl: "http://localhost:8787",
  agentsUrl: "http://localhost:8789",
  artifactsUrl: "http://localhost:3000/circuits",
  explorerUrl: "",
});

export const networks = { bsc } as const;
export type NetworkName = keyof typeof networks;
