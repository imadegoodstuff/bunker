"use client";
import { useEffect, useState } from "react";
import { IndexerApi as IndexerApiV1 } from "@bunker/sdk-v1";
import { indexer } from "@/lib/api";
import { INDEXER_V1_URL } from "@/lib/config";
import { fmtAmount } from "@/lib/format";

const NATIVE = "0x0000000000000000000000000000000000000000";
type Stats = { leaves: number; txs: number; shieldedBnb: bigint; launches: number };

async function statsFrom(api: { stats: (days: number) => Promise<{ leaves: number; perToken: Record<string, { shielded: string; unshielded: string }>; daily: { txs: number }[] }>; launches: (n: number) => Promise<unknown[]> }): Promise<Stats> {
  const [st, ls] = await Promise.all([api.stats(30), api.launches(200)]);
  const bnb = st.perToken[NATIVE];
  const shielded = bnb ? BigInt(bnb.shielded) - BigInt(bnb.unshielded) : 0n;
  return { leaves: st.leaves, txs: st.daily.reduce((n, d) => n + d.txs, 0), shieldedBnb: shielded < 0n ? 0n : shielded, launches: ls.length };
}

/**
 * Live numbers: protocol v2 plus the first (v1) pool and launchpad, which are
 * still live contracts with their own history. Dashes until the indexers
 * answer so the page never blocks on them.
 */
export function Figures() {
  const [s, setS] = useState<Stats>();
  useEffect(() => {
    const v1 = INDEXER_V1_URL ? statsFrom(new IndexerApiV1(INDEXER_V1_URL)).catch(() => null) : Promise.resolve(null);
    Promise.all([statsFrom(indexer).catch(() => null), v1]).then(([a, b]) => {
      if (!a && !b) return;
      const z: Stats = { leaves: 0, txs: 0, shieldedBnb: 0n, launches: 0 };
      const sum = [a, b].filter((x): x is Stats => !!x).reduce((acc, x) => ({ leaves: acc.leaves + x.leaves, txs: acc.txs + x.txs, shieldedBnb: acc.shieldedBnb + x.shieldedBnb, launches: acc.launches + x.launches }), z);
      setS(sum);
    });
  }, []);
  const cells = [
    { l: "notes in the trees", v: s ? s.leaves.toLocaleString() : "—" },
    { l: "transactions · 30d", v: s ? s.txs.toLocaleString() : "—" },
    { l: "BNB shielded now", v: s ? fmtAmount(s.shieldedBnb, 18, 2) : "—" },
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
