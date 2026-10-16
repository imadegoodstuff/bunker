"use client";
// Client-side shielded wallet state, a thin layer over the SDK's BunkerClient.
// Nothing here ever leaves the browser except proofs, ciphertexts and the
// contract call handed to the relayer.
import { create } from "zustand";
import { getAddress, type Hex, type WalletClient } from "viem";
import {
  BunkerClient, assetId, seedFromSignature, amountForBurn, amountForMint, sharesForDeposit, toUnits, readNextIndex, readInsertedIndex,
  contractErrorFromData, NATIVE_TOKEN, ShieldedPoolAbi, IERC20MetadataAbi, SPENDING_KEY_MESSAGE, decodeAddress,
  type PoolState, type SpendableNote, type EvmAddress, type TxEvent,
} from "@bunker/sdk";
import { ApiError, indexer, relayer, type AssetQuote, type RelayerInfo } from "./api";
import { ASSETS, BNB, KNOWN_TOKENS, NETWORK, POOL_ADDRESS, SWAP_EXIT_ADDRESS, type AssetMeta } from "./config";
import { publicClient } from "./chain";
import { customTokens, describeToken, describeTokens, walletTokens } from "./walletAssets";
import { artifactFor, prefetchArtifacts, type Progress } from "./artifacts";
import { deviceProvider, forgetDeviceSeed, gasAccount, rememberDeviceSeed } from "./device";
import { useLegacy } from "./legacy";
import { useWallet } from "./wallet";

export type Phase = "idle" | "deriving" | "syncing" | "ready" | "error";
export type TxStage = "idle" | "building" | "proving" | "draining" | "signing" | "relaying" | "confirming" | "done" | "failed";

export interface ActivityItem {
  id: string;
  kind: "shield" | "send" | "unshield" | "swap" | "buy" | "sell" | "launch" | "settle" | "register" | "migrate";
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

/** The app's signer as what the SDK accepts: a wallet client with an account. */
export function sdkSigner(s: Signer): WalletClient {
  return { account: { address: s.address, type: "json-rpc" }, writeContract: (req: Parameters<Signer["writeContract"]>[0]) => s.writeContract(req) } as unknown as WalletClient;
}

interface State {
  phase: Phase;
  error?: string;
  client?: BunkerClient;
  /** this wallet's stable `bunker1…` address (what you register); `rotateAddress` swaps in a fresh diversified one */
  address?: string;
  /** opened from a viewing key: sees everything, spends nothing */
  watchOnly: boolean;
  /** pool state per token address (lower-case) */
  pools: Record<string, PoolState>;
  /** Wall-clock proving time of the last proof made on this device, in ms. */
  lastProveMs?: number;
  /** spendable shielded balances in shares, per token address */
  balances: Record<string, bigint>;
  /** shares still queued for the next drain, per token address: yours, visible, not yet spendable */
  queued: Record<string, bigint>;
  /** leaves the chain has queued but not yet folded into the tree */
  pending: number;
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
  /** the shielded address the connected EOA has registered on-chain (null: none; undefined: not looked up) */
  registered?: string | null;
  activity: ActivityItem[];
  tx: { stage: TxStage; message?: string; txHash?: string };

  /** `passphrase === null` means the user explicitly chose signature-only (SDK `allowEmpty`). */
  unlock: (signMessage: (m: string) => Promise<Hex>, passphrase: string | null) => Promise<void>;
  unlockFromSeed: (backup: string) => Promise<void>;
  /** Open a watch-only vault from a `bunkerview1…` full viewing key. */
  unlockFromViewingKey: (key: string) => Promise<void>;
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
  /** Full viewing key: sees everything, spends nothing. */
  exportViewingKey: () => string | undefined;
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
  /** Fold the queued leaves into the tree: asks the relayer's keeper, and with a signer drains directly if nobody does. */
  settle: (signer?: Signer) => Promise<void>;
  /** Look up what the connected EOA has registered. */
  checkRegistry: (owner: EvmAddress) => Promise<void>;
  /** Publish this vault's address under the signer's EOA so anyone can pay the EOA privately. */
  register: (signer: Signer) => Promise<void>;
  unregister: (signer: Signer) => Promise<void>;
  /** amounts in base units (wei for BNB); `to` is a `bunker1…` address or a registered `0x…` */
  shield: (asset: AssetMeta, amount: bigint, signer: Signer, to?: string) => Promise<void>;
  send: (asset: AssetMeta, amount: bigint, to: string, memo?: string) => Promise<void>;
  /** Send without a relayer: the signer submits and pays gas, no fee note. The signer is visible as the submitter. */
  sendDirect: (asset: AssetMeta, amount: bigint, to: string, signer: Signer, memo?: string) => Promise<void>;
  /** `compliant`: the proof also shows every spent note descends from a deposit the association set vouches for. */
  unshield: (asset: AssetMeta, amount: bigint, recipient: EvmAddress, o?: { compliant?: boolean }) => Promise<void>;
  /** Withdraw without a relayer: the signer submits and pays gas, no fee note. For assets no relayer prices, or by choice. */
  unshieldDirect: (asset: AssetMeta, amount: bigint, recipient: EvmAddress, signer: Signer, o?: { compliant?: boolean }) => Promise<void>;
  /** The association set this deployment's indexer maintains (null: none). Cached after the first call. */
  asp?: { provider: EvmAddress; root: bigint; leaves: number; updatedAt: number | null } | null;
  loadAsp: () => Promise<void>;
  /** This vault's post-quantum (`bunkerq1…`) address: the same keys with an ML-KEM-768 key attached; longer, hybrid-encrypted notes. */
  pqAddress: () => string | undefined;
  /** A selective-disclosure document (SPEC §13) as JSON text; `full` adds the viewing key. */
  exportDisclosure: (scope: "notes" | "full") => string | undefined;
  /** Private PancakeSwap swap: `amount` of `from` leaves the vault, the output lands back as a note of `to`. */
  swap: (from: AssetMeta, amount: bigint, to: AssetMeta) => Promise<void>;
  quoteSwap: (from: AssetMeta, amount: bigint, to: AssetMeta) => Promise<{ out: bigint; relayerFee: bigint }>;
  /** Run a private trade the launchpad store built; `kind`/`label` name it in the activity list. */
  runTrade: (kind: "buy" | "sell", label: string, amount: bigint, decimals: number, run: (onEvent: (e: TxEvent) => void) => Promise<Hex>) => Promise<Hex>;
  /** Run a protocol-v1 (legacy) operation under the same overlay and activity log; the v1 client does the work. */
  runLegacy: (kind: ActivityItem["kind"], label: string, amount: bigint, decimals: number, run: (onEvent: (e: TxEvent) => void) => Promise<Hex>) => Promise<Hex>;
  addLaunchAssets: (assets: AssetMeta[]) => void;
  pushActivity: (a: ActivityItem) => void;
  updateActivity: (id: string, patch: Partial<ActivityItem>) => void;
  setTx: (tx: State["tx"]) => void;
  resetTx: () => void;
}

const key = (t: string) => t.toLowerCase();

/** Spendable shielded balance of an asset in base units, from shares and the pool rate. */
export function shieldedAmount(s: Pick<State, "balances" | "pools">, asset: AssetMeta): bigint {
  const pool = s.pools[key(asset.token)];
  const shares = s.balances[key(asset.token)] ?? 0n;
  if (!pool) return 0n;
  return amountForBurn(pool, shares) * pool.unit;
}

/** What is yours but still queued for the next drain, in base units. */
export function queuedAmount(s: Pick<State, "queued" | "pools">, asset: AssetMeta): bigint {
  const pool = s.pools[key(asset.token)];
  const shares = s.queued[key(asset.token)] ?? 0n;
  if (!pool) return 0n;
  return amountForBurn(pool, shares) * pool.unit;
}

/** Relayer fee for a relayed spend of `amount`, from the published policy (what the SDK charges). */
export function relayerFeeFor(s: Pick<State, "relayer" | "assetQuotes" | "pools">, asset: AssetMeta, amount: bigint): bigint | null {
  const pool = s.pools[key(asset.token)];
  if (!pool) return null;
  const policy = s.relayer?.fees.find((f) => key(f.token) === key(asset.token));
  const quote = s.assetQuotes[key(asset.token)];
  const p = policy ?? (quote?.supported && quote.fee ? { min: quote.fee.min, bps: quote.fee.bps } : null);
  if (!p) return null;
  const units = amount / pool.unit;
  const pct = (units * BigInt(p.bps)) / 10_000n;
  return (pct > BigInt(p.min) ? pct : BigInt(p.min)) * pool.unit;
}

export const useBunker = create<State>((set, get) => {
  let queuedSync: Promise<void> | null = null;
  let proveStart = 0;

  /** Turns SDK progress into the tx modal's message, so a first-time proof is not a silent wait. */
  const reportArtifacts = (p: Progress) => {
    if (!p.total) return;
    const mb = (n: number) => (n / 1_048_576).toFixed(1);
    set({ tx: { stage: "proving", message: `Fetching the proving key (one-time, ${mb(p.loaded)} / ${mb(p.total)} MB)` } });
  };

  /** SDK tx events into the overlay's stages. */
  const onEvent = (e: TxEvent) => {
    if (e.stage === "proving") {
      proveStart = performance.now();
      set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
    } else if (e.stage === "relaying") {
      if (proveStart) set({ lastProveMs: performance.now() - proveStart });
      proveStart = 0;
      set({ tx: { stage: "relaying", message: "Handing the proof to the relayer" } });
    } else if (e.stage === "confirming") {
      if (proveStart) { set({ lastProveMs: performance.now() - proveStart }); proveStart = 0; }
      const wait = e.releaseAt ? Math.max(0, e.releaseAt - Date.now()) : 0;
      set({ tx: { stage: "confirming", message: wait ? `Queued. Relayer releases in ~${Math.ceil(wait / 1000)}s for timing privacy` : e.message ? cap(e.message) : "Waiting for confirmation", txHash: e.txHash } });
    } else if (e.stage === "draining") {
      set({ tx: { stage: "draining", message: "Folding queued notes into the tree first (one keeper transaction)" } });
    } else if (e.stage === "done") {
      set({ tx: { stage: "done", txHash: e.txHash } });
    }
  };

  async function readBalances() {
    const c = get().client;
    if (!c) return;
    const balances: Record<string, bigint> = {};
    const queued: Record<string, bigint> = {};
    for (const a of get().assets()) {
      const id = assetId(key(a.token));
      balances[key(a.token)] = c.wallet.balance(id);
      queued[key(a.token)] = c.wallet.queuedBalance(id);
    }
    set({ balances, queued, notes: [...c.wallet.notes.values()], syncedTo: c.leaves.length });
  }

  async function syncPass() {
    const c = get().client;
    if (!c) return;
    try {
      await c.sync();
      if (get().error?.startsWith("Local tree root")) set({ error: undefined });
    } catch (e) {
      const m = (e as Error).message;
      if (/root does not match/i.test(m)) set({ error: "Local tree root does not match the chain; the indexer may be lagging or corrupt." });
      else throw e;
    }
    await readBalances();
    try {
      const [next, inserted] = await Promise.all([readNextIndex(publicClient, POOL_ADDRESS), readInsertedIndex(publicClient, POOL_ADDRESS)]);
      set({ totalLeaves: next, pending: next - inserted });
    } catch { /* non-fatal */ }
  }

  async function open(o: { seed?: Uint8Array; viewingKey?: string }) {
    const client = await BunkerClient.connect({ network: NETWORK, ...o, artifactLoader: (circuit) => artifactFor(circuit, reportArtifacts) });
    set({ client, address: client.address(), watchOnly: client.watchOnly, phase: "syncing" });
    relayer.info().then((r) => set({ relayer: r })).catch(() => undefined);
    await get().refreshPools();
    await get().sync();
    set({ phase: "ready" });
    // the same seed also opens this user's protocol-v1 notes (legacy pool); nothing to do for watch-only vaults
    if (o.seed) void useLegacy.getState().open(o.seed);
  }

  async function opening(f: () => Promise<void>) {
    set({ phase: "deriving", error: undefined });
    prefetchArtifacts();
    try {
      await f();
    } catch (e) {
      set({ phase: "error", error: (e as Error).message });
    }
  }

  function activity(kind: ActivityItem["kind"], asset: string, amount: bigint, decimals: number): string {
    const id = crypto.randomUUID();
    set((s) => ({ activity: [{ id, kind, asset, amount, decimals, at: Date.now(), status: "pending" }, ...s.activity] }));
    return id;
  }
  function finish(id: string, txHash: string | undefined) {
    set((s) => ({ tx: { stage: "done", txHash }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "confirmed", txHash } : a)) }));
  }
  function fail(id: string, e: unknown): never {
    const msg = friendlyError(e);
    set((s) => ({ tx: { stage: "failed", message: msg }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "failed", error: msg } : a)) }));
    throw new Error(msg);
  }

  return {
  phase: "idle",
  watchOnly: false,
  pools: {},
  balances: {},
  queued: {},
  pending: 0,
  walletAssets: {},
  walletBalances: {},
  assetQuotes: {},
  launchAssets: {},
  notes: [],
  syncedTo: 0,
  totalLeaves: 0,
  activity: [],
  tx: { stage: "idle" },

  unlock(signMessage, passphrase) {
    return opening(async () => {
      const sigHex = await signMessage(SPENDING_KEY_MESSAGE);
      const sig = Uint8Array.from(Buffer.from(sigHex.slice(2), "hex"));
      const seed = passphrase === null ? await seedFromSignature(sig, "", { allowEmpty: true }) : await seedFromSignature(sig, passphrase);
      await open({ seed });
    });
  },

  unlockFromSeed(backup) {
    return opening(() => open({ seed: BunkerClient.seedFromBackup(backup.trim()) }));
  },

  unlockFromViewingKey(viewingKey) {
    return opening(() => open({ viewingKey: viewingKey.trim() }));
  },

  openDevice(seed) {
    return opening(async () => {
      const account = gasAccount(seed);
      useWallet.getState().useDevice(deviceProvider(account), account.address);
      rememberDeviceSeed(seed);
      await open({ seed });
      void get().scanWallet(account.address);
    });
  },

  forgetDevice() {
    forgetDeviceSeed();
    useWallet.getState().dropDevice();
    get().lock();
  },

  exportSeed() {
    const c = get().client;
    if (!c || c.watchOnly) return undefined;
    return c.backup();
  },

  exportViewingKey() {
    return get().client?.viewingKey();
  },

  lock() {
    useLegacy.getState().close();
    set({ phase: "idle", client: undefined, address: undefined, watchOnly: false, notes: [], balances: {}, queued: {}, pending: 0, syncedTo: 0, activity: [], registered: undefined, error: undefined });
  },

  addLaunchAssets(assets) {
    const cur = get().launchAssets;
    const fresh = assets.filter((a) => !cur[key(a.token)]);
    if (fresh.length === 0) return;
    const next = { ...cur };
    for (const a of fresh) next[key(a.token)] = { ...a, launched: true };
    set({ launchAssets: next });
    if (get().client && get().syncedTo > 0) void get().refreshPools().then(() => readBalances());
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
      // everything the account actually holds, from the indexer's token API (any ERC-20 on the chain, not only the known list)
      const discovered = await indexer.walletTokens(owner).catch(() => [] as { token: EvmAddress; balance: string }[]);
      const fresh = discovered.filter((d) => BigInt(d.balance) > 0n && !candidates.some((a) => a && key(a.token) === key(d.token))).slice(0, 60);
      const described = await describeTokens(publicClient, fresh.map((d) => d.token));
      for (const m of described) candidates.push(m);
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
      set({ walletAssets, walletBalances, walletScannedAt: Date.now(), walletScanError: undefined });
      await get().refreshPools();
      if (get().client && get().syncedTo > 0) await readBalances();
      void get().checkRegistry(owner);
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
    // the SDK shares one pass between concurrent callers; queue one more so a call made mid-pass sees the newest leaves
    const c = get().client;
    if (!c) return;
    if (queuedSync) return queuedSync;
    queuedSync = syncPass().finally(() => { queuedSync = null; });
    return queuedSync;
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
    const c = get().client;
    if (c) set({ address: c.freshAddress() });
  },

  resetTx() {
    set({ tx: { stage: "idle" } });
  },

  async settle(signer) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    const id = activity("settle", "queue", 0n, 0);
    set({ tx: { stage: "draining", message: "Asking the keeper to fold the queued notes into the tree" } });
    try {
      await c.ensureInserted(undefined, { signer: signer ? sdkSigner(signer) : undefined, waitMs: 25_000, onEvent });
      await get().sync();
      finish(id, undefined);
    } catch (e) {
      fail(id, e);
    }
  },

  async checkRegistry(owner) {
    const c = get().client;
    if (!c) return;
    try { set({ registered: await c.resolve(owner) }); } catch { /* leave as is */ }
  },

  async register(signer) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    const id = activity("register", "address", 0n, 0);
    set({ tx: { stage: "signing", message: "Approve in your wallet: this publishes your vault address under your account" } });
    try {
      const h = await c.register(sdkSigner(signer));
      finish(id, h);
      await get().checkRegistry(signer.address);
    } catch (e) {
      fail(id, e);
    }
  },

  async unregister(signer) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    const id = activity("register", "cleared", 0n, 0);
    set({ tx: { stage: "signing", message: "Approve in your wallet: this clears your registry entry" } });
    try {
      const h = await c.unregister(sdkSigner(signer));
      finish(id, h);
      await get().checkRegistry(signer.address);
    } catch (e) {
      fail(id, e);
    }
  },

  async shield(asset, amount, signer, to) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    if (c.watchOnly) throw new Error("this vault is watch-only");
    const native = asset.token === NATIVE_TOKEN;
    const id = activity("shield", asset.symbol, amount, asset.decimals);
    set({ tx: { stage: "building", message: "Preparing" } });
    try {
      // Pools are permissionless: the first shield of a token opens its pool (one extra transaction).
      let pool = get().pools[key(asset.token)];
      if (!pool) {
        if (native) throw new Error("BNB pool not found on chain");
        set({ tx: { stage: "signing", message: `Approve in your wallet: this opens the ${asset.symbol} pool (one-time)` } });
        await c.openPool(asset.token, sdkSigner(signer));
        if (get().relayer?.dynamicAssets) await relayer.asset(asset.token).catch(() => undefined);
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
      const t0 = performance.now();
      const built = await c.buildShield(asset.token, amount, { to: to || undefined });
      set({ lastProveMs: performance.now() - t0, tx: { stage: "signing", message: "Approve the transaction in your wallet" } });
      let hash: Hex;
      try {
        hash = await signer.writeContract({ ...built.call });
      } catch (e) {
        c.wallet.release(built.consumed);
        throw e;
      }
      set({ tx: { stage: "confirming", message: "Waiting for confirmation", txHash: hash } });
      await waitOk(hash);
      finish(id, hash);
      await get().refreshPools();
      void get().syncUntilCaughtUp();
    } catch (e) {
      fail(id, e);
    }
  },

  async send(asset, amount, to, memo) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    if (c.watchOnly) throw new Error("this vault is watch-only");
    const id = activity("send", asset.symbol, amount, asset.decimals);
    set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
    try {
      const h = await c.send(asset.token, amount, to, { memo: memo || undefined, onEvent });
      finish(id, h);
      await after();
    } catch (e) {
      fail(id, e);
    }
  },

  async sendDirect(asset, amount, to, signer, memo) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    if (c.watchOnly) throw new Error("this vault is watch-only");
    const id = activity("send", asset.symbol, amount, asset.decimals);
    set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
    try {
      const h = await c.sendDirect(tok(asset), amount, to, { signer: sdkSigner(signer), memo: memo || undefined, onEvent });
      finish(id, h);
      await after();
    } catch (e) {
      fail(id, e);
    }
  },

  async unshield(asset, amount, recipient, o = {}) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    if (c.watchOnly) throw new Error("this vault is watch-only");
    const id = activity("unshield", asset.symbol, amount, asset.decimals);
    set({ tx: { stage: "proving", message: o.compliant ? "Generating the proof, with association-set membership for every note spent" : "Generating zero-knowledge proof in your browser" } });
    try {
      const h = await c.unshield(asset.token, amount, recipient, { onEvent, compliant: o.compliant });
      finish(id, h);
      await after();
    } catch (e) {
      fail(id, e);
    }
  },

  async unshieldDirect(asset, amount, recipient, signer, o = {}) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    if (c.watchOnly) throw new Error("this vault is watch-only");
    const id = activity("unshield", asset.symbol, amount, asset.decimals);
    set({ tx: { stage: "proving", message: o.compliant ? "Generating the proof, with association-set membership for every note spent" : "Generating zero-knowledge proof in your browser" } });
    try {
      const h = await c.unshieldDirect(tok(asset), amount, recipient, { signer: sdkSigner(signer), onEvent, compliant: o.compliant });
      finish(id, h);
      await after();
    } catch (e) {
      fail(id, e);
    }
  },

  async loadAsp() {
    const c = get().client;
    if (!c) return;
    try { set({ asp: await c.aspInfo() }); } catch { set({ asp: null }); }
  },

  pqAddress() {
    const c = get().client;
    return c ? c.address({ pq: true }) : undefined;
  },

  exportDisclosure(scope) {
    const c = get().client;
    if (!c) return undefined;
    return JSON.stringify(c.disclosure({ scope }), null, 2);
  },

  async quoteSwap(from, amount, to) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    if (!SWAP_EXIT_ADDRESS) throw new Error("private swaps are not deployed on this network");
    const q = await c.quoteSwap(tok(from), amount, tok(to));
    return { out: q.out, relayerFee: q.relayerFee };
  },

  async swap(from, amount, to) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    if (c.watchOnly) throw new Error("this vault is watch-only");
    const id = activity("swap", `${from.symbol} → ${to.symbol}`, amount, from.decimals);
    set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
    try {
      // the output needs a pool to land in; the first swap into a token opens it through the relayer
      if (!get().pools[key(to.token)]) {
        set({ tx: { stage: "building", message: `Opening the ${to.symbol} pool (one-time)` } });
        await openPoolViaRelayer(to.token);
        await get().refreshPools();
      }
      const h = await c.swap(tok(from), amount, tok(to), { onEvent });
      finish(id, h);
      await after();
    } catch (e) {
      fail(id, e);
    }
  },

  async runLegacy(kind, label, amount, decimals, run) {
    const id = activity(kind, label, amount, decimals);
    set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser (protocol v1)" } });
    try {
      const h = await run(onEvent);
      finish(id, h);
      if (get().client) await after();
      return h;
    } catch (e) {
      fail(id, e);
    }
  },

  async runTrade(kind, label, amount, decimals, run) {
    const c = get().client;
    if (!c) throw new Error("wallet locked");
    if (c.watchOnly) throw new Error("this vault is watch-only");
    const id = activity(kind, label, amount, decimals);
    set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
    try {
      const h = await run(onEvent);
      finish(id, h);
      await after();
      return h;
    } catch (e) {
      fail(id, e);
    }
  },
  };

  async function after() {
    await get().refreshPools();
    await get().sync();
    void get().syncUntilCaughtUp();
  }
});

const tok = (a: AssetMeta) => (a.token === NATIVE_TOKEN ? ("BNB" as const) : a.token);

/** Ask the relayer to open an ERC-20's pool (its keeper pays); falls back to telling the user to shield once. */
async function openPoolViaRelayer(token: EvmAddress) {
  const r = await fetch(`${NETWORK.relayerUrl}/pool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
  if (!r.ok) throw new Error("no shielded pool for the output token yet; shield a little of it once to open one");
  const t0 = Date.now();
  for (;;) {
    await new Promise((res) => setTimeout(res, 2500));
    const p = await publicClient.readContract({ address: POOL_ADDRESS, abi: ShieldedPoolAbi, functionName: "pools", args: [token] });
    if (p.exists) return;
    if (Date.now() - t0 > 120_000) throw new Error("the pool did not open in time; try again in a minute");
  }
}

async function waitOk(hash: Hex) {
  const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") throw new Error(`transaction ${hash.slice(0, 10)}… reverted`);
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One line a person can act on, from a viem error, an ApiError or a plain Error. */
export function friendlyError(e: unknown): string {
  const raw = (e as { shortMessage?: string })?.shortMessage ?? (e as Error)?.message ?? String(e);
  if (/user rejected|user denied|rejected the request/i.test(raw)) return "you rejected the request in your wallet";
  if (/insufficient funds/i.test(raw)) return "the wallet does not hold enough BNB for this transaction and its gas";
  const data = /data="?(0x[0-9a-f]{8})/i.exec(raw)?.[1] ?? /(0x[0-9a-f]{8})\b/i.exec(raw)?.[1];
  const name = data ? contractErrorFromData(data as Hex) : undefined;
  if (name === "NullifierSpent") return "these notes were already spent on-chain; your balance will update after a rescan";
  if (name === "ShortDelivery") return "this token takes a tax on transfer, so the pool received less than you sent and refused the deposit; fee-on-transfer tokens cannot be shielded";
  if (name === "TvlCapExceeded") return "this deposit would push the pool over its current cap; try a smaller amount or later";
  if (name) return `the contract refused the transaction: ${name}`;
  if (e instanceof ApiError && typeof e.body === "object" && e.body && "error" in e.body) return String((e.body as { error: unknown }).error).slice(0, 220);
  return raw.length > 220 ? raw.slice(0, 220) + "…" : raw;
}

/** True for a `bunker1…` address this wallet can decode (not a registered `0x…`, which is resolved on-chain). */
export function isShieldedAddress(s: Pick<State, "client">, to: string): boolean {
  const c = s.client;
  if (!c) return false;
  try { decodeAddress(c.wallet.bjj, to); return true; } catch { return false; }
}

export { BNB };
