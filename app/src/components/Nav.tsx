"use client";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { CLUSTER, MAINNET } from "@/lib/config";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

const LINKS: [string, string][] = [
  ["How it works", "/#how"],
  ["Launchpad", "/launch"],
  ["Why scash", "/#why"],
  ["Security", "/#security"],
  ["FAQ", "/#faq"],
];

export function Nav({ app = false }: { app?: boolean }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);
  return (
    <header className="sticky top-0 z-40">
      <div className="mx-auto mt-3 flex h-14 w-[calc(100%-1.5rem)] max-w-6xl items-center justify-between rounded-full border border-line bg-bg/70 px-3 pl-4 backdrop-blur-xl sm:mt-4 sm:w-[calc(100%-2rem)]">
        <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
          <img src="/icon.svg" alt="" className="h-6 w-6 rounded-md" />
          <span className="text-[15px] font-medium tracking-tight">scash</span>
          <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">{MAINNET ? "mainnet" : CLUSTER}</span>
        </Link>
        <nav className="flex items-center gap-2 text-sm sm:gap-5">
          {!app && LINKS.map(([l, h]) => (
            <Link key={h} href={h} className="link hidden lg:inline">{l}</Link>
          ))}
          {app && <Link href="/launch" className="link hidden sm:inline">Launchpad</Link>}
          <a href="https://github.com/imadegoodstuff/scash" target="_blank" rel="noreferrer" className="link hidden lg:inline">GitHub</a>
          {app ? <WalletButton /> : <Link href="/app" className="btn-primary !h-10 !px-4 sm:!px-5">Open app</Link>}
          {!app && (
            <button
              type="button"
              aria-label={open ? "Close menu" : "Open menu"}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
              className="flex h-10 w-10 items-center justify-center rounded-full border border-line text-fg lg:hidden"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
              </svg>
            </button>
          )}
        </nav>
      </div>
      {open && !app && (
        <div className="fixed inset-0 top-[4.25rem] z-30 bg-bg/95 backdrop-blur-xl lg:hidden" onClick={() => setOpen(false)}>
          <nav className="mx-auto flex w-[calc(100%-1.5rem)] max-w-6xl flex-col gap-1 pt-4 text-lg" onClick={(e) => e.stopPropagation()}>
            {LINKS.map(([l, h]) => (
              <Link key={h} href={h} onClick={() => setOpen(false)} className="rounded-2xl px-4 py-3.5 text-fg hover:bg-white/5">{l}</Link>
            ))}
            <a href="https://github.com/imadegoodstuff/scash" target="_blank" rel="noreferrer" className="rounded-2xl px-4 py-3.5 text-fg hover:bg-white/5">GitHub</a>
            <div className="mt-4 grid gap-2 px-2">
              <Link href="/app" onClick={() => setOpen(false)} className="btn-primary w-full">Open app</Link>
              <Link href="/launch" onClick={() => setOpen(false)} className="btn-ghost w-full">Launch a token</Link>
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
