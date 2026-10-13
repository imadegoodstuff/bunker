"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useScash } from "@/lib/store";
import { explorerTx } from "@/lib/config";

const steps: { key: string; label: string }[] = [
  { key: "proving", label: "Prove" },
  { key: "signing", label: "Sign" },
  { key: "relaying", label: "Relay" },
  { key: "confirming", label: "Confirm" },
  { key: "done", label: "Done" },
];
const order = ["building", "proving", "signing", "relaying", "confirming", "done"];

export function TxOverlay() {
  const { tx, resetTx } = useScash();
  const open = tx.stage !== "idle";
  const idx = order.indexOf(tx.stage);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-ink-950/70 p-4 backdrop-blur-sm sm:items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="panel-strong w-full max-w-md p-7" initial={{ y: 24, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 24, opacity: 0 }}>
            <div className="flex items-center justify-between">
              {steps.map((s, i) => {
                const si = order.indexOf(s.key);
                const state = tx.stage === "failed" ? (si <= idx ? "fail" : "todo") : si < idx ? "done" : si === idx ? "active" : "todo";
                return (
                  <div key={s.key} className="flex flex-1 items-center">
                    <div className={`flex h-7 w-7 items-center justify-center rounded-full border font-mono text-[11px] ${state === "done" ? "border-mint-500 bg-mint-500 text-ink-950" : state === "active" ? "border-mint-400 text-mint-300 shadow-glow" : state === "fail" ? "border-rose-400 text-rose-400" : "border-white/10 text-ink-400"}`}>
                      {state === "done" ? "✓" : i + 1}
                    </div>
                    {i < steps.length - 1 && <div className={`mx-1 h-px flex-1 ${si < idx ? "bg-mint-500" : "bg-white/10"}`} />}
                  </div>
                );
              })}
            </div>
            <h3 className="mt-6 text-lg font-semibold">
              {tx.stage === "done" ? "Confirmed" : tx.stage === "failed" ? "Transaction failed" : steps.find((s) => s.key === tx.stage)?.label ?? "Working"}
            </h3>
            <p className="mt-1 text-sm text-ink-200">{tx.message}</p>
            {tx.stage === "proving" && <div className="shimmer mt-4 h-1.5 rounded-full" />}
            {tx.signature && (
              <a href={explorerTx(tx.signature)} target="_blank" rel="noreferrer" className="mt-4 block break-all font-mono text-xs text-mint-400 hover:text-mint-300">
                {tx.signature}
              </a>
            )}
            {(tx.stage === "done" || tx.stage === "failed") && (
              <button className="btn-ghost mt-6 w-full" onClick={resetTx}>Close</button>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
