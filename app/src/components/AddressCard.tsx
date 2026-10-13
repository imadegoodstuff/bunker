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
  return (
    <div className="panel p-6">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wider text-ink-400">Receive privately</div>
        <button className="text-xs text-mint-400 hover:text-mint-300" onClick={rotateAddress} title="Derive a fresh unlinkable address from the same keys">
          New address
        </button>
      </div>
      <button onClick={copy} className="mt-3 w-full break-all rounded-xl border border-white/10 bg-ink-900 p-4 text-left font-mono text-xs leading-5 text-ink-100 hover:border-mint-500/40">
        {address}
      </button>
      <div className="mt-2 flex items-center justify-between text-[11px] text-ink-400">
        <span>{copied ? "Copied" : "Click to copy"}</span>
        <span>diversified · bech32m</span>
      </div>
      <p className="mt-4 text-xs leading-relaxed text-ink-200">
        Every address you hand out is a different point on the curve, but all of them decrypt with your single viewing key.
        Give each counterparty its own.
      </p>
    </div>
  );
}
