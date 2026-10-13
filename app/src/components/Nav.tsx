"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { CLUSTER } from "@/lib/config";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export function Nav({ app = false }: { app?: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/70 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-3">
          <img src="/icon.svg" alt="" className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-tight">scash</span>
          <span className="rounded-md border border-mint-500/30 bg-mint-500/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-mint-300">
            {CLUSTER === "devnet" ? "devnet" : "beta"}
          </span>
        </Link>
        <nav className="hidden items-center gap-7 text-sm text-ink-200 md:flex">
          <Link href="/#how" className="hover:text-ink-100">How it works</Link>
          <Link href="/#security" className="hover:text-ink-100">Security</Link>
          <Link href="/#token" className="hover:text-ink-100">SCASH</Link>
          <a href="https://github.com/imadegoodstuff/scash" target="_blank" rel="noreferrer" className="hover:text-ink-100">GitHub</a>
        </nav>
        <div className="flex items-center gap-3">
          {app ? <WalletButton /> : <Link href="/app" className="btn-primary !py-2.5 !px-4 text-sm">Launch app</Link>}
        </div>
      </div>
    </header>
  );
}
