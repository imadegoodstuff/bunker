"use client";
import { useEffect, useState } from "react";
import { indexer } from "@/lib/api";

export function LiveStats() {
  const [s, setS] = useState<{ leaves: number; shields: number; unshields: number } | null>(null);
  useEffect(() => {
    indexer
      .stats(30)
      .then((r) => {
        let shields = 0, unshields = 0;
        for (const m of Object.values(r.perMint)) { shields += m.shields; unshields += m.unshields; }
        setS({ leaves: r.leaves, shields, unshields });
      })
      .catch(() => setS({ leaves: 0, shields: 0, unshields: 0 }));
  }, []);
  const items = [
    { k: "Notes in the tree", v: s ? s.leaves.toLocaleString() : "—" },
    { k: "Shields (30d)", v: s ? s.shields.toLocaleString() : "—" },
    { k: "Unshields (30d)", v: s ? s.unshields.toLocaleString() : "—" },
    { k: "Tree capacity", v: "67,108,864" },
  ];
  return (
    <div className="mt-16 grid grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 md:grid-cols-4">
      {items.map((i) => (
        <div key={i.k} className="bg-ink-950 p-5">
          <div className="font-mono text-2xl tabular-nums">{i.v}</div>
          <div className="mt-1 text-xs uppercase tracking-wider text-ink-400">{i.k}</div>
        </div>
      ))}
    </div>
  );
}
