"use client";
import { useEffect, useState } from "react";
import { indexer, relayer as relayerApi } from "@/lib/api";

type Fig = { k: string; v: string; sub: string };

export function Figures() {
  const [figs, setFigs] = useState<Fig[] | null>(null);
  useEffect(() => {
    (async () => {
      const [s, r] = await Promise.allSettled([indexer.stats(30), relayerApi.info()]);
      const stats = s.status === "fulfilled" ? s.value : null;
      const info = r.status === "fulfilled" ? r.value : null;
      let shields = 0, unshields = 0;
      if (stats) for (const m of Object.values(stats.perMint)) { shields += m.shields; unshields += m.unshields; }
      setFigs([
        { k: "SOL privacy set", v: stats ? shields.toLocaleString() : "—", sub: "deposits into the SOL pool; sets are per asset" },
        { k: "SOL withdrawals", v: stats ? unshields.toLocaleString() : "—", sub: "exits to fresh addresses" },
        { k: "Notes in tree", v: stats ? stats.leaves.toLocaleString() : "—", sub: "all assets, all alike on-chain" },
        { k: "Relayer", v: info ? `${info.delay.minMs / 1000}–${info.delay.maxMs / 1000}s` : "—", sub: info ? `random delay · ${info.queued} queued` : "offline" },
      ]);
    })();
  }, []);
  const items = figs ?? [
    { k: "SOL privacy set", v: "—", sub: "deposits into the SOL pool; sets are per asset" },
    { k: "SOL withdrawals", v: "—", sub: "exits to fresh addresses" },
    { k: "Notes in tree", v: "—", sub: "all assets, all alike on-chain" },
    { k: "Relayer", v: "—", sub: "random delay" },
  ];
  return (
    <div className="card grid grid-cols-2 divide-line overflow-hidden bg-raise md:grid-cols-4 md:divide-x">
      {items.map((f) => (
        <div key={f.k} className="p-5">
          <div className="text-xs text-mute">{f.k}</div>
          <div className="mt-2 text-3xl tracking-[-0.03em] tabular-nums">{f.v}</div>
          <div className="mt-1 text-xs text-dim">{f.sub}</div>
        </div>
      ))}
    </div>
  );
}
