"use client";
import { useState } from "react";
import { CHAIN_ID } from "@/lib/config";
import { short } from "@/lib/format";
import { useBunker } from "@/lib/store";
import { useWallet } from "@/lib/wallet";

export function ConnectButton() {
  const w = useWallet();
  const lock = useBunker((s) => s.lock);
  const [switching, setSwitching] = useState(false);

  if (!w.ready) return <span className="btn btn-sm opacity-0">connect wallet</span>;
  if (!w.address) {
    return (
      <button className="btn btn-signal btn-sm" disabled={w.connecting || !w.available} onClick={() => w.connect()} title={w.error}>
        {w.connecting ? "connecting" : w.available ? "connect wallet" : "no wallet found"}
      </button>
    );
  }
  if (w.chainId !== CHAIN_ID) {
    return (
      <button className="btn btn-sm border-warn text-warn" disabled={switching} onClick={async () => { setSwitching(true); try { await w.switchChain(); } finally { setSwitching(false); } }}>
        {switching ? "switching" : "switch to BNB chain"}
      </button>
    );
  }
  return (
    <button className="btn btn-sm font-mono" title={w.device ? "lock (the vault stays on this device)" : "disconnect"} onClick={() => { lock(); w.disconnect(); }}>
      <span className={`inline-block w-1.5 h-1.5 ${w.device ? "bg-steel" : "bg-signal"}`} />
      {w.device ? "device · " : ""}{short(w.address, 4)}
    </button>
  );
}
