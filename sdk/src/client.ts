// One object that connects to a deployed BUNKER: chain, indexer, relayers,
// agents and proving artifacts. Amounts cross this API in wei / token base
// units; the pool's internal units and shares stay inside.
//
//   const bunker = await BunkerClient.connect({ seed });
//   await bunker.sync();
//   await bunker.shield(NATIVE_TOKEN, parseEther("0.01"), { signer });
//   await bunker.send(NATIVE_TOKEN, parseEther("0.005"), "bunker1…");
//   await bunker.unshield(NATIVE_TOKEN, parseEther("0.004"), "0xRecipient");
//   await bunker.launchpad.buy(token, parseEther("0.1"));       // one private tx, tokens land as a note
//   await bunker.swap("BNB", parseEther("0.1"), usdt);          // private PancakeSwap swap
import { createPublicClient, createWalletClient, defineChain, getAddress, http, parseEventLogs, type Account, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc as bscChain, bscTestnet, hardhat, type Chain } from "viem/chains";
import { AgentsApi, ApiError, IndexerApi, RelayerApi, type LaunchRow, type RelayJob, type RelayerInfo } from "./api.js";
import { STALE_ROOT_ERRORS } from "./errors.js";
import type { EvmAddress } from "./extdata.js";
import { addressAtIndex, addressFromBytes, addressToBytes, decodeAddress, decodeViewingKey, encodeAddress, encodeViewingKey, seedFromBackup, seedFromSignature, seedToBackup, SPENDING_KEY_MESSAGE, type Address } from "./keys.js";
import {
  EXIT_BUY, EXIT_SELL, exitData, launchCall, quotePrivateBuy, quotePrivateSell, readCurve, readParams, rolled, swapExitData, worstFeeBps,
  LaunchpadAbi, type CurveState, type LaunchpadParams,
} from "./launch.js";
import { IERC20MetadataAbi, IPancakeRouter02Abi, ShieldedPoolAbi, SwapExitAbi } from "./abi/index.js";
import { MerkleTree } from "./merkle.js";
import { NATIVE_TOKEN, assetId } from "./note.js";
import {
  amountForBurn, amountForMint, drainCall, readInsertedIndex, readLastRoot, readNextIndex, readPool, readRegistry, registerCall,
  sharesForDeposit, sharesForWithdraw, toUnits, transactCallToJson, PROTOCOL_VERSION, type PoolState, type TransactCall,
} from "./pool.js";
import type { CircuitArtifacts, CircuitName } from "./prover.js";
import { ShieldedWallet, type BuiltTransact, type LedgerEntry, type TransactKind } from "./wallet.js";
import { bsc, type NetworkConfig, type NetworkName, networks } from "./networks.js";

export type Token = EvmAddress | "BNB";

/** Anything that can sign a public transaction: a viem account, a raw private key, or a wallet client (browser wallet). */
export type Signer = Account | Hex | WalletClient;

export interface ConnectOptions {
  /** `"bsc"` (default) or a full config; individual fields can be overridden with `overrides` */
  network?: NetworkName | NetworkConfig;
  overrides?: Partial<NetworkConfig>;
  /** The 32-byte spending seed. Derive it with `BunkerClient.seedFromSignature` or restore it with `BunkerClient.seedFromBackup`. */
  seed?: Uint8Array;
  /** A `bunkerview1…` full viewing key instead of a seed: a watch-only client that sees everything and spends nothing. */
  viewingKey?: string;
  /** Proving artifacts, if the caller wants to supply them (bytes or URLs). Default: fetched from `network.artifactsUrl` and cached in memory. */
  artifacts?: Partial<Record<CircuitName, CircuitArtifacts>>;
  /** Progress callback while artifacts download. */
  onArtifactProgress?: (p: { circuit: CircuitName; loaded: number; total: number }) => void;
  /** Supply artifacts on demand instead (an app that prefetches and caches them itself). */
  artifactLoader?: (circuit: CircuitName) => Promise<CircuitArtifacts>;
}

export type TxStage = "proving" | "relaying" | "confirming" | "draining" | "done";
export interface TxEvent { stage: TxStage; message?: string; txHash?: string; releaseAt?: number }

export interface RelayOptions {
  /** Relayer fee in the pool's units; defaults to the relayer's published policy for the token. */
  fee?: bigint;
  /** UTF-8 memo encrypted to the recipient (private sends only). */
  memo?: string;
  onEvent?: (e: TxEvent) => void;
}

export interface Balance { token: EvmAddress; shares: bigint; amount: bigint; decimals: number; notes: number; /** wei of notes still queued for the next drain */ queued: bigint }

export interface TradeResult { txHash: Hex }

export const DEFAULT_SLIPPAGE_BPS = 100n;

export class BunkerClient {
  readonly network: NetworkConfig;
  readonly chain: Chain;
  readonly publicClient: PublicClient;
  readonly indexer: IndexerApi;
  readonly agents: AgentsApi;
  readonly wallet: ShieldedWallet;
  /** the tree of *inserted* leaves: what proofs are made against */
  readonly tree: MerkleTree;
  readonly launchpad: Launchpad;
  /** every leaf the indexer has shown us, inserted or queued */
  readonly leaves: bigint[] = [];

  private readonly seed?: Uint8Array;
  private syncedTo = 0;
  private syncing: Promise<void> | null = null;
  private pools = new Map<string, PoolState>();
  /** asset id (decimal string) -> token address, for every token that has a commitment */
  private seenTokens = new Map<string, EvmAddress>();
  private relayers: { api: RelayerApi; info?: RelayerInfo; failedAt?: number }[];
  private chosen?: { api: RelayerApi; info: RelayerInfo; at: number };
  private readonly artifacts: Partial<Record<CircuitName, CircuitArtifacts>>;
  private readonly artifactLoads: Partial<Record<CircuitName, Promise<CircuitArtifacts>>> = {};
  private readonly onArtifactProgress?: ConnectOptions["onArtifactProgress"];
  private readonly artifactLoader?: ConnectOptions["artifactLoader"];

  private constructor(network: NetworkConfig, seed: Uint8Array | undefined, wallet: ShieldedWallet, tree: MerkleTree, o: ConnectOptions) {
    this.network = network;
    this.chain = chainFor(network);
    this.publicClient = createPublicClient({ chain: this.chain, transport: http(network.rpcUrl, { batch: true }) });
    this.indexer = new IndexerApi(network.indexerUrl);
    const urls = Array.from(new Set([...(network.relayerUrls ?? []), network.relayerUrl].filter(Boolean)));
    this.relayers = urls.map((u) => ({ api: new RelayerApi(u) }));
    this.agents = new AgentsApi(network.agentsUrl);
    this.wallet = wallet;
    this.tree = tree;
    this.seed = seed;
    this.artifacts = { ...(o.artifacts ?? {}) };
    this.onArtifactProgress = o.onArtifactProgress;
    this.artifactLoader = o.artifactLoader;
    this.launchpad = new Launchpad(this);
  }

  // ---- construction & keys

  static async connect(o: ConnectOptions): Promise<BunkerClient> {
    const base = typeof o.network === "string" ? networks[o.network] : (o.network ?? bsc);
    const network = { ...base, ...(o.overrides ?? {}) };
    if (network.protocolVersion !== PROTOCOL_VERSION) throw new Error(`this SDK speaks protocol v${PROTOCOL_VERSION}; the network config is v${network.protocolVersion}`);
    let wallet: ShieldedWallet;
    if (o.seed) {
      if (o.seed.length !== 32) throw new Error("seed must be 32 bytes");
      wallet = await ShieldedWallet.fromSeed(o.seed);
    } else if (o.viewingKey) {
      wallet = await ShieldedWallet.fromViewingKey(await decodeViewingKey(o.viewingKey));
    } else throw new Error("a seed or a viewing key is required");
    const tree = new MerkleTree(26);
    await tree.whenReady();
    return new BunkerClient(network, o.seed, wallet, tree, o);
  }

  /** The message a user signs once with their EOA to derive the spending seed (same text the web app uses). */
  static readonly SPENDING_KEY_MESSAGE = SPENDING_KEY_MESSAGE;
  /** Seed from an EIP-191 signature of `SPENDING_KEY_MESSAGE` plus the user's passphrase. */
  static seedFromSignature(signature: Hex | Uint8Array, passphrase = "", opts?: { allowEmpty?: boolean }) {
    const bytes = typeof signature === "string" ? hexToBytes(signature) : signature;
    return seedFromSignature(bytes, passphrase, opts);
  }
  static seedToBackup = seedToBackup;
  static seedFromBackup = seedFromBackup;
  /** A fresh random seed (keep the backup string: it is the only way to see or spend these notes). */
  static randomSeed(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }

  private get hrp(): "bunker" | "tbunker" { return this.network.chainId === 56 ? "bunker" : "tbunker"; }
  /** This wallet's stable shielded address (`bunker1…`, diversifier 0). Hand it out to receive private payments. */
  address(): string { return encodeAddress(this.wallet.bjj, this.primaryAddress(), this.hrp); }
  /** A fresh diversified address of the same wallet: unlinkable to the others, pays into the same balance. */
  freshAddress(): string { return encodeAddress(this.wallet.bjj, this.wallet.address(), this.hrp); }
  private primaryAddress(): Address { return addressAtIndex(this.wallet.bjj, this.wallet.fvk.ivk, 0); }
  backup(): string { if (!this.seed) throw new Error("watch-only client has no seed"); return seedToBackup(this.seed); }
  /** The full viewing key (`bunkerview1…`): lets an auditor or a watch-only device see every note and spend, and sign nothing. */
  viewingKey(): string { return encodeViewingKey(this.wallet.fvk); }
  get watchOnly(): boolean { return this.wallet.watchOnly; }

  // ---- state

  /**
   * Pull every new leaf from the indexer, decrypt ours, rebuild the tree of
   * inserted leaves, drop spent notes. Safe to call repeatedly; concurrent calls share one pass.
   */
  sync(): Promise<void> {
    if (!this.syncing) this.syncing = this.syncPass().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async syncPass() {
    const ids = new Map<string, bigint>();
    const idFor = (t: string) => {
      const k = t.toLowerCase();
      let id = ids.get(k);
      if (id === undefined) { id = assetId(k); ids.set(k, id); this.seenTokens.set(id.toString(), getAddress(k)); }
      return id;
    };
    let from = this.syncedTo;
    for (;;) {
      const page = await this.indexer.commitments(from, 1000);
      for (const row of page.items) {
        const cm = BigInt("0x" + row.commitment);
        if (row.index !== this.leaves.length) {
          if (row.index < this.leaves.length) continue;
          throw new Error(`indexer skipped leaf ${this.leaves.length}`);
        }
        this.leaves.push(cm);
        if (row.blockTime != null) this.noteBlockTime(row.block, row.blockTime);
        const ct = b64ToBytes(row.ciphertext);
        const where = { block: row.block, blockTime: row.blockTime ?? null };
        if (row.kind === "open" && row.shares != null && row.ownerHash != null) {
          await this.wallet.scanOpenNote({ index: row.index, commitment: cm, shares: BigInt(row.shares), ownerHash: BigInt("0x" + row.ownerHash.replace(/^0x/, "")), ciphertext: ct, ...where }, idFor(row.token));
        } else if (ct.length) {
          await this.wallet.scan({ index: row.index, commitment: cm, ciphertext: ct, ...where }, idFor(row.token));
        }
      }
      from = page.next;
      this.syncedTo = from;
      if (page.items.length < 1000) break;
    }
    const nfs = await this.indexer.nullifiers(0);
    this.wallet.markSpent(nfs.map((n) => ({ nullifier: BigInt("0x" + n.nullifier), block: n.block, blockTime: this.timeForBlock(n.block) })));
    const [inserted, chainRoot] = await Promise.all([readInsertedIndex(this.publicClient, this.network.pool), readLastRoot(this.publicClient, this.network.pool)]);
    const upTo = Math.min(inserted, this.leaves.length);
    for (let i = this.tree.size; i < upTo; i++) await this.tree.insert(this.leaves[i]);
    this.wallet.markInserted(this.tree.size);
    if (this.tree.size === inserted && chainRoot !== (await this.tree.root())) throw new Error("local tree root does not match the chain; the indexer may be lagging or corrupt");
  }

  // block -> unix time anchors learned from commitment rows (sorted, deduplicated per block)
  private blockAnchors: { block: number; time: number }[] = [];
  private noteBlockTime(block: number, time: number) {
    const last = this.blockAnchors[this.blockAnchors.length - 1];
    if (!last || block > last.block) this.blockAnchors.push({ block, time });
  }
  /** Time of a block from the nearest known anchor; BSC blocks are ~0.75 s apart, so the estimate is tight. */
  timeForBlock(block: number): number | null {
    const a = this.blockAnchors;
    if (a.length === 0) return null;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (a[mid].block <= block) lo = mid; else hi = mid - 1; }
    const near = a[lo].block <= block ? a[lo] : a[0];
    if (near.block === block) return near.time;
    const next = a[lo + 1];
    if (next && near.block < block && block < next.block) {
      return Math.round(near.time + ((block - near.block) * (next.time - near.time)) / (next.block - near.block));
    }
    return Math.round(near.time + (block - near.block) * 0.75);
  }

  /** Every note this vault has ever owned (received and spent), oldest first; the raw material for a balance history. */
  history(token?: Token): LedgerEntry[] {
    return this.wallet.history(token === undefined ? undefined : assetId(norm(token).toLowerCase()));
  }

  /** Keep syncing until the local view has every leaf the chain has (the indexer trails the chain by a few seconds). */
  async syncUntilCaughtUp(timeoutMs = 60_000): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      await this.sync();
      const next = await readNextIndex(this.publicClient, this.network.pool);
      if (this.leaves.length >= next || Date.now() - t0 > timeoutMs) return;
      await sleep(2000);
    }
  }

  /** Leaves the chain has queued but not yet hashed into the tree. */
  async pendingCount(): Promise<number> {
    const [next, inserted] = await Promise.all([readNextIndex(this.publicClient, this.network.pool), readInsertedIndex(this.publicClient, this.network.pool)]);
    return next - inserted;
  }

  /** The `drain(max)` call: anyone may send it to fold queued leaves into the tree. */
  drainCall(max?: number) { return drainCall(this.network.pool, max); }

  /**
   * Make sure every leaf below `index` (default: all of them) is in the tree, so
   * notes there are spendable. Asks the relayer to drain; with a `signer`, drains
   * directly when no relayer does it within `waitMs`.
   */
  async ensureInserted(index?: number, o: { signer?: Signer; waitMs?: number; onEvent?: (e: TxEvent) => void } = {}): Promise<void> {
    const target = index ?? (await readNextIndex(this.publicClient, this.network.pool));
    const t0 = Date.now();
    let asked = false;
    for (;;) {
      const inserted = await readInsertedIndex(this.publicClient, this.network.pool);
      if (inserted >= target) { await this.sync(); return; }
      if (!asked) {
        asked = true;
        o.onEvent?.({ stage: "draining", message: "folding queued notes into the tree" });
        const r = await this.relayerApi().catch(() => undefined);
        await r?.drain().catch(() => undefined);
      }
      if (o.signer && Date.now() - t0 > (o.waitMs ?? 20_000)) {
        const h = await this.write(o.signer, this.drainCall());
        await this.waitOk(h);
        continue;
      }
      if (Date.now() - t0 > 180_000) throw new Error("the queue is not being drained; call drain() yourself");
      await sleep(2000);
    }
  }

  /** Pool state for a token, cached; `refresh` re-reads the chain. */
  async pool(token: Token, refresh = false): Promise<PoolState> {
    const t = norm(token);
    const have = this.pools.get(t.toLowerCase());
    if (have && !refresh) return have;
    const p = await readPool(this.publicClient, this.network.pool, t);
    if (!p.exists) throw new Error(`no shielded pool for ${t}`);
    this.pools.set(t.toLowerCase(), p);
    return p;
  }

  /** Shielded balance of a token in wei / base units (after `sync`). */
  async balance(token: Token = "BNB"): Promise<Balance> {
    const t = norm(token);
    const pool = await this.pool(t, true);
    const id = assetId(t.toLowerCase());
    const shares = this.wallet.balance(id);
    const queued = this.wallet.queuedBalance(id);
    return { token: t, shares, amount: amountForBurn(pool, shares) * pool.unit, decimals: pool.decimals, notes: this.wallet.spendable(id).length, queued: amountForBurn(pool, queued) * pool.unit };
  }

  /** Balances for every token this wallet holds notes of. */
  async balances(): Promise<Balance[]> {
    const held = new Set<string>();
    for (const n of this.wallet.notes.values()) held.add(n.asset.toString());
    const out: Balance[] = [];
    for (const [id, t] of this.seenTokens) if (held.has(id)) out.push(await this.balance(t));
    return out;
  }

  // ---- relayers

  /**
   * The relayer in use: the cheapest healthy one of `network.relayerUrls` (by
   * its BNB fee), re-evaluated every minute or on `refresh`.
   */
  async relayerInfoCached(refresh = false): Promise<RelayerInfo> {
    return (await this.pickRelayer(refresh)).info;
  }
  /** @internal */
  async relayerApi(): Promise<RelayerApi> { return (await this.pickRelayer(false)).api; }
  get relayer(): RelayerApi { return this.chosen?.api ?? this.relayers[0].api; }

  private async pickRelayer(refresh: boolean): Promise<{ api: RelayerApi; info: RelayerInfo }> {
    if (this.chosen && !refresh && Date.now() - this.chosen.at < 60_000) return this.chosen;
    const now = Date.now();
    const results = await Promise.all(this.relayers.map(async (r) => {
      if (r.failedAt && now - r.failedAt < 120_000 && this.relayers.length > 1) return r;
      try { r.info = await r.api.info(); r.failedAt = undefined; } catch { r.failedAt = now; r.info = undefined; }
      return r;
    }));
    const live = results.filter((r) => r.info && !r.failedAt && r.info.pool.toLowerCase() === this.network.pool.toLowerCase() && r.info.shieldedAddress);
    if (!live.length) throw new Error("no relayer is reachable for this pool");
    const cost = (i: RelayerInfo) => { const f = i.fees.find((x) => x.token.toLowerCase() === NATIVE_TOKEN); return f ? BigInt(f.bps) * 1_000_000n + BigInt(f.min) : (1n << 64n); };
    live.sort((a, b) => (cost(a.info!) < cost(b.info!) ? -1 : cost(a.info!) > cost(b.info!) ? 1 : a.info!.queued - b.info!.queued));
    this.chosen = { api: live[0].api, info: live[0].info!, at: now };
    return this.chosen;
  }

  /** The relayer fee (in wei / base units of `token`) for a relayed transact of `amount`, per the relayer's published policy. */
  async relayerFee(token: Token, amount: bigint): Promise<bigint> {
    const t = norm(token);
    const pool = await this.pool(t);
    const units = toUnits(amount, pool.unit);
    return (await this.feeUnits(t, units)) * pool.unit;
  }

  /** @internal relayer fee in pool units */
  async feeUnits(token: EvmAddress, units: bigint): Promise<bigint> {
    const { api, info } = await this.pickRelayer(false);
    let policy = info.fees.find((f) => f.token.toLowerCase() === token.toLowerCase());
    if (!policy) {
      const q = await api.asset(token);
      if (!q.supported || !q.fee) throw new Error(q.reason ?? "relayer does not support this asset");
      policy = { token, min: q.fee.min, bps: q.fee.bps };
    }
    const pct = (units * BigInt(policy.bps)) / 10_000n;
    return pct > BigInt(policy.min) ? pct : BigInt(policy.min);
  }

  // ---- registry

  /** Publish this wallet's shielded address under the signer's EOA, so anyone can pay the EOA privately. */
  async register(signer: Signer): Promise<Hex> {
    const h = await this.write(signer, registerCall(this.network.pool, addressToBytes(this.wallet.bjj, this.primaryAddress())));
    await this.waitOk(h);
    return h;
  }
  /** Remove the signer's registry entry. */
  async unregister(signer: Signer): Promise<Hex> {
    const h = await this.write(signer, registerCall(this.network.pool, new Uint8Array(0)));
    await this.waitOk(h);
    return h;
  }
  /** The shielded address an EOA registered on-chain, or null. Read from the chain, never trusted from the indexer. */
  async resolve(owner: EvmAddress): Promise<string | null> {
    const raw = await readRegistry(this.publicClient, this.network.pool, getAddress(owner));
    if (!raw) return null;
    return encodeAddress(this.wallet.bjj, addressFromBytes(this.wallet.bjj, raw), this.hrp);
  }
  /** Accepts a `bunker1…` address or a registered `0x…` EOA. */
  async toShieldedAddress(to: string): Promise<Address> {
    if (/^0x[0-9a-fA-F]{40}$/.test(to)) {
      const raw = await readRegistry(this.publicClient, this.network.pool, getAddress(to as EvmAddress));
      if (!raw) throw new Error(`${to} has not registered a shielded address`);
      return addressFromBytes(this.wallet.bjj, raw);
    }
    return decodeAddress(this.wallet.bjj, to).address;
  }

  // ---- proving

  async loadArtifacts(circuit: CircuitName): Promise<CircuitArtifacts> {
    const have = this.artifacts[circuit];
    if (have) return have;
    const running = this.artifactLoads[circuit];
    if (running) return running;
    if (this.artifactLoader) return this.artifactLoader(circuit);
    const base = this.network.artifactsUrl.replace(/\/$/, "");
    const p = (async () => {
      const [wasm, zkey] = await Promise.all([
        fetchBytes(`${base}/${circuit}.wasm`, () => undefined),
        fetchBytes(`${base}/${circuit}.zkey`, (loaded, total) => this.onArtifactProgress?.({ circuit, loaded, total })),
      ]);
      const a = { wasm, zkey };
      this.artifacts[circuit] = a;
      return a;
    })();
    this.artifactLoads[circuit] = p;
    return p;
  }

  private async allArtifacts(): Promise<Record<CircuitName, CircuitArtifacts>> {
    const [a, b] = await Promise.all([this.loadArtifacts("transact2x3"), this.loadArtifacts("transact4x3")]);
    return { transact2x3: a, transact4x3: b };
  }

  // ---- shield (public tx, paid by the depositor)

  /**
   * Build the `transact` call that deposits `amount` (wei / base units) into
   * your own shielded address (or `to`: a `bunker1…` address or a registered EOA).
   * ERC-20s must be approved to the pool first.
   */
  async buildShield(token: Token, amount: bigint, o: { to?: string } = {}): Promise<BuiltTransact> {
    const t = norm(token);
    const pool = await this.pool(t, true);
    const units = toUnits(amount, pool.unit);
    if (units <= 0n) throw new Error("amount too small for this pool's unit");
    await this.sync();
    return this.wallet.buildTransact({
      asset: assetId(t.toLowerCase()), poolAddress: this.network.pool, token: t, pool, tree: this.tree, artifacts: await this.allArtifacts(),
      kind: "shield", amount: units, to: o.to ? await this.toShieldedAddress(o.to) : undefined,
    });
  }

  /**
   * Shield from a public account: opens the token's pool if this is its first
   * shield, approves the ERC-20 if needed, proves, sends, waits for the
   * receipt, re-syncs. Returns the tx hash. `to` defaults to your own address.
   */
  async shield(token: Token, amount: bigint, o: { signer: Signer; to?: string; onEvent?: (e: TxEvent) => void }): Promise<Hex> {
    const t = norm(token);
    const wc = this.walletClientFor(o.signer);
    const sender = wc.account?.address;
    if (!sender) throw new Error("signer has no account");
    let pool = await readPool(this.publicClient, this.network.pool, t);
    if (!pool.exists) {
      if (t === NATIVE_TOKEN) throw new Error("BNB pool not found on chain");
      o.onEvent?.({ stage: "confirming", message: "opening the pool (one-time)" });
      await this.openPool(t, wc);
      pool = await this.pool(t, true);
    }
    if (t !== NATIVE_TOKEN) {
      const units = toUnits(amount, pool.unit);
      const need = amountForMint(pool, sharesForDeposit(pool, units)) * pool.unit;
      const allowance = await this.publicClient.readContract({ address: t, abi: IERC20MetadataAbi, functionName: "allowance", args: [sender, this.network.pool] });
      if (allowance < need) {
        o.onEvent?.({ stage: "confirming", message: "approving the token" });
        await this.waitOk(await this.write(wc, { address: t, abi: IERC20MetadataAbi, functionName: "approve", args: [this.network.pool, need] }));
      }
    }
    o.onEvent?.({ stage: "proving", message: "generating proof" });
    const built = await this.buildShield(t, amount, { to: o.to });
    try {
      o.onEvent?.({ stage: "confirming", message: "sending transaction" });
      const hash = await this.write(wc, built.call);
      await this.waitOk(hash);
      o.onEvent?.({ stage: "done", txHash: hash });
      await this.syncUntilCaughtUp().catch(() => undefined);
      return hash;
    } catch (e) {
      this.wallet.release(built.consumed);
      throw e;
    }
  }

  /** Open the shielded pool of an ERC-20 (permissionless, one-time per token). */
  async openPool(token: EvmAddress, signer: Signer): Promise<Hex | null> {
    const t = getAddress(token);
    if ((await readPool(this.publicClient, this.network.pool, t)).exists) return null;
    const decimals = await this.publicClient.readContract({ address: t, abi: IERC20MetadataAbi, functionName: "decimals" });
    const h = await this.write(signer, { address: this.network.pool, abi: ShieldedPoolAbi, functionName: "createPool", args: [t, Math.max(0, Number(decimals) - 9), (1n << 256n) - 1n] });
    await this.waitOk(h);
    this.pools.delete(t.toLowerCase());
    return h;
  }

  // ---- private send / unshield / exit (through a relayer, paid with a private fee note)

  /** Pay `amount` to another shielded address (or a registered EOA). Nothing public links sender and recipient. */
  send(token: Token, amount: bigint, to: string, o: RelayOptions = {}): Promise<Hex> {
    return this.relayed(norm(token), amount, "send", { ...o, to });
  }

  /** Withdraw `amount` to a public address. The relayer pays gas; its fee is a private note, so the recipient receives exactly `amount`. */
  unshield(token: Token, amount: bigint, recipient: EvmAddress, o: RelayOptions = {}): Promise<Hex> {
    return this.relayed(norm(token), amount, "unshield", { ...o, recipient: getAddress(recipient) });
  }

  /**
   * Withdraw without a relayer: `signer` submits the transaction and pays gas,
   * the fee output is empty, and `recipient` receives exactly `amount`. Works
   * for any asset, including ones no relayer will price. The signer's address
   * is public on the transaction, so use it for an account that may be linked
   * to the recipient anyway (typically the recipient itself).
   */
  async unshieldDirect(token: Token, amount: bigint, recipient: EvmAddress, o: { signer: Signer; onEvent?: (e: TxEvent) => void }): Promise<Hex> {
    const t = norm(token);
    const pool = await this.pool(t, true);
    const units = toUnits(amount, pool.unit);
    if (units <= 0n) throw new Error("amount too small for this pool's unit");
    await this.sync();
    const asset = assetId(t.toLowerCase());
    const need = sharesForWithdraw(pool, units);
    if (this.wallet.balance(asset) < need && this.wallet.balance(asset) + this.wallet.queuedBalance(asset) >= need) await this.ensureInserted(undefined, { signer: o.signer, onEvent: o.onEvent });
    let consumed: bigint[] = [];
    try {
      const build = async () => {
        o.onEvent?.({ stage: "proving", message: "generating proof" });
        const built = await this.wallet.buildTransact({
          asset, poolAddress: this.network.pool, token: t, pool, tree: this.tree, artifacts: await this.allArtifacts(),
          kind: "unshield", amount: units, recipient: getAddress(recipient), relayerFee: 0n,
        });
        consumed = built.consumed;
        return built;
      };
      let built: BuiltTransact;
      try { built = await build(); } catch (e) {
        if (!isStaleRoot(e)) throw e;
        this.wallet.release(consumed); consumed = [];
        await this.sync();
        built = await build();
      }
      o.onEvent?.({ stage: "confirming", message: "confirm the withdrawal in your wallet" });
      const hash = await this.write(o.signer, built.call);
      o.onEvent?.({ stage: "confirming", message: "waiting for the transaction", txHash: hash });
      await this.waitOk(hash);
      this.wallet.markSpent(built.consumedNullifiers);
      o.onEvent?.({ stage: "done", txHash: hash });
      await this.syncUntilCaughtUp().catch(() => undefined);
      return hash;
    } catch (e) {
      await this.sync().catch(() => undefined);
      this.wallet.release(consumed.filter((cm) => !this.wallet.isSpent(cm)));
      throw e;
    }
  }

  /**
   * Withdraw `amount` into a contract that implements `IBunkerExit`. With
   * `reshield`, whatever the hook sends back to the pool in that token becomes
   * a fresh note of yours in the same transaction (an atomic private call).
   */
  exit(token: Token, amount: bigint, target: EvmAddress, data: Uint8Array, o: RelayOptions & { reshield?: Token } = {}): Promise<Hex> {
    return this.relayed(norm(token), amount, "exit", { ...o, exit: { target: getAddress(target), data }, reshield: o.reshield ? norm(o.reshield) : undefined });
  }

  private async relayed(token: EvmAddress, amount: bigint, kind: Exclude<TransactKind, "shield">, o: RelayOptions & { to?: string; recipient?: EvmAddress; exit?: { target: EvmAddress; data: Uint8Array }; reshield?: EvmAddress }): Promise<Hex> {
    const { api, info } = await this.pickRelayer(true);
    if (o.exit && !info.launchpad && !info.swapExit) throw new Error("this relayer does not forward exits");
    if (o.reshield) await this.pool(o.reshield, true); // the proceeds need a pool to land in
    const pool = await this.pool(token, true);
    const units = toUnits(amount, pool.unit);
    if (units <= 0n) throw new Error("amount too small for this pool's unit");
    const fee = o.fee ?? (await this.feeUnits(token, units));
    const relayerAddress = decodeAddress(this.wallet.bjj, info.shieldedAddress!).address;
    const to = o.to ? await this.toShieldedAddress(o.to) : undefined;
    await this.sync();
    // if the spendable notes fall short but queued ones would cover it, get the queue drained first
    const asset = assetId(token.toLowerCase());
    const need = sharesForWithdraw(pool, units + fee);
    if (this.wallet.balance(asset) < need && this.wallet.balance(asset) + this.wallet.queuedBalance(asset) >= need) await this.ensureInserted(undefined, { onEvent: o.onEvent });
    let consumed: bigint[] = [];
    let accepted = false;
    try {
      const build = async () => {
        o.onEvent?.({ stage: "proving", message: "generating proof" });
        const built = await this.wallet.buildTransact({
          asset, poolAddress: this.network.pool, token, pool, tree: this.tree, artifacts: await this.allArtifacts(),
          kind, amount: units, to, recipient: o.recipient,
          relayerAddress, relayerFee: fee,
          memo: o.memo ? new TextEncoder().encode(o.memo) : undefined,
          exitTarget: o.exit?.target, exitData: o.exit?.data,
          reshield: o.reshield ? { token: o.reshield } : undefined,
        });
        consumed = built.consumed;
        o.onEvent?.({ stage: "relaying", message: "handing the proof to the relayer" });
        return api.relay(transactCallToJson(built.call));
      };
      let job: { id: string; releaseAt: number };
      try {
        job = await build();
      } catch (e) {
        // the root we proved against fell out of the 128-root ring: re-sync and prove once more
        if (!isStaleRoot(e)) throw e;
        this.wallet.release(consumed);
        consumed = [];
        await this.sync();
        job = await build();
      }
      accepted = true;
      o.onEvent?.({ stage: "confirming", message: "queued at the relayer", releaseAt: job.releaseAt });
      const txHash = await this.waitForJob(job.id, api);
      o.onEvent?.({ stage: "done", txHash });
      await this.syncUntilCaughtUp().catch(() => undefined);
      return txHash;
    } catch (e) {
      if (accepted) {
        await this.sync().catch(() => undefined);
        this.wallet.release(consumed.filter((cm) => !this.wallet.isSpent(cm)));
      } else this.wallet.release(consumed);
      throw e;
    }
  }

  /** Poll a relayer job until it confirms; resolves with the tx hash, rejects on failure. */
  async waitForJob(id: string, api?: RelayerApi, pollMs = 2500): Promise<Hex> {
    const r = api ?? (await this.relayerApi());
    let errors = 0;
    for (;;) {
      await sleep(pollMs);
      let st: RelayJob;
      try { st = await r.job(id); errors = 0; } catch (e) {
        if (++errors < 48) continue;
        throw new Error(`lost contact with the relayer: ${(e as Error).message}`);
      }
      if (st.status === "confirmed" && st.txHash) return st.txHash as Hex;
      if (st.status === "failed") {
        if (st.txHash) {
          const rc = await this.publicClient.getTransactionReceipt({ hash: st.txHash as Hex }).catch(() => null);
          if (rc?.status === "success") return st.txHash as Hex;
        }
        throw new Error(st.error ?? "the relayer could not land the transaction");
      }
    }
  }

  // ---- private swaps (PancakeSwap V2 through SwapExit)

  /** Quote a private swap of `amountIn` of `tokenIn` for `tokenOut` on PancakeSwap, after the relayer's fee note. */
  async quoteSwap(tokenIn: Token, amountIn: bigint, tokenOut: Token): Promise<{ out: bigint; path: EvmAddress[]; relayerFee: bigint }> {
    if (!this.network.swapExit) throw new Error("no SwapExit on this network");
    const path = this.swapPath(tokenIn, tokenOut);
    const router = await this.publicClient.readContract({ address: this.network.swapExit, abi: SwapExitAbi, functionName: "router" });
    const amounts = await this.publicClient.readContract({ address: router, abi: IPancakeRouter02Abi, functionName: "getAmountsOut", args: [amountIn, path] });
    return { out: amounts[amounts.length - 1], path, relayerFee: await this.relayerFee(tokenIn, amountIn) };
  }

  /**
   * Swap privately: the pool pays `amountIn` to `SwapExit`, which trades on
   * PancakeSwap and hands the output back to the pool as a note of yours. One
   * transaction, no public account involved.
   */
  async swap(tokenIn: Token, amountIn: bigint, tokenOut: Token, o: RelayOptions & { slippageBps?: bigint; minOut?: bigint } = {}): Promise<Hex> {
    if (!this.network.swapExit) throw new Error("no SwapExit on this network");
    const q = await this.quoteSwap(tokenIn, amountIn, tokenOut);
    const minOut = o.minOut ?? q.out - (q.out * (o.slippageBps ?? DEFAULT_SLIPPAGE_BPS)) / 10_000n;
    return this.exit(tokenIn, amountIn, this.network.swapExit, swapExitData(q.path, minOut), { ...o, reshield: tokenOut });
  }

  private swapPath(tokenIn: Token, tokenOut: Token): EvmAddress[] {
    const a = tokenIn === "BNB" ? this.network.wbnb : getAddress(tokenIn);
    const b = tokenOut === "BNB" ? this.network.wbnb : getAddress(tokenOut);
    if (a.toLowerCase() === b.toLowerCase()) throw new Error("same token");
    if (tokenIn === "BNB" || tokenOut === "BNB") return [a, b];
    return [a, this.network.wbnb, b];
  }

  // ---- helpers

  /** @internal */
  async write(signer: Signer, call: TransactCall | { address: EvmAddress; abi: any; functionName: string; args: readonly unknown[]; value?: bigint }, extra: { gas?: bigint; gasPrice?: bigint } = {}): Promise<Hex> {
    const wc = this.walletClientFor(signer);
    const account = wc.account;
    if (!account) throw new Error("signer has no account");
    return wc.writeContract({ ...(call as any), account, chain: this.chain, ...extra });
  }

  /** @internal */
  async waitOk(hash: Hex): Promise<void> {
    const rc = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error(`transaction ${hash} reverted`);
  }

  /** @internal */
  walletClientFor(signer: Signer): WalletClient {
    if (typeof signer === "string") return createWalletClient({ account: privateKeyToAccount(signer), chain: this.chain, transport: http(this.network.rpcUrl) });
    if ("writeContract" in signer) return signer as WalletClient;
    return createWalletClient({ account: signer as Account, chain: this.chain, transport: http(this.network.rpcUrl) });
  }
}

// ---- launchpad

export interface TradeOptions { slippageBps?: bigint; onEvent?: (e: TxEvent) => void }

export class Launchpad {
  constructor(private readonly c: BunkerClient) {}

  get address(): EvmAddress { return this.c.network.launchpad; }

  /** Tokens launched so far, newest first, as the indexer lists them (name, symbol, curve, volume, graduation). */
  list(limit = 100): Promise<LaunchRow[]> { return this.c.indexer.launches(limit); }
  params(): Promise<LaunchpadParams> { return readParams(this.c.publicClient, this.address); }

  /** The curve as it stands at the current block (fee policy rolled forward). */
  async curve(token: EvmAddress): Promise<CurveState & { block: bigint; worstFeeBps: number }> {
    const t = getAddress(token);
    const [stored, block] = await Promise.all([readCurve(this.c.publicClient, this.address, t), this.c.publicClient.getBlockNumber()]);
    if (!stored) throw new Error("curve not found");
    return { ...rolled(stored, block), block, worstFeeBps: worstFeeBps(stored, block) };
  }

  /**
   * Quote a private buy: tokens received for `bnbWei` of shielded BNB. The
   * relayer's fee is a separate private note (`relayerFeeWei`), so the whole
   * `bnbWei` reaches the curve. `maxIn` is the most the curve still accepts.
   */
  async quoteBuy(token: EvmAddress, bnbWei: bigint) {
    const [curve, pool] = await Promise.all([this.curve(token), this.c.pool("BNB", true)]);
    const units = toUnits(bnbWei, pool.unit);
    const fee = await this.c.feeUnits(NATIVE_TOKEN, units);
    const delivered = deliveredFor(pool, units);
    return { ...quotePrivateBuy({ ...curve, tradeFeeBps: curve.worstFeeBps }, delivered), relayerFeeWei: fee * pool.unit, curve };
  }

  /** Quote a private sell: BNB received for `tokens` (base units) of the shielded token balance. */
  async quoteSell(token: EvmAddress, tokens: bigint) {
    const t = getAddress(token);
    const [curve, pool] = await Promise.all([this.curve(t), this.c.pool(t, true)]);
    const units = toUnits(tokens, pool.unit);
    const fee = await this.c.feeUnits(t, units);
    const delivered = deliveredFor(pool, units);
    return { ...quotePrivateSell({ ...curve, tradeFeeBps: curve.worstFeeBps }, delivered), relayerFeeTokens: fee * pool.unit, curve };
  }

  /**
   * Launch a token: uploads metadata to the indexer, sends `launch` from a
   * public account. Returns the token address.
   */
  async launch(input: { name: string; symbol: string; description?: string; image: string; header?: string }, signer: Signer): Promise<EvmAddress> {
    const hosted = await this.c.indexer.uploadMeta(input);
    const hash = await this.c.write(signer, launchCall(this.address, input.name, input.symbol, hosted.uri));
    const rc = await this.c.publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== "success") throw new Error("the launch transaction reverted");
    const ev = parseEventLogs({ abi: LaunchpadAbi, logs: rc.logs, eventName: "Launch" })[0];
    if (!ev) throw new Error("no Launch event in the receipt");
    return getAddress(ev.args.token);
  }

  /**
   * Buy `token` privately with `bnbWei` of shielded BNB: the pool pays the
   * curve through its exit hook and the tokens come straight back as a note
   * of yours, in one transaction. A buy larger than the curve has left is
   * refused on-chain; size it to `quoteBuy().maxIn`.
   */
  async buy(token: EvmAddress, bnbWei: bigint, o: TradeOptions = {}): Promise<TradeResult> {
    const t = getAddress(token);
    const q = await this.quoteBuy(t, bnbWei);
    if (q.curve.graduated) throw new Error("this curve has graduated; it trades on PancakeSwap now");
    if (q.overshoots) throw new Error(`the curve only has room for ${q.maxIn} wei more; buy at most that`);
    const minOut = q.out - (q.out * (o.slippageBps ?? DEFAULT_SLIPPAGE_BPS)) / 10_000n;
    const txHash = await this.c.exit("BNB", bnbWei, this.address, exitData(EXIT_BUY, t, minOut), { onEvent: o.onEvent, reshield: t });
    return { txHash };
  }

  /** Sell `tokens` (base units) of shielded `token` back to the curve; the BNB comes back as a note of yours in the same transaction. */
  async sell(token: EvmAddress, tokens: bigint, o: TradeOptions = {}): Promise<TradeResult> {
    const t = getAddress(token);
    const q = await this.quoteSell(t, tokens);
    if (q.curve.graduated) throw new Error("this curve has graduated; it trades on PancakeSwap now");
    const minOut = q.out - (q.out * (o.slippageBps ?? DEFAULT_SLIPPAGE_BPS)) / 10_000n;
    const txHash = await this.c.exit(t, tokens, this.address, exitData(EXIT_SELL, t, minOut), { onEvent: o.onEvent, reshield: "BNB" });
    return { txHash };
  }
}

// ---- internals

function norm(token: Token): EvmAddress { return token === "BNB" ? NATIVE_TOKEN : getAddress(token); }

/** What the pool pays out for a withdrawal of `units`, after the shares round trip, in wei. */
export function deliveredFor(pool: PoolState, units: bigint): bigint {
  const u = pool.totalShares === 0n ? units : amountForBurn(pool, sharesForWithdraw(pool, units));
  return u * pool.unit;
}

function chainFor(n: NetworkConfig): Chain {
  const base = n.chainId === 56 ? bscChain : n.chainId === 97 ? bscTestnet : n.chainId === 31337 ? hardhat : defineChain({ id: n.chainId, name: n.name, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [n.rpcUrl] } } });
  return { ...base, rpcUrls: { default: { http: [n.rpcUrl] } } };
}

function isStaleRoot(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  const ce = (e.body as { contractError?: string } | undefined)?.contractError;
  return !!ce && (STALE_ROOT_ERRORS as readonly string[]).includes(ce);
}

function hexToBytes(h: Hex): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64ToBytes(s: string): Uint8Array {
  if (!s) return new Uint8Array(0);
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function fetchBytes(url: string, onChunk: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    onChunk(n, total);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
