// Protocol v1 (legacy) state: the first mainnet pool and launchpad are
// immutable contracts that still hold user notes and four bonding curves.
// The same seed opens them here, so nothing a user had in v1 is lost: v1
// notes can be spent, v1 tokens can be bought and sold on their curves, and
// any v1 balance can be migrated into the v2 pool in one relayed transaction
// (MigrateExit: v1 unshield -> v2 shield, no public hop).
import { create } from "zustand";
import { encodeAbiParameters, encodeFunctionData, getAddress, type Hex } from "viem";
import {
  BunkerClient as BunkerClientV1, IndexerApi as IndexerApiV1, NATIVE_TOKEN as NATIVE_V1, deliveredFor, toUnits as toUnitsV1,
  type Balance as BalanceV1, type LaunchRow as LaunchRowV1, type TradeRow as TradeRowV1, type FeeEventRow as FeeEventRowV1, type EvmAddress, type TxEvent,
} from "@bunker/sdk-v1";
import { ShieldedPoolAbi, NATIVE_TOKEN, toUnits } from "@bunker/sdk";
import { LEGACY, INDEXER_V1_URL, MIGRATE_EXIT_ADDRESS, NETWORK_V1, POOL_V1_ADDRESS, RELAYER_URL, type AssetMeta } from "./config";
import { useBunker, sdkSigner, type Signer } from "./store";
import { publicClient } from "./chain";
import { POOL_ADDRESS } from "./config";

export type LegacyPhase = "off" | "idle" | "opening" | "ready" | "error";

export interface LegacyHolding {
  token: EvmAddress;
  symbol: string;
  decimals: number;
  /** spendable in the v1 pool, base units */
  amount: bigint;
  notes: number;
}

export interface MigrateQuote {
  /** what the v1 pool hands the bridge after the relayer fee, base units */
  delivered: bigint;
  /** what lands in the v2 pool (rounded down to its unit), base units */
  shielded: bigint;
  /** v1 relayer fee (public, doubled: two proofs verify in one transaction), base units */
  fee: bigint;
}

interface LegacyState {
  phase: LegacyPhase;
  error?: string;
  client?: BunkerClientV1;
  holdings: LegacyHolding[];
  /** the four v1 launches, newest first */
  launches: LaunchRowV1[];
  launchesLoaded: boolean;
  busy?: string;
  /** claim keys swept on the last recover */
  recovered?: number;

  open: (seed: Uint8Array) => Promise<void>;
  close: () => void;
  sync: () => Promise<void>;
  loadLaunches: () => Promise<void>;
  launch: (token: string) => Promise<(LaunchRowV1 & { trades: TradeRowV1[]; feeEvents: FeeEventRowV1[] }) | null>;
  isV1Token: (token: string) => boolean;

  unshield: (h: LegacyHolding, amount: bigint, to: EvmAddress) => Promise<Hex>;
  quoteMigrate: (h: LegacyHolding, amount: bigint) => Promise<MigrateQuote>;
  migrate: (h: LegacyHolding, amount: bigint) => Promise<Hex>;

  quoteBuy: (token: EvmAddress, bnbWei: bigint) => Promise<{ out: bigint; relayerFee: bigint; claimBudget: bigint; curveFee: bigint }>;
  quoteSell: (token: EvmAddress, tokens: bigint) => Promise<{ out: bigint; relayerTip: bigint; curveFee: bigint }>;
  buy: (token: EvmAddress, symbol: string, decimals: number, bnbWei: bigint) => Promise<Hex>;
  sell: (token: EvmAddress, symbol: string, decimals: number, tokens: bigint) => Promise<Hex>;
  recover: () => Promise<number>;
  /** Shield BNB from the connected wallet into the *v1* pool (a public transaction), to buy on a v1 curve. */
  topUp: (bnbWei: bigint, signer: Signer) => Promise<Hex>;
}

const indexerV1 = INDEXER_V1_URL ? new IndexerApiV1(INDEXER_V1_URL) : null;
const symbolCache = new Map<string, { symbol: string; decimals: number }>();

export const useLegacy = create<LegacyState>((set, get) => {
  async function describe(token: EvmAddress, decimals: number): Promise<{ symbol: string; decimals: number }> {
    const key = token.toLowerCase();
    if (key === NATIVE_V1) return { symbol: "BNB", decimals: 18 };
    const hit = symbolCache.get(key);
    if (hit) return hit;
    const fromLaunch = get().launches.find((l) => l.token.toLowerCase() === key);
    if (fromLaunch) { const d = { symbol: fromLaunch.symbol, decimals: fromLaunch.decimals }; symbolCache.set(key, d); return d; }
    try {
      const symbol = await publicClient.readContract({ address: token, abi: [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }] as const, functionName: "symbol" });
      const d = { symbol, decimals }; symbolCache.set(key, d); return d;
    } catch { return { symbol: `${token.slice(0, 6)}…`, decimals }; }
  }

  async function readHoldings() {
    const c = get().client;
    if (!c) return;
    const balances: BalanceV1[] = await c.balances();
    const holdings: LegacyHolding[] = [];
    for (const b of balances) {
      if (b.amount <= 0n) continue;
      const t = getAddress(b.token);
      const d = await describe(t, b.decimals);
      holdings.push({ token: t, symbol: d.symbol, decimals: d.decimals, amount: b.amount, notes: b.notes });
    }
    set({ holdings });
  }

  return {
    phase: LEGACY ? "idle" : "off",
    holdings: [],
    launches: [],
    launchesLoaded: false,

    async open(seed) {
      if (!NETWORK_V1) return;
      set({ phase: "opening", error: undefined });
      try {
        const client = await BunkerClientV1.connect({ network: NETWORK_V1, seed });
        set({ client });
        await get().loadLaunches().catch(() => undefined);
        await client.sync();
        await readHoldings();
        set({ phase: "ready" });
      } catch (e) {
        set({ phase: "error", error: (e as Error).message });
      }
    },

    close() {
      set({ phase: LEGACY ? "idle" : "off", client: undefined, holdings: [], busy: undefined, error: undefined, recovered: undefined });
    },

    async sync() {
      const c = get().client;
      if (!c) return;
      await c.sync();
      await readHoldings();
    },

    async loadLaunches() {
      if (!indexerV1) return;
      try {
        const launches = await indexerV1.launches(200);
        set({ launches, launchesLoaded: true });
      } catch (e) {
        set({ launchesLoaded: true, error: get().error ?? (e as Error).message });
      }
    },

    async launch(token) {
      if (!indexerV1) return null;
      try { return await indexerV1.launch(token.toLowerCase()); } catch { return null; }
    },

    isV1Token(token) {
      const k = token.toLowerCase();
      return get().launches.some((l) => l.token.toLowerCase() === k);
    },

    unshield(h, amount, to) {
      const c = get().client;
      if (!c) throw new Error("v1 vault not open");
      set({ busy: "unshield" });
      return useBunker.getState().runLegacy("unshield", `${h.symbol} (v1)`, amount, h.decimals, (onEvent) =>
        c.unshield(tokenArg(h.token), amount, to, { onEvent }),
      ).finally(() => { set({ busy: undefined }); void get().sync(); });
    },

    async quoteMigrate(h, amount) {
      const c = get().client;
      const v2 = useBunker.getState().client;
      if (!c || !v2) throw new Error("open the vault first");
      const pool = await c.pool(tokenArg(h.token), true);
      const units = toUnitsV1(amount, pool.unit);
      if (units <= 0n) throw new Error("amount too small for the pool's unit");
      const fee = (await c.feeUnits(h.token, units)) * 2n;
      const delivered = deliveredFor(pool, units) - fee * pool.unit;
      if (delivered <= 0n) throw new Error("the relayer fee would eat the whole amount");
      let shielded = delivered;
      const p2 = await v2.pool(tokenArg2(h.token), true).catch(() => null);
      if (p2) shielded = toUnits(delivered, p2.unit) * p2.unit;
      return { delivered, shielded, fee: fee * pool.unit };
    },

    async migrate(h, amount) {
      const c = get().client;
      const v2 = useBunker.getState().client;
      if (!c) throw new Error("v1 vault not open");
      if (!v2 || v2.watchOnly) throw new Error("open the vault with its seed to migrate");
      const bridge = MIGRATE_EXIT_ADDRESS;
      if (!bridge) throw new Error("no migration bridge on this network");
      set({ busy: "migrate" });
      try {
        return await useBunker.getState().runLegacy("migrate", `${h.symbol} v1 → v2`, amount, h.decimals, async (onEvent) => {
          // 1. the v2 pool must exist for this asset (the relayer's keeper opens it, once)
          if (!(await v2.pool(tokenArg2(h.token), true).catch(() => null))) {
            onEvent({ stage: "proving", message: `opening the ${h.symbol} pool in v2 (one-time)` });
            await openPoolViaRelayer(h.token);
          }
          const q = await get().quoteMigrate(h, amount);
          // 2. a v2 shield of what the bridge will receive, proved now, executed by the bridge
          onEvent({ stage: "proving", message: "proving the v2 note" });
          const built = await v2.buildShield(tokenArg2(h.token), q.shielded);
          const v2Calldata = encodeFunctionData({ abi: ShieldedPoolAbi, functionName: "transact", args: built.call.args });
          const exitData = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], ["0x0000000000000000000000000000000000000000", v2Calldata]);
          const bytes = Uint8Array.from(Buffer.from(exitData.slice(2), "hex"));
          // 3. the v1 unshield into the bridge, relayed; the bridge forwards to the v2 pool in the same transaction
          onEvent({ stage: "proving", message: "proving the v1 spend" });
          const pool = await c.pool(tokenArg(h.token), true);
          const fee = (await c.feeUnits(h.token, toUnitsV1(amount, pool.unit))) * 2n;
          try {
            return await c.exit(tokenArg(h.token), amount, bridge, bytes, { fee, onEvent });
          } catch (e) {
            v2.wallet.release(built.consumed);
            throw e;
          }
        });
      } finally {
        set({ busy: undefined });
        void get().sync();
      }
    },

    async quoteBuy(token, bnbWei) {
      const c = get().client;
      if (!c) throw new Error("v1 vault not open");
      const q = await c.launchpad.quoteBuy(token, bnbWei);
      return { out: q.out, relayerFee: q.relayerFeeWei, claimBudget: q.reserve, curveFee: q.fee };
    },

    async quoteSell(token, tokens) {
      const c = get().client;
      if (!c) throw new Error("v1 vault not open");
      const q = await c.launchpad.quoteSell(token, tokens);
      return { out: q.out, relayerTip: q.relayerTipWei, curveFee: q.fee };
    },

    buy(token, symbol, decimals, bnbWei) {
      const c = get().client;
      if (!c) throw new Error("v1 vault not open");
      set({ busy: "buy" });
      return useBunker.getState().runLegacy("buy", `${symbol} (v1)`, bnbWei, 18, async (onEvent) => {
        const r = await c.launchpad.buy(token, bnbWei, { onEvent });
        return (r.claimTxHash ?? r.tradeTxHash) as Hex;
      }).finally(() => { set({ busy: undefined }); void get().sync(); });
    },

    sell(token, symbol, decimals, tokens) {
      const c = get().client;
      if (!c) throw new Error("v1 vault not open");
      set({ busy: "sell" });
      return useBunker.getState().runLegacy("sell", `${symbol} (v1)`, tokens, decimals, async (onEvent) => {
        const r = await c.launchpad.sell(token, tokens, { onEvent });
        return (r.claimTxHash ?? r.tradeTxHash) as Hex;
      }).finally(() => { set({ busy: undefined }); void get().sync(); });
    },

    topUp(bnbWei, signer) {
      const c = get().client;
      if (!c) throw new Error("v1 vault not open");
      set({ busy: "shield" });
      return useBunker.getState().runLegacy("shield", "BNB (v1)", bnbWei, 18, (onEvent) =>
        c.shield("BNB", bnbWei, { signer: sdkSigner(signer) as never, onEvent }),
      ).finally(() => { set({ busy: undefined }); void get().sync(); });
    },

    async recover() {
      const c = get().client;
      if (!c) throw new Error("v1 vault not open");
      set({ busy: "recover" });
      try {
        const r = await c.launchpad.recover(32);
        set({ recovered: r.length });
        await get().sync();
        return r.length;
      } finally {
        set({ busy: undefined });
      }
    },
  };
});

const tokenArg = (t: EvmAddress) => (t.toLowerCase() === NATIVE_V1 ? ("BNB" as const) : t);
const tokenArg2 = (t: EvmAddress) => (t.toLowerCase() === NATIVE_TOKEN ? ("BNB" as const) : t);

/** Ask the v2 relayer to open an ERC-20's v2 pool (its keeper pays), then wait for it. */
async function openPoolViaRelayer(token: EvmAddress) {
  const r = await fetch(`${RELAYER_URL}/pool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  if (!r.ok) throw new Error("the relayer could not open a v2 pool for this token; try again in a minute");
  const t0 = Date.now();
  for (;;) {
    await new Promise((res) => setTimeout(res, 2500));
    const p = await publicClient.readContract({ address: POOL_ADDRESS, abi: ShieldedPoolAbi, functionName: "pools", args: [token] });
    if (p.exists) return;
    if (Date.now() - t0 > 120_000) throw new Error("the v2 pool did not open in time; try again in a minute");
  }
}

/** AssetMeta for a v1 holding, so the shared formatters can be used. */
export function assetOfHolding(h: LegacyHolding): AssetMeta {
  return { symbol: h.symbol, name: h.symbol, token: h.token, decimals: h.decimals, denominations: [] };
}

export const V1_POOL = POOL_V1_ADDRESS;
