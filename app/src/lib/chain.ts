"use client";
// One viem public client for every read; the connected wallet lives in wallet.ts.
import { createPublicClient, defineChain, http, type Chain } from "viem";
import { bsc, bscTestnet, hardhat } from "viem/chains";
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
