"use client";
import { useEffect, useRef, useState } from "react";

const HEX = "0123456789abcdef";
const SCENES = [
  { you: "4.20 SOL → maya", chain: "cm 8f3a…c91e" },
  { you: "140 USDC → payroll", chain: "nf 2b7d…0a44" },
  { you: "0.5 SOL → me", chain: "ct ■■■■■■■■■■" },
  { you: "25 SCASH → dana", chain: "cm e01c…77b2" },
];

function scramble(from: string, to: string, t: number) {
  const len = Math.max(from.length, to.length);
  let out = "";
  for (let i = 0; i < len; i++) {
    const p = i / len;
    if (t > p + 0.25) out += to[i] ?? "";
    else if (t > p - 0.05) out += HEX[(Math.random() * 16) | 0];
    else out += from[i] ?? " ";
  }
  return out;
}

/** The hero figure: a payment the way you see it, dissolving into the way the chain stores it. */
export function Veil() {
  const [scene, setScene] = useState(0);
  const [phase, setPhase] = useState<"you" | "chain">("you");
  const [text, setText] = useState(SCENES[0].you);
  const raf = useRef<number>(0);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      while (alive) {
        await wait(2200);
        await morph(SCENES[scene].you, SCENES[scene].chain, "chain");
        await wait(2600);
        const next = (scene + 1) % SCENES.length;
        await morph(SCENES[scene].chain, SCENES[next].you, "you");
        setScene(next);
      }
    };
    const morph = (a: string, b: string, p: "you" | "chain") =>
      new Promise<void>((res) => {
        const t0 = performance.now();
        const step = (now: number) => {
          const t = Math.min(1, (now - t0) / 900);
          setText(scramble(a, b, t * 1.3));
          if (t < 1) raf.current = requestAnimationFrame(step);
          else { setText(b); setPhase(p); res(); }
        };
        raf.current = requestAnimationFrame(step);
      });
    run();
    return () => { alive = false; cancelAnimationFrame(raf.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene]);

  return (
    <div className="relative mx-auto w-full max-w-[34rem] select-none">
      <Lattice />
      <div className="glass noise relative z-10 overflow-hidden p-7 float">
        <div className="flex items-center justify-between font-mono text-[11px] text-dim">
          <span className="flex items-center gap-2">
            <span className={`relative h-2 w-2 rounded-full ${phase === "you" ? "bg-accent pulse-ring" : "bg-ok"}`} />
            {phase === "you" ? "what you see" : "what the chain stores"}
          </span>
          <span>slot {(31_240_000 + scene * 7).toLocaleString()}</span>
        </div>
        <div className={`mt-10 min-h-[3.2rem] font-mono text-2xl tabular-nums tracking-tight transition-colors sm:text-[2rem] ${phase === "you" ? "text-fg" : "text-accent"}`}>
          {text}
        </div>
        <div className="mt-10 grid grid-cols-3 gap-3 text-[11px]">
          {(["sender", "amount", "recipient"] as const).map((k) => (
            <div key={k} className="rounded-xl border border-line bg-black/30 px-3 py-2.5">
              <div className="text-dim">{k}</div>
              <div className="mt-1 font-mono">{phase === "you" ? <span className="text-fg">visible</span> : <span className="redact w-12" />}</div>
            </div>
          ))}
        </div>
      </div>
      <p className="relative z-10 mt-5 text-center text-xs text-dim">One of the commitments on-chain is this payment. The chain cannot tell which; your anonymity set is the other notes of the same asset.</p>
    </div>
  );
}

function Lattice() {
  // a shallow Merkle lattice, drawn once, animated with dashes
  const w = 560, h = 420;
  const paths: string[] = [];
  const levels = 5;
  for (let l = 0; l < levels - 1; l++) {
    const n = 2 ** l, m = 2 ** (l + 1);
    const y1 = 40 + (l * (h - 80)) / (levels - 1), y2 = 40 + ((l + 1) * (h - 80)) / (levels - 1);
    for (let i = 0; i < n; i++) {
      const x1 = (w * (i + 0.5)) / n;
      for (const j of [2 * i, 2 * i + 1]) {
        const x2 = (w * (j + 0.5)) / m;
        paths.push(`M${x1},${y1} C${x1},${(y1 + y2) / 2} ${x2},${(y1 + y2) / 2} ${x2},${y2}`);
      }
    }
  }
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="lattice pointer-events-none absolute -inset-x-16 -top-24 z-0 h-[160%] w-[calc(100%+8rem)] opacity-70" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#f0b35b" stopOpacity="0.9" />
          <stop offset="1" stopColor="#f0b35b" stopOpacity="0" />
        </linearGradient>
      </defs>
      {paths.map((d, i) => <path key={i} d={d} fill="none" stroke="url(#lg)" strokeWidth="1" style={{ animationDelay: `${(i % 7) * -2.3}s` }} />)}
    </svg>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
