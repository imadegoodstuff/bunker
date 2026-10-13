"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { CLUSTER, MAINNET } from "@/lib/config";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export function Nav({ app = false }: { app?: boolean }) {
  return (
    <>
    <header className="sticky top-0 z-40">
      <div className="mx-auto mt-4 flex h-14 w-[calc(100%-2rem)] max-w-6xl items-center justify-between rounded-full border border-line bg-bg/70 px-3 pl-4 backdrop-blur-xl">
        <Link href="/" className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="h-6 w-6 rounded-md" />
          <span className="text-[15px] font-medium tracking-tight">scash</span>
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">{MAINNET ? "mainnet" : CLUSTER}</span>
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          {!app && (
            <>
              <Link href="/#how" className="link hidden md:inline">How it works</Link>
              <Link href="/#yield" className="link hidden md:inline">Yield</Link>
              <Link href="/#security" className="link hidden md:inline">Security</Link>
              <Link href="/#faq" className="link hidden md:inline">FAQ</Link>
            </>
          )}
          <Link href="/launch" className="link hidden sm:inline">Launchpad</Link>
          <a href="https://github.com/imadegoodstuff/scash" target="_blank" rel="noreferrer" className="link hidden sm:inline">GitHub</a>
          {app ? <WalletButton /> : <Link href="/app" className="btn-primary !h-10">Open app</Link>}
        </nav>
      </div>
    </header>
    </>
  );
}
