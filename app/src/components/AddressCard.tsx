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
    <section>
      <div className="flex items-center justify-between">
        <span className="label">Receive</span>
        <button className="link text-xs" onClick={rotateAddress} title="Derive a fresh unlinkable address">New address</button>
      </div>
      <button onClick={copy} className="card mt-3 w-full break-all p-4 text-left font-mono text-[12px] leading-5 text-fg transition-colors hover:border-white/30">
        {address}
      </button>
      <p className="mt-2 text-xs text-dim">{copied ? "Copied" : "Click to copy · each address is unlinkable to the others"}</p>
    </section>
  );
}
