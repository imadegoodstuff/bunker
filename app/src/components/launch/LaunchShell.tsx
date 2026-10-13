"use client";
import { useEffect } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { Nav } from "@/components/Nav";
import { Unlock } from "@/components/Unlock";
import { TxOverlay } from "@/components/TxOverlay";
import { useScash } from "@/lib/store";
import { useLaunchpad } from "@/lib/launchpad";

/** Nav + unlock gate shared by the launchpad pages; loads launches once the wallet is open. */
export function LaunchShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const { connected } = useWallet();
  const phase = useScash((s) => s.phase);
  const lock = useScash((s) => s.lock);
  const load = useLaunchpad((s) => s.load);
  useEffect(() => {
    if (!connected && phase !== "idle") lock();
  }, [connected, phase, lock]);
  useEffect(() => {
    if (phase === "ready") void load();
  }, [phase, load]);

  return (
    <>
      <div className="hero-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[40rem]" />
      <Nav app />
      <main className={`mx-auto px-6 pb-24 pt-10 ${wide ? "max-w-6xl" : "max-w-5xl"}`}>
        <div className="mb-6 flex items-center gap-4 text-sm">
          <Link href="/app" className="link">Wallet</Link>
          <span className="text-dim">/</span>
          <Link href="/launch" className="link">Launchpad</Link>
        </div>
        {phase !== "ready" ? <Unlock /> : children}
      </main>
      <TxOverlay />
    </>
  );
}

export function Row({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-dim">{k}</dt>
      <dd className={`text-right ${strong ? "text-fg" : "text-mute"}`}>{v}</dd>
    </div>
  );
}
