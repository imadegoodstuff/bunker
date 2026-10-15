import { getAddress } from "viem";
import { NATIVE_TOKEN, PROTOCOL_VERSION, bsc as bscPreset, type EvmAddress, type NetworkConfig } from "@bunker/sdk";

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://bunkeronbnb.com";
export const GITHUB = "https://github.com/imadegoodstuff/bunker";

export const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 56);
export const MAINNET = CHAIN_ID === 56;
export const CHAIN_NAME = CHAIN_ID === 56 ? "BNB Smart Chain" : CHAIN_ID === 97 ? "BSC testnet" : CHAIN_ID === 31337 ? "localhost" : `chain ${CHAIN_ID}`;
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? (CHAIN_ID === 97 ? "https://data-seed-prebsc-1-s1.bnbchain.org:8545" : CHAIN_ID === 31337 ? "http://127.0.0.1:8545" : "https://bsc-dataseed.bnbchain.org");
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL ?? "http://localhost:8788";
export const RELAYER_URL = process.env.NEXT_PUBLIC_RELAYER_URL ?? "http://localhost:8787";
export const AGENTS_URL = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:8789";
export const ARTIFACT_BASE = process.env.NEXT_PUBLIC_ARTIFACT_BASE ?? "/circuits";

const ZERO: EvmAddress = NATIVE_TOKEN;
function addr(s: string | undefined): EvmAddress {
  return s ? getAddress(s) : ZERO;
}

/** Deployed contracts. Unset in a build means the app points at nothing and says so. */
export const POOL_ADDRESS = addr(process.env.NEXT_PUBLIC_POOL_ADDRESS);
export const LAUNCHPAD_ADDRESS = addr(process.env.NEXT_PUBLIC_LAUNCHPAD_ADDRESS);
/** The private-swap exit hook (PancakeSwap V2); unset means the swap tab is hidden. */
export const SWAP_EXIT_ADDRESS: EvmAddress | null = process.env.NEXT_PUBLIC_SWAP_EXIT_ADDRESS ? getAddress(process.env.NEXT_PUBLIC_SWAP_EXIT_ADDRESS) : MAINNET ? bscPreset.swapExit : null;
export const WBNB_ADDRESS: EvmAddress = process.env.NEXT_PUBLIC_WBNB_ADDRESS ? getAddress(process.env.NEXT_PUBLIC_WBNB_ADDRESS) : bscPreset.wbnb;
export const CONFIGURED = POOL_ADDRESS !== ZERO && LAUNCHPAD_ADDRESS !== ZERO;
/** Every relayer the vault may use; the cheapest healthy one wins. Comma-separated in the env; the primary is always included. */
export const RELAYER_URLS: string[] = Array.from(new Set([RELAYER_URL, ...(process.env.NEXT_PUBLIC_RELAYER_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)]));

/** The SDK network this build points at, from the same env the rest of the app reads. */
export const NETWORK: NetworkConfig = {
  name: CHAIN_NAME,
  chainId: CHAIN_ID,
  rpcUrl: RPC_URL,
  protocolVersion: PROTOCOL_VERSION,
  pool: POOL_ADDRESS,
  launchpad: LAUNCHPAD_ADDRESS,
  swapExit: SWAP_EXIT_ADDRESS,
  wbnb: WBNB_ADDRESS,
  startBlock: 0,
  indexerUrl: INDEXER_URL,
  relayerUrl: RELAYER_URL,
  relayerUrls: RELAYER_URLS,
  agentsUrl: AGENTS_URL,
  artifactsUrl: ARTIFACT_BASE,
  explorerUrl: CHAIN_ID === 97 ? "https://testnet.bscscan.com" : "https://bscscan.com",
};

/** The $BUNKER token on BNB Smart Chain. */
export const BUNKER_TOKEN: EvmAddress = "0x2Ec1e08C2C6343671728EF7C6E7FDe0bD6F07777";

export interface AssetMeta {
  symbol: string;
  name: string;
  /** ERC-20 address; `NATIVE_TOKEN` (zero) for BNB */
  token: EvmAddress;
  decimals: number;
  /** suggested standard denominations (the UI nudges users towards these) */
  denominations: number[];
  /** token image, when known */
  image?: string;
  /** added by the user or found in the connected wallet rather than configured */
  fromWallet?: boolean;
  /** launched on the BUNKER curve */
  launched?: boolean;
}

export const BNB: AssetMeta = { symbol: "BNB", name: "BNB", token: NATIVE_TOKEN, decimals: 18, denominations: [0.1, 0.5, 1, 5] };
export const ASSETS: AssetMeta[] = [BNB];

/** Well-known BSC tokens the wallet scanner checks balances for. Any other ERC-20 can be added by address. */
export const KNOWN_TOKENS: AssetMeta[] = MAINNET
  ? [
      { symbol: "BUNKER", name: "bunker", token: BUNKER_TOKEN, decimals: 18, denominations: [10_000, 100_000, 1_000_000], image: "/brand/icon-192.png" },
      { symbol: "USDT", name: "Tether USD", token: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, denominations: [10, 100, 1000] },
      { symbol: "USDC", name: "USD Coin", token: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, denominations: [10, 100, 1000] },
      { symbol: "WBNB", name: "Wrapped BNB", token: "0xbb4CdB9CBd36B01bD1cBaEbF2De08d9173bc095c", decimals: 18, denominations: [0.1, 0.5, 1, 5] },
      { symbol: "BTCB", name: "Bitcoin BEP2", token: "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", decimals: 18, denominations: [0.001, 0.01, 0.1] },
      { symbol: "ETH", name: "Ethereum Token", token: "0x2170Ed0880ac9A755fd29B2688956BD959F933F8", decimals: 18, denominations: [0.01, 0.1, 1] },
      { symbol: "CAKE", name: "PancakeSwap Token", token: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", decimals: 18, denominations: [10, 100, 1000] },
    ]
  : [];

if (process.env.NEXT_PUBLIC_EXTRA_ASSETS) {
  for (const a of JSON.parse(process.env.NEXT_PUBLIC_EXTRA_ASSETS) as { symbol: string; name: string; token: string; decimals: number }[]) {
    KNOWN_TOKENS.push({ symbol: a.symbol, name: a.name, token: getAddress(a.token), decimals: a.decimals, denominations: [10, 100, 1000] });
  }
}

export const ARTIFACTS = {
  transact2x3: { wasm: `${ARTIFACT_BASE}/transact2x3.wasm`, zkey: `${ARTIFACT_BASE}/transact2x3.zkey` },
  transact4x3: { wasm: `${ARTIFACT_BASE}/transact4x3.wasm`, zkey: `${ARTIFACT_BASE}/transact4x3.zkey` },
};

const EXPLORER = CHAIN_ID === 97 ? "https://testnet.bscscan.com" : "https://bscscan.com";
export function explorerTx(hash: string) {
  return `${EXPLORER}/tx/${hash}`;
}
export function explorerAddr(a: string) {
  return `${EXPLORER}/address/${a}`;
}
export function explorerToken(a: string) {
  return `${EXPLORER}/token/${a}`;
}
