"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { getAddress, isAddress } from "viem";
import { NATIVE_TOKEN, rolled, quotePrivateBuy, quotePrivateSell, pancakeSwapUrl, spotPrice, NATIVE_UNIT, worstFeeBps } from "@bunker/sdk";
import { indexer, type FeeEventRow, type LaunchRow, type TradeRow } from "@/lib/api";
import { assetOf, CLAIM_BUDGET, deliveredFor, useLaunchpad, type ClaimRecord } from "@/lib/launchpad";
import { shieldedAmount, useBunker } from "@/lib/store";
import { useSigner } from "@/lib/useSigner";
import { BNB, explorerAddr, explorerTx } from "@/lib/config";
import { fmtAmount, fmtPrice, fmtProgress, barWidth, parseAmount, short, timeAgo } from "@/lib/format";
import { FeePolicy } from "@/components/launch/FeePolicy";
import { TxOverlay } from "@/components/TxOverlay";

const BUY_SIZES = ["0.01", "0.05", "0.1", "0.5"];
const SELL_PARTS = [25, 50, 100];

export default function TokenPage() {
  const { token: raw } = useParams<{ token: string }>();
  const valid = isAddress(raw);
  const token = valid ? getAddress(raw) : undefined;
  const lp = useLaunchpad();
  const bunker = useBunker();
  const signer = useSigner();
  const owner = useWallet((w) => w.address);
  const [row, setRow] = useState<(LaunchRow & { trades: TradeRow[]; feeEvents: FeeEventRow[] }) | null>();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("0.05");
  const [err, setErr] = useState<string>();
  const [topUp, setTopUp] = useState("");

  useEffect(() => {
    if (!token) return;
    const load = async () => {
      await lp.load().catch(() => undefined);
      await lp.refresh(token).catch(() => undefined);
      await indexer.launch(token.toLowerCase()).then(setRow).catch(() => setRow(null));
    };
    void load();
    const id = setInterval(() => { void lp.refresh(token).catch(() => undefined); void indexer.launch(token.toLowerCase()).then(setRow).catch(() => undefined); }, 10_000);
    return () => clearInterval(id);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const stored = token ? lp.curves[token.toLowerCase()] : undefined;
  const block = token ? lp.blocks[token.toLowerCase()] ?? 0n : 0n;
  const curve = stored ? rolled(stored, block) : undefined;
  const meta = row ?? lp.launches.find((l) => token && l.token.toLowerCase() === token.toLowerCase());
  const decimals = meta?.decimals ?? lp.params?.decimals ?? 6;
  const asset = meta ? assetOf(meta) : undefined;
  const bnbShielded = shieldedAmount(bunker, BNB);
  const tokShielded = asset ? shieldedAmount(bunker, asset) : 0n;
  const bnbPool = bunker.pools[NATIVE_TOKEN.toLowerCase()];
  const tokPool = asset ? bunker.pools[asset.token.toLowerCase()] : undefined;
  const feeBnb = bunker.relayer?.fees.find((f) => f.token.toLowerCase() === NATIVE_TOKEN.toLowerCase());
  const ready = bunker.phase === "ready";

  const quote = useMemo(() => {
    if (!curve || !stored || curve.graduated || !feeBnb) return undefined;
    const worst = { ...curve, tradeFeeBps: worstFeeBps(stored, block) };
    try {
      if (side === "buy") {
        if (!bnbPool) return undefined;
        const wei = parseAmount(amt, 18);
        const units = wei / bnbPool.unit;
        const pct = (units * BigInt(feeBnb.bps)) / 10_000n;
        const fee = (pct > BigInt(feeBnb.min) ? pct : BigInt(feeBnb.min)) * bnbPool.unit;
        const delivered = deliveredFor(bnbPool, units) - fee;
        if (delivered <= CLAIM_BUDGET) return { error: "too small to cover fees" };
        const q = quotePrivateBuy(worst, delivered, CLAIM_BUDGET, 0n);
        return { out: q.out, fee: fee + CLAIM_BUDGET, curveFee: q.fee, inWei: wei, enough: wei <= bnbShielded };
      } else {
        if (!tokPool) return undefined;
        const tokens = parseAmount(amt, decimals);
        const tip = BigInt(feeBnb.min) * NATIVE_UNIT;
        const delivered = deliveredFor(tokPool, tokens / tokPool.unit);
        const q = quotePrivateSell(worst, delivered, tip);
        if (q.out <= 0n) return { error: "proceeds would not cover the relayer" };
        return { out: q.out, fee: tip, curveFee: q.fee, inWei: tokens, enough: tokens <= tokShielded };
      }
    } catch { return { error: "invalid amount" }; }
  }, [curve, stored, block, feeBnb, side, amt, bnbPool, tokPool, decimals, bnbShielded, tokShielded]);

  async function trade() {
    if (!token || !quote || "error" in quote) return;
    setErr(undefined);
    try {
      if (side === "buy") await lp.buy(token, quote.inWei);
      else await lp.sell(token, quote.inWei);
    } catch (e) { setErr((e as Error).message); }
  }
  async function shieldTopUp() {
    if (!signer) return;
    setErr(undefined);
    try { await bunker.shield(BNB, parseAmount(topUp, 18), signer); setTopUp(""); if (owner) void bunker.scanWallet(owner); }
    catch (e) { setErr((e as Error).message); }
  }

  if (!valid) return <p className="font-mono text-[12px] text-bad">not a token address</p>;
  if (row === null && !stored) return <p className="font-mono text-[12px] text-dim">no curve at {raw}</p>;
  if (!curve || !meta) return <p className="font-mono text-[12px] text-dim">loading…</p>;

  const progress = Number(curve.realBnb * 10_000n / (lp.params?.graduationWei ?? BigInt(meta.graduation_wei))) / 10_000;
  const price = spotPrice(curve, decimals);
  const claims = lp.claims.filter((c) => c.token === token!.toLowerCase());

  return (
    <div className="max-w-6xl mx-auto rise">
      {meta.header ? <div className="aspect-[3/1] max-h-56 w-full overflow-hidden border rule mb-6"><img src={meta.header} alt="" className="w-full h-full object-cover" /></div> : null}
      <div className="flex flex-wrap items-start gap-4 mb-6">
        {meta.image ? <img src={meta.image} alt="" className="w-16 h-16 object-cover border rule" /> : <div className="w-16 h-16 border rule bg-bg" />}
        <div className="min-w-0">
          <div className="label-signal mb-1"><Link href="/launch" className="hover:text-fg">02 · Launchpad</Link> / {meta.symbol}</div>
          <h1 className="display text-3xl md:text-4xl truncate">{meta.name}</h1>
          <div className="mt-1 font-mono text-[11px] text-dim flex flex-wrap gap-3">
            <a href={explorerAddr(token!)} target="_blank" rel="noreferrer" className="hover:text-fg">{short(token!, 6)} ↗</a>
            <span>creator {short(meta.creator, 4)}</span>
            {curve.ammPair ? <a href={pancakeSwapUrl(token!)} target="_blank" rel="noreferrer" className="text-signal">trade on PancakeSwap ↗</a> : null}
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="label mb-1">price</div>
          <div className="display text-2xl num">{fmtPrice(price)} <span className="text-mute text-sm">BNB</span></div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_380px] gap-4">
        <div className="space-y-4">
          <section className="slab p-5">
            <div className="flex items-end justify-between font-mono text-[11px] mb-2">
              <span className="text-mute">{curve.graduated ? "graduated" : `${fmtProgress(progress)} to graduation`}</span>
              <span className="text-fg num">{fmtAmount(curve.realBnb, 18, 3)} / {fmtAmount(lp.params?.graduationWei ?? BigInt(meta.graduation_wei), 18, 0)} BNB</span>
            </div>
            <div className="meter"><i style={{ width: curve.graduated ? "100%" : barWidth(progress) }} /></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border rule mt-4">
              <Stat l="buys" v={curve.buys.toString()} />
              <Stat l="sells" v={curve.sells.toString()} />
              <Stat l="volume" v={`${fmtAmount(curve.bnbVolume, 18, 2)} BNB`} />
              <Stat l="fee" v={`${(curve.tradeFeeBps / 100).toFixed(2)}%`} />
            </div>
          </section>

          <section className="slab p-5">
            <h3 className="label mb-3">Trades</h3>
            {!row?.trades.length ? <p className="font-mono text-[11px] text-dim">none yet</p> : (
              <ul className="divide-y rule">
                {row.trades.slice(0, 40).map((t) => (
                  <li key={`${t.tx_hash}:${t.block}:${t.claim_key}`} className="py-2 flex items-center gap-3 font-mono text-[11px]">
                    <span className={`uppercase tracking-[0.15em] w-10 ${t.side === "buy" ? "text-signal" : "text-bad"}`}>{t.side}</span>
                    <span className="num text-fg">{fmtAmount(BigInt(t.bnb), 18, 4)} BNB</span>
                    <span className="text-dim">↔</span>
                    <span className="num text-mute">{fmtAmount(BigInt(t.tokens), decimals, 0)} {meta.symbol}</span>
                    <span className="ml-auto text-dim">{t.block_time ? timeAgo(t.block_time * 1000) : `blk ${t.block}`}</span>
                    <a href={explorerTx(t.tx_hash)} target="_blank" rel="noreferrer" className="text-steel hover:text-fg">↗</a>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {lp.params ? <FeePolicy curve={stored!} block={block} agentKeys={lp.params.agents} /> : null}
        </div>

        <div className="space-y-4">
          <section className="slab brackets p-5"><span className="bk" />
            {!ready ? (
              <div>
                <h3 className="label mb-3">Trade privately</h3>
                <p className="text-sm text-mute leading-relaxed mb-4">Buys are paid from your shielded BNB and the tokens land back in the vault. Nobody sees which wallet bought.</p>
                <Link href="/app" className="btn btn-signal w-full">open the vault</Link>
              </div>
            ) : curve.graduated ? (
              <div>
                <h3 className="label mb-3">Graduated</h3>
                <p className="text-sm text-mute leading-relaxed">This curve closed. Liquidity moved to PancakeSwap V2 and the LP tokens were burned. Your shielded {meta.symbol} can still be unshielded from the vault.</p>
              </div>
            ) : (
              <>
                <div className="flex gap-1 border-b rule mb-4">
                  <button className="tab" data-active={side === "buy"} onClick={() => { setSide("buy"); setAmt("0.05"); }}>buy</button>
                  <button className="tab" data-active={side === "sell"} onClick={() => { setSide("sell"); setAmt(fmtAmount(tokShielded / 2n, decimals, decimals).replace(/,/g, "")); }}>sell</button>
                </div>
                <div className="flex justify-between font-mono text-[11px] mb-2">
                  <span className="label">{side === "buy" ? "BNB in" : `${meta.symbol} in`}</span>
                  <span className="text-mute">vault: <span className="text-fg num">{side === "buy" ? fmtAmount(bnbShielded, 18, 4) : fmtAmount(tokShielded, decimals, 0)}</span></span>
                </div>
                <input className="field text-lg" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {side === "buy"
                    ? BUY_SIZES.map((s) => <button key={s} className="chip" data-active={amt === s} onClick={() => setAmt(s)}>{s}</button>)
                    : SELL_PARTS.map((p) => <button key={p} className="chip" onClick={() => setAmt(fmtAmount((tokShielded * BigInt(p)) / 100n, decimals, decimals).replace(/,/g, ""))}>{p}%</button>)}
                </div>
                <div className="mt-4 space-y-1.5 font-mono text-[11px] border-t rule pt-3">
                  {quote && !("error" in quote) ? (
                    <>
                      <Row l={side === "buy" ? "you receive ≈" : "you receive ≈"} v={side === "buy" ? `${fmtAmount(quote.out, decimals, 0)} ${meta.symbol}` : `${fmtAmount(quote.out, 18, 5)} BNB`} />
                      <Row l="curve fee" v={`${fmtAmount(quote.curveFee, 18, 5)} BNB`} />
                      <Row l={side === "buy" ? "relayer + claim gas" : "relayer tip"} v={`${fmtAmount(quote.fee, 18, 5)} BNB`} />
                      <Row l="slippage" v="1 % max" />
                    </>
                  ) : <span className="text-dim">{quote?.error ?? (feeBnb ? "—" : "relayer offline")}</span>}
                </div>
                <button className="btn btn-signal w-full h-12 mt-4" disabled={!quote || "error" in quote || !quote.enough || !!lp.busy} onClick={trade}>
                  {lp.busy ? lp.busy : quote && !("error" in quote) && !quote.enough ? "not enough in vault" : side === "buy" ? `buy ${meta.symbol}` : `sell ${meta.symbol}`}
                </button>
                {err ? <p className="mt-3 font-mono text-[11px] text-bad break-words">{err}</p> : null}
                {side === "buy" ? (
                  <div className="mt-5 border-t rule pt-4">
                    <div className="label mb-2">top up the vault from your wallet</div>
                    <div className="flex gap-1">
                      <input className="field h-9 text-[12px]" inputMode="decimal" placeholder="BNB" value={topUp} onChange={(e) => setTopUp(e.target.value)} />
                      <button className="btn btn-sm h-9" disabled={!signer || !topUp} onClick={shieldTopUp}>shield</button>
                    </div>
                    <p className="mt-2 font-mono text-[10px] text-dim">Shielding right before buying ties the two by timing. Better: shield a round amount, trade later.</p>
                  </div>
                ) : null}
              </>
            )}
          </section>

          {ready ? <Claims claims={claims} symbol={meta.symbol} /> : null}
          {ready && asset ? (
            <section className="slab p-5">
              <h3 className="label mb-2">Your position</h3>
              <div className="display text-2xl num">{fmtAmount(tokShielded, decimals, 0)} <span className="text-mute text-base">{meta.symbol}</span></div>
              <p className="mt-2 font-mono text-[10.5px] text-dim">≈ {fmtAmount(BigInt(Math.floor(Number(tokShielded) / 10 ** decimals * price * 1e9)) * 1_000_000_000n, 18, 5)} BNB at spot · shielded, unshield from the vault any time</p>
            </section>
          ) : null}
        </div>
      </div>
      <TxOverlay />
    </div>
  );
}

function Stat({ l, v }: { l: string; v: string }) {
  return <div className="bg-slab p-3"><div className="label text-[9.5px] mb-1">{l}</div><div className="font-mono text-sm num">{v}</div></div>;
}
function Row({ l, v }: { l: string; v: string }) {
  return <div className="flex justify-between"><span className="text-mute">{l}</span><span className="text-fg num">{v}</span></div>;
}

function Claims({ claims, symbol }: { claims: ClaimRecord[]; symbol: string }) {
  const lp = useLaunchpad();
  const [busy, setBusy] = useState(false);
  const pending = claims.filter((c) => c.status === "pending" || c.status === "failed");
  return (
    <section className="slab p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="label">Claims</h3>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { await lp.recover(); } finally { setBusy(false); } }}>{busy ? "sweeping" : "recover"}</button>
      </div>
      {claims.length === 0 ? <p className="font-mono text-[11px] text-dim">Each trade uses a one-off claim key that shields the result back automatically. If a tab closed mid-way, recover sweeps it.</p> : (
        <ul className="divide-y rule">
          {claims.slice(0, 12).map((c) => (
            <li key={c.nonce} className="py-2 flex items-center gap-3 font-mono text-[11px]">
              <span className={`w-1.5 h-1.5 ${c.status === "claimed" ? "bg-ok" : c.status === "failed" ? "bg-bad" : c.status === "empty" ? "bg-dim" : "bg-warn blink"}`} />
              <span className="uppercase tracking-[0.15em] text-mute">{c.kind}</span>
              <span className="text-dim">#{c.nonce}</span>
              <span className="text-fg">{c.status}</span>
              <span className="ml-auto text-dim">{timeAgo(c.at)}</span>
              {c.claimTxHash ? <a href={explorerTx(c.claimTxHash)} target="_blank" rel="noreferrer" className="text-steel hover:text-fg">↗</a> : null}
              {(c.status === "failed" || c.status === "pending") ? <button className="btn btn-ghost btn-sm" onClick={() => lp.claim(c).catch(() => undefined)}>retry</button> : null}
            </li>
          ))}
        </ul>
      )}
      {pending.length ? <p className="mt-2 font-mono text-[10px] text-warn">{pending.length} {symbol} claim(s) waiting; retry or recover.</p> : null}
    </section>
  );
}
