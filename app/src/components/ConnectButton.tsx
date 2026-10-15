"use client";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { CHAIN_ID } from "@/lib/config";
import { short } from "@/lib/format";
import { useBunker } from "@/lib/store";

export function ConnectButton() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const lock = useBunker((s) => s.lock);
  const injected = connectors.find((c) => c.id === "injected") ?? connectors[0];

  if (!isConnected || !address) {
    return (
      <button className="btn btn-signal btn-sm" disabled={isPending || !injected} onClick={() => injected && connect({ connector: injected })}>
        {isPending ? "connecting" : injected ? "connect wallet" : "no wallet found"}
      </button>
    );
  }
  if (chainId !== CHAIN_ID) {
    return (
      <button className="btn btn-sm border-warn text-warn" disabled={switching} onClick={() => switchChain({ chainId: CHAIN_ID })}>
        {switching ? "switching" : "switch to BNB chain"}
      </button>
    );
  }
  return (
    <button className="btn btn-sm font-mono" title="disconnect" onClick={() => { lock(); disconnect(); }}>
      <span className="inline-block w-1.5 h-1.5 bg-signal" />
      {short(address, 4)}
    </button>
  );
}
