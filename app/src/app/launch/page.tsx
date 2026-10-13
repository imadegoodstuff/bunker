"use client";
import { useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { LaunchShell, Row } from "@/components/launch/LaunchShell";
import { useLaunchpad } from "@/lib/launchpad";
import { fmtAmount, timeAgo } from "@/lib/format";
import type { LaunchRow } from "@/lib/api";

export default function LaunchListPage() {
  return (
    <LaunchShell wide>
      <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
        <LaunchList />
        <aside className="space-y-4">
          <CreateCard />
          <WhatIsPublic />
        </aside>
      </div>
    </LaunchShell>
  );
}

function progress(l: LaunchRow) {
  const g = BigInt(l.graduation_lamports);
  return g === 0n ? 1 : Math.min(1, Number(BigInt(l.real_sol)) / Number(g));
}

function LaunchList() {
  const { launches, loaded } = useLaunchpad();
  return (
    <section className="glass noise overflow-hidden">
      <div className="flex items-end justify-between px-7 pt-7">
        <div>
          <div className="label">Launched inside the pool</div>
          <h1 className="mt-2 text-3xl tracking-[-0.03em]">Tokens you can buy without a wallet showing up</h1>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-mute">
            Every token here is bought and sold from shielded notes. Until a curve graduates there is no public route in: a buyer&apos;s only on-chain
            footprint is a throwaway key that exists for one transaction.
          </p>
        </div>
      </div>
      <div className="mt-6 divide-y divide-line border-t border-line">
        {!loaded && <p className="px-7 py-6 text-sm text-dim">Loading…</p>}
        {loaded && launches.length === 0 && <p className="px-7 py-6 text-sm text-dim">Nothing launched yet on this cluster. Be the first — the form is on the right.</p>}
        {launches.map((l) => {
          const p = progress(l);
          return (
            <Link key={l.mint} href={`/launch/${l.mint}`} className="block px-7 py-5 transition-colors hover:bg-white/[0.03]">
              <div className="flex items-baseline justify-between gap-4">
                <div className="flex items-baseline gap-3">
                  <span className="text-lg">{l.name}</span>
                  <span className="font-mono text-xs text-dim">{l.symbol}</span>
                  {l.graduated ? <span className="rounded-full border border-accent/40 px-2 py-0.5 font-mono text-[10px] uppercase text-accent">graduated</span> : null}
                </div>
                <span className="text-xs text-dim">{l.block_time ? timeAgo(l.block_time * 1000) : `slot ${l.slot}`}</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-accent" style={{ width: `${(p * 100).toFixed(1)}%` }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-mute">
                <span>{fmtAmount(BigInt(l.real_sol), 9, 2)} / {fmtAmount(BigInt(l.graduation_lamports), 9, 0)} SOL raised</span>
                <span>{l.buys} buys · {l.sells} sells</span>
                <span>{fmtAmount(BigInt(l.sol_volume), 9, 2)} SOL volume</span>
                <span>{fmtAmount(BigInt(l.tokens_donated), l.decimals, 0)} {l.symbol} paid to holders</span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function CreateCard() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const launch = useLaunchpad((s) => s.launch);
  const busy = useLaunchpad((s) => s.busy);
  const router = useRouter();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [uri, setUri] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const submit = async () => {
    setErr(null);
    if (!publicKey) return setErr("Connect a wallet");
    if (!name.trim() || !symbol.trim()) return setErr("Name and symbol are required");
    if (name.length > 32 || symbol.length > 10 || uri.length > 200) return setErr("Name ≤ 32, symbol ≤ 10, URI ≤ 200 characters");
    try {
      const mint = await launch({ name: name.trim(), symbol: symbol.trim().toUpperCase(), uri: uri.trim() }, publicKey, (tx) => sendTransaction(tx, connection));
      router.push(`/launch/${mint.toBase58()}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className="glass p-5">
      <div className="label">Launch a token</div>
      <p className="mt-2 text-xs leading-relaxed text-mute">
        Two wallet signatures. You pay the rent (about 0.02 SOL) and get nothing else: no allocation, no mint or freeze authority, no fee switch.
      </p>
      <div className="mt-4 space-y-3">
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
        <input className="input font-mono uppercase" placeholder="SYMBOL" value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} />
        <input className="input font-mono text-[13px]" placeholder="Metadata URI (optional)" value={uri} onChange={(e) => setUri(e.target.value)} maxLength={200} />
      </div>
      <dl className="mt-4 space-y-1.5 text-xs">
        <Row k="Supply" v="1,000,000,000 · 6 decimals" />
        <Row k="On the curve" v="793,100,000 (79.3%)" />
        <Row k="Graduates at" v="85 SOL raised" />
        <Row k="Trading fee" v="0.5–3%, set per token by four AI agents each epoch · 50–100% of it to holders" />
        <Row k="Your privileges" v="none" strong />
      </dl>
      {err && <p className="mt-3 text-sm text-bad">{err}</p>}
      <button className="btn-primary mt-4 h-11 w-full" disabled={busy === "launch"} onClick={submit}>
        {busy === "launch" ? "Launching…" : "Launch"}
      </button>
    </section>
  );
}

function WhatIsPublic() {
  return (
    <section className="glass p-5 text-xs leading-relaxed">
      <div className="label">What stays public</div>
      <ul className="mt-3 space-y-2 text-mute">
        <li><span className="text-fg">The curve.</span> Reserves, every trade&apos;s size and time, fees, graduation. Anyone can chart it.</li>
        <li><span className="text-fg">The creator.</span> Whoever paid the launch rent.</li>
        <li><span className="text-fg">One throwaway key per trade.</span> Funded by the vault, emptied by the claim, never reused, never linked to a wallet.</li>
      </ul>
      <div className="label mt-5">What does not exist on-chain</div>
      <ul className="mt-3 space-y-2 text-mute">
        <li>Which shielded note paid for a buy, or who holds the tokens afterwards — holdings are notes in the token&apos;s own pool.</li>
        <li>Any link between a buy and the later sell of the same tokens.</li>
      </ul>
      <p className="mt-4 text-dim">Timing and amounts are still signals. Round sizes and the relayer&apos;s random delay blunt them; they do not remove them.</p>
    </section>
  );
}
