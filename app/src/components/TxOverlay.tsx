"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useScash } from "@/lib/store";
import { explorerTx } from "@/lib/config";

const steps = [
  { key: "proving", label: "Prove" },
  { key: "signing", label: "Sign" },
  { key: "relaying", label: "Relay" },
  { key: "confirming", label: "Confirm" },
];
const order = ["building", "proving", "signing", "relaying", "confirming", "done"];

export function TxOverlay() {
  const { tx, resetTx } = useScash();
  const open = tx.stage !== "idle";
  const idx = order.indexOf(tx.stage);
  const finished = tx.stage === "done" || tx.stage === "failed";
  const title = tx.stage === "done" ? "Confirmed" : tx.stage === "failed" ? "Failed" : steps.find((s) => s.key === tx.stage)?.label ?? "Working";

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="card w-full max-w-sm bg-raise p-6" initial={{ y: 12 }} animate={{ y: 0 }} exit={{ y: 12, opacity: 0 }}>
            <ol className="flex gap-4 text-xs">
              {steps.map((s) => {
                const si = order.indexOf(s.key);
                const state = tx.stage === "failed" ? (si <= idx ? "fail" : "todo") : si < idx || tx.stage === "done" ? "done" : si === idx ? "active" : "todo";
                const cls = state === "done" || state === "active" ? "text-fg" : state === "fail" ? "text-bad" : "text-dim";
                return <li key={s.key} className={cls}>{s.label}</li>;
              })}
            </ol>
            {!finished && <div className="progress mt-4" />}
            <h3 className="mt-5 text-xl tracking-tight">{title}</h3>
            <p className="mt-1 text-sm text-mute">{tx.message}</p>
            {tx.signature && (
              <a href={explorerTx(tx.signature)} target="_blank" rel="noreferrer" className="link mt-4 block break-all font-mono text-xs">
                {tx.signature}
              </a>
            )}
            {finished && <button className="btn-ghost mt-6 w-full" onClick={resetTx}>Close</button>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
