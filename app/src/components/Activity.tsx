"use client";
import { ASSETS, explorerTx } from "@/lib/config";
import { useScash } from "@/lib/store";
import { fmtAmount, short, timeAgo } from "@/lib/format";

export function Activity() {
  const activity = useScash((s) => s.activity);
  if (activity.length === 0) return null;
  return (
    <section>
      <span className="label">This session</span>
      <ul className="mt-3 divide-y divide-line border-y border-line">
        {activity.map((a) => {
          const meta = ASSETS.find((x) => x.symbol === a.asset)!;
          const dot = a.status === "confirmed" ? "bg-ok" : a.status === "failed" ? "bg-bad" : "animate-pulse bg-warn";
          return (
            <li key={a.id} className="flex items-center justify-between py-3 text-sm">
              <div className="flex items-center gap-3">
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                <span className="capitalize">{a.kind}</span>
                <span className="tabular-nums text-mute">{fmtAmount(a.amount, meta.decimals)} {a.asset}</span>
              </div>
              <div className="flex items-center gap-4 text-xs text-dim">
                {a.signature && <a className="link font-mono" href={explorerTx(a.signature)} target="_blank" rel="noreferrer">{short(a.signature)}</a>}
                {a.error && <span className="max-w-[14rem] truncate text-bad" title={a.error}>{a.error}</span>}
                <span>{timeAgo(a.at)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-dim">Kept in memory only.</p>
    </section>
  );
}
