import type { TransactCallJson } from "@bunker/sdk";
import { AGENTS_URL, INDEXER_URL, RELAYER_URL } from "./config";

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) {
    let body: unknown;
    try { body = await r.json(); } catch { body = await r.text(); }
    throw new ApiError(r.status, body);
  }
  return r.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === "object" && body && "error" in (body as object) ? String((body as { error: string }).error) : `HTTP ${status}`);
  }
}

export interface CommitmentRow { index: number; commitment: string; token: string; ciphertext: string; txHash: string; block: number; blockTime: number | null; kind?: "note" | "open"; shares?: string; ownerHash?: string }
export interface CommitmentsPage { from: number; next: number; total: number; items: CommitmentRow[] }

export interface LaunchRow {
  token: string; creator: string; name: string; symbol: string; uri: string; decimals: number;
  virtual_bnb: string; virtual_token0: string; curve_supply: string; total_supply: string; graduation_wei: string;
  real_bnb: string; real_token: string; virtual_token: string; graduated: number; buys: number; sells: number; bnb_volume: string;
  fees_to_treasury: string; tx_hash: string; block: number; block_time: number | null;
  /** PancakeSwap pair once the curve migrated; null before */
  amm_pair: string | null; amm_bnb: string | null; amm_tokens: string | null;
  /** token icon, resolved by the indexer from the metadata it hosts */
  image: string | null;
  /** optional 3:1 header banner from the same metadata */
  header?: string | null;
}
export interface FeeEventRow { tx_hash: string; token: string; kind: "vote" | "roll"; agent: number | null; fee_bps: number; epoch: number | null; block: number; block_time: number | null }
export interface TradeRow { tx_hash: string; side: "buy" | "sell"; bnb: string; fee: string; tokens: string; block: number; block_time: number | null }

export const indexer = {
  health: () => j<{ ok: boolean; commitments: number; insertedIndex?: number; protocolVersion?: number; pool: string; scan: { lastBlock: number; head: number | null } }>(`${INDEXER_URL}/health`),
  launches: (limit = 50) => j<LaunchRow[]>(`${INDEXER_URL}/launches?limit=${limit}`),
  launch: (token: string) => j<LaunchRow & { trades: TradeRow[]; feeEvents: FeeEventRow[] }>(`${INDEXER_URL}/launches/${token}`),
  /** Upload a token's icon (data URL, ≤ 4.5 MB) and optional 3:1 header with its name/symbol/description; returns the metadata URI the token points at. */
  uploadMeta: (m: { name: string; symbol: string; description?: string; image: string; header?: string }) =>
    j<{ uri: string; image: string; header: string | null }>(`${INDEXER_URL}/meta`, { method: "POST", body: JSON.stringify(m) }),
  commitments: (from: number, limit = 1000) => j<CommitmentsPage>(`${INDEXER_URL}/commitments?from=${from}&limit=${limit}`),
  nullifiers: (sinceBlock: number) => j<{ nullifier: string; block: number }[]>(`${INDEXER_URL}/nullifiers?sinceBlock=${sinceBlock}&limit=5000`),
  roots: () => j<{ root: string; next_index: number; block: number }[]>(`${INDEXER_URL}/roots?n=32`),
  /** Every ERC-20 the account holds (indexer-side token API); empty when the indexer cannot discover tokens. */
  walletTokens: (owner: string) => j<{ owner: string; items: { token: `0x${string}`; balance: string }[] }>(`${INDEXER_URL}/wallet/${owner}/tokens`).then((r) => r.items),
  stats: (days = 30) =>
    j<{ leaves: number; perToken: Record<string, { shields: number; unshields: number; donated: string; shielded: string; unshielded: string }>; daily: { day: string; txs: number }[] }>(
      `${INDEXER_URL}/stats?days=${days}`
    ),
};

export interface RelayerInfo {
  relayer: string;
  chainId: number;
  pool: string;
  protocolVersion?: number;
  /** the relayer's own `bunker1…` address: where the private fee note of every relayed transact goes */
  shieldedAddress?: string;
  /** exit target the relayer forwards to (the launchpad), or null if it refuses exits */
  launchpad: string | null;
  /** the private-swap hook the relayer forwards to, or null */
  swapExit?: string | null;
  /** leaves queued on-chain, not yet in the tree */
  pending?: number;
  /** whether this relayer runs the drain keeper */
  drains?: boolean;
  /** min in the pool's internal units */
  fees: { token: string; min: string; bps: number; costWei?: string }[];
  delay: { minMs: number; maxMs: number };
  gasPrice: { current: string; cap: string };
  gasLimit: string;
  /** the relayer prices any ERC-20 with a pool on demand (see `asset`) */
  dynamicAssets?: boolean;
  queued: number;
}

/** The relayer's answer for one ERC-20: can it be relayed and at what fee (internal units). */
export interface AssetQuote {
  token: string;
  decimals: number;
  pool: boolean;
  unit?: string;
  supported: boolean;
  reason?: string;
  fee?: { min: string; bps: number };
  tokensPerBnb?: string;
}

export const relayer = {
  info: () => j<RelayerInfo>(`${RELAYER_URL}/info`),
  asset: (token: string) => j<AssetQuote>(`${RELAYER_URL}/asset/${token}`),
  relay: (call: TransactCallJson) => j<{ id: string; releaseAt: number; gas?: string; duplicate?: boolean }>(`${RELAYER_URL}/relay`, { method: "POST", body: JSON.stringify(call) }),
  job: (id: string) => j<{ id: string; status: "queued" | "submitting" | "confirmed" | "failed"; txHash?: string; error?: string; releaseAt: number }>(`${RELAYER_URL}/job/${id}`),
  /** Ask the keeper to fold the queued leaves into the tree now. */
  drain: () => j<{ pending: number; job?: string; txHash?: string }>(`${RELAYER_URL}/drain`, { method: "POST", body: "{}" }),
};

export interface AgentLogEntry {
  at: number; block: string; epoch: string; agent: number; agentKey: string; model: string; token: string; symbol: string;
  decision?: { feeBps: number; reason: string }; sent?: string; skipped?: string; error?: string;
}
export const agents = {
  health: () => j<{ ok: boolean; agents: { index: number; key: string; model: string }[]; treasury: string }>(`${AGENTS_URL}/health`),
  log: (token?: string, limit = 50) => j<AgentLogEntry[]>(`${AGENTS_URL}/log?limit=${limit}${token ? `&token=${token}` : ""}`),
};
