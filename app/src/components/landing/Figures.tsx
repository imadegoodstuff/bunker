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
        { k: "Privacy set", v: stats ? stats.leaves.toLocaleString() : "—", sub: "notes in the tree, all alike" },
        { k: "Shields, 30 days", v: stats ? shields.toLocaleString() : "—", sub: "deposits that joined the set" },
        { k: "Unshields, 30 days", v: stats ? unshields.toLocaleString() : "—", sub: "exits to fresh addresses" },
        { k: "Relayer", v: info ? `${info.delay.minMs / 1000}–${info.delay.maxMs / 1000}s` : "—", sub: info ? `random delay · ${info.queued} queued` : "offline" },
      ]);
    })();
  }, []);
  const items = figs ?? [
    { k: "Privacy set", v: "—", sub: "notes in the tree, all alike" },
    { k: "Shields, 30 days", v: "—", sub: "deposits that joined the set" },
    { k: "Unshields, 30 days", v: "—", sub: "exits to fresh addresses" },
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
