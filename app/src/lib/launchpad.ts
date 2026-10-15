"use client";
// Launchpad client state: curves and private buys/sells. A trade is one
// relayed pool transaction: the pool pays the curve through its exit hook and
// what the curve returns (tokens for a buy, BNB for a sell) is re-shielded
// into the vault in the same transaction. Nothing to claim, nothing to recover.
import { create } from "zustand";
import { getAddress, parseEventLogs, type Hex } from "viem";
import { launchCall, readCurve, readPool, readParams, LaunchpadAbi, type CurveState, type PoolState, type LaunchpadParams, type EvmAddress } from "@bunker/sdk";
import { indexer, type LaunchRow } from "./api";
import { useBunker, type Signer } from "./store";
import { LAUNCHPAD_ADDRESS, POOL_ADDRESS, type AssetMeta } from "./config";
import { publicClient } from "./chain";

/** Slippage tolerated between quote and execution (other trades can land first). */
export const SLIPPAGE_BPS = 100n;

export interface BuyQuote { out: bigint; curveFee: bigint; relayerFee: bigint; maxIn: bigint; overshoots: boolean }
export interface SellQuote { out: bigint; curveFee: bigint; relayerFeeTokens: bigint }

interface LaunchpadState {
  launches: LaunchRow[];
  params?: LaunchpadParams;
  /** curves exactly as stored on chain (fee policy not yet rolled to the current block) */
  curves: Record<string, CurveState>;
  /** the block at which each curve was last read */
  blocks: Record<string, bigint>;
  tokenPools: Record<string, PoolState>;
  loaded: boolean;
  loadError?: string;
  busy?: string;

  load: () => Promise<void>;
  refresh: (token: string) => Promise<{ curve: CurveState; pool?: PoolState; block: bigint }>;
  /** Uploads the image + metadata to the indexer first (an image is required), then sends the launch transaction. Returns the token address. */
  launch: (meta: { name: string; symbol: string; description?: string; image: string; header?: string }, signer: Signer) => Promise<EvmAddress>;
  quoteBuy: (token: string, wei: bigint) => Promise<BuyQuote>;
  quoteSell: (token: string, tokens: bigint) => Promise<SellQuote>;
  buy: (token: string, wei: bigint) => Promise<Hex>;
  sell: (token: string, tokens: bigint) => Promise<Hex>;
}

const k = (t: string) => t.toLowerCase();

export function assetOf(l: LaunchRow): AssetMeta {
  return { symbol: l.symbol, name: l.name, token: getAddress(l.token), decimals: l.decimals, denominations: [], image: l.image ?? undefined, launched: true };
}

export const useLaunchpad = create<LaunchpadState>((set, get) => {
  const client = () => {
    const c = useBunker.getState().client;
    if (!c) throw new Error("wallet locked");
    return c;
  };
  const symbolOf = (token: string) => get().launches.find((l) => k(l.token) === k(token))?.symbol ?? "token";

  return {
    launches: [],
    curves: {},
    blocks: {},
    tokenPools: {},
    loaded: false,

    async load() {
      try {
        const [indexed, params] = await Promise.all([
          indexer.launches(100),
          get().params ?? readParams(publicClient, LAUNCHPAD_ADDRESS).catch(() => undefined),
        ]);
        // a token launched from this browser is listed at once; the indexer's row replaces it as soon as it exists
        const known = new Set(indexed.map((l) => k(l.token)));
        const launches = [...get().launches.filter((l) => l.block === 0 && !known.has(k(l.token))), ...indexed];
        set({ launches, params, loaded: true, loadError: undefined });
        useBunker.getState().addLaunchAssets(launches.map(assetOf));
      } catch (e) {
        set({ loaded: true, loadError: `indexer unreachable: ${(e as Error).message}` });
      }
    },

    async refresh(token) {
      const t = getAddress(token);
      const [curve, pool, block] = await Promise.all([readCurve(publicClient, LAUNCHPAD_ADDRESS, t), readPool(publicClient, POOL_ADDRESS, t), publicClient.getBlockNumber()]);
      if (!curve) throw new Error("curve not found");
      const p = pool.exists ? pool : undefined;
      set((s) => ({ curves: { ...s.curves, [k(token)]: curve }, blocks: { ...s.blocks, [k(token)]: block }, tokenPools: p ? { ...s.tokenPools, [k(token)]: p } : s.tokenPools }));
      return { curve, pool: p, block };
    },

    async launch(input, signer) {
      set({ busy: "launch" });
      try {
        if (!input.image) throw new Error("an image is required");
        // launching needs only a public wallet, not an open vault
        const hosted = await indexer.uploadMeta({ name: input.name, symbol: input.symbol, description: input.description, image: input.image, header: input.header });
        const hash = await signer.writeContract(launchCall(LAUNCHPAD_ADDRESS, input.name, input.symbol, hosted.uri));
        const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
        if (rc.status !== "success") throw new Error("the launch transaction reverted");
        const ev = parseEventLogs({ abi: LaunchpadAbi, logs: rc.logs, eventName: "Launch" })[0];
        if (!ev) throw new Error("no Launch event in the receipt");
        const token = getAddress(ev.args.token);
        const params = get().params ?? (await readParams(publicClient, LAUNCHPAD_ADDRESS));
        useBunker.getState().pushActivity({ id: crypto.randomUUID(), kind: "launch", asset: input.symbol, amount: 0n, decimals: 0, at: Date.now(), status: "confirmed", txHash: hash });
        const { curve } = await get().refresh(token);
        const row: LaunchRow = {
          token: k(token), creator: k(signer.address), name: input.name, symbol: input.symbol, uri: hosted.uri, decimals: params.decimals,
          virtual_bnb: curve.virtualBnb.toString(), virtual_token0: curve.virtualToken.toString(), curve_supply: params.curveSupply.toString(), total_supply: params.totalSupply.toString(),
          graduation_wei: params.graduationWei.toString(), real_bnb: curve.realBnb.toString(), real_token: curve.realToken.toString(), virtual_token: curve.virtualToken.toString(),
          graduated: 0, buys: 0, sells: 0, bnb_volume: "0", fees_to_treasury: "0", tx_hash: hash, block: 0, block_time: Math.floor(Date.now() / 1000),
          amm_pair: null, amm_bnb: null, amm_tokens: null, image: hosted.image, header: hosted.header,
        };
        set((s) => ({ launches: [row, ...s.launches.filter((l) => k(l.token) !== k(token))] }));
        useBunker.getState().addLaunchAssets([assetOf(row)]);
        setTimeout(() => void get().load(), 8000);
        return token;
      } finally {
        set({ busy: undefined });
      }
    },

    async quoteBuy(token, wei) {
      const q = await client().launchpad.quoteBuy(getAddress(token), wei);
      return { out: q.out, curveFee: q.fee, relayerFee: q.relayerFeeWei, maxIn: q.maxIn, overshoots: q.overshoots };
    },

    async quoteSell(token, tokens) {
      const q = await client().launchpad.quoteSell(getAddress(token), tokens);
      return { out: q.out, curveFee: q.fee, relayerFeeTokens: q.relayerFeeTokens };
    },

    async buy(token, wei) {
      const c = client();
      set({ busy: "buy" });
      try {
        return await useBunker.getState().runTrade("buy", symbolOf(token), wei, 18, async (onEvent) => (await c.launchpad.buy(getAddress(token), wei, { slippageBps: SLIPPAGE_BPS, onEvent })).txHash);
      } finally {
        set({ busy: undefined });
        void get().refresh(token).catch(() => undefined);
      }
    },

    async sell(token, tokens) {
      const c = client();
      const decimals = get().launches.find((l) => k(l.token) === k(token))?.decimals ?? get().params?.decimals ?? 6;
      set({ busy: "sell" });
      try {
        return await useBunker.getState().runTrade("sell", symbolOf(token), tokens, decimals, async (onEvent) => (await c.launchpad.sell(getAddress(token), tokens, { slippageBps: SLIPPAGE_BPS, onEvent })).txHash);
      } finally {
        set({ busy: undefined });
        void get().refresh(token).catch(() => undefined);
      }
    },
  };
});

/** Spot price in wei per whole token, from the curve's current reserves. */
export function priceWeiPerToken(c: CurveState, decimals: number): number {
  const x = Number(c.virtualBnb + c.realBnb);
  const y = Number(c.virtualToken);
  return (x / y) * 10 ** decimals;
}

export type { Hex };
