"use client";
import { useBunker, type TxStage } from "@/lib/store";
import { explorerTx } from "@/lib/config";

const STEPS: { key: TxStage[]; label: string }[] = [
  { key: ["building", "draining", "proving"], label: "prove" },
  { key: ["signing", "relaying"], label: "submit" },
  { key: ["confirming"], label: "confirm" },
];

export function TxOverlay() {
  const { tx, resetTx } = useBunker();
  if (tx.stage === "idle") return null;
  const done = tx.stage === "done";
  const failed = tx.stage === "failed";
  const active = STEPS.findIndex((s) => s.key.includes(tx.stage));
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="slab brackets w-full max-w-md p-6 rise"><span className="bk" />
        <div className="flex items-center justify-between mb-5">
          <span className="label-signal">{done ? "Landed" : failed ? "Failed" : "In progress"}</span>
          {done || failed ? <button className="btn btn-ghost btn-sm" onClick={resetTx}>close</button> : null}
        </div>
        <div className="grid grid-cols-3 gap-1 mb-5">
          {STEPS.map((s, i) => {
            const state = done ? "done" : failed ? (i <= active ? "bad" : "idle") : i < active ? "done" : i === active ? "active" : "idle";
            return (
              <div key={s.label}>
                <div className={`h-1 ${state === "done" ? "bg-signal" : state === "active" ? "bg-signal blink" : state === "bad" ? "bg-bad" : "bg-slab-2"}`} />
                <div className={`mt-2 font-mono text-[10.5px] uppercase tracking-[0.2em] ${state === "idle" ? "text-dim" : "text-fg"}`}>{s.label}</div>
              </div>
            );
          })}
        </div>
        <p className={`text-sm leading-relaxed ${failed ? "text-bad" : "text-mute"}`}>{done ? (tx.txHash ? "Confirmed on chain. New notes show as settling until the next batch folds them into the tree; a keeper does that within seconds." : "Done.") : tx.message ?? "…"}</p>
        {tx.txHash ? (
          <a href={explorerTx(tx.txHash)} target="_blank" rel="noreferrer" className="mt-4 inline-block font-mono text-[11px] text-steel hover:text-fg break-all">{tx.txHash} ↗</a>
        ) : null}
        {!done && !failed ? <p className="mt-4 font-mono text-[10.5px] text-dim">Keep this tab open. The proof is being made on this device.</p> : null}
      </div>
    </div>
  );
}
