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
  const dot = grade === "strong" ? "bg-ok" : grade === "moderate" ? "bg-warn" : "bg-bad";

  return (
    <section>
      <div className="flex items-center justify-between">
        <span className="label">Anonymity set</span>
        <span className="flex items-center gap-1.5 text-xs text-mute">
          <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
          {grade}
        </span>
      </div>
      <dl className="mt-3 space-y-1.5 text-xs">
        <Row k="Notes in tree" v={s ? s.leaves.toLocaleString() : "—"} />
        <Row k="Shields, 30d" v={sol ? sol.shields.toLocaleString() : "—"} />
        <Row k="Unshields, 30d" v={sol ? sol.unshields.toLocaleString() : "—"} />
        {relayer && <Row k="Relayer queue" v={String(relayer.queued)} />}
      </dl>
      <p className="mt-4 text-xs leading-relaxed text-dim">
        Wait {wait} between shielding and withdrawing. Use round amounts. Withdraw to a fresh wallet.
      </p>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-dim">{k}</dt>
      <dd className="tabular-nums text-mute">{v}</dd>
    </div>
  );
}
