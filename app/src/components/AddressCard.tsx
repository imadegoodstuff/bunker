"use client";
import { useState } from "react";
import { useScash } from "@/lib/store";

export function AddressCard() {
  const { address, rotateAddress } = useScash();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const shortAddr = address ? `${address.slice(0, 14)}…${address.slice(-10)}` : "";
  return (
    <section className="glass p-5">
      <div className="flex items-center justify-between">
        <span className="label">Receive</span>
        <button className="link text-xs" onClick={rotateAddress} title="Derive a fresh unlinkable address">New address</button>
      </div>
      <button onClick={copy} className="mt-3 flex w-full items-center justify-between gap-3 rounded-xl border border-line bg-black/30 px-3.5 py-3 text-left font-mono text-[12px] text-fg transition-colors hover:border-accent/50">
        <span className="truncate">{shortAddr}</span>
        <span className={`shrink-0 text-[11px] ${copied ? "text-ok" : "text-dim"}`}>{copied ? "copied" : "copy"}</span>
      </button>
      <p className="mt-2 text-[11px] leading-relaxed text-dim">Every address you derive is unlinkable to the others. Share freely.</p>
    </section>
  );
}
