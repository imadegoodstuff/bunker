"use client";
import { ASSETS } from "@/lib/config";
import { useScash } from "@/lib/store";
import { fmtAmount } from "@/lib/format";
import { amountForBurn } from "@scash/sdk";

export function BalanceCard() {
  const { balances, pools, notes, sync, syncedTo, totalLeaves } = useScash();
  return (
    <div className="panel-strong p-7">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-400">Shielded balance</div>
          <div className="mt-3 space-y-3">
            {ASSETS.map((a) => {
              const shares = balances[a.symbol] ?? 0n;
              const pool = pools[a.symbol];
              const amount = pool ? amountForBurn(pool, shares) : shares;
              const rate = pool && pool.totalShares > 0n ? Number(pool.totalAssets) / Number(pool.totalShares) : 1;
              return (
                <div key={a.symbol} className="flex items-baseline gap-3">
                  <span className="font-mono text-4xl tabular-nums tracking-tight">{fmtAmount(amount, a.decimals)}</span>
                  <span className="text-lg text-ink-200">{a.symbol}</span>
                  <span className="ml-2 rounded-md bg-white/5 px-2 py-0.5 font-mono text-[11px] text-ink-200" title="pool share rate: assets per share">
                    rate {rate.toFixed(6)}
                  </span>
                  {!pool && <span className="text-xs text-amber-400">pool not created yet</span>}
                </div>
              );
            })}
          </div>
        </div>
        <button onClick={() => sync()} className="btn-ghost text-xs">Rescan</button>
      </div>
      <div className="mt-6 flex flex-wrap gap-6 border-t border-white/5 pt-5 font-mono text-xs text-ink-400">
        <span>{notes.length} unspent note{notes.length === 1 ? "" : "s"}</span>
        <span>synced {syncedTo.toLocaleString()} / {totalLeaves.toLocaleString()} leaves</span>
        <span>tree depth 26 · 128-root ring</span>
      </div>
    </div>
  );
}
