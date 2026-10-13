// Fee policy: per-asset minimum fee in base units + optional bps of the
// unshield amount. Loaded from env `FEE_POLICY` as JSON, e.g.
//   {"11111111111111111111111111111111":{"min":"2000000","bps":10}}
export interface AssetPolicy {
  /** minimum fee in base units */
  min: bigint;
  /** basis points of the withdrawn amount */
  bps: number;
  /** relayer's receiving account (token account, or relayer key for SOL) */
  dest?: string;
}

export class FeePolicy {
  private readonly assets = new Map<string, AssetPolicy>();

  constructor(json: string | undefined, defaultSol: bigint) {
    this.assets.set("11111111111111111111111111111111", { min: defaultSol, bps: 5 });
    if (!json) return;
    const o = JSON.parse(json) as Record<string, { min: string; bps?: number; dest?: string }>;
    for (const [mint, p] of Object.entries(o)) {
      this.assets.set(mint, { min: BigInt(p.min), bps: p.bps ?? 0, dest: p.dest });
    }
  }

  supports(mint: string) {
    return this.assets.has(mint);
  }
  get(mint: string) {
    return this.assets.get(mint);
  }
  list() {
    return [...this.assets.entries()].map(([mint, p]) => ({ mint, min: p.min.toString(), bps: p.bps }));
  }
  /** Minimum fee required for a withdrawal of `amount` (0 for private sends). */
  required(mint: string, amount: bigint): bigint {
    const p = this.assets.get(mint);
    if (!p) throw new Error("unsupported asset");
    const pct = (amount * BigInt(p.bps)) / 10_000n;
    return pct > p.min ? pct : p.min;
  }
}
