"use client";
// Two pictures of the vault: your balance over time (from the wallet's own
// ledger of received and spent notes) and the tree you hide in (leaves per
// day from the indexer, with your notes' positions marked). Plain SVG, no
// chart library; everything is computed from data already on the device.
import { useEffect, useMemo, useRef, useState } from "react";
import { amountForBurn, type LedgerEntry } from "@bunker/sdk";
import { useBunker } from "@/lib/store";
import { indexer } from "@/lib/api";
import type { AssetMeta } from "@/lib/config";

type Range = "7d" | "30d" | "all";
const RANGE_MS: Record<Range, number> = { "7d": 7 * 86400e3, "30d": 30 * 86400e3, all: Number.POSITIVE_INFINITY };

export function VaultCharts() {
  const s = useBunker();
  const assets = s.assets();
  const [token, setToken] = useState<string>(assets[0]?.token ?? "");
  const [range, setRange] = useState<Range>("30d");
  // assets with any history come first; the rest stay selectable
  const withHistory = useMemo(() => {
    const c = s.client;
    if (!c) return new Set<string>();
    return new Set(assets.filter((a) => c.history(a.token).length > 0).map((a) => a.token.toLowerCase()));
  }, [assets, s.client, s.notes.length, s.syncedTo]); // eslint-disable-line react-hooks/exhaustive-deps
  const asset = assets.find((a) => a.token.toLowerCase() === token.toLowerCase()) ?? assets[0];
  useEffect(() => {
    if (withHistory.size && !withHistory.has(token.toLowerCase())) setToken([...withHistory][0]);
  }, [withHistory]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="grid md:grid-cols-2 gap-4">
      <section className="slab p-5 md:p-6">
        <div className="flex items-center justify-between gap-3 mb-4">
          <h3 className="label flex items-center gap-2.5"><span className="inline-block w-1 h-3 bg-signal/80 rounded-sm" />Balance</h3>
          <div className="flex items-center gap-1">
            {(["7d", "30d", "all"] as Range[]).map((r) => <button key={r} className="chip h-6 px-1.5 text-[10px]" data-active={range === r} onClick={() => setRange(r)}>{r}</button>)}
          </div>
        </div>
        <div className="flex flex-wrap gap-1 mb-3">
          {assets.filter((a) => withHistory.has(a.token.toLowerCase()) || a.token === asset?.token).slice(0, 6).map((a) => (
            <button key={a.token} className="chip h-6 px-1.5 text-[10px]" data-active={a.token === asset?.token} onClick={() => setToken(a.token)}>{a.symbol}</button>
          ))}
        </div>
        {asset ? <BalanceChart asset={asset} range={range} /> : null}
      </section>
      <TreeChart />
    </div>
  );
}

// ---- balance over time

function BalanceChart({ asset, range }: { asset: AssetMeta; range: Range }) {
  const s = useBunker();
  const pool = s.pools[asset.token.toLowerCase()];
  const series = useMemo(() => {
    const c = s.client;
    if (!c || !pool) return [];
    const toAmt = (shares: bigint) => Number(amountForBurn(pool, shares) * pool.unit) / 10 ** asset.decimals;
    const ev: { t: number; d: number }[] = [];
    const h: LedgerEntry[] = c.history(asset.token);
    for (const e of h) {
      if (e.receivedAt != null) ev.push({ t: e.receivedAt * 1000, d: toAmt(e.value) });
      if (e.spentBlock != null) ev.push({ t: (e.spentAt ?? e.receivedAt ?? 0) * 1000, d: -toAmt(e.value) });
    }
    ev.sort((a, b) => a.t - b.t);
    const pts: { t: number; v: number }[] = [];
    let v = 0;
    for (const e of ev) { v += e.d; pts.push({ t: e.t, v: Math.max(0, v) }); }
    return pts;
  }, [s.client, pool, asset, s.notes.length, s.syncedTo, s.totalLeaves]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = Date.now();
  const from = range === "all" ? (series[0]?.t ?? now - 86400e3) : now - RANGE_MS[range];
  // step series clipped to the window, carrying the balance at `from` in
  let start = 0;
  for (const p of series) if (p.t <= from) start = p.v;
  const win = [{ t: Math.min(from, series[0]?.t ?? from), v: start }, ...series.filter((p) => p.t > from), { t: now, v: series.length ? series[series.length - 1].v : 0 }];
  const current = win[win.length - 1].v;
  const first = win[0].v;
  const delta = current - first;

  if (series.length === 0) return <Empty text="no notes yet · the curve starts with your first shield" />;
  return (
    <>
      <div className="flex items-baseline gap-3 mb-2">
        <div className="display text-2xl num metal">{trim(current)} <span className="text-mute text-sm font-sans">{asset.symbol}</span></div>
        {Math.abs(delta) > 0 ? <span className={`font-mono text-[11px] num ${delta >= 0 ? "text-ok" : "text-bad"}`}>{delta >= 0 ? "+" : "−"}{trim(Math.abs(delta))} · {range}</span> : null}
      </div>
      <Area pts={win} step unit={asset.symbol} />
    </>
  );
}

// ---- the tree

function TreeChart() {
  const s = useBunker();
  const [daily, setDaily] = useState<{ day: string; txs: number }[]>();
  const [leaves, setLeaves] = useState(0);
  useEffect(() => {
    indexer.stats(30).then((r) => { setDaily(r.daily); setLeaves(r.leaves); }).catch(() => setDaily([]));
  }, [s.totalLeaves]);
  const pts = useMemo(() => {
    if (!daily) return [];
    // cumulative leaves per day, anchored so the last day ends at the total
    const days: { day: string; txs: number }[] = [];
    const byDay = new Map(daily.map((d) => [d.day, d.txs]));
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
      days.push({ day: d, txs: byDay.get(d) ?? 0 });
    }
    const total = days.reduce((n, d) => n + d.txs, 0);
    let cum = Math.max(0, leaves - total);
    return days.map((d) => { cum += d.txs; return { t: Date.parse(d.day + "T00:00:00Z"), v: cum, bar: d.txs }; });
  }, [daily, leaves]);
  const mine = s.notes.length;
  const share = leaves > 0 ? (mine / leaves) * 100 : 0;
  const peak = Math.max(1, ...pts.map((p) => p.bar));

  return (
    <section className="slab p-5 md:p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="label flex items-center gap-2.5"><span className="inline-block w-1 h-3 bg-steel/80 rounded-sm" />The tree · 30d</h3>
        <span className="font-mono text-[10px] text-dim">leaves per day</span>
      </div>
      <div className="flex items-baseline gap-3 mb-2">
        <div className="display text-2xl num metal">{leaves.toLocaleString()} <span className="text-mute text-sm font-sans">leaves</span></div>
        <span className="font-mono text-[11px] text-dim num">{mine} yours · {share < 0.01 && share > 0 ? "<0.01" : share.toFixed(2)}% of the crowd</span>
      </div>
      {!daily ? <Empty text="loading…" /> : pts.length === 0 ? <Empty text="no activity yet" /> : (
        <div className="relative">
          <Area pts={pts} color="var(--color-steel)" unit="leaves" />
          <div className="absolute inset-x-0 bottom-0 h-8 flex items-end gap-px pointer-events-none px-px">
            {pts.map((p) => <i key={p.t} className="flex-1 bg-steel/30" style={{ height: `${(p.bar / peak) * 100}%` }} />)}
          </div>
        </div>
      )}
    </section>
  );
}

// ---- svg

function Area({ pts, step, color = "var(--color-signal)", unit }: { pts: { t: number; v: number }[]; step?: boolean; color?: string; unit: string }) {
  const W = 600, H = 150, PAD = 6;
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number>();
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1;
  const vmax = Math.max(1e-12, ...pts.map((p) => p.v));
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => H - PAD - (v / vmax) * (H - 2 * PAD - 18);
  let d = `M${x(pts[0].t)},${y(pts[0].v)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    d += step ? ` H${x(p.t)} V${y(p.v)}` : ` L${x(p.t)},${y(p.v)}`;
  }
  const area = `${d} V${H - PAD} H${x(pts[0].t)} Z`;
  const id = useMemo(() => "g" + Math.random().toString(36).slice(2, 8), []);
  const hp = hover !== undefined ? pts[hover] : undefined;
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
    let best = 0;
    for (let i = 0; i < pts.length; i++) if (pts[i].t <= t) best = i;
    setHover(best);
  };
  return (
    <div className="relative">
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full h-[150px] block" preserveAspectRatio="none" onMouseMove={onMove} onMouseLeave={() => setHover(undefined)}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={PAD} x2={W - PAD} y1={y(vmax * f)} y2={y(vmax * f)} stroke="rgb(236 235 228 / 0.06)" strokeWidth="1" />)}
        <path d={area} fill={`url(#${id})`} />
        <path d={d} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
        {hp ? <>
          <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD} y2={H - PAD} stroke="rgb(236 235 228 / 0.25)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <circle cx={x(hp.t)} cy={y(hp.v)} r="3.5" fill={color} stroke="#08080a" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </> : null}
      </svg>
      <div className="flex justify-between font-mono text-[9.5px] text-dim mt-1 num">
        <span>{fmtDate(t0)}</span>
        {hp ? <span className="text-mute">{fmtDate(hp.t, true)} · <span className="text-fg">{trim(hp.v)}</span> {unit}</span> : <span>max {trim(vmax)}</span>}
        <span>{fmtDate(t1)}</span>
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="h-[150px] well flex items-center justify-center font-mono text-[11px] text-dim text-center px-6">{text}</div>;
}

function trim(v: number): string {
  if (v === 0) return "0";
  if (v >= 1000) return Math.round(v).toLocaleString();
  if (v >= 1) return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return v.toPrecision(3).replace(/\.?0+$/, "");
}
function fmtDate(t: number, withTime = false) {
  const d = new Date(t);
  const day = `${d.toLocaleString("en", { month: "short" })} ${d.getDate()}`;
  return withTime ? `${day} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : day;
}
