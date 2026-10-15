"use client";
// One viem public client for reads, one wagmi config for the connected wallet.
import { createPublicClient, defineChain, http, type Chain } from "viem";
import { bsc, bscTestnet, hardhat } from "viem/chains";
import { createConfig, injected } from "wagmi";
import { CHAIN_ID, RPC_URL } from "./config";

export const chain: Chain =
  CHAIN_ID === 56
    ? { ...bsc, rpcUrls: { default: { http: [RPC_URL] } } }
    : CHAIN_ID === 97
      ? { ...bscTestnet, rpcUrls: { default: { http: [RPC_URL] } } }
      : CHAIN_ID === 31337
        ? { ...hardhat, rpcUrls: { default: { http: [RPC_URL] } } }
        : defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });

export const publicClient = createPublicClient({ chain, transport: http(RPC_URL, { batch: true }) });

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [chain.id]: http(RPC_URL) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
