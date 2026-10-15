"use client";
import { useState } from "react";
import { BUNKER_TOKEN, CHAIN_NAME, CONFIGURED, LAUNCHPAD_ADDRESS, POOL_ADDRESS, explorerAddr } from "@/lib/config";

/** Official addresses, copyable, linked to the explorer. */
export function Contracts() {
  const rows = [
    { l: "Shielded pool", a: POOL_ADDRESS },
    { l: "Launchpad", a: LAUNCHPAD_ADDRESS },
  ];
  return (
    <section id="contracts" className="border-b rule">
      <div className="max-w-7xl mx-auto px-5 md:px-10 py-8 flex flex-col gap-4">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-2">
          <div>
            <div className="label-signal mb-1">Official addresses · {CHAIN_NAME}</div>
            <div className="text-sm text-mute">Only these. Anything else claiming to be BUNKER is not.</div>
          </div>
        </div>
        <Row label="$BUNKER token (CA)" address={BUNKER_TOKEN} big />
        <div className="grid md:grid-cols-2 gap-3">
          {rows.map((r) => <Row key={r.l} label={r.l} address={r.a} />)}
        </div>
      </div>
    </section>
  );
}

function Row({ label, address, big }: { label: string; address: string; big?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };
  const live = big || CONFIGURED;
  return (
    <div className={`slab p-4 flex flex-col gap-2 min-w-0 ${big ? "border-signal/40" : ""}`}>
      <div className="flex items-center justify-between gap-3">
        <span className={big ? "label-signal" : "label"}>{label}</span>
        {live && (
          <a href={explorerAddr(address as `0x${string}`)} target="_blank" rel="noreferrer" className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-steel hover:text-fg">BscScan ↗</a>
        )}
      </div>
      {live ? (
        <button type="button" onClick={copy} className={`text-left font-mono break-all text-fg hover:text-signal transition-colors ${big ? "text-base md:text-2xl" : "text-[12.5px] md:text-sm"}`} title="Copy address">
          {address}
          <span className="ml-2 text-[10.5px] uppercase tracking-[0.18em] text-dim">{copied ? "copied" : "copy"}</span>
        </button>
      ) : (
        <span className="font-mono text-sm text-warn">not configured</span>
      )}
    </div>
  );
}
