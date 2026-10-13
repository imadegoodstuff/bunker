"use client";
import { AnimatePresence, motion } from "framer-motion";
import { useScash } from "@/lib/store";
import { explorerTx } from "@/lib/config";

const steps = [
  { key: "proving", label: "Prove", sub: "zero-knowledge proof, in your browser" },
  { key: "signing", label: "Sign", sub: "your wallet approves" },
  { key: "relaying", label: "Relay", sub: "random delay, relayer pays gas" },
  { key: "confirming", label: "Confirm", sub: "verified on-chain" },
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
        <motion.div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 backdrop-blur-sm sm:items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <motion.div className="glass noise relative w-full max-w-sm p-7" initial={{ y: 16, scale: 0.98 }} animate={{ y: 0, scale: 1 }} exit={{ y: 16, opacity: 0 }}>
            <div className="flex items-center gap-3">
              <span className={`relative flex h-10 w-10 items-center justify-center rounded-full ${tx.stage === "done" ? "bg-ok/15 text-ok" : tx.stage === "failed" ? "bg-bad/15 text-bad" : "bg-accent/15 text-accent pulse-ring"}`}>
                {tx.stage === "done" ? "✓" : tx.stage === "failed" ? "!" : "·"}
              </span>
              <div>
                <h3 className="text-xl tracking-tight">{title}</h3>
                <p className="text-xs text-mute">{tx.message}</p>
              </div>
            </div>
            <ol className="mt-6 space-y-2.5">
              {steps.map((s) => {
                const si = order.indexOf(s.key);
                const state = tx.stage === "failed" ? (si <= idx ? "fail" : "todo") : si < idx || tx.stage === "done" ? "done" : si === idx ? "active" : "todo";
                return (
                  <li key={s.key} className="flex items-center gap-3 text-sm">
                    <span className={`h-1.5 w-1.5 rounded-full ${state === "done" ? "bg-ok" : state === "active" ? "animate-pulse bg-accent" : state === "fail" ? "bg-bad" : "bg-white/15"}`} />
                    <span className={state === "todo" ? "text-dim" : "text-fg"}>{s.label}</span>
                    <span className="ml-auto text-[11px] text-dim">{s.sub}</span>
                  </li>
                );
              })}
            </ol>
            {!finished && <div className="progress mt-6" />}
            {tx.signature && (
              <a href={explorerTx(tx.signature)} target="_blank" rel="noreferrer" className="link mt-5 block truncate font-mono text-xs">
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
