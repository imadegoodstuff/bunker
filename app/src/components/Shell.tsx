"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ConnectButton } from "./ConnectButton";
import { publicClient } from "@/lib/chain";
import { Wordmark } from "./Wordmark";
import { indexer, relayer } from "@/lib/api";
import { CHAIN_NAME, CONFIGURED, GITHUB } from "@/lib/config";
import { useBunker } from "@/lib/store";

const NAV = [
  { href: "/app", label: "Vault", code: "01" },
  { href: "/launch", label: "Launchpad", code: "02" },
  { href: "/agents", label: "Agents", code: "03" },
  { href: "/docs", label: "Docs", code: "04" },
  { href: "/android", label: "Android", code: "05" },
  { href: "/ios", label: "iPhone", code: "06" },
];

type Health = "ok" | "down" | "unknown";

function useServices() {
  const [s, setS] = useState<{ indexer: Health; relayer: Health; lag?: number }>({ indexer: "unknown", relayer: "unknown" });
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const [i, r] = await Promise.allSettled([indexer.health(), relayer.info()]);
      if (!alive) return;
      const ih = i.status === "fulfilled" ? i.value : undefined;
      setS({
        indexer: i.status === "fulfilled" ? (ih?.ok ? "ok" : "down") : "down",
        relayer: r.status === "fulfilled" ? "ok" : "down",
        lag: ih?.scan.head != null ? Math.max(0, ih.scan.head - ih.scan.lastBlock) : undefined,
      });
    };
    void tick();
    const id = setInterval(tick, 20_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return s;
}

function useBlock() {
  const [b, setB] = useState<bigint>();
  useEffect(() => {
    let alive = true;
    const tick = () => publicClient.getBlockNumber().then((n) => alive && setB(n)).catch(() => undefined);
    tick();
    const id = setInterval(tick, 6000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  return b;
}

function Dot({ h }: { h: Health }) {
  const c = h === "ok" ? "bg-ok dot-ok" : h === "down" ? "bg-bad" : "bg-dim";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${c} ${h === "ok" ? "blink" : ""}`} />;
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const landing = path === "/";
  const block = useBlock();
  const svc = useServices();
  const phase = useBunker((s) => s.phase);
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);

  if (landing) return <>{children}</>;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[232px_1fr]">
      {/* rail */}
      <aside className={`fixed inset-y-0 left-0 z-40 w-[232px] flex flex-col border-r rule transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 ${open ? "translate-x-0" : "-translate-x-full"}`} style={{ background: "linear-gradient(180deg, #0c0c0e 0%, #08080a 100%)" }}>
        <Link href="/" className="h-16 flex items-center px-5 border-b rule">
          <Wordmark className="h-7" />
        </Link>
        <nav className="py-4">
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} className="rail-link" data-active={path === n.href || path.startsWith(n.href + "/")}>
              <span className="text-dim w-5 text-[10px]">{n.code}</span>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto m-4 p-4 slab-flat space-y-3">
          <div className="label flex items-center justify-between">Services <span className="font-mono text-[9px] tracking-normal text-dim normal-case">live</span></div>
          <div className="space-y-2 font-mono text-[11px]">
            <div className="flex items-center justify-between"><span className="text-mute">indexer</span><span className="flex items-center gap-2 text-fg">{svc.lag !== undefined && svc.lag > 0 ? <span className="text-dim">−{svc.lag} blk</span> : null}<Dot h={svc.indexer} /></span></div>
            <div className="flex items-center justify-between"><span className="text-mute">relayer</span><Dot h={svc.relayer} /></div>
            <div className="flex items-center justify-between"><span className="text-mute">vault</span><span className={phase === "ready" ? "text-signal" : "text-fg"}>{phase === "ready" ? "open" : phase === "syncing" || phase === "deriving" ? "opening" : "sealed"}</span></div>
          </div>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="label block hover:text-fg transition pt-1">source ↗</a>
        </div>
      </aside>
      {open ? <button aria-label="close menu" className="fixed inset-0 z-30 bg-black/60 lg:hidden" onClick={() => setOpen(false)} /> : null}

      {/* main column */}
      <div className="min-w-0 flex flex-col min-h-screen">
        <header className="sticky top-0 z-20 h-16 flex items-center gap-4 px-4 md:px-8 border-b rule bg-bg/80 backdrop-blur-xl">
          <button className="lg:hidden btn btn-ghost btn-sm px-2" onClick={() => setOpen(true)} aria-label="menu">☰</button>
          <div className="hidden md:flex items-center gap-5 font-mono text-[11px] text-mute">
            <span className="chip gap-2"><span className={`inline-block w-1.5 h-1.5 rounded-full ${CONFIGURED ? "bg-signal" : "bg-warn"}`} />{CHAIN_NAME}</span>
            <span className="num text-dim">blk <span className="text-mute">{block ? block.toLocaleString() : "—"}</span></span>
            {!CONFIGURED ? <span className="text-warn">contracts not configured</span> : null}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ConnectButton />
          </div>
        </header>
        <main className="flex-1 px-4 md:px-10 py-10">{children}</main>
        <footer className="px-4 md:px-8 h-12 flex items-center justify-between border-t rule font-mono text-[10.5px] text-dim">
          <span>BUNKER · bunkeronbnb.com</span>
          <span>proofs are made in your browser · nothing private leaves it</span>
        </footer>
      </div>
    </div>
  );
}
