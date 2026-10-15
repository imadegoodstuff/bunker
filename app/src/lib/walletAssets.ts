// What the connected wallet holds. An EVM account has no list of its tokens,
// so the scanner checks a known list (config `KNOWN_TOKENS`), every token
// launched on the curve, and any address the user adds by hand. Pools are
// permissionless: the first shield of a new token opens its pool.
import { getAddress, isAddress, type PublicClient } from "viem";
import { IERC20MetadataAbi, type EvmAddress } from "@bunker/sdk";
import type { AssetMeta } from "./config";

export interface WalletToken {
  asset: AssetMeta;
  /** public balance in base units */
  amount: bigint;
}

const CUSTOM_KEY = "bunker.customTokens";

export function customTokens(): EvmAddress[] {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(CUSTOM_KEY);
    return raw ? (JSON.parse(raw) as string[]).filter((a) => isAddress(a)).map((a) => getAddress(a)) : [];
  } catch {
    return [];
  }
}
export function addCustomToken(token: EvmAddress) {
  const cur = customTokens();
  if (cur.some((t) => t.toLowerCase() === token.toLowerCase())) return;
  localStorage.setItem(CUSTOM_KEY, JSON.stringify([...cur, getAddress(token)]));
}

/** name / symbol / decimals of an ERC-20, or throws if the address is not one. */
export async function describeToken(client: PublicClient, token: EvmAddress): Promise<AssetMeta> {
  const [name, symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: IERC20MetadataAbi, functionName: "name" }).catch(() => ""),
    client.readContract({ address: token, abi: IERC20MetadataAbi, functionName: "symbol" }).catch(() => ""),
    client.readContract({ address: token, abi: IERC20MetadataAbi, functionName: "decimals" }),
  ]);
  const sym = (symbol || token.slice(2, 6)).trim().slice(0, 12);
  return { symbol: sym, name: (name || sym).trim(), token: getAddress(token), decimals: Number(decimals), denominations: [1, 10, 100], fromWallet: true };
}

/** Balances of `owner` for every asset in `candidates` (BNB handled by the caller); zero balances are dropped. */
export async function walletTokens(client: PublicClient, owner: EvmAddress, candidates: AssetMeta[]): Promise<WalletToken[]> {
  const results = await client.multicall({
    contracts: candidates.map((a) => ({ address: a.token, abi: IERC20MetadataAbi, functionName: "balanceOf" as const, args: [owner] as const })),
    allowFailure: true,
  });
  const out: WalletToken[] = [];
  results.forEach((r, i) => {
    if (r.status === "success" && r.result > 0n) out.push({ asset: candidates[i], amount: r.result });
  });
  return out;
}

export function roundDenominations(decimals: number, amount: bigint): number[] {
  const whole = Number(amount) / 10 ** decimals;
  if (whole >= 10_000) return [100, 1000, 10_000];
  if (whole >= 100) return [1, 10, 100];
  if (whole >= 1) return [0.1, 1, 10];
  return [0.01, 0.1, 1];
}
