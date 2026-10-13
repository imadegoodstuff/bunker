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

  const max = Math.max(1, ...(s?.daily.map((d) => d.txs) ?? [1]));
  const sol = s?.perMint[ASSETS[0].mint.toBase58()];
  const recent = sol ? sol.shields : 0;
  const grade = recent >= 500 ? "strong" : recent >= 50 ? "moderate" : "thin";
  const wait = recent >= 500 ? "a few hours" : recent >= 50 ? "about a day" : "several days";

  return (
    <div className="panel p-6">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-ink-400">Anonymity set</div>
        <span className={`rounded-md px-2 py-0.5 font-mono text-[11px] ${grade === "strong" ? "bg-mint-500/15 text-mint-300" : grade === "moderate" ? "bg-amber-400/15 text-amber-400" : "bg-rose-400/15 text-rose-400"}`}>
          {grade}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3">
        <Stat k="notes" v={s ? s.leaves.toLocaleString() : "—"} />
        <Stat k="shields 30d" v={sol ? sol.shields.toLocaleString() : "—"} />
        <Stat k="unshields 30d" v={sol ? sol.unshields.toLocaleString() : "—"} />
      </div>
      <div className="mt-5">
        <div className="mb-2 flex justify-between text-[11px] text-ink-400"><span>daily activity</span><span>30d</span></div>
        <div className="flex h-16 items-end gap-[3px]">
          {Array.from({ length: 30 }).map((_, i) => {
            const d = s?.daily[s.daily.length - 30 + i];
            const h = d ? Math.max(4, (d.txs / max) * 100) : 4;
            return <div key={i} className="flex-1 rounded-sm bg-gradient-to-t from-mint-600/60 to-mint-300/80" style={{ height: `${h}%`, opacity: d ? 1 : 0.25 }} title={d ? `${d.day}: ${d.txs}` : ""} />;
          })}
        </div>
      </div>
      <div className="mt-5 space-y-2 text-xs leading-relaxed text-ink-200">
        <p>
          Recommended: wait <span className="text-ink-100">{wait}</span> between shielding and withdrawing, use standard denominations,
          and withdraw to a fresh wallet.
        </p>
        {relayer && (
          <p className="text-ink-400">
            Relayer <span className="font-mono">{relayer.relayer.slice(0, 4)}…{relayer.relayer.slice(-4)}</span> · {relayer.queued} queued
          </p>
        )}
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-xl border border-white/5 bg-ink-900/60 p-3">
      <div className="font-mono text-lg tabular-nums">{v}</div>
      <div className="text-[11px] text-ink-400">{k}</div>
    </div>
  );
}
