"use client";
import { useEffect } from "react";
import Link from "next/link";
import { useWallet } from "@solana/wallet-adapter-react";
import { Nav } from "@/components/Nav";
import { TxOverlay } from "@/components/TxOverlay";
import { useScash } from "@/lib/store";
import { useLaunchpad } from "@/lib/launchpad";

/**
 * Nav + layout shared by the launchpad pages. The launchpad is public: the
 * list, every curve and the launch form need no shielded wallet (launching
 * needs only a connected Solana wallet to sign two transactions). Only
 * trading and holdings, which spend notes, ask for the shielded unlock — the
 * pages do that inline where it is needed.
 */
export function LaunchShell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const { connected } = useWallet();
  const phase = useScash((s) => s.phase);
  const lock = useScash((s) => s.lock);
  const load = useLaunchpad((s) => s.load);
  useEffect(() => {
    if (!connected && phase !== "idle") lock();
  }, [connected, phase, lock]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);
  // claims persisted under the spending seed become readable once the wallet is open
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
        {children}
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
