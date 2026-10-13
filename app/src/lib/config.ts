import { PublicKey, SystemProgram } from "@solana/web3.js";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const CLUSTER = (process.env.NEXT_PUBLIC_CLUSTER ?? "devnet") as "devnet" | "mainnet-beta";
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:8788";
export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:8787";
export const ARTIFACT_BASE = process.env.NEXT_PUBLIC_ARTIFACT_BASE ?? "/circuits";
export const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID ?? "A827Zi2VyPGQrPrQsZMr66hbxp7AaG2NdBYkV8Cj2yoJ");

export interface AssetMeta {
  symbol: string;
  name: string;
  mint: PublicKey;
  decimals: number;
  tokenProgram?: PublicKey;
  /** suggested standard denominations (UI nudges users towards these) */
  denominations: number[];
}

export const ASSETS: AssetMeta[] = [
  { symbol: "SOL", name: "Solana", mint: SystemProgram.programId, decimals: 9, denominations: [0.1, 1, 10, 100] },
];

if (process.env.NEXT_PUBLIC_EXTRA_ASSETS) {
  for (const a of JSON.parse(process.env.NEXT_PUBLIC_EXTRA_ASSETS) as { symbol: string; name: string; mint: string; decimals: number; token2022?: boolean }[]) {
    ASSETS.push({
      symbol: a.symbol,
      name: a.name,
      mint: new PublicKey(a.mint),
      decimals: a.decimals,
      tokenProgram: a.token2022 ? new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") : undefined,
      denominations: [10, 100, 1000],
    });
  }
}

export const ARTIFACTS = {
  transact2x2: { wasm: `${ARTIFACT_BASE}/transact2x2.wasm`, zkey: `${ARTIFACT_BASE}/transact2x2.zkey` },
  transact4x2: { wasm: `${ARTIFACT_BASE}/transact4x2.wasm`, zkey: `${ARTIFACT_BASE}/transact4x2.zkey` },
};

export function explorerTx(sig: string) {
  return `https://solscan.io/tx/${sig}${CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;
}
export function explorerAddr(addr: string) {
  return `https://solscan.io/account/${addr}${CLUSTER === "devnet" ? "?cluster=devnet" : ""}`;
}
