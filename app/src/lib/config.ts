import { PublicKey, SystemProgram } from "@solana/web3.js";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.mainnet-beta.solana.com";
/** Keyless endpoint used only for public reads (wallet token balances) when the main one refuses. */
export const FALLBACK_RPC_URL = process.env.NEXT_PUBLIC_FALLBACK_RPC_URL ?? "https://api.mainnet-beta.solana.com";
/** The app runs on mainnet-beta only; the variable remains so a local build can label itself (e.g. "localnet"). */
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "mainnet-beta";
export const MAINNET = CLUSTER === "mainnet-beta";
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:8788";
export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:8787";
export const ARTIFACT_BASE = process.env.NEXT_PUBLIC_ARTIFACT_BASE ?? "/circuits";
export const PROGRAM_ID = new PublicKey(process.env.NEXT_PUBLIC_PROGRAM_ID ?? "89TrDDtwYTkrvxGmfYnSz6EbA1muGStuPBFUt3Dvd8WR");

export interface AssetMeta {
  symbol: string;
  name: string;
  mint: PublicKey;
  decimals: number;
  tokenProgram?: PublicKey;
  /** suggested standard denominations (UI nudges users towards these) */
  denominations: number[];
  /** Only the native SCASH pool receives harvested creator fees. Everything else earns nothing. */
  yieldBearing?: boolean;
  /** token image, when a registry knows one */
  image?: string;
  /** found in the connected wallet rather than configured */
  fromWallet?: boolean;
}

export const ASSETS: AssetMeta[] = [
  { symbol: "SOL", name: "Solana", mint: SystemProgram.programId, decimals: 9, denominations: [0.1, 1, 10, 100] },
];

if (process.env.NEXT_PUBLIC_EXTRA_ASSETS) {
  for (const a of JSON.parse(process.env.NEXT_PUBLIC_EXTRA_ASSETS) as { symbol: string; name: string; mint: string; decimals: number; token2022?: boolean; yield?: boolean }[]) {
    ASSETS.push({
      symbol: a.symbol,
      name: a.name,
      mint: new PublicKey(a.mint),
      decimals: a.decimals,
      tokenProgram: a.token2022 ? new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb") : undefined,
      denominations: [10, 100, 1000],
      yieldBearing: a.yield === true || a.symbol === "SCASH",
    });
  }
}

export const ARTIFACTS = {
  transact2x2: { wasm: `${ARTIFACT_BASE}/transact2x2.wasm`, zkey: `${ARTIFACT_BASE}/transact2x2.zkey` },
  transact4x2: { wasm: `${ARTIFACT_BASE}/transact4x2.wasm`, zkey: `${ARTIFACT_BASE}/transact4x2.zkey` },
};

const clusterQuery = MAINNET ? "" : `?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`;
export function explorerTx(sig: string) {
  return `https://solscan.io/tx/${sig}${clusterQuery}`;
}
export function explorerAddr(addr: string) {
  return `https://solscan.io/account/${addr}${clusterQuery}`;
}
