// Dynamic ERC-20 assets: any token can be shielded (pools are permissionless),
// so the relayer must be able to price its fee in that token without an
// operator editing FEE_POLICY. The price comes from PancakeSwap V2 on-chain:
// `getAmountsOut(costWei, [WBNB, token])` says how many tokens the relayer's
// BNB cost is worth; a margin absorbs the move between quote and submission.
// Tokens still on a launchpad curve are priced off the curve. Tokens with
// neither are shield-only: the relayer cannot take a fee it cannot value, so it
// refuses relayed sends/withdrawals of them.
//
// The fee arrives as a private note in the token (protocol v2), so no
// per-token setup is needed; the relayer sweeps its notes to BNB periodically.
import type { PublicClient } from "viem";
import { IPancakeRouter02Abi, IERC20MetadataAbi, readPool, readCurve, curveBuy, type EvmAddress } from "@bunker/sdk";

export interface AssetQuote {
  token: EvmAddress;
  decimals: number;
  /** the pool exists */
  pool: boolean;
  /** internal units per base unit, when the pool exists */
  unit?: string;
  /** the relayer will relay sends/withdrawals of this asset and take its fee in it */
  supported: boolean;
  reason?: string;
  /** fee in internal units of the token; present when `supported` */
  fee?: { min: string; bps: number };
  /** tokens per BNB the quote used, for display */
  tokensPerBnb?: string;
}

interface Priced { tokensPerBnb: bigint; at: number }

export class DynamicAssets {
  private prices = new Map<string, Priced>();
  private pending = new Map<string, Promise<AssetQuote>>();

  constructor(
    readonly client: PublicClient,
    readonly pool: EvmAddress,
    readonly opts: {
      router: EvmAddress;
      wbnb: EvmAddress;
      /** tokens still on a bonding curve are priced off the curve */
      launchpad?: EvmAddress;
      /** margin over the BNB cost floor, in bps, to absorb price moves between quote and submission */
      marginBps: number;
      bps: number;
      priceTtlMs: number;
      enabled: boolean;
    },
  ) {}

  quote(token: EvmAddress, costFloorWei: bigint): Promise<AssetQuote> {
    const k = token.toLowerCase();
    const live = this.pending.get(k);
    if (live) return live;
    const p = this.doQuote(token, costFloorWei).finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  }

  private async doQuote(token: EvmAddress, costFloorWei: bigint): Promise<AssetQuote> {
    let decimals = 18;
    try {
      decimals = Number(await this.client.readContract({ address: token, abi: IERC20MetadataAbi, functionName: "decimals" }));
    } catch {
      throw new Error("not an ERC-20 token");
    }
    const p = await readPool(this.client, this.pool, token);
    const base: AssetQuote = { token, decimals, pool: p.exists, unit: p.exists ? p.unit.toString() : undefined, supported: false };
    if (!this.opts.enabled) return { ...base, reason: "this relayer only relays configured assets" };

    const floor = costFloorWei + (costFloorWei * BigInt(this.opts.marginBps)) / 10_000n;
    const tokensForFloor = await this.tokensFor(token, floor);
    if (tokensForFloor === undefined) return { ...base, reason: "no PancakeSwap market for this token; it can be shielded but the relayer cannot take a fee in it" };
    const perBnb = await this.tokensFor(token, 10n ** 18n);
    base.tokensPerBnb = perBnb?.toString();
    if (!p.exists) return { ...base, reason: "pool not open yet" };
    // base units → internal units, rounded up
    const min = (tokensForFloor + p.unit - 1n) / p.unit;
    if (min <= 0n) return { ...base, reason: "token price too high to express a fee in it" };
    return { ...base, supported: true, fee: { min: min.toString(), bps: this.opts.bps } };
  }

  /** Current fee policy for a token, or undefined if unsupported. For /relay. */
  async policyFor(token: EvmAddress, costFloorWei: bigint): Promise<{ min: bigint; bps: number } | undefined> {
    const q = await this.quote(token, costFloorWei).catch(() => undefined);
    if (!q?.supported || !q.fee) return undefined;
    return { min: BigInt(q.fee.min), bps: q.fee.bps };
  }

  /** How many base units of `token` `wei` of BNB buys on PancakeSwap right now (cached). */
  private async tokensFor(token: EvmAddress, wei: bigint): Promise<bigint | undefined> {
    const k = token.toLowerCase();
    const c = this.prices.get(k);
    if (c && Date.now() - c.at < this.opts.priceTtlMs) return (c.tokensPerBnb * wei) / 10n ** 18n;
    let perBnb: bigint | undefined;
    try {
      const amounts = await this.client.readContract({ address: this.opts.router, abi: IPancakeRouter02Abi, functionName: "getAmountsOut", args: [10n ** 18n, [this.opts.wbnb, token]] });
      if (amounts[1] > 0n) perBnb = amounts[1];
    } catch {
      /* no pair */
    }
    if (perBnb === undefined && this.opts.launchpad) {
      // a token still on its curve: what 1 BNB buys there (spot, before fees)
      try {
        const curve = await readCurve(this.client, this.opts.launchpad, token);
        if (curve && !curve.graduated) perBnb = curveBuy(curve, 10n ** 18n).out;
      } catch {
        /* sold out / none */
      }
    }
    if (perBnb === undefined) return c ? (c.tokensPerBnb * wei) / 10n ** 18n : undefined;
    this.prices.set(k, { tokensPerBnb: perBnb, at: Date.now() });
    return (perBnb * wei) / 10n ** 18n;
  }
}
