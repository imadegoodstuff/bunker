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
  /** the pool's governance (a Timelock; compliance hooks and role changes queue here, 24 h ahead), if known */
  timelock?: EvmAddress;
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
  pool: "0x19D7Ae0287507A9A16E3F5c726E1d2dA62787A39",
  launchpad: "0xC0016aFC627FF96041a64347485F58B4ed1DD94E",
  swapExit: "0x7Ebe074b0378860C0f088ace26158Af737f05126",
  timelock: "0x70c3898970E3D440cD94B16DDD72Dca46120C954",
  wbnb: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
  startBlock: 127892057,
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
