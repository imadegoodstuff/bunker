"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { CLUSTER } from "@/lib/config";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export function Nav({ app = false }: { app?: boolean }) {
  return (
    <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-6">
      <Link href="/" className="flex items-center gap-2.5">
        <span className="text-[15px] font-medium tracking-tight">scash</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{CLUSTER === "devnet" ? "devnet" : "beta"}</span>
      </Link>
      <nav className="flex items-center gap-6 text-sm">
        <a href="https://github.com/imadegoodstuff/scash/blob/main/SPEC.md" target="_blank" rel="noreferrer" className="link hidden sm:inline">Spec</a>
        <a href="https://github.com/imadegoodstuff/scash" target="_blank" rel="noreferrer" className="link hidden sm:inline">GitHub</a>
        {app ? <WalletButton /> : <Link href="/app" className="btn-primary !h-9">Open app</Link>}
      </nav>
    </header>
  );
}
