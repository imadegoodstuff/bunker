"use client";
import { useEffect, useState } from "react";
import { indexer, relayer as relayerApi } from "@/lib/api";

type Fig = { k: string; v: string };

export function Figures() {
  const [figs, setFigs] = useState<Fig[]>([
    { k: "SOL deposits", v: "—" },
    { k: "Notes on-chain", v: "—" },
    { k: "Relayer delay", v: "—" },
    { k: "Proof time", v: "~3 s" },
  ]);
  useEffect(() => {
    (async () => {
      const [s, r] = await Promise.allSettled([indexer.stats(30), relayerApi.info()]);
      const stats = s.status === "fulfilled" ? s.value : null;
      const info = r.status === "fulfilled" ? r.value : null;
      let shields = 0;
      if (stats) for (const m of Object.values(stats.perMint)) shields += m.shields;
      setFigs([
        { k: "SOL deposits", v: stats ? shields.toLocaleString() : "—" },
        { k: "Notes on-chain", v: stats ? stats.leaves.toLocaleString() : "—" },
        { k: "Relayer delay", v: info ? `${info.delay.minMs / 1000}–${info.delay.maxMs / 1000}s` : "offline" },
        { k: "Proof time", v: "~3 s" },
      ]);
    })();
  }, []);
  return (
    <dl className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-4">
      {figs.map((f) => (
        <div key={f.k}>
          <dd className="text-2xl tracking-[-0.03em] tabular-nums">{f.v}</dd>
          <dt className="mt-1 text-xs text-dim">{f.k}</dt>
        </div>
      ))}
    </dl>
  );
}
