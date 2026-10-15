"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { useLaunchpad } from "@/lib/launchpad";
import { useBunker } from "@/lib/store";
import { useLegacy } from "@/lib/legacy";
import { useSigner } from "@/lib/useSigner";
import { fmtAmount, fmtProgress, barWidth, timeAgo } from "@/lib/format";
import type { LaunchRow } from "@/lib/api";

const MAX_IMG = 4.5 * 1024 * 1024;

export default function LaunchIndex() {
  const lp = useLaunchpad();
  const phase = useBunker((s) => s.phase);
  const [tab, setTab] = useState<"live" | "graduated">("live");
  const [q, setQ] = useState("");
  const [create, setCreate] = useState(false);
  const legacy = useLegacy();
  useEffect(() => { void lp.load(); void legacy.loadLaunches(); const id = setInterval(() => { void lp.load(); void legacy.loadLaunches(); }, 15_000); return () => clearInterval(id); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // v2 curves first, then the protocol-v1 curves (still trading on the first launchpad), newest first within each
  const all = useMemo<(LaunchRow & { v1?: boolean })[]>(() => [...lp.launches, ...legacy.launches.map((l) => ({ ...l, v1: true }))], [lp.launches, legacy.launches]);
  const rows = useMemo(() => all.filter((l) => (tab === "live" ? !l.graduated : !!l.graduated)).filter((l) => !q || `${l.name} ${l.symbol} ${l.token}`.toLowerCase().includes(q.toLowerCase())), [all, tab, q]);

  return (
    <div className="max-w-6xl mx-auto rise">
      <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
        <div>
          <div className="label-signal mb-2">02 · Launchpad</div>
          <h1 className="display text-3xl md:text-4xl">Curves that trade from the vault</h1>
        </div>
        <button className="btn btn-signal" onClick={() => setCreate(!create)}>{create ? "close" : "launch a token"}</button>
      </div>

      {create ? <CreateForm onDone={() => setCreate(false)} /> : null}

      <div className="flex flex-wrap items-center gap-3 border-b rule mb-4">
        <button className="tab" data-active={tab === "live"} onClick={() => setTab("live")}>on the curve</button>
        <button className="tab" data-active={tab === "graduated"} onClick={() => setTab("graduated")}>graduated</button>
        <input className="field h-8 w-56 ml-auto text-[11px] mb-1" placeholder="search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {!lp.loaded && !legacy.launchesLoaded ? <p className="font-mono text-[11px] text-dim">loading…</p> : rows.length === 0 ? (
        <p className={`font-mono text-[11px] py-10 text-center ${lp.loadError ? "text-warn" : "text-dim"}`}>{lp.loadError ?? "nothing here yet"}</p>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-px bg-line border rule">
          {rows.map((l) => <LaunchCard key={l.token} l={l} />)}
        </div>
      )}
      {phase !== "ready" ? <p className="mt-6 font-mono text-[11px] text-dim">Open the <Link href="/app" className="text-steel hover:text-fg">vault</Link> to trade. Browsing needs nothing.</p> : null}
    </div>
  );
}

function LaunchCard({ l }: { l: LaunchRow & { v1?: boolean } }) {
  const progress = Number(BigInt(l.real_bnb) * 10_000n / BigInt(l.graduation_wei)) / 10_000;
  const x = BigInt(l.virtual_bnb) + BigInt(l.real_bnb);
  const price = Number(x) / Number(BigInt(l.virtual_token)) * 10 ** l.decimals;
  return (
    <Link href={l.v1 ? `/launch/v1/${l.token}` : `/launch/${l.token}`} className="bg-slab p-5 hover:bg-slab-2 transition group">
      <div className="flex items-start gap-3 mb-4">
        {l.image ? <img src={l.image} alt="" className="w-12 h-12 object-cover border rule" /> : <div className="w-12 h-12 border rule bg-bg" />}
        <div className="min-w-0">
          <div className="display text-lg truncate group-hover:text-signal transition">{l.symbol}{l.v1 ? <span className="ml-2 align-middle font-mono text-[9px] tracking-[0.2em] text-dim border rule px-1.5 py-0.5">V1</span> : null}</div>
          <div className="text-xs text-mute truncate">{l.name}</div>
        </div>
        <span className="ml-auto font-mono text-[10px] text-dim">{l.block_time ? timeAgo(l.block_time * 1000) : "pending"}</span>
      </div>
      <div className="flex items-end justify-between font-mono text-[11px] mb-2">
        <span className="text-mute">{l.graduated ? "on PancakeSwap" : `${fmtProgress(progress)} to graduation`}</span>
        <span className="text-fg num">{fmtAmount(BigInt(l.real_bnb), 18, 3)} BNB</span>
      </div>
      <div className="meter"><i style={{ width: l.graduated ? "100%" : barWidth(progress) }} /></div>
      <div className="mt-3 flex justify-between font-mono text-[10.5px] text-dim">
        <span>{price.toExponential(2)} BNB</span>
        <span>{l.buys + l.sells} trades</span>
      </div>
    </Link>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const lp = useLaunchpad();
  const signer = useSigner();
  const isConnected = useWallet((w) => !!w.address);
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [desc, setDesc] = useState("");
  const [image, setImage] = useState<string>();
  const [header, setHeader] = useState<string>();
  const [err, setErr] = useState<string>();
  const [out, setOut] = useState<string>();

  const pick = (set: (s: string) => void, square: boolean) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (f.size > MAX_IMG) { setErr("image larger than 4.5 MB"); return; }
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      const img = new Image();
      img.onload = () => {
        if (square && Math.abs(img.width - img.height) > img.width * 0.05) { setErr("icon must be square"); return; }
        if (!square && Math.abs(img.width / img.height - 3) > 0.2) { setErr("header should be 3:1"); return; }
        setErr(undefined); set(url);
      };
      img.src = url;
    };
    r.readAsDataURL(f);
  };

  async function go() {
    setErr(undefined);
    if (!signer) { setErr("connect a wallet"); return; }
    if (!image) { setErr("an icon is required"); return; }
    try {
      const token = await lp.launch({ name: name.trim(), symbol: symbol.trim().toUpperCase(), description: desc.trim() || undefined, image, header }, signer);
      setOut(token);
    } catch (e) { setErr((e as Error).message); }
  }

  if (out) return (
    <div className="slab brackets p-6 mb-8"><span className="bk" />
      <div className="label-signal mb-2">Launched</div>
      <p className="font-mono text-[12px] break-all mb-4">{out}</p>
      <div className="flex gap-2"><Link href={`/launch/${out}`} className="btn btn-signal btn-sm">open</Link><button className="btn btn-sm" onClick={onDone}>done</button></div>
    </div>
  );

  return (
    <div className="slab brackets p-6 mb-8 grid md:grid-cols-[1fr_280px] gap-6"><span className="bk" />
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <div><label className="label block mb-2">name</label><input className="field" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} /></div>
          <div><label className="label block mb-2">symbol</label><input className="field uppercase" value={symbol} maxLength={10} onChange={(e) => setSymbol(e.target.value)} /></div>
        </div>
        <div><label className="label block mb-2">description</label><textarea className="field text-[13px]" rows={3} maxLength={400} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
        <p className="font-mono text-[10.5px] text-dim leading-relaxed">
          The launch is a public transaction from your wallet (the creator is on chain). {lp.params ? `${fmtAmount(lp.params.curveSupply, lp.params.decimals, 0)} of ${fmtAmount(lp.params.totalSupply, lp.params.decimals, 0)} tokens sell on the curve; at ${fmtAmount(lp.params.graduationWei, 18, 0)} BNB raised it graduates to PancakeSwap V2 and the LP is burned.` : ""}
        </p>
        <div className="flex items-center gap-3">
          <button className="btn btn-signal" disabled={!isConnected || !name.trim() || !symbol.trim() || !image || !!lp.busy} onClick={go}>{lp.busy === "launch" ? "launching" : "launch"}</button>
          {err ? <span className="font-mono text-[11px] text-bad">{err}</span> : null}
        </div>
      </div>
      <div className="space-y-3">
        <label className="block">
          <span className="label block mb-2">icon · square · required</span>
          <div className="aspect-square border rule bg-bg flex items-center justify-center overflow-hidden cursor-pointer hover:border-signal transition">
            {image ? <img src={image} alt="" className="w-full h-full object-cover" /> : <span className="font-mono text-[11px] text-dim">click to choose</span>}
          </div>
          <input type="file" accept="image/*" className="hidden" onChange={pick(setImage, true)} />
        </label>
        <label className="block">
          <span className="label block mb-2">header · 3:1 · optional</span>
          <div className="aspect-[3/1] border rule bg-bg flex items-center justify-center overflow-hidden cursor-pointer hover:border-signal transition">
            {header ? <img src={header} alt="" className="w-full h-full object-cover" /> : <span className="font-mono text-[11px] text-dim">click to choose</span>}
          </div>
          <input type="file" accept="image/*" className="hidden" onChange={pick(setHeader, false)} />
        </label>
      </div>
    </div>
  );
}
