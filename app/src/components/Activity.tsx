"use client";
import { ASSETS, explorerTx } from "@/lib/config";
import { useScash } from "@/lib/store";
import { fmtAmount, short, timeAgo } from "@/lib/format";

export function Activity() {
  const activity = useScash((s) => s.activity);
  if (activity.length === 0) return null;
  return (
    <div className="panel p-6">
      <div className="text-xs uppercase tracking-wider text-ink-400">This session</div>
      <ul className="mt-3 divide-y divide-white/5">
        {activity.map((a) => {
          const meta = ASSETS.find((x) => x.symbol === a.asset)!;
          return (
            <li key={a.id} className="flex items-center justify-between py-3 text-sm">
              <div className="flex items-center gap-3">
                <span className={`h-2 w-2 rounded-full ${a.status === "confirmed" ? "bg-mint-400" : a.status === "failed" ? "bg-rose-400" : "animate-pulse bg-amber-400"}`} />
                <span className="capitalize">{a.kind}</span>
                <span className="font-mono text-ink-200">{fmtAmount(a.amount, meta.decimals)} {a.asset}</span>
              </div>
              <div className="flex items-center gap-4 font-mono text-xs text-ink-400">
                {a.signature && <a className="text-mint-400 hover:text-mint-300" href={explorerTx(a.signature)} target="_blank" rel="noreferrer">{short(a.signature)}</a>}
                {a.error && <span className="max-w-[16rem] truncate text-rose-400" title={a.error}>{a.error}</span>}
                <span>{timeAgo(a.at)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[11px] text-ink-400">Activity is kept in memory only. Nothing is written to disk or sent to a server.</p>
    </div>
  );
}
