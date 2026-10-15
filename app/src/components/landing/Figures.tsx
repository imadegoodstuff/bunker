"use client";
import { useEffect, useState } from "react";
import { indexer } from "@/lib/api";
import { fmtAmount } from "@/lib/format";

/** Live numbers from the indexer; renders dashes until it answers so the page never blocks on it. */
export function Figures() {
  const [s, setS] = useState<{ leaves: number; txs: number; shieldedBnb: bigint; launches: number }>();
  useEffect(() => {
    Promise.all([indexer.stats(30), indexer.launches(200)]).then(([st, ls]) => {
      const bnb = st.perToken["0x0000000000000000000000000000000000000000"];
      setS({ leaves: st.leaves, txs: st.daily.reduce((n, d) => n + d.txs, 0), shieldedBnb: bnb ? BigInt(bnb.shielded) - BigInt(bnb.unshielded) : 0n, launches: ls.length });
    }).catch(() => undefined);
  }, []);
  const cells = [
    { l: "notes in the tree", v: s ? s.leaves.toLocaleString() : "—" },
    { l: "transactions · 30d", v: s ? s.txs.toLocaleString() : "—" },
    { l: "BNB shielded now", v: s ? fmtAmount(s.shieldedBnb < 0n ? 0n : s.shieldedBnb, 18, 2) : "—" },
    { l: "tokens launched", v: s ? s.launches.toLocaleString() : "—" },
  ];
  return (
    <section className="border-b rule">
      <div className="max-w-7xl mx-auto grid grid-cols-2 lg:grid-cols-4">
        {cells.map((c, i) => (
          <div key={c.l} className={`px-8 md:px-10 py-8 ${i % 2 === 0 ? "border-r rule" : ""} ${i < 2 ? "border-b lg:border-b-0 rule" : ""} ${i === 1 ? "lg:border-r" : ""}`}>
            <div className="label mb-2">{c.l}</div>
            <div className="display text-3xl md:text-5xl num">{c.v}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
