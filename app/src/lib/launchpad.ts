"use client";
// Launchpad client state: curves, private buys/sells through the pool's exit
// hook, and the throwaway "claim keys" that carry what a trade produced back
// into the shielded pool. Claim keys are derived from the spending seed, so
// nothing here needs to be backed up: `recover()` re-derives them and sweeps
// whatever is still waiting.
import { create } from "zustand";
import { createWalletClient, http, getAddress, parseEventLogs, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assetId, claimKey, exitData, EXIT_BUY, EXIT_SELL, quotePrivateBuy, quotePrivateSell, rolled, worstFeeBps, readCurve, readPool, readParams,
  amountForBurn, sharesForWithdraw, toUnits, launchCall, LaunchpadAbi, IERC20MetadataAbi, NATIVE_TOKEN, NATIVE_UNIT,
  type CurveState, type PoolState, type LaunchpadParams, type EvmAddress,
} from "@bunker/sdk";
import { indexer, type LaunchRow } from "./api";
import { useBunker, type Signer } from "./store";
import { BNB, LAUNCHPAD_ADDRESS, POOL_ADDRESS, RPC_URL, type AssetMeta } from "./config";
import { chain, publicClient } from "./chain";
import { artifactsForProof } from "./artifacts";

export interface ClaimRecord {
  nonce: number;
  token: string;
  kind: "buy" | "sell";
  at: number;
  status: "pending" | "claiming" | "claimed" | "empty" | "failed";
  /** the relayed trade */
  txHash?: string;
  /** the claim shield */
  claimTxHash?: string;
  error?: string;
}

/** Wei a buy leaves at the claim key for its own gas; whatever is unused stays there (dust). */
export const CLAIM_BUDGET = BigInt(process.env.NEXT_PUBLIC_CLAIM_BUDGET_WEI ?? 3_000_000_000_000_000); // 0.003 BNB
/** Gas a claim shield needs (a transact2x2 with one ERC-20 transfer is ~1.2M). */
const CLAIM_GAS = 1_500_000n;
/** Slippage tolerated between quote and execution (other trades can land first). */
export const SLIPPAGE_BPS = 100n;

/**
 * What the pool pays out for a withdrawal of `units`, after the shares→amount
 * round trip, in wei / base units.
 */
export function deliveredFor(pool: PoolState, units: bigint): bigint {
  const u = pool.totalShares === 0n ? units : amountForBurn(pool, sharesForWithdraw(pool, units));
  return u * pool.unit;
}

interface LaunchpadState {
  launches: LaunchRow[];
  params?: LaunchpadParams;
  /** curves exactly as stored on chain (fee policy not yet rolled to the current block) */
  curves: Record<string, CurveState>;
  /** the block at which each curve was last read */
  blocks: Record<string, bigint>;
  tokenPools: Record<string, PoolState>;
  claims: ClaimRecord[];
  nextNonce: number;
  loaded: boolean;
  loadError?: string;
  busy?: string;

  load: () => Promise<void>;
  refresh: (token: string) => Promise<{ curve: CurveState; pool?: PoolState; block: bigint }>;
  /** Uploads the image + metadata to the indexer first (an image is required), then sends the launch transaction. Returns the token address. */
  launch: (meta: { name: string; symbol: string; description?: string; image: string; header?: string }, signer: Signer) => Promise<EvmAddress>;
  buy: (token: string, wei: bigint) => Promise<void>;
  sell: (token: string, tokens: bigint) => Promise<void>;
  claim: (rec: ClaimRecord) => Promise<void>;
  /** Re-derive claim keys from the seed and sweep anything waiting at them. */
  recover: () => Promise<number>;
}

const k = (t: string) => t.toLowerCase();

const storageKey = async (seed: Uint8Array) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...new TextEncoder().encode("bunker-claims"), ...seed])));
  return "bunker.claims." + Array.from(h.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
};

export function assetOf(l: LaunchRow): AssetMeta {
  return { symbol: l.symbol, name: l.name, token: getAddress(l.token), decimals: l.decimals, denominations: [], image: l.image ?? undefined, launched: true };
}

export const useLaunchpad = create<LaunchpadState>((set, get) => {
  const seed = () => {
    const w = useBunker.getState().wallet;
    if (!w) throw new Error("wallet locked");
    return w.spend.sk;
  };

  async function persist() {
    const w = useBunker.getState().wallet;
    if (!w) return;
    localStorage.setItem(await storageKey(w.spend.sk), JSON.stringify({ claims: get().claims, nextNonce: get().nextNonce }));
  }
  async function restore() {
    const w = useBunker.getState().wallet;
    if (!w) return;
    try {
      const raw = localStorage.getItem(await storageKey(w.spend.sk));
      if (raw) {
        const o = JSON.parse(raw) as { claims: ClaimRecord[]; nextNonce: number };
        set({ claims: o.claims, nextNonce: o.nextNonce });
      }
    } catch { /* ignore a corrupt record; recover() re-derives everything that matters */ }
  }
  function upsert(rec: ClaimRecord) {
    set((s) => ({ claims: [rec, ...s.claims.filter((c) => c.nonce !== rec.nonce)].sort((a, b) => b.nonce - a.nonce) }));
    void persist();
  }

  async function gasReserve(): Promise<bigint> {
    const price = await publicClient.getGasPrice();
    return (CLAIM_GAS * price * 12n) / 10n;
  }

  /** The claim: an ordinary pool shield signed and paid by the claim key alone. */
  async function shieldFromClaim(rec: ClaimRecord): Promise<"claimed" | "empty"> {
    const bunker = useBunker.getState();
    const { wallet, tree } = bunker;
    if (!wallet || !tree) throw new Error("wallet locked");
    const ck = claimKey(seed(), BigInt(rec.nonce));
    const account = privateKeyToAccount(ck.privateKey);
    const signer = createWalletClient({ account, chain, transport: http(RPC_URL) });
    const artifacts = await artifactsForProof();
    const gasPrice = await publicClient.getGasPrice();
    let call;
    if (rec.kind === "buy") {
      const token = getAddress(rec.token);
      const bal = await publicClient.readContract({ address: token, abi: IERC20MetadataAbi, functionName: "balanceOf", args: [account.address] });
      if (bal === 0n) return "empty";
      const pool = (await get().refresh(rec.token)).pool;
      if (!pool) throw new Error("token pool missing");
      const built = await wallet.buildTransact({
        asset: assetId(token), poolAddress: POOL_ADDRESS, token, pool, tree, artifacts, kind: "shield", amount: toUnits(bal, pool.unit),
        relayer: account.address, relayerFee: 0n,
      });
      call = built.call;
    } else {
      const wei = await publicClient.getBalance({ address: account.address });
      const keep = (CLAIM_GAS * gasPrice * 12n) / 10n;
      if (wei <= keep + NATIVE_UNIT) return "empty";
      const pool = bunker.pools[k(NATIVE_TOKEN)];
      if (!pool) throw new Error("BNB pool missing");
      const built = await wallet.buildTransact({
        asset: assetId(NATIVE_TOKEN), poolAddress: POOL_ADDRESS, token: NATIVE_TOKEN, pool, tree, artifacts, kind: "shield", amount: toUnits(wei - keep, pool.unit),
        relayer: account.address, relayerFee: 0n,
      });
      call = built.call;
    }
    const hash = await signer.writeContract({ ...call, account, chain, gas: CLAIM_GAS, gasPrice });
    const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error(`claim ${hash.slice(0, 10)}… reverted`);
    upsert({ ...rec, status: "claimed", claimTxHash: hash });
    await bunker.refreshPools();
    await bunker.syncUntilCaughtUp();
    return "claimed";
  }

  return {
    launches: [],
    curves: {},
    blocks: {},
    tokenPools: {},
    claims: [],
    nextNonce: 0,
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
      await restore();
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

    async buy(tokenStr, wei) {
      const bunker = useBunker.getState();
      const rl = bunker.relayer;
      if (!rl) throw new Error("relayer unavailable");
      if (!rl.launchpad) throw new Error("this relayer does not forward launchpad trades");
      const bnbPool = bunker.pools[k(NATIVE_TOKEN)];
      if (!bnbPool) throw new Error("BNB pool missing");
      const token = getAddress(tokenStr);
      const { curve: stored, block } = await get().refresh(tokenStr);
      const curve = rolled(stored, block);
      const worst = { ...curve, tradeFeeBps: worstFeeBps(stored, block) };
      if (curve.graduated) throw new Error("this curve has graduated; it trades on PancakeSwap now");
      const feePolicy = rl.fees.find((f) => k(f.token) === k(NATIVE_TOKEN));
      if (!feePolicy) throw new Error("relayer has no BNB policy");
      const units = toUnits(wei, bnbPool.unit);
      const pct = (units * BigInt(feePolicy.bps)) / 10_000n;
      const fee = pct > BigInt(feePolicy.min) ? pct : BigInt(feePolicy.min);
      const delivered = deliveredFor(bnbPool, units) - fee * bnbPool.unit;
      const q = quotePrivateBuy(worst, delivered, CLAIM_BUDGET, 0n);
      const minOut = q.out - (q.out * SLIPPAGE_BPS) / 10_000n;
      const nonce = get().nextNonce;
      const ck = claimKey(seed(), BigInt(nonce));
      const rec: ClaimRecord = { nonce, token: k(token), kind: "buy", at: Date.now(), status: "pending" };
      set({ nextNonce: nonce + 1, busy: "buy" });
      upsert(rec);
      try {
        const txHash = await bunker.relayExit(BNB, wei, {
          recipient: LAUNCHPAD_ADDRESS, fee, kind: "buy", label: get().launches.find((l) => k(l.token) === k(token))?.symbol ?? "token",
          exit: { target: LAUNCHPAD_ADDRESS, data: exitData(EXIT_BUY, token, ck.address, minOut, CLAIM_BUDGET, 0n) },
        });
        upsert({ ...rec, txHash, status: "claiming" });
        await get().claim({ ...rec, txHash, status: "claiming" });
      } catch (e) {
        upsert({ ...rec, status: "failed", error: (e as Error).message });
        throw e;
      } finally {
        set({ busy: undefined });
      }
    },

    async sell(tokenStr, tokens) {
      const bunker = useBunker.getState();
      const rl = bunker.relayer;
      if (!rl) throw new Error("relayer unavailable");
      if (!rl.launchpad) throw new Error("this relayer does not forward launchpad trades");
      const token = getAddress(tokenStr);
      const { curve: stored, pool, block } = await get().refresh(tokenStr);
      const curve = rolled(stored, block);
      const worst = { ...curve, tradeFeeBps: worstFeeBps(stored, block) };
      if (!pool) throw new Error("token pool missing");
      if (curve.graduated) throw new Error("this curve has graduated; it trades on PancakeSwap now");
      const feePolicy = rl.fees.find((f) => k(f.token) === k(NATIVE_TOKEN));
      if (!feePolicy) throw new Error("relayer has no BNB policy");
      // the relayer is tipped in BNB out of the proceeds: its BNB minimum, which already covers its gas
      const tip = BigInt(feePolicy.min) * NATIVE_UNIT;
      const delivered = deliveredFor(pool, toUnits(tokens, pool.unit));
      const q = quotePrivateSell(worst, delivered, tip);
      const minOut = q.out - (q.out * SLIPPAGE_BPS) / 10_000n;
      const nonce = get().nextNonce;
      const ck = claimKey(seed(), BigInt(nonce));
      const row = get().launches.find((l) => k(l.token) === k(token));
      const rec: ClaimRecord = { nonce, token: k(token), kind: "sell", at: Date.now(), status: "pending" };
      set({ nextNonce: nonce + 1, busy: "sell" });
      upsert(rec);
      try {
        const asset: AssetMeta = row ? assetOf(row) : { symbol: "token", name: "token", token, decimals: get().params?.decimals ?? 6, denominations: [] };
        const txHash = await bunker.relayExit(asset, tokens, {
          recipient: LAUNCHPAD_ADDRESS, fee: 0n, kind: "sell", label: asset.symbol,
          exit: { target: LAUNCHPAD_ADDRESS, data: exitData(EXIT_SELL, token, ck.address, minOut, 0n, tip) },
        });
        upsert({ ...rec, txHash, status: "claiming" });
        await get().claim({ ...rec, txHash, status: "claiming" });
      } catch (e) {
        upsert({ ...rec, status: "failed", error: (e as Error).message });
        throw e;
      } finally {
        set({ busy: undefined });
      }
    },

    async claim(rec) {
      upsert({ ...rec, status: "claiming", error: undefined });
      try {
        const r = await shieldFromClaim(rec);
        if (r === "empty") upsert({ ...rec, status: "empty" });
      } catch (e) {
        upsert({ ...rec, status: "failed", error: (e as Error).message });
        throw e;
      }
    },

    async recover() {
      const s = seed();
      const known = new Map(get().claims.map((r) => [r.nonce, r]));
      const limit = Math.max(get().nextNonce, 0) + 12; // lookahead past the last nonce this browser knows about
      const tokens = get().launches.map((l) => getAddress(l.token));
      const keep = await gasReserve();
      let swept = 0;
      for (let nonce = 0; nonce < limit; nonce++) {
        const addr = claimKey(s, BigInt(nonce)).address;
        const [wei, bals] = await Promise.all([
          publicClient.getBalance({ address: addr }),
          tokens.length
            ? publicClient.multicall({ contracts: tokens.map((t) => ({ address: t, abi: IERC20MetadataAbi, functionName: "balanceOf" as const, args: [addr] as const })), allowFailure: true })
            : Promise.resolve([]),
        ]);
        const prior = known.get(nonce);
        let rec: ClaimRecord | undefined;
        bals.forEach((b, i) => {
          if (b.status === "success" && b.result > 0n) rec = { nonce, token: k(tokens[i]), kind: "buy", at: prior?.at ?? Date.now(), status: "pending", txHash: prior?.txHash };
        });
        if (!rec && wei > keep + NATIVE_UNIT) rec = { nonce, token: prior?.token ?? k(NATIVE_TOKEN), kind: "sell", at: prior?.at ?? Date.now(), status: "pending", txHash: prior?.txHash };
        if (!rec) continue;
        if (nonce >= get().nextNonce) set({ nextNonce: nonce + 1 });
        try {
          await get().claim(rec);
          swept++;
        } catch { /* recorded on the claim; the user can retry */ }
      }
      void persist();
      return swept;
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
