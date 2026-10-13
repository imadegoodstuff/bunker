"use client";
import { ASSETS } from "@/lib/config";
import { useScash } from "@/lib/store";
import { fmtAmount } from "@/lib/format";
import { amountForBurn } from "@scash/sdk";

export function BalanceCard() {
  const { balances, pools, notes, sync, syncedTo, totalLeaves } = useScash();
  return (
    <section>
      <div className="flex items-center justify-between">
        <span className="label">Shielded balance</span>
        <button onClick={() => sync()} className="link text-xs">Rescan</button>
      </div>
      <div className="mt-3 space-y-2">
        {ASSETS.map((a) => {
          const shares = balances[a.symbol] ?? 0n;
          const pool = pools[a.symbol];
          const amount = pool ? amountForBurn(pool, shares) : shares;
          return (
            <div key={a.symbol} className="flex items-baseline gap-3">
              <span className="text-5xl tracking-[-0.03em] tabular-nums">{fmtAmount(amount, a.decimals)}</span>
              <span className="text-lg text-mute">{a.symbol}</span>
              {!pool && <span className="text-xs text-warn">pool not created</span>}
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-dim">
        {notes.length} note{notes.length === 1 ? "" : "s"} · synced {syncedTo.toLocaleString()} / {totalLeaves.toLocaleString()}
      </p>
    </section>
  );
}
