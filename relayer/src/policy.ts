// Fee policy: per-asset minimum fee in the pool's internal units + optional bps
// of the unshield amount. Loaded from env `FEE_POLICY` as JSON keyed by token
// address (address(0) = BNB, units of 1 gwei), e.g.
//   {"0x0000000000000000000000000000000000000000":{"min":"2000000","bps":10}}
export const NATIVE = "0x0000000000000000000000000000000000000000";

export interface AssetPolicy {
  /** minimum fee in internal units */
  min: bigint;
  /** basis points of the withdrawn amount */
  bps: number;
}

export class FeePolicy {
  private readonly assets = new Map<string, AssetPolicy>();

  constructor(json: string | undefined, defaultNative: bigint) {
    this.assets.set(NATIVE, { min: defaultNative, bps: 5 });
    if (!json) return;
    const o = JSON.parse(json) as Record<string, { min: string; bps?: number }>;
    for (const [token, p] of Object.entries(o)) {
      this.assets.set(token.toLowerCase(), { min: BigInt(p.min), bps: p.bps ?? 0 });
    }
  }

  supports(token: string) {
    return this.assets.has(token.toLowerCase());
  }
  get(token: string) {
    return this.assets.get(token.toLowerCase());
  }
  list() {
    return [...this.assets.entries()].map(([token, p]) => ({ token, min: p.min.toString(), bps: p.bps }));
  }
  /** Minimum fee required for a withdrawal of `amount` units (0 for private sends). */
  required(token: string, amount: bigint): bigint {
    const p = this.assets.get(token.toLowerCase());
    if (!p) throw new Error("unsupported asset");
    const pct = (amount * BigInt(p.bps)) / 10_000n;
    return pct > p.min ? pct : p.min;
  }
}
