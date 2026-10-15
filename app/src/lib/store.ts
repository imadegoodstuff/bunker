"use client";
// Client-side shielded wallet state. Nothing here ever leaves the browser
// except proofs, ciphertexts and the contract call handed to the relayer.
import { create } from "zustand";
import { getAddress, type Hex } from "viem";
import {
  ShieldedWallet, MerkleTree, assetId, seedFromSignature, encodeAddress, decodeAddress, readPool, readLastRoot, readNextIndex,
  toUnits, amountForMint, amountForBurn, sharesForDeposit, type PoolState, type SpendableNote, SPENDING_KEY_MESSAGE, seedToBackup, seedFromBackup,
  isStaleRootRejection, contractErrorFromData, STALE_ROOT_ERRORS, transactCallToJson, NATIVE_TOKEN, ShieldedPoolAbi, IERC20MetadataAbi, type EvmAddress,
} from "@bunker/sdk";
import { ApiError, indexer, relayer, type AssetQuote, type RelayerInfo } from "./api";
import { ASSETS, BNB, KNOWN_TOKENS, MAINNET, POOL_ADDRESS, type AssetMeta } from "./config";
import { publicClient } from "./chain";
import { customTokens, describeToken, walletTokens } from "./walletAssets";
import { artifactsForProof, prefetchArtifacts, type Progress } from "./artifacts";
import { deviceProvider, forgetDeviceSeed, gasAccount, rememberDeviceSeed } from "./device";
import { useWallet } from "./wallet";

/** Turns proving-key download progress into the tx modal's message, so a first-time proof is not a silent wait. */
function reportArtifacts(set: (p: Partial<State>) => void) {
  return (p: Progress) => {
    if (!p.total) return;
    const mb = (n: number) => (n / 1_048_576).toFixed(1);
    set({ tx: { stage: "proving", message: `Fetching the proving key (one-time, ${mb(p.loaded)} / ${mb(p.total)} MB)` } });
  };
}

export type Phase = "idle" | "deriving" | "syncing" | "ready" | "error";
export type TxStage = "idle" | "building" | "proving" | "signing" | "relaying" | "confirming" | "done" | "failed";

export interface ActivityItem {
  id: string;
  kind: "shield" | "send" | "unshield" | "buy" | "sell" | "claim" | "launch";
  asset: string;
  /** base units of the asset */
  amount: bigint;
  decimals: number;
  at: number;
  txHash?: string;
  status: "pending" | "confirmed" | "failed";
  error?: string;
}

/** What the store needs from the connected wallet: its address and a way to send a contract call. */
export interface Signer {
  address: EvmAddress;
  writeContract: (req: { address: EvmAddress; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; value?: bigint }) => Promise<Hex>;
}

interface State {
  phase: Phase;
  error?: string;
  wallet?: ShieldedWallet;
  tree?: MerkleTree;
  address?: string;
  /** pool state per token address (lower-case) */
  pools: Record<string, PoolState>;
  /** Wall-clock proving time of the last proof made on this device, in ms. */
  lastProveMs?: number;
  /** shielded balances in shares, per token address */
  balances: Record<string, bigint>;
  /** Tokens found in the connected public wallet, keyed by token address. Any of them can be shielded; the first shield opens the pool. */
  walletAssets: Record<string, AssetMeta>;
  /** Public (unshielded) balances per token address, base units. */
  walletBalances: Record<string, bigint>;
  walletScanError?: string;
  walletScannedAt?: number;
  /** Relayer quotes per ERC-20: fee in the token, or why it is shield-only. */
  assetQuotes: Record<string, AssetQuote>;
  /** Launched tokens the wallet also scans for, keyed by token address. */
  launchAssets: Record<string, AssetMeta>;
  notes: SpendableNote[];
  syncedTo: number;
  totalLeaves: number;
  relayer?: RelayerInfo;
  activity: ActivityItem[];
  tx: { stage: TxStage; message?: string; txHash?: string };

  /** `passphrase === null` means the user explicitly chose signature-only (SDK `allowEmpty`). */
  unlock: (signMessage: (m: string) => Promise<Hex>, passphrase: string | null) => Promise<void>;
  unlockFromSeed: (backup: string) => Promise<void>;
  /**
   * Open a vault that lives on this device: the seed is remembered in local
   * storage and its derived gas account becomes the connected wallet. Used by
   * the Android app and by anyone without a wallet extension.
   */
  openDevice: (seed: Uint8Array) => Promise<void>;
  /** Wipe the remembered seed and lock. The notes stay spendable from the backup string. */
  forgetDevice: () => void;
  /** Backup string for the current wallet. Anyone holding it can spend. */
  exportSeed: () => string | undefined;
  lock: () => void;
  sync: () => Promise<void>;
  /** Sync repeatedly until the indexer has every leaf the chain has (or `maxMs` passes). Resolves to whether it caught up. */
  syncUntilCaughtUp: (maxMs?: number) => Promise<boolean>;
  refreshPools: () => Promise<void>;
  /** Configured assets plus whatever the connected wallet holds plus launched tokens. */
  assets: () => AssetMeta[];
  assetFor: (token: string) => AssetMeta | undefined;
  /** Read the public wallet's balances and register every token it holds as a shieldable asset. */
  scanWallet: (owner: EvmAddress) => Promise<void>;
  /** Add an ERC-20 by address to the shieldable list. */
  addToken: (token: EvmAddress) => Promise<AssetMeta>;
  rotateAddress: () => void;
  /** amounts in base units (wei for BNB) */
  shield: (asset: AssetMeta, amount: bigint, signer: Signer, to?: string) => Promise<void>;
  send: (asset: AssetMeta, amount: bigint, to: string, memo?: string) => Promise<void>;
  unshield: (asset: AssetMeta, amount: bigint, recipient: EvmAddress) => Promise<void>;
  /**
   * An unshield whose recipient is a contract (the launchpad): the pool pays
   * `recipient` and then calls `exitTarget.onExit(exitData)`. Used for
   * private buys and sells; `fee` (internal units) overrides the policy.
   */
  relayExit: (asset: AssetMeta, amount: bigint, o: { recipient: EvmAddress; fee: bigint; exit: { target: EvmAddress; data: Uint8Array }; kind: "buy" | "sell"; label: string }) => Promise<string | undefined>;
  addLaunchAssets: (assets: AssetMeta[]) => void;
  pushActivity: (a: ActivityItem) => void;
  updateActivity: (id: string, patch: Partial<ActivityItem>) => void;
  setTx: (tx: State["tx"]) => void;
  resetTx: () => void;
}

const key = (t: string) => t.toLowerCase();
const bjjAddress = (w: ShieldedWallet) => encodeAddress(w.bjj, w.address(), MAINNET ? "bunker" : "tbunker");

function b64ToBytes(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Shielded balance of an asset in base units, from shares and the pool rate. */
export function shieldedAmount(s: Pick<State, "balances" | "pools">, asset: AssetMeta): bigint {
  const pool = s.pools[key(asset.token)];
  const shares = s.balances[key(asset.token)] ?? 0n;
  if (!pool) return 0n;
  return amountForBurn(pool, shares) * pool.unit;
}

export const useBunker = create<State>((set, get) => {
  let syncing: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  async function syncPass() {
    const { wallet, tree } = get();
    if (!wallet || !tree) return;
    let from = get().syncedTo;
    const ids = new Map<string, bigint>();
    const idFor = (token: string) => {
      const k = key(token);
      let id = ids.get(k);
      if (id === undefined) { id = assetId(k); ids.set(k, id); }
      return id;
    };
    for (;;) {
      const page = await indexer.commitments(from, 1000);
      for (const row of page.items) {
        const cm = BigInt("0x" + row.commitment);
        if (row.index === tree.size) await tree.insert(cm);
        await wallet.scan({ index: row.index, commitment: cm, ciphertext: b64ToBytes(row.ciphertext) }, idFor(row.token));
      }
      from = page.next;
      set({ syncedTo: from, totalLeaves: page.total });
      if (page.items.length < 1000) break;
    }
    const nfs = await indexer.nullifiers(0);
    wallet.markSpent(nfs.map((n) => BigInt("0x" + n.nullifier)));
    const balances: Record<string, bigint> = {};
    for (const a of get().assets()) balances[key(a.token)] = wallet.balance(idFor(a.token));
    set({ balances, notes: [...wallet.notes.values()] });

    // sanity: our local root must be one the chain knows
    try {
      const [next, chainRoot] = await Promise.all([readNextIndex(publicClient, POOL_ADDRESS), readLastRoot(publicClient, POOL_ADDRESS)]);
      const local = await tree.root();
      if (next === tree.size && chainRoot !== local) set({ error: "Local tree root does not match the chain; the indexer may be lagging or corrupt." });
      else if (get().error?.startsWith("Local tree root")) set({ error: undefined });
    } catch { /* non-fatal */ }
  }

  async function openWithSeed(seed: Uint8Array) {
    const wallet = await ShieldedWallet.fromSeed(seed);
    const tree = new MerkleTree(26);
    await tree.whenReady();
    set({ wallet, tree, address: bjjAddress(wallet), phase: "syncing" });
    relayer.info().then((r) => set({ relayer: r })).catch(() => undefined);
    await get().refreshPools();
    await get().sync();
    set({ phase: "ready" });
  }

  return {
  phase: "idle",
  pools: {},
  balances: {},
  walletAssets: {},
  walletBalances: {},
  assetQuotes: {},
  launchAssets: {},
  notes: [],
  syncedTo: 0,
  totalLeaves: 0,
  activity: [],
  tx: { stage: "idle" },

  async unlock(signMessage, passphrase) {
    set({ phase: "deriving", error: undefined });
    prefetchArtifacts();
    try {
      const sigHex = await signMessage(SPENDING_KEY_MESSAGE);
      const sig = Uint8Array.from(Buffer.from(sigHex.slice(2), "hex"));
      const seed = passphrase === null ? await seedFromSignature(sig, "", { allowEmpty: true }) : await seedFromSignature(sig, passphrase);
      await openWithSeed(seed);
    } catch (e) {
      set({ phase: "error", error: (e as Error).message });
    }
  },

  async unlockFromSeed(backup) {
    set({ phase: "deriving", error: undefined });
    prefetchArtifacts();
    try {
      await openWithSeed(seedFromBackup(backup));
    } catch (e) {
      set({ phase: "error", error: (e as Error).message });
    }
  },

  async openDevice(seed) {
    set({ phase: "deriving", error: undefined });
    prefetchArtifacts();
    try {
      const account = gasAccount(seed);
      useWallet.getState().useDevice(deviceProvider(account), account.address);
      rememberDeviceSeed(seed);
      await openWithSeed(seed);
      void get().scanWallet(account.address);
    } catch (e) {
      set({ phase: "error", error: (e as Error).message });
    }
  },

  forgetDevice() {
    forgetDeviceSeed();
    useWallet.getState().dropDevice();
    get().lock();
  },

  exportSeed() {
    const w = get().wallet;
    return w ? seedToBackup(w.spend.sk) : undefined;
  },

  lock() {
    set({ phase: "idle", wallet: undefined, tree: undefined, address: undefined, notes: [], balances: {}, syncedTo: 0, activity: [], error: undefined });
  },

  addLaunchAssets(assets) {
    const cur = get().launchAssets;
    const fresh = assets.filter((a) => !cur[key(a.token)]);
    if (fresh.length === 0) return;
    const next = { ...cur };
    for (const a of fresh) next[key(a.token)] = { ...a, launched: true };
    set({ launchAssets: next });
    if (get().wallet && get().syncedTo > 0) void get().refreshPools().then(() => get().sync());
  },
  pushActivity(a) { set((s) => ({ activity: [a, ...s.activity] })); },
  updateActivity(id, patch) { set((s) => ({ activity: s.activity.map((a) => (a.id === id ? { ...a, ...patch } : a)) })); },
  setTx(tx) { set({ tx }); },

  assets() {
    const seen = new Set<string>();
    const out: AssetMeta[] = [];
    for (const a of [...ASSETS, ...Object.values(get().walletAssets), ...Object.values(get().launchAssets)]) {
      const k = key(a.token);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
    return out;
  },
  assetFor(token) {
    return get().assets().find((a) => key(a.token) === key(token));
  },

  async scanWallet(owner) {
    try {
      const candidates = [...KNOWN_TOKENS, ...Object.values(get().launchAssets), ...Object.values(get().walletAssets)].filter((a, i, arr) => arr.findIndex((b) => key(b.token) === key(a.token)) === i);
      for (const t of customTokens()) if (!candidates.some((a) => key(a.token) === key(t))) candidates.push(await describeToken(publicClient, t).catch(() => undefined as never));
      const list = candidates.filter(Boolean);
      const [tokens, bnb] = await Promise.all([walletTokens(publicClient, owner, list), publicClient.getBalance({ address: owner })]);
      const walletAssets: Record<string, AssetMeta> = {};
      for (const t of tokens) if (!t.asset.launched) walletAssets[key(t.asset.token)] = { ...t.asset, fromWallet: true };
      // keep custom tokens even at zero balance so the user can still see them
      for (const t of customTokens()) {
        const k = key(t);
        if (!walletAssets[k]) {
          const prior = get().walletAssets[k] ?? list.find((a) => key(a.token) === k);
          if (prior) walletAssets[k] = prior;
        }
      }
      const walletBalances: Record<string, bigint> = { [key(NATIVE_TOKEN)]: bnb };
      for (const t of tokens) walletBalances[key(t.asset.token)] = t.amount;
      const added = Object.keys(walletAssets).some((k) => !get().walletAssets[k]);
      set({ walletAssets, walletBalances, walletScannedAt: Date.now(), walletScanError: undefined });
      await get().refreshPools();
      if (added && get().wallet && get().syncedTo > 0) void get().sync();
    } catch (e) {
      set({ walletScanError: `could not read your wallet: ${(e as Error).message}` });
      throw e;
    }
  },

  async addToken(token) {
    const meta = await describeToken(publicClient, getAddress(token));
    const { addCustomToken } = await import("./walletAssets");
    addCustomToken(meta.token);
    set((s) => ({ walletAssets: { ...s.walletAssets, [key(meta.token)]: meta } }));
    await get().refreshPools();
    return meta;
  },

  async refreshPools() {
    const { relayer: rl } = get();
    const all = get().assets();
    const results = await publicClient.multicall({
      contracts: all.map((a) => ({ address: POOL_ADDRESS, abi: ShieldedPoolAbi, functionName: "pools" as const, args: [a.token] as const })),
      allowFailure: true,
    });
    const pools: Record<string, PoolState> = {};
    results.forEach((r, i) => {
      if (r.status !== "success") return;
      const p = r.result;
      if (!p.exists) return;
      pools[key(all[i].token)] = { exists: true, decimals: Number(p.decimals), unit: p.unit, totalShares: p.totalShares, totalAssets: p.totalAssets, totalIn: p.totalIn, totalOut: p.totalOut, tvlCap: p.tvlCap };
    });
    set({ pools });
    // Ask the relayer how it would price each ERC-20 with a pool.
    const erc20 = all.filter((a) => a.token !== NATIVE_TOKEN);
    if (rl?.dynamicAssets && erc20.length) {
      const quotes = { ...get().assetQuotes };
      await Promise.all(erc20.map(async (a) => {
        if (rl.fees.some((f) => key(f.token) === key(a.token))) return;
        try { quotes[key(a.token)] = await relayer.asset(a.token); } catch { /* keep the last quote, if any */ }
      }));
      set({ assetQuotes: quotes });
    }
  },

  async sync() {
    if (syncing) {
      if (!queued) queued = syncing.catch(() => undefined).then(() => { queued = null; return get().sync(); });
      return queued;
    }
    syncing = syncPass().finally(() => { syncing = null; });
    return syncing;
  },

  async syncUntilCaughtUp(maxMs = 90_000) {
    const deadline = Date.now() + maxMs;
    for (;;) {
      await get().sync();
      let target = 0;
      try { target = await readNextIndex(publicClient, POOL_ADDRESS); } catch { /* retry below */ }
      if (target > 0 && get().syncedTo >= target) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 2500));
    }
  },

  rotateAddress() {
    const w = get().wallet;
    if (w) set({ address: bjjAddress(w) });
  },

  resetTx() {
    set({ tx: { stage: "idle" } });
  },

  async shield(asset, amount, signer, to) {
    const { wallet, tree, relayer: rl } = get();
    if (!wallet || !tree) throw new Error("wallet locked");
    const native = asset.token === NATIVE_TOKEN;
    const id = crypto.randomUUID();
    const act: ActivityItem = { id, kind: "shield", asset: asset.symbol, amount, decimals: asset.decimals, at: Date.now(), status: "pending" };
    set((s) => ({ activity: [act, ...s.activity], tx: { stage: "building", message: "Preparing" } }));
    try {
      // Pools are permissionless: the first shield of a token opens its pool (one extra transaction).
      let pool = get().pools[key(asset.token)];
      if (!pool) {
        if (native) throw new Error("BNB pool not found on chain");
        set({ tx: { stage: "signing", message: `Approve in your wallet: this opens the ${asset.symbol} pool (one-time)` } });
        const unitExp = Math.max(0, asset.decimals - 9);
        const openHash = await signer.writeContract({ address: POOL_ADDRESS, abi: ShieldedPoolAbi, functionName: "createPool", args: [asset.token, unitExp, (1n << 256n) - 1n] });
        set({ tx: { stage: "confirming", message: "Opening the pool", txHash: openHash } });
        await waitOk(openHash);
        if (rl?.dynamicAssets) await relayer.asset(asset.token).catch(() => undefined);
        await get().refreshPools();
        pool = get().pools[key(asset.token)];
        if (!pool) throw new Error("pool did not appear after opening it");
      }
      const units = toUnits(amount, pool.unit);
      if (units <= 0n) throw new Error("amount too small for this pool's precision");
      // ERC-20: the pool pulls exactly what the shares cost; approve that much first if needed
      if (!native) {
        const need = amountForMint(pool, sharesForDeposit(pool, units)) * pool.unit;
        const allowance = await publicClient.readContract({ address: asset.token, abi: IERC20MetadataAbi, functionName: "allowance", args: [signer.address, POOL_ADDRESS] });
        if (allowance < need) {
          set({ tx: { stage: "signing", message: `Approve ${asset.symbol} for the pool in your wallet` } });
          const h = await signer.writeContract({ address: asset.token, abi: IERC20MetadataAbi, functionName: "approve", args: [POOL_ADDRESS, need] });
          set({ tx: { stage: "confirming", message: "Waiting for the approval", txHash: h } });
          await waitOk(h);
        }
      }
      set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
      const relayerKey = rl ? getAddress(rl.relayer) : signer.address;
      const artifacts = await artifactsForProof(reportArtifacts(set));
      set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
      const t0 = performance.now();
      const built = await wallet.buildTransact({
        asset: assetId(asset.token), poolAddress: POOL_ADDRESS, token: asset.token, pool, tree, artifacts,
        kind: "shield", amount: units, to: to ? decodeAddress(wallet.bjj, to).address : undefined,
        relayer: relayerKey, relayerFee: 0n,
      });
      set({ lastProveMs: performance.now() - t0, tx: { stage: "signing", message: "Approve the transaction in your wallet" } });
      const hash = await signer.writeContract({ ...built.call });
      set({ tx: { stage: "confirming", message: "Waiting for confirmation", txHash: hash } });
      await waitOk(hash);
      set((s) => ({ tx: { stage: "done", txHash: hash }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "confirmed", txHash: hash } : a)) }));
      await get().refreshPools();
      void get().syncUntilCaughtUp();
    } catch (e) {
      const msg = friendlyError(e);
      set((s) => ({ tx: { stage: "failed", message: msg }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "failed", error: msg } : a)) }));
      throw new Error(msg);
    }
  },

  async send(asset, amount, to, memo) {
    await relayedTransact(get, set, asset, amount, "send", { to, memo });
  },

  async unshield(asset, amount, recipient) {
    await relayedTransact(get, set, asset, amount, "unshield", { recipient });
  },

  async relayExit(asset, amount, o) {
    return relayedTransact(get, set, asset, amount, "unshield", { recipient: o.recipient, fee: o.fee, exit: o.exit, activityKind: o.kind, label: o.label });
  },
  };
});

async function waitOk(hash: Hex) {
  const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") throw new Error(`transaction ${hash.slice(0, 10)}… reverted`);
}

/** One line a person can act on, from a viem error, an ApiError or a plain Error. */
export function friendlyError(e: unknown): string {
  const raw = (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  if (/user rejected|user denied|rejected the request/i.test(raw)) return "you rejected the request in your wallet";
  if (/insufficient funds/i.test(raw)) return "the wallet does not hold enough BNB for this transaction and its gas";
  const data = /data="?(0x[0-9a-f]{8})/i.exec(raw)?.[1] ?? /(0x[0-9a-f]{8})\b/i.exec(raw)?.[1];
  const name = data ? contractErrorFromData(data as Hex) : undefined;
  if (name === "NullifierSpent") return "these notes were already spent on-chain; your balance will update after a rescan";
  if (name) return `the contract refused the transaction: ${name}`;
  return raw.length > 220 ? raw.slice(0, 220) + "…" : raw;
}

export function isStaleRootError(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 422) return false;
  if (isStaleRootRejection(e.body)) return true;
  const ce = (e.body as { contractError?: string } | undefined)?.contractError;
  return !!ce && (STALE_ROOT_ERRORS as readonly string[]).includes(ce);
}

async function relayedTransact(
  get: () => State,
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  asset: AssetMeta,
  amount: bigint,
  kind: "send" | "unshield",
  o: { to?: string; memo?: string; recipient?: EvmAddress; fee?: bigint; exit?: { target: EvmAddress; data: Uint8Array }; activityKind?: ActivityItem["kind"]; label?: string }
): Promise<string | undefined> {
  const { wallet, tree, pools, relayer: rl, assetQuotes } = get();
  if (!wallet || !tree) throw new Error("wallet locked");
  if (!rl) throw new Error("relayer unavailable");
  const pool = pools[key(asset.token)];
  if (!pool) throw new Error("pool not found on chain");
  const units = toUnits(amount, pool.unit);
  if (units <= 0n) throw new Error("amount too small");
  const relayerKey = getAddress(rl.relayer);
  let fee = o.fee;
  if (fee === undefined) {
    const feePolicy = rl.fees.find((f) => key(f.token) === key(asset.token));
    const quote = assetQuotes[key(asset.token)];
    if (feePolicy) {
      const pct = (units * BigInt(feePolicy.bps)) / 10_000n;
      fee = pct > BigInt(feePolicy.min) ? pct : BigInt(feePolicy.min);
    } else if (quote?.supported && quote.fee) {
      const pct = (units * BigInt(quote.fee.bps)) / 10_000n;
      fee = pct > BigInt(quote.fee.min) ? pct : BigInt(quote.fee.min);
    } else {
      throw new Error(quote?.reason ?? "relayer does not support this asset");
    }
  }
  const id = crypto.randomUUID();
  const act: ActivityItem = { id, kind: o.activityKind ?? kind, asset: o.label ?? asset.symbol, amount, decimals: asset.decimals, at: Date.now(), status: "pending" };
  set((s) => ({ activity: [act, ...s.activity], tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } }));
  let consumed: bigint[] = [];
  let accepted = false;
  try {
    const build = async () => {
      const artifacts = await artifactsForProof(reportArtifacts(set));
      set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
      const t0 = performance.now();
      const built = await wallet.buildTransact({
        asset: assetId(asset.token), poolAddress: POOL_ADDRESS, token: asset.token, pool, tree, artifacts,
        kind, amount: units,
        to: o.to ? decodeAddress(wallet.bjj, o.to).address : undefined,
        recipient: o.recipient,
        relayer: relayerKey, relayerFee: fee!,
        memo: o.memo ? new TextEncoder().encode(o.memo) : undefined,
        exitTarget: o.exit?.target, exitData: o.exit?.data,
      });
      consumed = built.consumed;
      set({ lastProveMs: performance.now() - t0, tx: { stage: "relaying", message: "Handing the proof to the relayer" } });
      return relayer.relay(transactCallToJson(built.call));
    };
    let job: Awaited<ReturnType<typeof build>>;
    try {
      job = await build();
    } catch (e) {
      // The proof names a root in the 128-root ring. Under load that slot can be
      // overwritten before the relayer simulates: UnknownRoot or InvalidProof.
      // Both mean "the tree moved": re-sync, re-prove once, then give up.
      if (!isStaleRootError(e)) throw e;
      wallet.release(consumed);
      consumed = [];
      set({ tx: { stage: "proving", message: "The tree moved while proving; syncing and proving again" } });
      await get().sync();
      job = await build();
    }
    accepted = true;
    const wait = Math.max(0, job.releaseAt - Date.now());
    set({ tx: { stage: "confirming", message: `Queued. Relayer releases in ~${Math.ceil(wait / 1000)}s for timing privacy` } });
    let pollErrors = 0;
    let txHash: string | undefined;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      let st: Awaited<ReturnType<typeof relayer.job>>;
      try {
        st = await relayer.job(job.id);
        pollErrors = 0;
      } catch (e) {
        if (++pollErrors < 48) continue;
        throw new Error(`lost contact with the relayer: ${(e as Error).message}`);
      }
      if (st.status === "confirmed") {
        txHash = st.txHash;
        set((s) => ({ tx: { stage: "done", txHash: st.txHash }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "confirmed", txHash: st.txHash } : a)) }));
        break;
      }
      if (st.status === "failed") {
        if (st.txHash) {
          const rc = await publicClient.getTransactionReceipt({ hash: st.txHash as Hex }).catch(() => null);
          if (rc?.status === "success") {
            txHash = st.txHash;
            set((s) => ({ tx: { stage: "done", txHash: st.txHash }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "confirmed", txHash: st.txHash } : a)) }));
            break;
          }
        }
        throw new Error(st.error ?? "the relayer could not land the transaction");
      }
    }
    await get().refreshPools();
    await get().sync();
    void get().syncUntilCaughtUp();
    return txHash;
  } catch (e) {
    if (accepted) {
      await get().sync().catch(() => undefined);
      wallet.release(consumed.filter((cm) => !wallet.isSpent(cm)));
    } else {
      wallet.release(consumed);
    }
    const msg = friendlyError(e);
    set((s) => ({ tx: { stage: "failed", message: msg }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "failed", error: msg } : a)) }));
    throw new Error(msg);
  }
}

export { BNB };
