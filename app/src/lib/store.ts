"use client";
// Client-side shielded wallet state. Nothing here ever leaves the browser
// except proofs, ciphertexts and the instruction handed to the relayer.
import { create } from "zustand";
import { Connection, PublicKey, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
import {
  ShieldedWallet, MerkleTree, assetId, seedFromSignature, encodeAddress, decodeAddress, decodePool, poolPda, treePda, decodeTree,
  buildV0, fetchLookupTable, type PoolState, type SpendableNote, SPENDING_KEY_MESSAGE, seedToBackup, seedFromBackup,
  isStaleRootRejection, vaultErrorName, STALE_ROOT_ERRORS, createPoolIx, ataFor, TOKEN_PROGRAM_ID,
} from "@scash/sdk";
import { ApiError, indexer, relayer, type AssetQuote, type RelayerInfo } from "./api";
import { ASSETS, FALLBACK_RPC_URL, MAINNET, PROGRAM_ID, RPC_URL, type AssetMeta } from "./config";
import { describe, walletTokens } from "./walletAssets";
import { awaitConfirmation, ConfirmError } from "./confirm";
import { artifactsForProof, prefetchArtifacts, type Progress } from "./artifacts";

const U64_MAX = (1n << 64n) - 1n;

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
  amount: bigint;
  at: number;
  signature?: string;
  status: "pending" | "confirmed" | "failed";
  error?: string;
}

interface State {
  phase: Phase;
  error?: string;
  wallet?: ShieldedWallet;
  tree?: MerkleTree;
  address?: string;
  pools: Record<string, PoolState>;
  /** Base-mint freeze authority per asset symbol, when one exists. A frozen vault account blocks withdrawals of that asset. */
  freezeAuthority: Record<string, string>;
  /** Wall-clock proving time of the last proof made on this device, in ms. */
  lastProveMs?: number;
  balances: Record<string, bigint>;
  /** Tokens found in the connected public wallet, keyed by mint. Any of them can be shielded; the first shield opens the pool. */
  walletAssets: Record<string, AssetMeta>;
  /** Public (unshielded) balances per asset symbol, base units. */
  walletBalances: Record<string, bigint>;
  /** Why the last wallet scan failed, if it did. */
  walletScanError?: string;
  /** When the last successful wallet scan finished (ms). */
  walletScannedAt?: number;
  /** Relayer quotes per SPL mint: fee in the token, lookup table, or why it is shield-only. */
  assetQuotes: Record<string, AssetQuote>;
  /** Launched tokens the wallet also scans for, keyed by mint; their shielded balances (shares) live in `tokenBalances`. */
  launchAssets: Record<string, AssetMeta>;
  tokenBalances: Record<string, bigint>;
  notes: SpendableNote[];
  syncedTo: number;
  totalLeaves: number;
  relayer?: RelayerInfo;
  activity: ActivityItem[];
  tx: { stage: TxStage; message?: string; signature?: string };
  connection: Connection;

  /** `passphrase === null` means the user explicitly chose signature-only (SDK `allowEmpty`). */
  unlock: (signMessage: (m: Uint8Array) => Promise<Uint8Array>, passphrase: string | null) => Promise<void>;
  unlockFromSeed: (backup: string) => Promise<void>;
  /** Backup string for the current wallet. Anyone holding it can spend. */
  exportSeed: () => string | undefined;
  lock: () => void;
  sync: () => Promise<void>;
  /** Sync repeatedly until the indexer has every leaf the chain has (or `maxMs` passes). Resolves to whether it caught up. */
  syncUntilCaughtUp: (maxMs?: number) => Promise<boolean>;
  refreshPools: () => Promise<void>;
  /** Configured assets plus whatever the connected wallet holds. */
  assets: () => AssetMeta[];
  /** Read the public wallet's token accounts and register every mint as a shieldable asset. */
  scanWallet: (owner: PublicKey) => Promise<void>;
  rotateAddress: () => void;
  shield: (asset: AssetMeta, amount: bigint, owner: PublicKey, sendTx: (tx: VersionedTransaction) => Promise<string>, to?: string) => Promise<void>;
  send: (asset: AssetMeta, amount: bigint, to: string, memo?: string) => Promise<void>;
  unshield: (asset: AssetMeta, amount: bigint, recipient: PublicKey) => Promise<void>;
  /**
   * An unshield whose recipient is a program (the launchpad): the vault pays
   * `recipient` and then calls `exit.target` with `exit.accounts`. Used for
   * private buys and sells; `pool` and `fee` override the configured ones.
   */
  relayExit: (asset: AssetMeta, amount: bigint, o: { recipient: PublicKey; pool: PoolState; fee: bigint; exit: { target: PublicKey; data: Uint8Array; accounts: import("@solana/web3.js").AccountMeta[] }; kind: "buy" | "sell"; label: string }) => Promise<string | undefined>;
  /** Register launched tokens so `sync` scans their notes too. */
  addLaunchAssets: (assets: AssetMeta[]) => void;
  pushActivity: (a: ActivityItem) => void;
  updateActivity: (id: string, patch: Partial<ActivityItem>) => void;
  setTx: (tx: State["tx"]) => void;
  resetTx: () => void;
}

const bjjAddress = (w: ShieldedWallet) => encodeAddress(w.bjj, w.address(), MAINNET ? "scash" : "tscash"); // tscash only for a local test validator build

async function loadChainTree(conn: Connection) {
  const info = await conn.getAccountInfo(treePda(PROGRAM_ID));
  if (!info) throw new Error("protocol not initialized on this cluster");
  return decodeTree(new Uint8Array(info.data));
}

function b64ToBytes(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export const useScash = create<State>((set, get) => {
  let syncing: Promise<void> | null = null;
  let queued: Promise<void> | null = null;

  async function syncPass() {
    const { wallet, tree } = get();
    if (!wallet || !tree) return;
    let from = get().syncedTo;
    const launched = Object.values(get().launchAssets);
    const all = get().assets();
    const assetIds = [...all, ...launched].map((a) => ({ a, id: assetId(a.mint) }));
    for (;;) {
      const page = await indexer.commitments(from, 1000);
      for (const row of page.items) {
        const cm = BigInt("0x" + row.commitment);
        if (row.index === tree.size) await tree.insert(cm);
        const ct = b64ToBytes(row.ciphertext);
        for (const { id } of assetIds) {
          const n = await wallet.scan({ index: row.index, commitment: cm, ciphertext: ct }, id);
          if (n) break;
        }
      }
      from = page.next;
      set({ syncedTo: from, totalLeaves: page.total });
      if (page.items.length < 1000) break;
    }
    const nfs = await indexer.nullifiers(0);
    wallet.markSpent(nfs.map((n) => BigInt("0x" + n.nullifier)));
    const balances: Record<string, bigint> = {};
    for (const a of all) balances[a.symbol] = wallet.balance(assetId(a.mint));
    const tokenBalances: Record<string, bigint> = {};
    for (const a of launched) tokenBalances[a.mint.toBase58()] = wallet.balance(assetId(a.mint));
    set({ balances, tokenBalances, notes: [...wallet.notes.values()] });

    // sanity: our local root must be one the chain knows
    try {
      const info = await get().connection.getAccountInfo(treePda(PROGRAM_ID));
      if (info) {
        const t = decodeTree(new Uint8Array(info.data));
        const local = await tree.root();
        if (Number(t.nextIndex) === tree.size && t.currentRoot !== local) {
          set({ error: "Local tree root does not match chain; indexer may be lagging or corrupt." });
        }
      }
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
  freezeAuthority: {},
  balances: {},
  walletAssets: {},
  walletBalances: {},
  assetQuotes: {},
  launchAssets: {},
  tokenBalances: {},
  notes: [],
  syncedTo: 0,
  totalLeaves: 0,
  activity: [],
  tx: { stage: "idle" },
  connection: new Connection(RPC_URL, "confirmed"),

  async unlock(signMessage, passphrase) {
    set({ phase: "deriving", error: undefined });
    prefetchArtifacts();
    try {
      const sig = await signMessage(new TextEncoder().encode(SPENDING_KEY_MESSAGE));
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

  exportSeed() {
    const w = get().wallet;
    return w ? seedToBackup(w.spend.sk) : undefined;
  },

  lock() {
    set({ phase: "idle", wallet: undefined, tree: undefined, address: undefined, notes: [], balances: {}, tokenBalances: {}, syncedTo: 0, activity: [], walletAssets: {}, walletBalances: {} });
  },

  addLaunchAssets(assets) {
    const cur = get().launchAssets;
    const fresh = assets.filter((a) => !cur[a.mint.toBase58()]);
    if (fresh.length === 0) return;
    const next = { ...cur };
    for (const a of fresh) next[a.mint.toBase58()] = a;
    set({ launchAssets: next });
    // notes of a token we did not know about may already be in the scanned prefix
    if (get().wallet && get().syncedTo > 0) {
      set({ syncedTo: 0 });
      void get().sync();
    }
  },
  pushActivity(a) { set((s) => ({ activity: [a, ...s.activity] })); },
  updateActivity(id, patch) { set((s) => ({ activity: s.activity.map((a) => (a.id === id ? { ...a, ...patch } : a)) })); },
  setTx(tx) { set({ tx }); },

  assets() {
    return [...ASSETS, ...Object.values(get().walletAssets)];
  },

  async scanWallet(owner) {
    let connection = get().connection;
    let tokens: Awaited<ReturnType<typeof walletTokens>>;
    let sol: number;
    try {
      [tokens, sol] = await Promise.all([walletTokens(connection, owner), connection.getBalance(owner)]);
    } catch (e) {
      // The configured endpoint refused (rate limit, method not allowed from a
      // browser, outage). Reading public token balances needs no key: try the
      // public endpoint before giving up, and say what happened either way.
      try {
        connection = new Connection(FALLBACK_RPC_URL, "confirmed");
        [tokens, sol] = await Promise.all([walletTokens(connection, owner), connection.getBalance(owner)]);
      } catch {
        set({ walletScanError: `could not read your wallet's tokens: ${(e as Error).message}` });
        throw e;
      }
    }
    set({ walletScanError: undefined });
    const known = new Set(ASSETS.map((a) => a.mint.toBase58()));
    const fresh = tokens.filter((t) => !known.has(t.mint.toBase58()));
    const cur = get().walletAssets;
    const metas = await describe(connection, fresh.filter((t) => !cur[t.mint.toBase58()]), new Set(get().assets().map((a) => a.symbol)));
    const walletAssets = { ...cur };
    for (const m of metas) walletAssets[m.mint.toBase58()] = m;
    // drop assets the wallet no longer holds unless it has shielded notes of them
    for (const k of Object.keys(walletAssets)) {
      if (!tokens.some((t) => t.mint.toBase58() === k) && !(get().balances[walletAssets[k].symbol] ?? 0n)) delete walletAssets[k];
    }
    const walletBalances: Record<string, bigint> = {};
    walletBalances.SOL = BigInt(sol);
    for (const t of tokens) {
      const a = walletAssets[t.mint.toBase58()] ?? ASSETS.find((x) => x.mint.equals(t.mint));
      if (a) walletBalances[a.symbol] = t.amount;
    }
    const added = metas.length > 0;
    set({ walletAssets, walletBalances, walletScannedAt: Date.now() });
    await get().refreshPools();
    // notes of a token we did not know about may already be in the scanned prefix
    if (added && get().wallet && get().syncedTo > 0) {
      set({ syncedTo: 0 });
      void get().sync();
    }
  },

  async refreshPools() {
    const { connection, relayer: rl } = get();
    const all = get().assets();
    const pools: Record<string, PoolState> = {};
    const infos = await connection.getMultipleAccountsInfo(all.map((a) => poolPda(a.mint, PROGRAM_ID)));
    infos.forEach((info, i) => {
      if (info) pools[all[i].symbol] = decodePool(new Uint8Array(info.data));
    });
    // Mint layout (SPL Token and Token-2022 share it): freeze_authority is a
    // COption<Pubkey> at offset 46 — 4-byte tag, then 32 bytes. The program
    // deliberately does not refuse such mints (USDC has one); the UI shows it.
    const freezeAuthority: Record<string, string> = {};
    const spl = all.filter((a) => !a.mint.equals(SystemProgram.programId));
    if (spl.length) {
      const mints = await connection.getMultipleAccountsInfo(spl.map((a) => a.mint));
      mints.forEach((m, i) => {
        if (m && m.data.length >= 82 && m.data.readUInt32LE(46) === 1) {
          freezeAuthority[spl[i].symbol] = new PublicKey(m.data.subarray(50, 82)).toBase58();
        }
      });
    }
    set({ pools, freezeAuthority });
    // Ask the relayer how it would price each SPL asset (and let it provision
    // its token account + lookup table for the ones with pools).
    if (rl?.dynamicAssets && spl.length) {
      const quotes = { ...get().assetQuotes };
      await Promise.all(spl.map(async (a) => {
        const k = a.mint.toBase58();
        if (rl.fees.some((f) => f.mint === k)) return;
        try { quotes[k] = await relayer.asset(k); } catch { /* keep the last quote, if any */ }
      }));
      set({ assetQuotes: quotes });
    }
  },

  async sync() {
    // One pass at a time: a second caller waits for the running one (which
    // already covers the leaves it wants) instead of racing it on the tree.
    // A caller that arrives mid-pass (e.g. after resetting `syncedTo` for a
    // newly known asset) gets one more pass after the current one.
    if (syncing) {
      if (!queued) queued = syncing.catch(() => undefined).then(() => { queued = null; return get().sync(); });
      return queued;
    }
    syncing = syncPass().finally(() => { syncing = null; });
    return syncing;
  },

  async syncUntilCaughtUp(maxMs = 90_000) {
    // The indexer ticks every few seconds and fetches each transaction after
    // it; a leaf that just landed is not served for a while. Sync until the
    // indexer's leaf count reaches the chain's, so balances reflect the note
    // that was just created, instead of trusting one retry.
    const deadline = Date.now() + maxMs;
    for (;;) {
      await get().sync();
      let target = 0;
      try {
        const info = await get().connection.getAccountInfo(treePda(PROGRAM_ID));
        if (info) target = Number(decodeTree(new Uint8Array(info.data)).nextIndex);
      } catch { /* retry below */ }
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

  async shield(asset, amount, owner, sendTx, to) {
    const { wallet, tree, pools, relayer: rl } = get();
    if (!wallet || !tree) throw new Error("wallet locked");
    const native = asset.mint.equals(SystemProgram.programId);
    const tokenProgram = asset.tokenProgram ?? TOKEN_PROGRAM_ID;
    const conn = get().connection;
    const id = crypto.randomUUID();
    const act: ActivityItem = { id, kind: "shield", asset: asset.symbol, amount, at: Date.now(), status: "pending" };
    set((s) => ({ activity: [act, ...s.activity], tx: { stage: "building", message: "Preparing" } }));
    try {
      // Pools are permissionless: the first shield of a mint opens its pool
      // first (the depositor pays the ~0.002 SOL rent), then the relayer is
      // asked to quote it so its lookup table exists before the shield itself.
      let pool = pools[asset.symbol];
      if (!pool) {
        if (native) throw new Error("pool not found on chain");
        set({ tx: { stage: "signing", message: `Approve in your wallet: this opens the ${asset.symbol} pool (one-time, ~0.002 SOL rent)` } });
        const openBh = await conn.getLatestBlockhash();
        const openTx = buildV0(owner, [createPoolIx(owner, asset.mint, U64_MAX, tokenProgram, PROGRAM_ID)], openBh.blockhash, undefined, { cuLimit: 100_000 });
        const openSig = await sendTx(openTx);
        set({ tx: { stage: "confirming", message: "Opening the pool", signature: openSig } });
        await awaitConfirmation(conn, openSig, openBh);
        if (rl?.dynamicAssets) await relayer.asset(asset.mint.toBase58()).catch(() => undefined);
        await get().refreshPools();
        pool = get().pools[asset.symbol];
        if (!pool) throw new Error("pool did not appear after opening it");
      }
      set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
      const relayerKey = rl ? new PublicKey(rl.relayer) : owner;
      const [artifacts, chainTree] = await Promise.all([artifactsForProof(reportArtifacts(set)), loadChainTree(get().connection)]);
      set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
      const t0 = performance.now();
      const built = await wallet.buildTransact({
        asset: assetId(asset.mint), mint: asset.mint, tokenProgram: asset.tokenProgram, pool, tree, chainTree, artifacts,
        kind: "shield", amount, to: to ? decodeAddress(wallet.bjj, to).address : undefined,
        relayer: relayerKey, relayerDest: relayerKey, relayerFee: 0n, payer: owner, depositor: owner,
        depositorSource: native ? owner : ataFor(owner, asset.mint, tokenProgram),
      });
      set({ lastProveMs: performance.now() - t0, tx: { stage: "signing", message: "Approve the transaction in your wallet" } });
      const tableKeys = [rl?.lookupTable, get().assetQuotes[asset.mint.toBase58()]?.lookupTable].filter((k): k is string => !!k);
      const tables = (await Promise.all(tableKeys.map((k) => fetchLookupTable(conn, new PublicKey(k)).catch(() => undefined)))).filter((t) => !!t);
      const bh = await conn.getLatestBlockhash();
      const tx = buildV0(owner, [built.instruction], bh.blockhash, tables);
      if (tx.serialize().length > 1232) throw new Error("transaction too large for this token yet; the relayer is still preparing its lookup table, try again in a minute");
      const sig = await sendTx(tx);
      set({ tx: { stage: "confirming", message: "Waiting for confirmation", signature: sig } });
      await awaitConfirmation(conn, sig, bh);
      set((s) => ({ tx: { stage: "done", signature: sig }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "confirmed", signature: sig } : a)) }));
      await get().refreshPools();
      void get().syncUntilCaughtUp();
    } catch (e) {
      const msg = (e as Error).message;
      if (e instanceof ConfirmError && !e.expired && !/failed on-chain/.test(msg)) {
        // Sent, not yet seen: the chain decides, not a timer. Keep the record
        // pending with its signature and let `sync` pick the note up.
        set((s) => ({ tx: { stage: "confirming", message: msg, signature: e.signature }, activity: s.activity.map((a) => (a.id === id ? { ...a, signature: e.signature } : a)) }));
        setTimeout(() => { void get().refreshPools().then(() => get().sync()); }, 15_000);
        throw e;
      }
      set((s) => ({ tx: { stage: "failed", message: msg }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "failed", error: msg } : a)) }));
      throw e;
    }
  },

  async send(asset, amount, to, memo) {
    await relayedTransact(get, set, asset, amount, "send", { to, memo });
  },

  async unshield(asset, amount, recipient) {
    await relayedTransact(get, set, asset, amount, "unshield", { recipient });
  },

  async relayExit(asset, amount, o) {
    return relayedTransact(get, set, asset, amount, "unshield", { recipient: o.recipient, pool: o.pool, fee: o.fee, exit: o.exit, activityKind: o.kind, label: o.label });
  },
  };
});

/**
 * Relayer 422 whose simulation failed with UnknownRoot or InvalidProof. The
 * relayer names the error in `vaultError` (SDK `RelayRejection`); if it is an
 * older relayer without that field, classify its raw `details` with the same
 * SDK table rather than a regex.
 */
/** Turn a raw web3.js preflight dump into one line a person can act on. */
function friendlyRelayError(raw?: string): string {
  if (!raw) return "the relayer could not land the transaction";
  const m = /custom program error: (0x[0-9a-f]+)/i.exec(raw);
  if (m) {
    const name = vaultErrorName({ InstructionError: [0, { Custom: Number(m[1]) }] });
    if (name === "NullifierSpent") return "these notes were already spent on-chain; your balance will update after a rescan";
    if (name) return `the vault refused the transaction: ${name}`;
    return `the vault refused the transaction (${m[1]})`;
  }
  if (/expired before inclusion|Blockhash not found/i.test(raw)) return "the network did not include the transaction in time; nothing was spent, try again";
  return raw.length > 200 ? raw.slice(0, 200) + "…" : raw;
}

export function isStaleRootError(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 422) return false;
  if (isStaleRootRejection(e.body)) return true;
  const name = vaultErrorName((e.body as { details?: unknown } | undefined)?.details);
  return !!name && STALE_ROOT_ERRORS.includes(name);
}

async function relayedTransact(
  get: () => State,
  set: (p: Partial<State> | ((s: State) => Partial<State>)) => void,
  asset: AssetMeta,
  amount: bigint,
  kind: "send" | "unshield",
  o: {
    to?: string; memo?: string; recipient?: PublicKey;
    pool?: PoolState; fee?: bigint; exit?: { target: PublicKey; data: Uint8Array; accounts: import("@solana/web3.js").AccountMeta[] };
    activityKind?: ActivityItem["kind"]; label?: string;
  }
): Promise<string | undefined> {
  const { wallet, tree, pools, relayer: rl, assetQuotes } = get();
  if (!wallet || !tree) throw new Error("wallet locked");
  if (!rl) throw new Error("relayer unavailable");
  const pool = o.pool ?? pools[asset.symbol];
  if (!pool) throw new Error("pool not found on chain");
  const native = asset.mint.equals(SystemProgram.programId);
  const tokenProgram = asset.tokenProgram ?? TOKEN_PROGRAM_ID;
  const relayerKey = new PublicKey(rl.relayer);
  let relayerDest = relayerKey;
  let fee = o.fee;
  if (fee === undefined) {
    const mintKey = asset.mint.toBase58();
    const feePolicy = rl.fees.find((f) => f.mint === mintKey);
    const quote = assetQuotes[mintKey];
    if (feePolicy) {
      const pct = (amount * BigInt(feePolicy.bps)) / 10_000n;
      fee = pct > BigInt(feePolicy.min) ? pct : BigInt(feePolicy.min);
      if (!native) relayerDest = ataFor(relayerKey, asset.mint, tokenProgram);
    } else if (quote?.supported && quote.fee) {
      const pct = (amount * BigInt(quote.fee.bps)) / 10_000n;
      fee = pct > BigInt(quote.fee.min) ? pct : BigInt(quote.fee.min);
      relayerDest = new PublicKey(quote.fee.dest);
    } else {
      throw new Error(quote?.reason ?? "relayer does not support this asset");
    }
  } else if (!native) {
    relayerDest = ataFor(relayerKey, asset.mint, tokenProgram);
  }
  // An SPL withdrawal lands in a token account, not a wallet: use the
  // recipient's associated account, which must already exist (the relayer
  // does not fund rent for strangers).
  let recipient = o.recipient;
  if (recipient && !native && !o.exit) {
    const ata = ataFor(recipient, asset.mint, tokenProgram);
    if (!(await get().connection.getAccountInfo(ata))) throw new Error(`${recipient.toBase58().slice(0, 4)}… has no ${asset.symbol} token account yet; send it any ${asset.symbol} once first (or pick a wallet that holds some)`);
    recipient = ata;
  }
  const id = crypto.randomUUID();
  const act: ActivityItem = { id, kind: o.activityKind ?? kind, asset: o.label ?? asset.symbol, amount, at: Date.now(), status: "pending" };
  set((s) => ({ activity: [act, ...s.activity], tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } }));
  let consumed: bigint[] = [];
  let accepted = false;
  try {
    const build = async () => {
      const [artifacts, chainTree] = await Promise.all([artifactsForProof(reportArtifacts(set)), loadChainTree(get().connection)]);
      set({ tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } });
      const t0 = performance.now();
      const built = await wallet.buildTransact({
        asset: assetId(asset.mint), mint: asset.mint, tokenProgram: asset.tokenProgram, pool, tree, chainTree, artifacts,
        kind, amount,
        to: o.to ? decodeAddress(wallet.bjj, o.to).address : undefined,
        recipient,
        relayer: relayerKey, relayerDest, relayerFee: fee, payer: relayerKey,
        memo: o.memo ? new TextEncoder().encode(o.memo) : undefined,
        exitTarget: o.exit?.target, exitData: o.exit?.data, exitAccounts: o.exit?.accounts,
      });
      consumed = built.consumed;
      set({ lastProveMs: performance.now() - t0, tx: { stage: "relaying", message: "Handing the proof to the relayer" } });
      return relayer.relay(
        Buffer.from(built.instruction.data).toString("base64"),
        built.instruction.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable }))
      );
    };
    let job: Awaited<ReturnType<typeof build>>;
    try {
      job = await build();
    } catch (e) {
      // The proof names a root by ring index. Under load, or after a long
      // proving time, that slot can be overwritten before the relayer
      // simulates (SPEC §5): the program reports UnknownRoot (5) or, when the
      // slot now holds a different root, InvalidProof (7). Both mean "the tree
      // moved": re-sync, re-prove once against the current root, and only
      // then give up. Any other error is final.
      if (!isStaleRootError(e)) throw e;
      wallet.release(consumed);
      consumed = [];
      set({ tx: { stage: "proving", message: "The tree moved while proving; syncing and proving again" } });
      await get().sync();
      job = await build();
    }
    // From here on the relayer holds our proof. The notes it spends stay
    // reserved until the chain says otherwise: a network error while polling
    // is not a failed payment, and releasing the notes here would let the
    // user build a second proof for the same nullifiers (the relayer would
    // answer with the same job — see /relay idempotency — but we should never
    // get there).
    accepted = true;
    const wait = Math.max(0, job.releaseAt - Date.now());
    set({ tx: { stage: "confirming", message: `Queued. Relayer releases in ~${Math.ceil(wait / 1000)}s for timing privacy` } });
    let pollErrors = 0;
    let signature: string | undefined;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2500));
      let st: Awaited<ReturnType<typeof relayer.job>>;
      try {
        st = await relayer.job(job.id);
        pollErrors = 0;
      } catch (e) {
        // Keep polling through transient failures; after ~2 minutes of
        // silence fall back to the chain itself.
        if (++pollErrors < 48) continue;
        throw new Error(`lost contact with the relayer: ${(e as Error).message}`);
      }
      if (st.status === "confirmed") {
        signature = st.signature;
        set((s) => ({ tx: { stage: "done", signature: st.signature }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "confirmed", signature: st.signature } : a)) }));
        break;
      }
      if (st.status === "failed") {
        // The relayer's verdict is advisory; the chain's is final. If it sent
        // the transaction and then lost track of it (a dropped WebSocket, a
        // retry refused because the nullifier was already spent by the first
        // send), the signature it reports may well be confirmed.
        if (st.signature) {
          const landed = await awaitConfirmation(get().connection, st.signature, { maxMs: 20_000 }).then(() => true).catch(() => false);
          if (landed) {
            signature = st.signature;
            set((s) => ({ tx: { stage: "done", signature: st.signature }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "confirmed", signature: st.signature } : a)) }));
            break;
          }
        }
        throw new Error(friendlyRelayError(st.error));
      }
    }
    await get().refreshPools();
    await get().sync();
    // the change note (or a sell's proceeds, once claimed) shows up when the indexer has the leaf
    void get().syncUntilCaughtUp();
    return signature;
  } catch (e) {
    if (accepted) {
      // The relayer may have landed it anyway. Ask the chain: `sync` pulls the
      // nullifier set and marks spent notes; whatever is still unspent after
      // that is genuinely ours again.
      await get().sync().catch(() => undefined);
      wallet.release(consumed.filter((nf) => !wallet.isSpent(nf)));
    } else {
      wallet.release(consumed);
    }
    const msg = (e as Error).message;
    set((s) => ({ tx: { stage: "failed", message: msg }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "failed", error: msg } : a)) }));
    throw e;
  }
}
