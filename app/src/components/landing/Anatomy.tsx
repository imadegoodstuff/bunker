"use client";
import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

type Vis = "yes" | "no" | "hash";
type Step = {
  who: string;
  title: string;
  body: string;
  matrix: Record<"Sender" | "Recipient" | "Amount" | "Memo", Vis>;
  note: string;
};

const steps: Step[] = [
  {
    who: "Your wallet",
    title: "Sign once",
    body: "Your wallet signs one fixed message. The signature becomes your spending key, derived locally. Nothing new to back up; the same wallet opens the same notes on any device.",
    matrix: { Sender: "yes", Recipient: "yes", Amount: "yes", Memo: "yes" },
    note: "Everything is visible here, and only here: this is your own browser.",
  },
  {
    who: "Your browser",
    title: "Prove it locally",
    body: "A Groth16 proof is written on your device: you own notes worth at least 0.4 SOL, the new notes add up, and nothing was spent twice. About three seconds.",
    matrix: { Sender: "hash", Recipient: "hash", Amount: "hash", Memo: "hash" },
    note: "The proof commits to the facts without containing them.",
  },
  {
    who: "Relayer",
    title: "Someone else pays the fee",
    body: "A relayer submits the transaction and pays gas. Its fee is deducted inside the proof, from your notes. Your public address signs nothing and appears nowhere.",
    matrix: { Sender: "no", Recipient: "no", Amount: "no", Memo: "no" },
    note: "The relayer sees bytes it cannot read and a fee it can.",
  },
  {
    who: "The chain",
    title: "The vault keeps ciphertext",
    body: "The program verifies the proof and stores a nullifier so the spent note can't be reused, two new commitments, and the notes encrypted for their owners.",
    matrix: { Sender: "no", Recipient: "no", Amount: "no", Memo: "no" },
    note: "Nullifier, commitment, ciphertext. That is the whole public record.",
  },
  {
    who: "Recipient",
    title: "Only they can read it",
    body: "Their viewing key trial-decrypts the new note: 0.4 SOL and your memo. If they ever need to, they can prove receipt of this one payment and nothing else.",
    matrix: { Sender: "no", Recipient: "yes", Amount: "yes", Memo: "yes" },
    note: "They learn what you sent. Not who you are, unless you tell them in the memo.",
  },
];

const fields = ["Sender", "Recipient", "Amount", "Memo"] as const;

function Mark({ v }: { v: Vis }) {
  if (v === "yes") return <span className="text-fg">visible</span>;
  if (v === "hash") return <span className="text-accent">committed</span>;
  return <span className="redact w-16" aria-label="hidden" />;
}

export function Anatomy() {
  const [i, setI] = useState(1);
  const s = steps[i];
  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_22rem] lg:gap-16">
      <div>
        <ol className="flex items-center">
          {steps.map((st, idx) => (
            <li key={st.who} className="flex flex-1 items-center last:flex-none">
              <button onClick={() => setI(idx)} className="group flex flex-col items-center gap-2" aria-current={idx === i}>
                <span className="step-dot" data-active={idx === i} data-done={idx < i}>{String(idx + 1).padStart(2, "0")}</span>
                <span className={`hidden text-[11px] sm:block ${idx === i ? "text-fg" : "text-dim group-hover:text-mute"}`}>{st.who}</span>
              </button>
              {idx < steps.length - 1 && <span className={`mx-2 mb-6 h-px flex-1 ${idx < i ? "bg-accent" : "bg-line-strong"}`} />}
            </li>
          ))}
        </ol>
        <AnimatePresence mode="wait">
          <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.2 }} className="mt-10">
            <h3 className="text-2xl tracking-tight md:text-3xl">{s.title}</h3>
            <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-mute">{s.body}</p>
          </motion.div>
        </AnimatePresence>
        <div className="mt-8 flex gap-3">
          <button className="btn-ghost !h-9 !px-3" onClick={() => setI((i + steps.length - 1) % steps.length)} aria-label="previous">←</button>
          <button className="btn-ghost !h-9 !px-3" onClick={() => setI((i + 1) % steps.length)} aria-label="next">→</button>
        </div>
      </div>

      <div className="card bg-raise p-5">
        <div className="flex items-center justify-between font-mono text-[11px] text-dim">
          <span>what {s.who.toLowerCase()} learns</span>
          <span>{String(i + 1).padStart(2, "0")}/{String(steps.length).padStart(2, "0")}</span>
        </div>
        <dl className="mt-4 divide-y divide-line border-y border-line font-mono text-[12px]">
          {fields.map((f) => (
            <div key={f} className="flex items-center justify-between py-3">
              <dt className="text-mute">{f}</dt>
              <dd><Mark v={s.matrix[f]} /></dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs leading-relaxed text-dim">{s.note}</p>
      </div>
    </div>
  );
}
