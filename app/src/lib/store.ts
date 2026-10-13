"use client";
// Client-side shielded wallet state. Nothing here ever leaves the browser
// except proofs, ciphertexts and the instruction handed to the relayer.
import { create } from "zustand";
import { Connection, PublicKey, SystemProgram, type VersionedTransaction } from "@solana/web3.js";
import {
  ShieldedWallet, MerkleTree, assetId, seedFromSignature, encodeAddress, decodeAddress, decodePool, poolPda, treePda, decodeTree,
  buildV0, fetchLookupTable, type PoolState, type SpendableNote, SPENDING_KEY_MESSAGE, seedToBackup, seedFromBackup,
  isStaleRootRejection, vaultErrorName, STALE_ROOT_ERRORS,
} from "@scash/sdk";
import { ApiError, indexer, relayer, type RelayerInfo } from "./api";
import { ARTIFACTS, ASSETS, CLUSTER, PROGRAM_ID, RPC_URL, type AssetMeta } from "./config";

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
  refreshPools: () => Promise<void>;
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

const bjjAddress = (w: ShieldedWallet) => encodeAddress(w.bjj, w.address(), CLUSTER === "mainnet-beta" ? "scash" : "tscash");

async function loadChainTree(conn: Connection) {
  const info = await conn.getAccountInfo(treePda(PROGRAM_ID));
  if (!info) throw new Error("protocol not initialized on this cluster");
  return decodeTree(new Uint8Array(info.data));
}

function b64ToBytes(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export const useScash = create<State>((set, get) => {
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
    set({ phase: "idle", wallet: undefined, tree: undefined, address: undefined, notes: [], balances: {}, tokenBalances: {}, syncedTo: 0, activity: [] });
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

  async refreshPools() {
    const { connection } = get();
    const pools: Record<string, PoolState> = {};
    const infos = await connection.getMultipleAccountsInfo(ASSETS.map((a) => poolPda(a.mint, PROGRAM_ID)));
    infos.forEach((info, i) => {
      if (info) pools[ASSETS[i].symbol] = decodePool(new Uint8Array(info.data));
    });
    // Mint layout (SPL Token and Token-2022 share it): freeze_authority is a
    // COption<Pubkey> at offset 46 — 4-byte tag, then 32 bytes. The program
    // deliberately does not refuse such mints (USDC has one); the UI shows it.
    const freezeAuthority: Record<string, string> = {};
    const spl = ASSETS.filter((a) => !a.mint.equals(SystemProgram.programId));
    if (spl.length) {
      const mints = await connection.getMultipleAccountsInfo(spl.map((a) => a.mint));
      mints.forEach((m, i) => {
        if (m && m.data.length >= 82 && m.data.readUInt32LE(46) === 1) {
          freezeAuthority[spl[i].symbol] = new PublicKey(m.data.subarray(50, 82)).toBase58();
        }
      });
    }
    set({ pools, freezeAuthority });
  },

  async sync() {
    const { wallet, tree } = get();
    if (!wallet || !tree) return;
    let from = get().syncedTo;
    const launched = Object.values(get().launchAssets);
    const assetIds = [...ASSETS, ...launched].map((a) => ({ a, id: assetId(a.mint) }));
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
    for (const a of ASSETS) balances[a.symbol] = wallet.balance(assetId(a.mint));
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
    const pool = pools[asset.symbol];
    if (!pool) throw new Error("pool not found on chain");
    const id = crypto.randomUUID();
    const act: ActivityItem = { id, kind: "shield", asset: asset.symbol, amount, at: Date.now(), status: "pending" };
    set((s) => ({ activity: [act, ...s.activity], tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } }));
    try {
      const relayerKey = rl ? new PublicKey(rl.relayer) : owner;
      const t0 = performance.now();
      const built = await wallet.buildTransact({
        asset: assetId(asset.mint), mint: asset.mint, tokenProgram: asset.tokenProgram, pool, tree, chainTree: await loadChainTree(get().connection), artifacts: ARTIFACTS,
        kind: "shield", amount, to: to ? decodeAddress(wallet.bjj, to).address : undefined,
        relayer: relayerKey, relayerDest: relayerKey, relayerFee: 0n, payer: owner, depositor: owner,
        depositorSource: asset.mint.equals(SystemProgram.programId) ? owner : undefined,
      });
      set({ lastProveMs: performance.now() - t0, tx: { stage: "signing", message: "Approve the transaction in your wallet" } });
      const conn = get().connection;
      const table = rl?.lookupTable ? await fetchLookupTable(conn, new PublicKey(rl.lookupTable)) : undefined;
      const tx = buildV0(owner, [built.instruction], (await conn.getLatestBlockhash()).blockhash, table);
      const sig = await sendTx(tx);
      set({ tx: { stage: "confirming", message: "Waiting for confirmation", signature: sig } });
      await get().connection.confirmTransaction(sig, "confirmed");
      set((s) => ({ tx: { stage: "done", signature: sig }, activity: s.activity.map((a) => (a.id === id ? { ...a, status: "confirmed", signature: sig } : a)) }));
      await get().refreshPools();
      await get().sync();
    } catch (e) {
      const msg = (e as Error).message;
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
  const { wallet, tree, pools, relayer: rl } = get();
  if (!wallet || !tree) throw new Error("wallet locked");
  if (!rl) throw new Error("relayer unavailable");
  const pool = o.pool ?? pools[asset.symbol];
  if (!pool) throw new Error("pool not found on chain");
  let fee = o.fee;
  if (fee === undefined) {
    const feePolicy = rl.fees.find((f) => f.mint === asset.mint.toBase58());
    if (!feePolicy) throw new Error("relayer does not support this asset");
    const pct = (amount * BigInt(feePolicy.bps)) / 10_000n;
    fee = pct > BigInt(feePolicy.min) ? pct : BigInt(feePolicy.min);
  }
  const relayerKey = new PublicKey(rl.relayer);
  const id = crypto.randomUUID();
  const act: ActivityItem = { id, kind: o.activityKind ?? kind, asset: o.label ?? asset.symbol, amount, at: Date.now(), status: "pending" };
  set((s) => ({ activity: [act, ...s.activity], tx: { stage: "proving", message: "Generating zero-knowledge proof in your browser" } }));
  let consumed: bigint[] = [];
  let accepted = false;
  try {
    const build = async () => {
      const t0 = performance.now();
      const built = await wallet.buildTransact({
        asset: assetId(asset.mint), mint: asset.mint, tokenProgram: asset.tokenProgram, pool, tree, chainTree: await loadChainTree(get().connection), artifacts: ARTIFACTS,
        kind, amount,
        to: o.to ? decodeAddress(wallet.bjj, o.to).address : undefined,
        recipient: o.recipient,
        relayer: relayerKey, relayerDest: relayerKey, relayerFee: fee, payer: relayerKey,
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
      if (st.status === "failed") throw new Error(st.error ?? "relayer failed");
    }
    await get().refreshPools();
    await get().sync();
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
