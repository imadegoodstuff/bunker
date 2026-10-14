"use client";
// Launchpad client state: curves, private buys/sells through the vault's exit
// target, and the throwaway "claim keys" that carry what a trade produced back
// into the shielded pool. Claim keys are derived from the spending seed, so
// nothing here needs to be backed up: `recover()` re-derives them and sweeps
// whatever is still waiting.
import { create } from "zustand";
import { Keypair, PublicKey, SystemProgram, type AddressLookupTableAccount, type VersionedTransaction } from "@solana/web3.js";
import {
  LAUNCH_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, assetId, poolPda, decodePool, decodeCurve, curvePda, intakePda, intakeAta, claimAta,
  claimKeypair, claimShieldAccounts, closeTokenAccountIx, exitData, exitAccounts, EXIT_BUY, EXIT_SELL, fetchClaimRents, quotePrivateBuy, quotePrivateSell, rolled, worstFeeBps,
  amountForBurn, amountForMint, sharesForDeposit, sharesForWithdraw, buildV0, fetchLookupTable, launchIx, launchLookupTableIxs, lookupTableCovers,
  decodeTree, treePda, type CurveState, type PoolState, type ClaimRents,
} from "@scash/sdk";
import { indexer, type LaunchRow } from "./api";
import { useScash } from "./store";
import { ARTIFACTS, PROGRAM_ID, type AssetMeta } from "./config";
import { awaitConfirmation } from "./confirm";

export interface ClaimRecord {
  nonce: number;
  mint: string;
  kind: "buy" | "sell";
  at: number;
  status: "pending" | "claiming" | "claimed" | "empty" | "failed";
  /** the relayed trade */
  signature?: string;
  /** the claim shield */
  claimSignature?: string;
  error?: string;
}

/** Lamports a buy leaves at the claim key for its own transaction fee; whatever is unused stays there (dust). */
export const CLAIM_BUDGET = 20_000n;
/** Slippage tolerated between quote and execution (other trades can land first). */
export const SLIPPAGE_BPS = 100n;
export const SOL = SystemProgram.programId;

interface LaunchpadState {
  launches: LaunchRow[];
  /** curve accounts exactly as stored on chain (fee policy not yet rolled to the current epoch) */
  curves: Record<string, CurveState>;
  /** the slot at which each curve was last read */
  slots: Record<string, bigint>;
  tokenPools: Record<string, PoolState>;
  rents?: ClaimRents;
  claims: ClaimRecord[];
  nextNonce: number;
  loaded: boolean;
  busy?: string;

  load: () => Promise<void>;
  refresh: (mint: string) => Promise<{ curve: CurveState; pool?: PoolState; slot: bigint }>;
  /** Create a token: two wallet transactions (frozen lookup table, then the launch). Returns the mint. */
  /** Uploads the image + metadata to the indexer first (an image is required), then sends the two launch transactions. */
  launch: (meta: { name: string; symbol: string; description?: string; image: string; header?: string }, owner: PublicKey, sendTx: (tx: VersionedTransaction) => Promise<string>) => Promise<PublicKey>;
  buy: (mint: string, lamports: bigint) => Promise<void>;
  sell: (mint: string, tokens: bigint) => Promise<void>;
  claim: (rec: ClaimRecord) => Promise<void>;
  /** Re-derive claim keys from the seed and sweep anything waiting at them. */
  recover: () => Promise<number>;
}

const storageKey = async (seed: Uint8Array) => {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([...new TextEncoder().encode("scash-claims"), ...seed])));
  return "scash.claims." + Array.from(h.subarray(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
};

function assetOf(l: LaunchRow): AssetMeta {
  return { symbol: l.symbol, name: l.name, mint: new PublicKey(l.mint), decimals: l.decimals, tokenProgram: TOKEN_2022_PROGRAM_ID, denominations: [] };
}

export const useLaunchpad = create<LaunchpadState>((set, get) => {
  const conn = () => useScash.getState().connection;
  const seed = () => {
    const w = useScash.getState().wallet;
    if (!w) throw new Error("wallet locked");
    return w.spend.sk;
  };

  async function persist() {
    const w = useScash.getState().wallet;
    if (!w) return;
    localStorage.setItem(await storageKey(w.spend.sk), JSON.stringify({ claims: get().claims, nextNonce: get().nextNonce }));
  }
  async function restore() {
    const w = useScash.getState().wallet;
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

  async function tables(mint: PublicKey): Promise<AddressLookupTableAccount[]> {
    const rl = useScash.getState().relayer;
    const out: AddressLookupTableAccount[] = [];
    if (rl?.lookupTable) out.push(await fetchLookupTable(conn(), new PublicKey(rl.lookupTable)));
    if (mint.equals(SOL)) return out; // a SOL claim only touches the vault's statics
    try {
      const c = get().curves[mint.toBase58()] ?? (await get().refresh(mint.toBase58())).curve;
      const t = await fetchLookupTable(conn(), c.lookupTable);
      if (lookupTableCovers(t.state.addresses, mint, PROGRAM_ID)) out.push(t);
    } catch { /* the size check at send will tell */ }
    return out;
  }

  /** The claim: an ordinary vault shield signed and paid by the claim key alone. */
  async function shieldFromClaim(rec: ClaimRecord): Promise<"claimed" | "empty"> {
    const scash = useScash.getState();
    const { wallet, tree } = scash;
    if (!wallet || !tree) throw new Error("wallet locked");
    const mint = new PublicKey(rec.mint);
    const key = claimKeypair(seed(), BigInt(rec.nonce));
    const rents = get().rents ?? (await fetchClaimRents(conn()));
    const c = conn();
    const chainTree = decodeTree(new Uint8Array((await c.getAccountInfo(treePda(PROGRAM_ID)))!.data));
    const ixs = [];
    if (rec.kind === "buy") {
      const ata = claimAta(key.publicKey, mint);
      const bal = await c.getTokenAccountBalance(ata).then((r) => BigInt(r.value.amount)).catch(() => 0n);
      if (bal === 0n) return "empty";
      const pool = (await get().refresh(rec.mint)).pool;
      if (!pool) throw new Error("token pool missing");
      const moved = amountForMint(pool, sharesForDeposit(pool, bal));
      const built = await wallet.buildTransact({
        asset: assetId(mint), mint, pool, tree, chainTree, artifacts: ARTIFACTS, kind: "shield", amount: bal,
        ...claimShieldAccounts(key.publicKey, mint),
      });
      ixs.push(built.instruction);
      // the ATA can only be closed when nothing is left in it (the pool rate can leave a unit of dust)
      if (moved === bal) ixs.push(closeTokenAccountIx(ata, key.publicKey, key.publicKey));
    } else {
      const lamports = BigInt(await c.getBalance(key.publicKey));
      const keep = rents.claimRent + 2n * rents.nullifierRent + 10_000n; // rent-exempt floor, two nullifier PDAs, the signature
      if (lamports <= keep + 1_000n) return "empty";
      const pool = useScash.getState().pools.SOL;
      if (!pool) throw new Error("SOL pool missing");
      const built = await wallet.buildTransact({
        asset: assetId(SOL), mint: SOL, pool, tree, chainTree, artifacts: ARTIFACTS, kind: "shield", amount: lamports - keep,
        ...claimShieldAccounts(key.publicKey, SOL),
      });
      ixs.push(built.instruction);
    }
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash();
    const tx = buildV0(key.publicKey, ixs, blockhash, await tables(rec.kind === "buy" ? mint : SOL));
    tx.sign([key]);
    const sig = await c.sendTransaction(tx, { skipPreflight: false });
    await awaitConfirmation(c, sig, { blockhash, lastValidBlockHeight });
    upsert({ ...rec, status: "claimed", claimSignature: sig });
    // the indexer needs a moment to see the leaf; sync twice
    await scash.refreshPools();
    await scash.sync();
    setTimeout(() => void useScash.getState().sync(), 6000);
    return "claimed";
  }

  return {
    launches: [],
    curves: {},
    tokenPools: {},
    claims: [],
    nextNonce: 0,
    slots: {},
    loaded: false,

    async load() {
      const [indexed, rents] = await Promise.all([indexer.launches(100), get().rents ? Promise.resolve(get().rents!) : fetchClaimRents(conn())]);
      // a token launched from this browser is listed at once; the indexer's row replaces it as soon as it exists
      const known = new Set(indexed.map((l) => l.mint));
      const launches = [...get().launches.filter((l) => l.slot === 0 && !known.has(l.mint)), ...indexed];
      set({ launches, rents, loaded: true });
      useScash.getState().addLaunchAssets(launches.map(assetOf));
      await restore();
    },

    async refresh(mint) {
      const m = new PublicKey(mint);
      const { context, value: [ci, pi] } = await conn().getMultipleAccountsInfoAndContext([curvePda(m), poolPda(m, PROGRAM_ID)]);
      if (!ci) throw new Error("curve not found");
      const curve = decodeCurve(new Uint8Array(ci.data));
      const pool = pi ? decodePool(new Uint8Array(pi.data)) : undefined;
      const slot = BigInt(context.slot);
      set((s) => ({ curves: { ...s.curves, [mint]: curve }, slots: { ...s.slots, [mint]: slot }, tokenPools: pool ? { ...s.tokenPools, [mint]: pool } : s.tokenPools }));
      return { curve, pool, slot };
    },

    async launch(input, owner, sendTx) {
      const c = conn();
      const mint = Keypair.generate();
      set({ busy: "launch" });
      try {
        if (!input.image) throw new Error("an image is required");
        const hosted = await indexer.uploadMeta({ name: input.name, symbol: input.symbol, description: input.description, image: input.image, header: input.header });
        const meta = { name: input.name, symbol: input.symbol, uri: hosted.uri };
        const alt = launchLookupTableIxs(owner, mint.publicKey, await c.getSlot("finalized"), PROGRAM_ID);
        let bh = await c.getLatestBlockhash();
        const t1 = buildV0(owner, alt.ixs, bh.blockhash, undefined, { cuLimit: 100_000 });
        const s1 = await sendTx(t1);
        await awaitConfirmation(c, s1, bh);
        bh = await c.getLatestBlockhash();
        const t2 = buildV0(owner, [launchIx(owner, mint.publicKey, meta, alt.table, PROGRAM_ID)], bh.blockhash, undefined, { cuLimit: 400_000 });
        t2.sign([mint]);
        const s2 = await sendTx(t2);
        await awaitConfirmation(c, s2, bh);
        useScash.getState().pushActivity({ id: crypto.randomUUID(), kind: "launch", asset: meta.symbol, amount: 0n, at: Date.now(), status: "confirmed", signature: s2 });
        const { curve } = await get().refresh(mint.publicKey.toBase58());
        // show it in the list now, from the curve we just read; `slot: 0` marks it as not yet indexed
        const row: LaunchRow = {
          mint: mint.publicKey.toBase58(), name: meta.name, symbol: meta.symbol, uri: meta.uri, decimals: 6,
          virtual_sol: curve.virtualSol.toString(), virtual_token0: curve.virtualToken.toString(), curve_supply: curve.curveSupply.toString(), total_supply: curve.totalSupply.toString(),
          graduation_lamports: curve.graduationLamports.toString(), real_sol: curve.realSol.toString(), real_token: curve.realToken.toString(), virtual_token: curve.virtualToken.toString(),
          graduated: 0, buys: 0, sells: 0, sol_volume: "0", fees_to_treasury: "0", tokens_donated: "0", signature: s2, slot: 0, block_time: Math.floor(Date.now() / 1000),
          amm_pool: null, amm_sol: null, amm_tokens: null, image: hosted.image, header: hosted.header,
        };
        set((s) => ({ launches: [row, ...s.launches.filter((l) => l.mint !== row.mint)] }));
        useScash.getState().addLaunchAssets([{ symbol: meta.symbol, name: meta.name, mint: mint.publicKey, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID, denominations: [] }]);
        setTimeout(() => void get().load(), 8000);
        return mint.publicKey;
      } finally {
        set({ busy: undefined });
      }
    },

    async buy(mintStr, lamports) {
      const scash = useScash.getState();
      const rl = scash.relayer;
      if (!rl) throw new Error("relayer unavailable");
      if (!rl.launchProgram) throw new Error("this relayer does not forward launchpad trades");
      const solPool = scash.pools.SOL;
      if (!solPool) throw new Error("SOL pool missing");
      const mint = new PublicKey(mintStr);
      const { curve: stored, slot } = await get().refresh(mintStr);
      // quote at the fee the program will charge now; protect min_out with the worst fee the next ~300 slots can bring
      const curve = rolled(stored, slot);
      const worst = { ...curve, tradeFeeBps: worstFeeBps(stored, slot) };
      if (curve.graduated) throw new Error("this curve has graduated; it trades on Raydium now");
      const rents = get().rents ?? (await fetchClaimRents(conn()));
      const feePolicy = rl.fees.find((f) => f.mint === SOL.toBase58());
      if (!feePolicy) throw new Error("relayer has no SOL policy");
      const pct = (lamports * BigInt(feePolicy.bps)) / 10_000n;
      const fee = pct > BigInt(feePolicy.min) ? pct : BigInt(feePolicy.min);
      const delivered = amountForBurn(solPool, sharesForWithdraw(solPool, lamports)) - fee;
      const q = quotePrivateBuy(worst, delivered, rents, CLAIM_BUDGET);
      const minOut = q.out - (q.out * SLIPPAGE_BPS) / 10_000n;
      const nonce = get().nextNonce;
      const key = claimKeypair(seed(), BigInt(nonce));
      const relayerKey = new PublicKey(rl.relayer);
      const rec: ClaimRecord = { nonce, mint: mintStr, kind: "buy", at: Date.now(), status: "pending" };
      set({ nextNonce: nonce + 1, busy: "buy" });
      upsert(rec);
      try {
        const sig = await scash.relayExit({ symbol: "SOL", name: "Solana", mint: SOL, decimals: 9, denominations: [] }, lamports, {
          recipient: intakePda(mint), pool: solPool, fee, kind: "buy", label: get().launches.find((l) => l.mint === mintStr)?.symbol ?? "token",
          exit: { target: LAUNCH_PROGRAM_ID, data: exitData(EXIT_BUY, key.publicKey, CLAIM_BUDGET, minOut), accounts: exitAccounts(EXIT_BUY, mint, key.publicKey, relayerKey) },
        });
        upsert({ ...rec, signature: sig, status: "claiming" });
        await get().claim({ ...rec, signature: sig, status: "claiming" });
      } catch (e) {
        upsert({ ...rec, status: "failed", error: (e as Error).message });
        throw e;
      } finally {
        set({ busy: undefined });
      }
    },

    async sell(mintStr, tokens) {
      const scash = useScash.getState();
      const rl = scash.relayer;
      if (!rl) throw new Error("relayer unavailable");
      if (!rl.launchProgram) throw new Error("this relayer does not forward launchpad trades");
      const mint = new PublicKey(mintStr);
      const { curve: stored, pool, slot } = await get().refresh(mintStr);
      const curve = rolled(stored, slot);
      const worst = { ...curve, tradeFeeBps: worstFeeBps(stored, slot) };
      if (!pool) throw new Error("token pool missing");
      if (curve.graduated) throw new Error("this curve has graduated; it trades on Raydium now");
      const feePolicy = rl.fees.find((f) => f.mint === SOL.toBase58());
      if (!feePolicy) throw new Error("relayer has no SOL policy");
      // the relayer is tipped in SOL out of the proceeds: its SOL minimum, which already covers its costs
      const tip = BigInt(feePolicy.min);
      const delivered = amountForBurn(pool, sharesForWithdraw(pool, tokens));
      const q = quotePrivateSell(worst, delivered, tip);
      const minOut = q.out - (q.out * SLIPPAGE_BPS) / 10_000n;
      const nonce = get().nextNonce;
      const key = claimKeypair(seed(), BigInt(nonce));
      const relayerKey = new PublicKey(rl.relayer);
      const launchRow = get().launches.find((l) => l.mint === mintStr);
      const rec: ClaimRecord = { nonce, mint: mintStr, kind: "sell", at: Date.now(), status: "pending" };
      set({ nextNonce: nonce + 1, busy: "sell" });
      upsert(rec);
      try {
        const asset: AssetMeta = { symbol: launchRow?.symbol ?? "token", name: launchRow?.name ?? "token", mint, decimals: launchRow?.decimals ?? 6, tokenProgram: TOKEN_2022_PROGRAM_ID, denominations: [] };
        const sig = await scash.relayExit(asset, tokens, {
          recipient: intakeAta(mint), pool, fee: 0n, kind: "sell", label: asset.symbol,
          exit: { target: LAUNCH_PROGRAM_ID, data: exitData(EXIT_SELL, key.publicKey, 0n, minOut, tip), accounts: exitAccounts(EXIT_SELL, mint, key.publicKey, relayerKey) },
        });
        upsert({ ...rec, signature: sig, status: "claiming" });
        await get().claim({ ...rec, signature: sig, status: "claiming" });
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
      const c = conn();
      const s = seed();
      const rents = get().rents ?? (await fetchClaimRents(c));
      const known = new Map(get().claims.map((r) => [r.nonce, r]));
      const limit = Math.max(get().nextNonce, 0) + 12; // lookahead past the last nonce this browser knows about
      let swept = 0;
      for (let nonce = 0; nonce < limit; nonce++) {
        const key = claimKeypair(s, BigInt(nonce)).publicKey;
        const [lamports, tokenAccounts] = await Promise.all([c.getBalance(key), c.getTokenAccountsByOwner(key, { programId: TOKEN_2022_PROGRAM_ID })]);
        const prior = known.get(nonce);
        let rec: ClaimRecord | undefined;
        for (const ta of tokenAccounts.value) {
          const amount = ta.account.data.readBigUInt64LE(64);
          if (amount === 0n) continue;
          rec = { nonce, mint: new PublicKey(ta.account.data.subarray(0, 32)).toBase58(), kind: "buy", at: prior?.at ?? Date.now(), status: "pending", signature: prior?.signature };
        }
        if (!rec && BigInt(lamports) > rents.claimRent + 2n * rents.nullifierRent + 11_000n) {
          rec = { nonce, mint: prior?.mint ?? SOL.toBase58(), kind: "sell", at: prior?.at ?? Date.now(), status: "pending", signature: prior?.signature };
        }
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

/** Spot price in lamports per whole token, from the curve's current reserves. */
export function priceLamportsPerToken(c: CurveState, decimals: number): number {
  const x = Number(c.virtualSol + c.realSol);
  const y = Number(c.virtualToken);
  return (x / y) * 10 ** decimals;
}
