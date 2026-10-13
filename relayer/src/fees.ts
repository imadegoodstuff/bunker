// Priority-fee pricing. The relayer's cost per transact is nullifier rent +
// signature + priority fee; the first two are fixed, the third moves with the
// network. A static CU price either overpays in quiet periods or fails to land
// in busy ones, and the fee floor advertised on /info would be wrong either
// way, so the price is sampled from the RPC and clamped to operator bounds.
import type { Connection } from "@solana/web3.js";

export interface FeeSample {
  slot: number;
  /** micro-lamports per compute unit paid by the lowest-priced landed transaction in that slot */
  prioritizationFee: number;
}

/**
 * Pick a CU price from recent samples: the 75th percentile — what the busiest
 * quarter of recent slots paid to land, so a lone spike is ignored and a quiet
 * window still reads as cheap — clamped to `[floor, cap]`. No samples → floor.
 */
export function pickPriorityFee(samples: FeeSample[], floor: number, cap: number): number {
  if (cap < floor) throw new Error(`priority fee cap ${cap} below floor ${floor}`);
  const fees = samples.map((s) => s.prioritizationFee).filter((f) => Number.isFinite(f) && f >= 0).sort((a, b) => a - b);
  if (fees.length === 0) return floor;
  const p75 = fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))];
  return Math.min(cap, Math.max(floor, p75));
}

export interface PriorityFeeOptions {
  /** never pay less than this (micro-lamports/CU); the old static CU_PRICE */
  floor: number;
  /** never pay more than this; bounds the relayer's exposure to a fee spike between /relay and submission */
  cap: number;
  refreshMs: number;
}

/** Keeps a current CU price; `current()` is synchronous so the queue and the fee check never wait on the RPC. */
export class PriorityFeeOracle {
  private price: number;
  private source: "floor" | "recent" = "floor";
  private updatedAt = 0;
  private lastError?: string;
  private timer?: NodeJS.Timeout;

  constructor(readonly conn: Pick<Connection, "getRecentPrioritizationFees">, readonly opts: PriorityFeeOptions) {
    this.price = opts.floor;
  }

  current(): number {
    return this.price;
  }

  info() {
    return { microLamportsPerCu: this.price, floor: this.opts.floor, cap: this.opts.cap, source: this.source, updatedAt: this.updatedAt || null, lastError: this.lastError ?? null };
  }

  async refresh(): Promise<number> {
    try {
      const samples = await this.conn.getRecentPrioritizationFees();
      this.price = pickPriorityFee(samples, this.opts.floor, this.opts.cap);
      this.source = samples.length ? "recent" : "floor";
      this.updatedAt = Date.now();
      this.lastError = undefined;
    } catch (e) {
      // keep the last good price; say so on /info
      this.lastError = (e as Error).message;
    }
    return this.price;
  }

  start() {
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
