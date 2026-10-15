// HTTP clients for the three BUNKER services. Everything the indexer returns
// is re-verified by the wallet (commitments are recomputed, roots checked
// against the chain); the relayer only ever receives a finished proof.
import type { TransactCallJson } from "./pool.js";

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly body: unknown, public readonly url: string) {
    super(typeof body === "object" && body && "error" in (body as object) ? String((body as { error: string }).error) : `HTTP ${status} from ${url}`);
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) {
    let body: unknown;
    try { body = await r.json(); } catch { body = await r.text().catch(() => ""); }
    throw new ApiError(r.status, body, url);
  }
  return r.json() as Promise<T>;
}

// ---- indexer

/** One leaf. `kind: "open"` rows are notes the pool minted for exit proceeds: `shares` and `ownerHash` are public. */
export interface CommitmentRow {
  index: number; commitment: string; token: string; ciphertext: string; txHash: string; block: number; blockTime: number | null;
  kind?: "note" | "open"; shares?: string | null; ownerHash?: string | null;
}
export interface CommitmentsPage { from: number; next: number; total: number; items: CommitmentRow[] }
export interface RegistryRow { owner: string; shieldedAddress: string | null; block: number | null }
export interface IndexerHealth {
  ok: boolean; degraded?: boolean; commit?: string; chainId: number; pool: string; launchpad?: string | null; commitments: number;
  scan: { lastBlock: number; head: number | null; lastError?: string | null };
}
export interface LaunchRow {
  token: string; creator: string; name: string; symbol: string; uri: string; decimals: number;
  virtual_bnb: string; virtual_token0: string; curve_supply: string; total_supply: string; graduation_wei: string;
  real_bnb: string; real_token: string; virtual_token: string; graduated: number; buys: number; sells: number; bnb_volume: string;
  fees_to_treasury: string; tx_hash: string; block: number; block_time: number | null;
  amm_pair: string | null; amm_bnb: string | null; amm_tokens: string | null;
  image: string | null; header?: string | null;
}
export interface FeeEventRow { tx_hash: string; token: string; kind: "vote" | "roll"; agent: number | null; fee_bps: number; epoch: number | null; block: number; block_time: number | null }
export interface TradeRow { tx_hash: string; side: "buy" | "sell"; bnb: string; fee: string; tokens: string; claim_key: string; block: number; block_time: number | null }
export interface LaunchMetaInput { name: string; symbol: string; description?: string; /** data: URL, square, ≤ 4.5 MB */ image: string; /** data: URL, 3:1 */ header?: string }

export class IndexerApi {
  constructor(public readonly url: string) { this.url = url.replace(/\/$/, ""); }
  health() { return json<IndexerHealth>(`${this.url}/health`); }
  commitments(from: number, limit = 1000) { return json<CommitmentsPage>(`${this.url}/commitments?from=${from}&limit=${limit}`); }
  nullifiers(sinceBlock = 0, limit = 5000) { return json<{ nullifier: string; block: number }[]>(`${this.url}/nullifiers?sinceBlock=${sinceBlock}&limit=${limit}`); }
  roots(n = 32) { return json<{ root: string; next_index: number; block: number }[]>(`${this.url}/roots?n=${n}`); }
  stats(days = 30) {
    return json<{ leaves: number; perToken: Record<string, { shields: number; unshields: number; donated: string; shielded: string; unshielded: string }>; daily: { day: string; txs: number }[] }>(`${this.url}/stats?days=${days}`);
  }
  launches(limit = 100) { return json<LaunchRow[]>(`${this.url}/launches?limit=${limit}`); }
  launch(token: string) { return json<LaunchRow & { trades: TradeRow[]; feeEvents: FeeEventRow[] }>(`${this.url}/launches/${token}`); }
  uploadMeta(m: LaunchMetaInput) { return json<{ uri: string; image: string; header: string | null }>(`${this.url}/meta`, { method: "POST", body: JSON.stringify(m) }); }
  /** The shielded address an EOA registered on-chain (the wallet re-checks the chain before paying). */
  registry(owner: string) { return json<RegistryRow>(`${this.url}/registry/${owner}`); }
}

// ---- relayer

export interface RelayerInfo {
  protocolVersion?: number;
  relayer: string; chainId: number; pool: string; launchpad: string | null; swapExit?: string | null;
  /** the relayer's shielded address: fee notes are encrypted to it */
  shieldedAddress?: string;
  /** `min` in the pool's internal units; `bps` of the amount */
  fees: { token: string; min: string; bps: number; costWei?: string }[];
  delay: { minMs: number; maxMs: number };
  gasPrice: { current: string; cap: string };
  gasLimit: string;
  dynamicAssets?: boolean;
  queued: number;
  /** leaves waiting for a drain, and whether this relayer drains as a keeper */
  pending?: number;
  drains?: boolean;
}
export interface AssetQuote {
  token: string; decimals: number; pool: boolean; unit?: string; supported: boolean; reason?: string;
  fee?: { min: string; bps: number }; tokensPerBnb?: string;
}
export type RelayJobStatus = "queued" | "submitting" | "confirmed" | "failed";
export interface RelayJob { id: string; status: RelayJobStatus; txHash?: string; error?: string; releaseAt: number }

export class RelayerApi {
  constructor(public readonly url: string) { this.url = url.replace(/\/$/, ""); }
  info() { return json<RelayerInfo>(`${this.url}/info`); }
  asset(token: string) { return json<AssetQuote>(`${this.url}/asset/${token}`); }
  relay(call: TransactCallJson) { return json<{ id: string; releaseAt: number; gas?: string; duplicate?: boolean }>(`${this.url}/relay`, { method: "POST", body: JSON.stringify(call) }); }
  job(id: string) { return json<RelayJob>(`${this.url}/job/${id}`); }
  /** Ask the relayer to drain the queue now (it does so on its own every few seconds; this just hurries it). */
  drain() { return json<{ txHash?: string; pending: number }>(`${this.url}/drain`, { method: "POST", body: "{}" }); }
}

// ---- agents

export interface AgentLogEntry {
  at: number; block: string; epoch: string; agent: number; agentKey: string; model: string; token: string; symbol: string;
  decision?: { feeBps: number; reason: string }; sent?: string; skipped?: string; error?: string;
}
export class AgentsApi {
  constructor(public readonly url: string) { this.url = url.replace(/\/$/, ""); }
  health() { return json<{ ok: boolean; agents: { index: number; key: string; model: string }[]; treasury: string }>(`${this.url}/health`); }
  log(token?: string, limit = 50) { return json<AgentLogEntry[]>(`${this.url}/log?limit=${limit}${token ? `&token=${token}` : ""}`); }
}
