"use client";
import { useEffect, useState } from "react";
import { indexer } from "@/lib/api";
import { ASSETS } from "@/lib/config";
import { useScash } from "@/lib/store";

type Stats = Awaited<ReturnType<typeof indexer.stats>>;

export function AnonymityPanel() {
  const [s, setS] = useState<Stats | null>(null);
  const relayer = useScash((st) => st.relayer);
  useEffect(() => {
    const load = () => indexer.stats(30).then(setS).catch(() => undefined);
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, []);

  const sol = s?.perMint[ASSETS[0].mint.toBase58()];
  const recent = sol ? sol.shields : 0;
  const grade = recent >= 500 ? "strong" : recent >= 50 ? "moderate" : "thin";
  const wait = recent >= 500 ? "a few hours" : recent >= 50 ? "about a day" : "several days";
  const color = grade === "strong" ? "text-ok" : grade === "moderate" ? "text-warn" : "text-bad";
  const pct = Math.min(100, Math.round((Math.log10(recent + 1) / 3) * 100));

  return (
    <section className="glass p-5">
      <div className="flex items-center justify-between">
        <span className="label">Privacy set · {ASSETS[0].symbol}</span>
        <span className={`text-xs ${color}`}>{grade}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
        <div className="h-full rounded-full bg-gradient-to-r from-accent to-accent-2 transition-all" style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <Stat k="deposits" v={sol ? sol.shields.toLocaleString() : "—"} />
        <Stat k="withdrawals" v={sol ? sol.unshields.toLocaleString() : "—"} />
        <Stat k="notes, all assets" v={s ? s.leaves.toLocaleString() : "—"} />
        <Stat k="relayer queue" v={relayer ? String(relayer.queued) : "—"} />
      </dl>
      <p className="mt-4 text-[11px] leading-relaxed text-dim">
        You hide among {ASSETS[0].symbol} notes only. Wait {wait} between shielding and withdrawing, use round amounts, withdraw to a fresh wallet.
      </p>
    </section>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dd className="text-base tabular-nums">{v}</dd>
      <dt className="text-dim">{k}</dt>
    </div>
  );
}
