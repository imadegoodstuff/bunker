"use client";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

type Row = { from: string; to: string; amount: string; nf: string; cm: string; ct: string };

function hex(n: number, seed: number) {
  let x = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out += (x >>> 28).toString(16);
  }
  return out;
}
function b58(seed: number) {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let x = seed >>> 0, s = "";
  for (let i = 0; i < 8; i++) { x = (x * 22695477 + 1) >>> 0; s += A[x % A.length]; }
  return s.slice(0, 4) + "…" + s.slice(4);
}

const AMOUNTS = ["12.5", "0.25", "3", "140", "1", "0.5", "25", "8.8", "2", "61.2"];

function makeRows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    from: b58(i * 7919 + 11),
    to: b58(i * 104729 + 97),
    amount: AMOUNTS[i % AMOUNTS.length],
    nf: hex(10, i * 31 + 5),
    cm: hex(10, i * 17 + 3),
    ct: hex(14, i * 13 + 1),
  }));
}

export function LedgerDemo() {
  const [mode, setMode] = useState<"public" | "scash">("public");
  const [tick, setTick] = useState(0);
  const all = useMemo(() => makeRows(40), []);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1800);
    return () => clearInterval(t);
  }, []);
  const rows = Array.from({ length: 9 }, (_, i) => all[(tick + i) % all.length]);
  const yours = (tick + 4) % all.length;

  return (
    <div className="card overflow-hidden bg-raise">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <span className="font-mono text-[11px] text-dim">what the chain stores</span>
        <div className="segment">
          <button data-active={mode === "public"} onClick={() => setMode("public")}>Public ledger</button>
          <button data-active={mode === "scash"} onClick={() => setMode("scash")}>scash</button>
        </div>
      </div>
      <div className="relative h-[332px] font-mono text-[12px]">
        <AnimatePresence mode="popLayout" initial={false}>
          {rows.map((r, i) => {
            const isYours = mode === "public" && all.indexOf(r) === yours;
            return (
              <motion.div
                key={r.nf}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.35 }}
                className={`grid grid-cols-[1fr_1fr_auto] items-center gap-3 border-b border-line px-4 py-2.5 ${isYours ? "bg-accent-soft" : ""}`}
              >
                {mode === "public" ? (
                  <>
                    <span className={isYours ? "text-accent" : "text-mute"}>{r.from}</span>
                    <span className="text-mute">→ {r.to}</span>
                    <span className={`tabular-nums ${isYours ? "text-accent" : "text-fg"}`}>{r.amount} SOL</span>
                  </>
                ) : (
                  <>
                    <span className="text-dim">nf <span className="text-mute">{r.nf}</span></span>
                    <span className="text-dim">cm <span className="text-mute">{r.cm}</span></span>
                    <span className="text-dim">ct <span className="redact w-[5.5rem]" /></span>
                  </>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-raise to-transparent" />
      </div>
      <div className="flex items-center justify-between px-4 py-3 text-[11px] text-dim">
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {mode === "public" ? "your payment, readable by anyone" : "one of these is yours. nobody can tell which."}
        </span>
        <span className="font-mono">slot {(31_240_000 + tick * 3).toLocaleString()}</span>
      </div>
    </div>
  );
}
