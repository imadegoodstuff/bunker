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

export const indexer = {
  health: () => j<{ ok: boolean; commitments: number; program: string }>(`${INDEXER_URL}/health`),
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
  queued: number;
}

export const relayer = {
  info: () => j<RelayerInfo>(`${RELAYER_URL}/info`),
  relay: (data: string, keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[]) =>
    j<{ id: string; releaseAt: number; cu?: number }>(`${RELAYER_URL}/relay`, { method: "POST", body: JSON.stringify({ data, keys }) }),
  job: (id: string) => j<{ id: string; status: "queued" | "submitting" | "confirmed" | "failed"; signature?: string; error?: string; releaseAt: number }>(`${RELAYER_URL}/job/${id}`),
};
