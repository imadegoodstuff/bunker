"use client";
import { ASSETS, explorerTx } from "@/lib/config";
import { useScash } from "@/lib/store";
import { fmtAmount, short, timeAgo } from "@/lib/format";

const KIND: Record<string, string> = { shield: "Shielded", send: "Sent", unshield: "Withdrew" };

export function Activity() {
  const activity = useScash((s) => s.activity);
  if (activity.length === 0) return null;
  return (
    <section className="glass p-5">
      <div className="flex items-center justify-between">
        <span className="label">This session</span>
        <span className="text-[11px] text-dim">kept in memory only</span>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {activity.map((a) => {
          const meta = ASSETS.find((x) => x.symbol === a.asset)!;
          const dot = a.status === "confirmed" ? "bg-ok" : a.status === "failed" ? "bg-bad" : "animate-pulse bg-warn";
          return (
            <li key={a.id} className="flex items-center justify-between py-3 text-sm">
              <div className="flex items-center gap-3">
                <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                <span>{KIND[a.kind] ?? a.kind}</span>
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
    </section>
  );
}
