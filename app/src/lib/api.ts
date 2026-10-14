import { INDEXER_URL, RELAYER_URL } from "./config";

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

export interface CommitmentRow { index: number; commitment: string; ciphertext: string; signature: string; slot: number; blockTime: number | null }
export interface CommitmentsPage { from: number; next: number; total: number; items: CommitmentRow[] }

export interface LaunchRow {
  mint: string; name: string; symbol: string; uri: string; decimals: number;
  virtual_sol: string; virtual_token0: string; curve_supply: string; total_supply: string; graduation_lamports: string;
  real_sol: string; real_token: string; virtual_token: string; graduated: number; buys: number; sells: number; sol_volume: string;
  fees_to_treasury: string; tokens_donated: string; signature: string; slot: number; block_time: number | null;
  /** Raydium CP-Swap pool once the curve migrated (graduation at 20 SOL); null before */
  amm_pool: string | null; amm_sol: string | null; amm_tokens: string | null;
  /** token icon, resolved by the indexer from the metadata it hosts */
  image: string | null;
  /** optional 3:1 header banner from the same metadata */
  header?: string | null;
}
export interface FeeEventRow { signature: string; mint: string; kind: "vote" | "roll"; agent: number | null; fee_bps: number; holder_bps: number; epoch: number | null; slot: number; block_time: number | null }
export interface TradeRow { signature: string; side: "buy" | "sell"; sol: string; fee: string; tokens: string; private: number; slot: number; block_time: number | null }

export const indexer = {
  health: () => j<{ ok: boolean; commitments: number; program: string }>(`${INDEXER_URL}/health`),
  launches: (limit = 50) => j<LaunchRow[]>(`${INDEXER_URL}/launches?limit=${limit}`),
  launch: (mint: string) => j<LaunchRow & { trades: TradeRow[]; feeEvents: FeeEventRow[] }>(`${INDEXER_URL}/launches/${mint}`),
  /** Upload a token's icon (data URL, ≤ 4.5 MB) and optional 3:1 header with its name/symbol/description; returns the metadata URI the mint points at. */
  uploadMeta: (m: { name: string; symbol: string; description?: string; image: string; header?: string }) =>
    j<{ uri: string; image: string; header: string | null }>(`${INDEXER_URL}/meta`, { method: "POST", body: JSON.stringify(m) }),
  commitments: (from: number, limit = 1000) => j<CommitmentsPage>(`${INDEXER_URL}/commitments?from=${from}&limit=${limit}`),
  nullifiers: (sinceSlot: number) => j<{ nullifier: string; slot: number }[]>(`${INDEXER_URL}/nullifiers?sinceSlot=${sinceSlot}&limit=5000`),
  roots: () => j<{ root: string; next_index: number; slot: number }[]>(`${INDEXER_URL}/roots?n=32`),
  stats: (days = 30) =>
    j<{ leaves: number; perMint: Record<string, { shields: number; unshields: number; donated: string; shielded: string; unshielded: string }>; daily: { day: string; txs: number }[] }>(
      `${INDEXER_URL}/stats?days=${days}`
    ),
};

export interface RelayerInfo {
  relayer: string;
  program: string;
  cluster: string;
  fees: { mint: string; min: string; bps: number }[];
  delay: { minMs: number; maxMs: number };
  lookupTable: string | null;
  /** exit target the relayer forwards to (the launchpad), or null if it refuses exits */
  launchProgram?: string | null;
  /** the relayer prices any SPL mint with a pool on demand (see `asset`) */
  dynamicAssets?: boolean;
  queued: number;
}

/** The relayer's answer for one SPL mint: can it be relayed, at what fee, with which lookup table. */
export interface AssetQuote {
  mint: string;
  decimals: number;
  tokenProgram: string;
  pool: boolean;
  supported: boolean;
  reason?: string;
  fee?: { min: string; bps: number; dest: string };
  lookupTable?: string;
  priceUsd?: number;
  solUsd?: number;
}

export const relayer = {
  info: () => j<RelayerInfo>(`${RELAYER_URL}/info`),
  asset: (mint: string) => j<AssetQuote>(`${RELAYER_URL}/asset/${mint}`),
  relay: (data: string, keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]) =>
    j<{ id: string; releaseAt: number; cu?: number }>(`${RELAYER_URL}/relay`, { method: "POST", body: JSON.stringify({ data, keys }) }),
  job: (id: string) => j<{ id: string; status: "queued" | "submitting" | "confirmed" | "failed"; signature?: string; error?: string; releaseAt: number }>(`${RELAYER_URL}/job/${id}`),
};
