"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getAddress, isAddress } from "viem";
import { pancakeSwapUrl, spotPrice, type LaunchRow, type TradeRow, type FeeEventRow } from "@bunker/sdk-v1";
import { useLegacy } from "@/lib/legacy";
import { useBunker } from "@/lib/store";
import { useSigner } from "@/lib/useSigner";
import { explorerAddr, explorerTx, LAUNCHPAD_V1_ADDRESS } from "@/lib/config";
import { fmtAmount, fmtPrice, fmtProgress, barWidth, parseAmount, short, timeAgo } from "@/lib/format";
import { TxOverlay } from "@/components/TxOverlay";

const BUY_SIZES = ["0.01", "0.05", "0.1", "0.5"];
const SELL_PARTS = [25, 50, 100];
const NATIVE = "0x0000000000000000000000000000000000000000";

/**
 * A token launched on the protocol-v1 launchpad. Its curve lives in the
 * first (immutable) launchpad contract and still trades: buys spend v1 BNB
 * notes, proceeds land in the v1 pool and can be migrated to v2 from the vault.
 */
export default function LegacyTokenPage() {
  const { token: raw } = useParams<{ token: string }>();
  const valid = isAddress(raw);
  const token = valid ? getAddress(raw) : undefined;
  const lg = useLegacy();
  const bunker = useBunker();
  const signer = useSigner();
  const [row, setRow] = useState<(LaunchRow & { trades: TradeRow[]; feeEvents: FeeEventRow[] }) | null>();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("0.05");
  const [err, setErr] = useState<string>();
  const [topUp, setTopUp] = useState("");

  useEffect(() => {
    if (!token) return;
    const load = () => lg.launch(token).then(setRow);
    void load();
    const id = setInterval(() => void load(), 10_000);
    return () => clearInterval(id);
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = row ?? undefined;
  const decimals = meta?.decimals ?? 6;
  const bnb = lg.holdings.find((h) => h.token.toLowerCase() === NATIVE)?.amount ?? 0n;
  const tok = token ? lg.holdings.find((h) => h.token.toLowerCase() === token.toLowerCase())?.amount ?? 0n : 0n;
  const ready = lg.phase === "ready" && bunker.phase === "ready" && !bunker.watchOnly;

  const inAmount = useMemo(() => { try { return parseAmount(amt, side === "buy" ? 18 : decimals); } catch { return null; } }, [amt, side, decimals]);
  type Quote = { out: bigint; curveFee: bigint; fee: bigint; feeLabel: string; inWei: bigint; enough: boolean } | { error: string };
  const [quote, setQuote] = useState<Quote>();

  useEffect(() => {
    if (!token || !meta || meta.graduated || !ready) { setQuote(undefined); return; }
    if (inAmount === null) { setQuote({ error: "invalid amount" }); return; }
    if (inAmount <= 0n) { setQuote(undefined); return; }
    let alive = true;
    const id = setTimeout(async () => {
      try {
        if (side === "buy") {
          const q = await lg.quoteBuy(token, inAmount);
          if (!alive) return;
          setQuote({ out: q.out, curveFee: q.curveFee, fee: q.relayerFee + q.claimBudget, feeLabel: "relayer fee + claim gas", inWei: inAmount, enough: inAmount <= bnb });
        } else {
          const q = await lg.quoteSell(token, inAmount);
          if (!alive) return;
          if (q.out <= 0n) setQuote({ error: "proceeds would be nothing" });
          else setQuote({ out: q.out, curveFee: q.curveFee, fee: q.relayerTip, feeLabel: "relayer tip", inWei: inAmount, enough: inAmount <= tok });
        }
      } catch (e) { if (alive) setQuote({ error: (e as Error).message }); }
    }, 350);
    return () => { alive = false; clearTimeout(id); };
  }, [token, side, inAmount, ready, bnb, tok, meta?.block]); // eslint-disable-line react-hooks/exhaustive-deps

  async function trade() {
    if (!token || !meta || !quote || "error" in quote) return;
    setErr(undefined);
    try {
      if (side === "buy") await lg.buy(token, meta.symbol, decimals, quote.inWei);
      else await lg.sell(token, meta.symbol, decimals, quote.inWei);
      void lg.launch(token).then(setRow);
    } catch (e) { setErr((e as Error).message); }
  }
  async function shieldTopUp() {
    if (!signer) return;
    setErr(undefined);
    try { await lg.topUp(parseAmount(topUp, 18), signer); setTopUp(""); } catch (e) { setErr((e as Error).message); }
  }

  if (!valid) return <p className="font-mono text-[12px] text-bad">not a token address</p>;
  if (lg.phase === "off") return <p className="font-mono text-[12px] text-dim">no protocol-v1 launchpad on this network</p>;
  if (row === null) return <p className="font-mono text-[12px] text-dim">no v1 curve at {raw}</p>;
  if (!meta) return <p className="font-mono text-[12px] text-dim">loading…</p>;

  const realBnb = BigInt(meta.real_bnb);
  const graduationWei = BigInt(meta.graduation_wei);
  const progress = Number(realBnb * 10_000n / graduationWei) / 10_000;
  const price = spotPrice({ virtualBnb: BigInt(meta.virtual_bnb), realBnb, virtualToken: BigInt(meta.virtual_token), realToken: BigInt(meta.real_token) }, decimals);

  return (
    <div className="max-w-6xl mx-auto rise">
      {meta.header ? <div className="aspect-[3/1] max-h-56 w-full overflow-hidden border rule mb-6"><img src={meta.header} alt="" className="w-full h-full object-cover" /></div> : null}
      <div className="flex flex-wrap items-start gap-4 mb-6">
        {meta.image ? <img src={meta.image} alt="" className="w-16 h-16 object-cover border rule" /> : <div className="w-16 h-16 border rule bg-bg" />}
        <div className="min-w-0">
          <div className="label-signal mb-1"><Link href="/launch" className="hover:text-fg">02 · Launchpad</Link> / {meta.symbol} <span className="ml-2 font-mono text-[9px] tracking-[0.2em] text-dim border rule px-1.5 py-0.5">PROTOCOL V1</span></div>
          <h1 className="display text-3xl md:text-4xl truncate">{meta.name}</h1>
          <div className="mt-1 font-mono text-[11px] text-dim flex flex-wrap gap-3">
            <a href={explorerAddr(token!)} target="_blank" rel="noreferrer" className="hover:text-fg">{short(token!, 6)} ↗</a>
            <span>creator {short(meta.creator, 4)}</span>
            {LAUNCHPAD_V1_ADDRESS ? <a href={explorerAddr(LAUNCHPAD_V1_ADDRESS)} target="_blank" rel="noreferrer" className="hover:text-fg">v1 launchpad {short(LAUNCHPAD_V1_ADDRESS, 4)} ↗</a> : null}
            {meta.amm_pair ? <a href={pancakeSwapUrl(token!)} target="_blank" rel="noreferrer" className="text-signal">trade on PancakeSwap ↗</a> : null}
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
              <span className="text-mute">{meta.graduated ? "graduated" : `${fmtProgress(progress)} to graduation`}</span>
              <span className="text-fg num">{fmtAmount(realBnb, 18, 3)} / {fmtAmount(graduationWei, 18, 0)} BNB</span>
            </div>
            <div className="meter"><i style={{ width: meta.graduated ? "100%" : barWidth(progress) }} /></div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-line border rule mt-4">
              <Stat l="buys" v={String(meta.buys)} />
              <Stat l="sells" v={String(meta.sells)} />
              <Stat l="volume" v={`${fmtAmount(BigInt(meta.bnb_volume), 18, 2)} BNB`} />
              <Stat l="launched" v={meta.block_time ? timeAgo(meta.block_time * 1000) : `blk ${meta.block}`} />
            </div>
          </section>

          <section className="slab p-5">
            <h3 className="label mb-3">Trades</h3>
            {!meta.trades.length ? <p className="font-mono text-[11px] text-dim">none yet</p> : (
              <ul className="divide-y rule">
                {meta.trades.slice(0, 40).map((t, i) => (
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

          <section className="slab p-5">
            <h3 className="label mb-2">About protocol v1 tokens</h3>
            <p className="font-mono text-[10.5px] text-dim leading-relaxed">
              This curve was launched on the first BUNKER launchpad. The contract is immutable, so the curve, its reserves and every holder&apos;s tokens stay exactly where they are; it keeps trading here with the v1 circuits. A buy spends BNB from your v1 notes and the tokens are claimed into the v1 pool; from the vault you can migrate any v1 balance into v2 in one relayed transaction.
            </p>
          </section>
        </div>

        <div className="space-y-4">
          <section className="slab brackets p-5"><span className="bk" />
            {!ready ? (
              <div>
                <h3 className="label mb-3">Trade privately (v1)</h3>
                <p className="text-sm text-mute leading-relaxed mb-4">Open the vault; the same seed opens your v1 notes. Buys spend v1 BNB, and the tokens come back as a v1 note.</p>
                <Link href="/app" className="btn btn-signal w-full">{bunker.watchOnly ? "watch-only vault: open with the seed to trade" : lg.phase === "opening" ? "scanning v1…" : "open the vault"}</Link>
              </div>
            ) : meta.graduated ? (
              <div>
                <h3 className="label mb-3">Graduated</h3>
                <p className="text-sm text-mute leading-relaxed">This curve closed and its liquidity moved to PancakeSwap V2. Your v1 {meta.symbol} can be migrated or withdrawn from the vault.</p>
              </div>
            ) : (
              <>
                <div className="flex gap-1 border-b rule mb-4">
                  <button className="tab" data-active={side === "buy"} onClick={() => { setSide("buy"); setAmt("0.05"); }}>buy</button>
                  <button className="tab" data-active={side === "sell"} onClick={() => { setSide("sell"); setAmt(fmtAmount(tok / 2n, decimals, decimals).replace(/,/g, "")); }}>sell</button>
                </div>
                <div className="flex justify-between font-mono text-[11px] mb-2">
                  <span className="label">{side === "buy" ? "BNB in (v1 notes)" : `${meta.symbol} in`}</span>
                  <span className="text-mute">v1 vault: <span className="text-fg num">{side === "buy" ? fmtAmount(bnb, 18, 4) : fmtAmount(tok, decimals, 0)}</span></span>
                </div>
                <input className="field text-lg" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {side === "buy"
                    ? BUY_SIZES.map((s) => <button key={s} className="chip" data-active={amt === s} onClick={() => setAmt(s)}>{s}</button>)
                    : SELL_PARTS.map((p) => <button key={p} className="chip" onClick={() => setAmt(fmtAmount((tok * BigInt(p)) / 100n, decimals, decimals).replace(/,/g, ""))}>{p}%</button>)}
                </div>
                <div className="mt-4 space-y-1.5 font-mono text-[11px] border-t rule pt-3">
                  {quote && !("error" in quote) ? (
                    <>
                      <Row l="you receive ≈" v={side === "buy" ? `${fmtAmount(quote.out, decimals, 0)} ${meta.symbol}` : `${fmtAmount(quote.out, 18, 5)} BNB`} />
                      <Row l="curve fee" v={`${fmtAmount(quote.curveFee, 18, 5)} BNB`} />
                      <Row l={quote.feeLabel} v={`${fmtAmount(quote.fee, 18, 5)} BNB`} />
                      <Row l="slippage" v="1 % max" />
                    </>
                  ) : <span className={quote?.error ? "text-bad" : "text-dim"}>{quote?.error ?? "—"}</span>}
                </div>
                <button className="btn btn-signal w-full h-12 mt-4" disabled={!quote || "error" in quote || !quote.enough || !!lg.busy} onClick={trade}>
                  {lg.busy ? lg.busy : quote && !("error" in quote) && !quote.enough ? "not enough in the v1 vault" : side === "buy" ? `buy ${meta.symbol}` : `sell ${meta.symbol}`}
                </button>
                <p className="mt-2 font-mono text-[10px] text-dim">Two transactions as in v1: the relayed trade, then a claim from a throwaway key funded by the trade itself. The result is a v1 note; migrate it from the vault whenever you like.</p>
                {err ? <p className="mt-3 font-mono text-[11px] text-bad break-words">{err}</p> : null}
                {side === "buy" ? (
                  <div className="mt-5 border-t rule pt-4">
                    <div className="label mb-2">top up the v1 vault from your wallet</div>
                    <div className="flex gap-1">
                      <input className="field h-9 text-[12px]" inputMode="decimal" placeholder="BNB" value={topUp} onChange={(e) => setTopUp(e.target.value)} />
                      <button className="btn btn-sm h-9" disabled={!signer || !topUp || !!lg.busy} onClick={shieldTopUp}>shield</button>
                    </div>
                    <p className="mt-2 font-mono text-[10px] text-dim">Buys on a v1 curve are paid from v1 notes. This shields BNB into the first pool; your v2 balance is separate.</p>
                  </div>
                ) : null}
              </>
            )}
          </section>

          {lg.phase === "ready" ? (
            <section className="slab p-5">
              <h3 className="label mb-2">Your v1 position</h3>
              <div className="display text-2xl num">{fmtAmount(tok, decimals, 0)} <span className="text-mute text-base">{meta.symbol}</span></div>
              <p className="mt-2 font-mono text-[10.5px] text-dim">≈ {fmtAmount(BigInt(Math.floor(Number(tok) / 10 ** decimals * price * 1e9)) * 1_000_000_000n, 18, 5)} BNB at spot · in the v1 pool · <Link href="/app" className="text-steel hover:text-fg">migrate or withdraw from the vault</Link></p>
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
