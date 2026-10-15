"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { getAddress, isAddress } from "viem";
import { rolled, pancakeSwapUrl, spotPrice } from "@bunker/sdk";
import { indexer, type FeeEventRow, type LaunchRow, type TradeRow } from "@/lib/api";
import { assetOf, useLaunchpad, type BuyQuote, type SellQuote } from "@/lib/launchpad";
import { queuedAmount, shieldedAmount, useBunker } from "@/lib/store";
import { useLegacy } from "@/lib/legacy";
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
  const router = useRouter();
  const legacy = useLegacy();
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
    // old links to a protocol-v1 token keep working: hand them to the v1 page
    if (legacy.phase !== "off") void legacy.launch(token).then((r) => { if (r) router.replace(`/launch/v1/${token}`); });
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
  const bnbSettling = queuedAmount(bunker, BNB);
  const tokShielded = asset ? shieldedAmount(bunker, asset) : 0n;
  const tokSettling = asset ? queuedAmount(bunker, asset) : 0n;
  const ready = bunker.phase === "ready" && !bunker.watchOnly;

  // the amount typed, in base units
  const inAmount = useMemo(() => { try { return parseAmount(amt, side === "buy" ? 18 : decimals); } catch { return null; } }, [amt, side, decimals]);
  type Quote = { out: bigint; curveFee: bigint; fee: bigint; feeSymbol: string; inWei: bigint; enough: boolean; settling: boolean; note?: string } | { error: string };
  const [quote, setQuote] = useState<Quote>();

  // quotes read the curve and the pools at the current block; debounce the typing
  useEffect(() => {
    if (!token || !curve || curve.graduated || !ready) { setQuote(undefined); return; }
    if (inAmount === null) { setQuote({ error: "invalid amount" }); return; }
    if (inAmount <= 0n) { setQuote(undefined); return; }
    let alive = true;
    const id = setTimeout(async () => {
      try {
        if (side === "buy") {
          const q: BuyQuote = await lp.quoteBuy(token, inAmount);
          const total = inAmount + q.relayerFee;
          if (!alive) return;
          if (q.overshoots) setQuote({ error: `the curve only has room for ${fmtAmount(q.maxIn, 18, 4)} BNB more` });
          else setQuote({ out: q.out, curveFee: q.curveFee, fee: q.relayerFee, feeSymbol: "BNB", inWei: inAmount, enough: total <= bnbShielded, settling: total > bnbShielded && total <= bnbShielded + bnbSettling });
        } else {
          const q: SellQuote = await lp.quoteSell(token, inAmount);
          const total = inAmount + q.relayerFeeTokens;
          if (!alive) return;
          if (q.out <= 0n) setQuote({ error: "proceeds would be nothing" });
          else setQuote({ out: q.out, curveFee: q.curveFee, fee: q.relayerFeeTokens, feeSymbol: meta?.symbol ?? "tokens", inWei: inAmount, enough: total <= tokShielded, settling: total > tokShielded && total <= tokShielded + tokSettling });
        }
      } catch (e) { if (alive) setQuote({ error: (e as Error).message }); }
    }, 350);
    return () => { alive = false; clearTimeout(id); };
  }, [token, side, inAmount, ready, block, bnbShielded, bnbSettling, tokShielded, tokSettling]); // eslint-disable-line react-hooks/exhaustive-deps

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
                {row.trades.slice(0, 40).map((t, i) => (
                  <li key={`${t.tx_hash}:${t.block}:${i}`} className="py-2 flex items-center gap-3 font-mono text-[11px]">
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
                <p className="text-sm text-mute leading-relaxed mb-4">Buys are paid from your shielded BNB and the tokens land back in the vault in the same transaction. Nobody sees which wallet bought.</p>
                <Link href="/app" className="btn btn-signal w-full">{bunker.watchOnly ? "watch-only vault: open with the seed to trade" : "open the vault"}</Link>
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
                      <Row l="you receive ≈" v={side === "buy" ? `${fmtAmount(quote.out, decimals, 0)} ${meta.symbol}` : `${fmtAmount(quote.out, 18, 5)} BNB`} />
                      <Row l="curve fee" v={`${fmtAmount(quote.curveFee, 18, 5)} BNB`} />
                      <Row l="relayer fee (private note)" v={side === "buy" ? `${fmtAmount(quote.fee, 18, 5)} BNB` : `${fmtAmount(quote.fee, decimals, 0)} ${quote.feeSymbol}`} />
                      <Row l="slippage" v="1 % max" />
                    </>
                  ) : <span className={quote?.error ? "text-bad" : "text-dim"}>{quote?.error ?? (bunker.relayer ? "—" : "relayer offline")}</span>}
                </div>
                <button className="btn btn-signal w-full h-12 mt-4" disabled={!quote || "error" in quote || (!quote.enough && !quote.settling) || !!lp.busy} onClick={trade}>
                  {lp.busy ? lp.busy : quote && !("error" in quote) && !quote.enough ? (quote.settling ? `${side} ${meta.symbol} (settles first)` : "not enough in vault") : side === "buy" ? `buy ${meta.symbol}` : `sell ${meta.symbol}`}
                </button>
                <p className="mt-2 font-mono text-[10px] text-dim">One relayed transaction: the pool pays the curve, the curve pays the pool back, and the result is a fresh note of yours. No claim key, no gas from you.</p>
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

          {bunker.phase === "ready" && asset ? (
            <section className="slab p-5">
              <h3 className="label mb-2">Your position</h3>
              <div className="display text-2xl num">{fmtAmount(tokShielded + tokSettling, decimals, 0)} <span className="text-mute text-base">{meta.symbol}</span></div>
              <p className="mt-2 font-mono text-[10.5px] text-dim">
                ≈ {fmtAmount(BigInt(Math.floor(Number(tokShielded + tokSettling) / 10 ** decimals * price * 1e9)) * 1_000_000_000n, 18, 5)} BNB at spot · shielded, unshield from the vault any time
                {tokSettling > 0n ? ` · ${fmtAmount(tokSettling, decimals, 0)} settling` : ""}
              </p>
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
