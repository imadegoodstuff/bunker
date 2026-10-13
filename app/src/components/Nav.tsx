"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { CLUSTER } from "@/lib/config";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export function Nav({ app = false }: { app?: boolean }) {
  return (
    <>
    <div className="border-b border-line bg-raise px-6 py-2 text-center text-[12px] text-mute">
      Pre-release on {CLUSTER}. Unaudited circuits and programs, development proving keys.{" "}
      <a href="https://github.com/imadegoodstuff/scash/blob/main/SECURITY.md" target="_blank" rel="noreferrer" className="link underline underline-offset-4">Known limitations</a>
    </div>
    <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          <img src="/icon.svg" alt="" className="h-6 w-6 rounded-md" />
          <span className="text-[15px] font-medium tracking-tight">scash</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-dim">{CLUSTER === "devnet" ? "devnet" : "beta"}</span>
        </Link>
        <nav className="flex items-center gap-7 text-sm">
          {!app && (
            <>
              <Link href="/#how" className="link hidden md:inline">How it works</Link>
              <Link href="/#yield" className="link hidden md:inline">Yield</Link>
              <Link href="/#security" className="link hidden md:inline">Security</Link>
              <Link href="/#faq" className="link hidden md:inline">FAQ</Link>
            </>
          )}
          <a href="https://github.com/imadegoodstuff/scash" target="_blank" rel="noreferrer" className="link hidden sm:inline">GitHub</a>
          {app ? <WalletButton /> : <Link href="/app" className="btn-primary !h-9">Open app</Link>}
        </nav>
      </div>
    </header>
    </>
  );
}
