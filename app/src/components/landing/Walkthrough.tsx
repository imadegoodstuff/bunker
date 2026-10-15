"use client";
import { useEffect, useState } from "react";

const STEPS = [
  { k: "shield", title: "Shield", body: "Your wallet deposits BNB or any ERC-20 into the pool. The pool records a commitment: a hash of the amount, the asset and a key only you hold.", trace: ["wallet 0x7a3f… → pool", "+ 1 commitment", "tree root changes"] },
  { k: "wait", title: "Wait", body: "Other people shield too. Every new note widens the crowd your note can hide in. Timing is part of privacy: do not withdraw the moment you deposit.", trace: ["+ 412 commitments", "7 assets · 1 tree", "your note: indistinguishable"] },
  { k: "spend", title: "Spend", body: "In the browser you prove you own some note in the tree without saying which. The relayer submits the proof and is paid from the note. The chain sees a nullifier and a new commitment.", trace: ["proof: 1.4 s on this device", "nullifier published", "recipient 0x91c0… receives"] },
  { k: "trade", title: "Trade", body: "Point the withdrawal at the launchpad instead of an address. The curve fills it, pays a throwaway claim key, and that key shields the tokens straight back into your vault.", trace: ["exit → launchpad", "claim key 0x2b… (used once)", "tokens shielded"] },
];

export function Walkthrough() {
  const [i, setI] = useState(0);
  useEffect(() => { const id = setInterval(() => setI((n) => (n + 1) % STEPS.length), 5200); return () => clearInterval(id); }, []);
  const s = STEPS[i];
  return (
    <section className="border-b rule">
      <div className="max-w-7xl mx-auto px-5 md:px-10 py-16 grid lg:grid-cols-[320px_1fr] gap-10">
        <div>
          <div className="label-signal mb-4">How a note lives</div>
          <ol className="space-y-1">
            {STEPS.map((st, n) => (
              <li key={st.k}>
                <button className="rail-link w-full border-l-2" data-active={n === i} onClick={() => setI(n)}>
                  <span className="text-dim w-5">0{n + 1}</span>{st.title}
                </button>
              </li>
            ))}
          </ol>
        </div>
        <div className="slab brackets p-8 md:p-10 min-h-[280px] grain"><span className="bk" />
          <div key={s.k} className="rise">
            <h3 className="display text-3xl md:text-4xl mb-4">{s.title}</h3>
            <p className="text-mute leading-relaxed max-w-xl mb-8">{s.body}</p>
            <div className="font-mono text-[11px] space-y-1.5">
              {s.trace.map((t, n) => (
                <div key={t} className="flex items-center gap-3 rise" style={{ animationDelay: `${0.15 + n * 0.12}s` }}>
                  <span className="w-1.5 h-1.5 bg-signal" /><span className="text-fg">{t}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
