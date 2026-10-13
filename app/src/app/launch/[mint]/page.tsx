"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { amountForBurn, sharesForWithdraw, quotePrivateBuy, quotePrivateSell, rolled, worstFeeBps, raydium, type CurveState, type PoolState } from "@scash/sdk";
import { PublicKey } from "@solana/web3.js";
import { FeePolicy } from "@/components/launch/FeePolicy";
import { Unlock } from "@/components/Unlock";
import { LaunchShell, Row } from "@/components/launch/LaunchShell";
import { useLaunchpad, priceLamportsPerToken, CLAIM_BUDGET, SLIPPAGE_BPS, SOL, type ClaimRecord } from "@/lib/launchpad";
import { useScash } from "@/lib/store";
import { indexer, type LaunchRow, type TradeRow, type FeeEventRow } from "@/lib/api";
import { fmtAmount, short, timeAgo } from "@/lib/format";
import { explorerTx, explorerAddr } from "@/lib/config";

const BUY_SIZES = [0.1, 0.25, 0.5, 1, 2];
const SELL_PARTS: [string, bigint][] = [["25%", 25n], ["50%", 50n], ["100%", 100n]];

export default function TokenPage() {
  const { mint } = useParams<{ mint: string }>();
  return (
    <LaunchShell wide>
      <Token mint={mint} />
    </LaunchShell>
  );
}

function Token({ mint }: { mint: string }) {
  const { curves, slots, tokenPools, refresh, launches, rents } = useLaunchpad();
  const ready = useScash((s) => s.phase === "ready");
  const [row, setRow] = useState<(LaunchRow & { trades: TradeRow[]; feeEvents: FeeEventRow[] }) | null>(null);
  const stored = curves[mint];
  const slot = slots[mint] ?? 0n;
  // what the program will charge if a trade lands now: the fee policy rolled to this slot's epoch
  const curve = stored ? rolled(stored, slot) : undefined;
  const pool = tokenPools[mint];
  const meta = row ?? launches.find((l) => l.mint === mint);
  const load = useCallback(async () => {
    await refresh(mint).catch(() => undefined);
    await indexer.launch(mint).then(setRow).catch(() => undefined);
  }, [mint, refresh]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (!curve) return <p className="text-sm text-dim">Loading curve…</p>;
  const decimals = meta?.decimals ?? 6;
  const symbol = meta?.symbol ?? short(mint, 4);
  const migrated = !!curve.ammPool;
  const ammSol = meta?.amm_sol ? BigInt(meta.amm_sol) : null;
  const ammTokens = meta?.amm_tokens ? BigInt(meta.amm_tokens) : null;
  // after migration the curve is empty; the opening pool price is the last thing we can show without reading Raydium
  const price = migrated && ammSol && ammTokens ? (Number(ammSol) / Number(ammTokens)) * 10 ** decimals : priceLamportsPerToken(curve, decimals);
  const prog = curve.graduated ? 1 : Math.min(1, Number(curve.realSol) / Number(curve.graduationLamports || 1n));
  const image = meta && "image" in meta ? meta.image : null;

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="space-y-5">
        <section className="glass noise px-7 py-7">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="flex items-center gap-4">
              {image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image} alt="" className="h-16 w-16 rounded-2xl object-cover" />
              ) : null}
              <div>
                <div className="label">{meta?.name ?? "Token"}</div>
                <div className="mt-2 flex items-baseline gap-3">
                  <span className="text-[2.5rem] leading-none tracking-[-0.04em] tabular-nums">{(price / 1e9).toPrecision(3)}</span>
                  <span className="text-lg text-mute">SOL / {symbol}</span>
                </div>
              </div>
            </div>
            <a className="link font-mono text-xs" href={explorerAddr(mint)} target="_blank" rel="noreferrer">{short(mint)}</a>
          </div>
          <div className="mt-5 h-2 overflow-hidden rounded-full bg-white/5">
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${(prog * 100).toFixed(1)}%` }} />
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
            {migrated ? (
              <>
                <Row k="In the pool" v={ammSol !== null ? `${fmtAmount(ammSol, 9, 2)} SOL` : "—"} />
                <Row k="With" v={ammTokens !== null ? `${fmtAmount(ammTokens, decimals, 0)} ${symbol}` : "—"} />
              </>
            ) : (
              <>
                <Row k="Raised" v={`${fmtAmount(curve.realSol, 9, 3)} SOL`} />
                <Row k="Graduates at" v={`${fmtAmount(curve.graduationLamports, 9, 0)} SOL`} />
              </>
            )}
            <Row k="Left on curve" v={`${fmtAmount(curve.realToken, decimals, 0)}`} />
            <Row k="Status" v={migrated ? "on Raydium" : curve.graduated ? "graduated · moving to Raydium" : "shielded-only"} strong />
            <Row k="Trades" v={`${curve.buys} buys · ${curve.sells} sells`} />
            <Row k="Volume" v={`${fmtAmount(curve.solVolume, 9, 2)} SOL`} />
            <Row k="Fees waiting" v={`${fmtAmount(curve.feesAccrued, 9, 4)} SOL`} />
            <Row k="Paid to holders" v={meta ? `${fmtAmount(BigInt(meta.tokens_donated), decimals, 0)} ${symbol}` : "—"} />
          </dl>
        </section>

        {curve.graduated ? <OnRaydium mint={mint} curve={curve} symbol={symbol} /> : ready ? <TradePanel mint={mint} curve={curve} worstFee={worstFeeBps(stored, slot)} symbol={symbol} decimals={decimals} /> : <UnlockToTrade symbol={symbol} />}
        {!curve.graduated && <FeePolicy curve={curve} slot={slot} events={row?.feeEvents ?? []} />}
        <Trades trades={row?.trades ?? []} symbol={symbol} decimals={decimals} />
      </div>
      <aside className="space-y-4">
        {ready && <Holdings mint={mint} symbol={symbol} decimals={decimals} pool={pool} />}
        {ready && <Claims mint={mint} />}
        <section className="glass p-5 text-xs leading-relaxed text-mute">
          <div className="label">How a private buy works</div>
          <ol className="mt-3 list-decimal space-y-2 pl-4">
            <li>Your browser proves a spend of shielded SOL whose recipient is this curve.</li>
            <li>The relayer submits it; the vault pays the curve and the curve hands the tokens to a fresh key only you can derive.</li>
            <li>That key shields the tokens into {symbol}&apos;s own pool and is never used again. Your wallet signs nothing.</li>
          </ol>
          <p className="mt-3 text-dim">Selling is the mirror image: tokens leave your notes, SOL arrives at a fresh key, the key shields it back.</p>
          {rents && (
            <p className="mt-3 text-dim">
              Each buy sets aside {fmtAmount(rents.claimRent + 2n * rents.nullifierRent + rents.tokenAccountRent + CLAIM_BUDGET, 9, 4)} SOL for the claim&apos;s rents and fee.
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}

/** After graduation the curve is done: its SOL and the reserved supply are (or are about to be) a Raydium pool with the LP burned. */
function OnRaydium({ mint, curve, symbol }: { mint: string; curve: CurveState; symbol: string }) {
  const pool = curve.ammPool ?? raydium.poolState(new PublicKey(mint));
  return (
    <section className="glass px-7 py-6">
      <div className="label">{curve.ammPool ? `${symbol} trades on Raydium` : `${symbol} has graduated`}</div>
      <p className="mt-2 text-sm leading-relaxed text-mute">
        {curve.ammPool
          ? `The curve's SOL and the reserved supply became a Raydium CP-Swap pool; every LP token was burned, so the liquidity is permanent and nobody controls it. The launchpad's fee policy no longer applies — Raydium's 0.25% fee does.`
          : `The curve reached 20 SOL and is frozen. The next keeper tick (any wallet can send it) turns its SOL and the reserved supply into a Raydium pool with the LP burned.`}
      </p>
      <p className="mt-3 text-xs text-dim">
        Shielded {symbol} you already hold stays in your notes; unshield it to a wallet to sell on Raydium, or keep it private.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <a className="btn-primary h-11 px-5" href={raydium.swapUrl(new PublicKey(mint))} target="_blank" rel="noreferrer">Trade on Raydium</a>
        <a className="btn-ghost h-11 px-5 font-mono text-xs" href={explorerAddr(pool.toBase58())} target="_blank" rel="noreferrer">pool {short(pool.toBase58())}</a>
      </div>
    </section>
  );
}

/** Trading spends shielded notes, so it is the one thing on this page that needs the shielded wallet open. */
function UnlockToTrade({ symbol }: { symbol: string }) {
  return (
    <section className="glass px-7 py-6">
      <div className="label">Buy or sell {symbol} privately</div>
      <p className="mt-2 text-sm text-mute">Trades are paid from shielded notes and the proceeds go back into them. Open your shielded wallet to trade; everything else on this page is public.</p>
      <Unlock />
    </section>
  );
}

function TradePanel({ mint, curve, worstFee, symbol, decimals }: { mint: string; curve: CurveState; worstFee: number; symbol: string; decimals: number }) {
  const { buy, sell, busy, rents, tokenPools } = useLaunchpad();
  const { balances, pools, tokenBalances, relayer } = useScash();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [buySize, setBuySize] = useState(0.5);
  const [sellPart, setSellPart] = useState(50n);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const solPool = pools.SOL;
  const tokenPool = tokenPools[mint];
  const solShares = balances.SOL ?? 0n;
  const solAvail = solPool ? amountForBurn(solPool, solShares) : 0n;
  const tokShares = tokenBalances[mint] ?? 0n;
  const tokAvail = tokenPool ? amountForBurn(tokenPool, tokShares) : 0n;
  const feePolicy = relayer?.fees.find((f) => f.mint === SOL.toBase58());

  const quote = useMemo(() => {
    try {
      if (!feePolicy || !rents) return null;
      if (side === "buy") {
        if (!solPool) return null;
        const lamports = BigInt(Math.round(buySize * 1e9));
        const pct = (lamports * BigInt(feePolicy.bps)) / 10_000n;
        const fee = pct > BigInt(feePolicy.min) ? pct : BigInt(feePolicy.min);
        const delivered = amountForBurn(solPool, sharesForWithdraw(solPool, lamports)) - fee;
        const q = quotePrivateBuy(curve, delivered, rents, CLAIM_BUDGET);
        // min_out assumes the worst fee an epoch boundary inside the next few minutes can bring
        const w = quotePrivateBuy({ ...curve, tradeFeeBps: worstFee }, delivered, rents, CLAIM_BUDGET);
        return { amount: lamports, relayerFee: fee, curveFee: q.fee, out: q.out, minOut: w.out - (w.out * SLIPPAGE_BPS) / 10_000n, refund: q.refund };
      }
      if (!tokenPool) return null;
      const tokens = (tokAvail * sellPart) / 100n;
      if (tokens === 0n) return null;
      const tip = BigInt(feePolicy.min);
      const delivered = amountForBurn(tokenPool, sharesForWithdraw(tokenPool, tokens));
      const q = quotePrivateSell(curve, delivered, tip);
      const w = quotePrivateSell({ ...curve, tradeFeeBps: worstFee }, delivered, tip);
      return { amount: tokens, relayerFee: tip, curveFee: q.fee, out: q.out, minOut: w.out - (w.out * SLIPPAGE_BPS) / 10_000n, refund: 0n };
    } catch (e) {
      return { error: (e as Error).message } as const;
    }
  }, [side, buySize, sellPart, solPool, tokenPool, tokAvail, curve, worstFee, rents, feePolicy]);

  const submit = async () => {
    setErr(null); setDone(null);
    if (!quote || "error" in quote) return;
    try {
      if (side === "buy") {
        if (quote.amount > solAvail) throw new Error("More than your shielded SOL");
        await buy(mint, quote.amount);
        setDone(`Bought and claimed ${fmtAmount(quote.out, decimals, 0)} ${symbol} into your shielded notes.`);
      } else {
        await sell(mint, quote.amount);
        setDone(`Sold and claimed ${fmtAmount(quote.out, 9, 4)} SOL into your shielded notes.`);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const disabled = !!busy || curve.graduated || !relayer?.launchProgram || !quote || "error" in quote || (side === "sell" && tokAvail === 0n);

  return (
    <section className="glass px-7 py-6">
      <div className="modes">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} className="mode" data-active={side === s} onClick={() => { setSide(s); setErr(null); setDone(null); }}>
            {side === s && <span className="mode-pill" />}
            <span className="relative z-10">{s === "buy" ? "Buy privately" : "Sell privately"}</span>
          </button>
        ))}
      </div>
      <div className="mt-5 flex flex-wrap gap-2">
        {side === "buy"
          ? BUY_SIZES.map((s) => <button key={s} className="chip" data-active={buySize === s} aria-pressed={buySize === s} onClick={() => setBuySize(s)}>{s} SOL</button>)
          : SELL_PARTS.map(([label, p]) => <button key={label} className="chip" aria-pressed={sellPart === p} onClick={() => setSellPart(p)}>{label}</button>)}
        <span className="ml-auto self-center text-[11px] text-dim">
          {side === "buy" ? `shielded SOL: ${fmtAmount(solAvail, 9, 3)}` : `shielded ${symbol}: ${fmtAmount(tokAvail, decimals, 0)}`}
        </span>
      </div>
      <p className="mt-2 text-[11px] text-dim">Fixed sizes only: a trade that matches many others says less about you.</p>

      <dl className="mt-5 space-y-2 rounded-2xl border border-line bg-black/20 p-4 text-xs">
        {quote && !("error" in quote) ? (
          <>
            <Row k={side === "buy" ? "You spend" : "You sell"} v={side === "buy" ? `${fmtAmount(quote.amount, 9, 3)} SOL` : `${fmtAmount(quote.amount, decimals, 0)} ${symbol}`} />
            <Row k="Relayer" v={`${fmtAmount(quote.relayerFee, 9, 4)} SOL${side === "sell" ? " (tipped from the proceeds)" : ""}`} />
            <Row k={`Curve fee (${(curve.tradeFeeBps / 100).toFixed(1)}%)`} v={`${fmtAmount(quote.curveFee, 9, 4)} SOL · ${curve.holderShareBps / 100}% back to holders`} />
            <Row k="You receive" v={side === "buy" ? `≈ ${fmtAmount(quote.out, decimals, 0)} ${symbol}` : `≈ ${fmtAmount(quote.out, 9, 4)} SOL`} strong />
            <Row k={worstFee > curve.tradeFeeBps ? `Minimum (if the fee steps to ${(worstFee / 100).toFixed(1)}%)` : "Minimum"} v={side === "buy" ? `${fmtAmount(quote.minOut, decimals, 0)} ${symbol}` : `${fmtAmount(quote.minOut, 9, 4)} SOL`} />
            {quote.refund > 0n && <Row k="Graduation" v={`this buy takes the last tokens; ${fmtAmount(quote.refund, 9, 4)} SOL comes back to your claim key and the curve moves to Raydium`} />}
          </>
        ) : (
          <Row k="Quote" v={quote && "error" in quote ? quote.error : side === "sell" && tokAvail === 0n ? `no shielded ${symbol} yet` : "—"} />
        )}
        <Row k="Visible on-chain" v="the curve, the amount, a throwaway key" />
        <Row k="Your wallet" v="not involved" strong />
      </dl>

      {relayer && !relayer.launchProgram && <p className="mt-3 text-xs text-warn">The configured relayer does not forward launchpad trades.</p>}
      {err && <p className="mt-3 text-sm text-bad">{err}</p>}
      {done && <p className="mt-3 text-sm text-accent">{done}</p>}
      <button className="btn-primary mt-4 h-12 w-full text-[15px]" disabled={disabled} onClick={submit}>
        {busy === "buy" ? "Buying, then claiming…" : busy === "sell" ? "Selling, then claiming…" : side === "buy" ? `Buy ${symbol} privately` : `Sell ${symbol} privately`}
      </button>
    </section>
  );
}

function Trades({ trades, symbol, decimals }: { trades: TradeRow[]; symbol: string; decimals: number }) {
  return (
    <section className="glass px-7 py-6">
      <div className="flex items-baseline justify-between">
        <div className="label">Trades</div>
        <span className="text-[11px] text-dim">public: size, time, side · absent: who</span>
      </div>
      {trades.length === 0 ? (
        <p className="mt-3 text-sm text-dim">No trades yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line text-xs">
          {trades.map((t) => (
            <li key={`${t.signature}-${t.side}`} className="flex items-center justify-between gap-3 py-2">
              <span className={t.side === "buy" ? "text-accent" : "text-warn"}>{t.side}</span>
              <span className="tabular-nums text-mute">{fmtAmount(BigInt(t.sol), 9, 3)} SOL ⇄ {fmtAmount(BigInt(t.tokens), decimals, 0)} {symbol}</span>
              <span className="text-dim">{t.private ? "shielded" : "public"}</span>
              <a className="link font-mono" href={explorerTx(t.signature)} target="_blank" rel="noreferrer">{short(t.signature, 4)}</a>
              <span className="text-dim">{t.block_time ? timeAgo(t.block_time * 1000) : `slot ${t.slot}`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Holdings({ mint, symbol, decimals, pool }: { mint: string; symbol: string; decimals: number; pool?: PoolState }) {
  const shares = useScash((s) => s.tokenBalances[mint] ?? 0n);
  const sync = useScash((s) => s.sync);
  const amount = pool ? amountForBurn(pool, shares) : shares;
  return (
    <section className="glass p-5">
      <div className="label">Your shielded {symbol}</div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl tracking-[-0.03em] tabular-nums">{fmtAmount(amount, decimals, 2)}</span>
        <span className="text-sm text-mute">{symbol}</span>
      </div>
      <p className="mt-2 text-xs text-dim">
        {shares.toString()} shares in the {symbol} pool · harvested fees raise what a share is worth ·{" "}
        <button className="link underline-offset-4 hover:underline" onClick={() => void sync()}>rescan</button>
      </p>
    </section>
  );
}

function Claims({ mint }: { mint: string }) {
  const { claims, claim, recover, busy } = useLaunchpad();
  const [msg, setMsg] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const mine = claims.filter((c) => c.mint === mint || c.kind === "sell");
  const pending = mine.filter((c) => c.status === "pending" || c.status === "failed");
  const run = async (f: () => Promise<unknown>) => {
    setWorking(true); setMsg(null);
    try { const r = await f(); if (typeof r === "number") setMsg(r === 0 ? "Nothing waiting at any claim key." : `Swept ${r} claim${r === 1 ? "" : "s"}.`); }
    catch (e) { setMsg((e as Error).message); }
    finally { setWorking(false); }
  };
  return (
    <section className="glass p-5">
      <div className="flex items-baseline justify-between">
        <div className="label">Claims</div>
        <button className="link text-xs" disabled={working || !!busy} onClick={() => run(recover)}>recover from seed</button>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-dim">
        A trade&apos;s proceeds wait at a key derived from your seed until claimed. Claims normally happen automatically; if a tab closed mid-way, recover sweeps them.
      </p>
      {pending.length > 0 && (
        <ul className="mt-3 space-y-2 text-xs">
          {pending.map((c) => <ClaimLine key={c.nonce} c={c} onClaim={() => run(() => claim(c))} disabled={working || !!busy} />)}
        </ul>
      )}
      {mine.filter((c) => c.status === "claimed").slice(0, 5).map((c) => (
        <p key={c.nonce} className="mt-2 text-[11px] text-dim">
          #{c.nonce} {c.kind} · claimed{" "}
          {c.claimSignature && <a className="link" href={explorerTx(c.claimSignature)} target="_blank" rel="noreferrer">{short(c.claimSignature, 4)}</a>} · {timeAgo(c.at)}
        </p>
      ))}
      {msg && <p className="mt-3 text-xs text-mute">{msg}</p>}
    </section>
  );
}

function ClaimLine({ c, onClaim, disabled }: { c: ClaimRecord; onClaim: () => void; disabled: boolean }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-line px-3 py-2">
      <span>
        #{c.nonce} {c.kind} · <span className={c.status === "failed" ? "text-bad" : "text-warn"}>{c.status}</span>
        {c.error && <span className="block text-[11px] text-dim">{c.error}</span>}
      </span>
      <button className="chip" disabled={disabled} onClick={onClaim}>claim</button>
    </li>
  );
}