"use client";
import { useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useRouter } from "next/navigation";
import { LaunchShell, Row } from "@/components/launch/LaunchShell";
import { useLaunchpad } from "@/lib/launchpad";
import { barWidth, fmtAmount, fmtProgress, timeAgo } from "@/lib/format";
import type { LaunchRow } from "@/lib/api";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

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
  if (l.graduated || l.amm_pool) return 1;
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
            Every token here is bought and sold from shielded notes. Until a curve graduates at 20 SOL there is no public route in: a buyer&apos;s only on-chain
            footprint is a throwaway key that exists for one transaction. At graduation the curve becomes a Raydium pool with its LP burned.
          </p>
        </div>
      </div>
      <div className="mt-6 divide-y divide-line border-t border-line">
        {!loaded && <p className="px-7 py-6 text-sm text-dim">Loading…</p>}
        {loaded && launches.length === 0 && <p className="px-7 py-6 text-sm text-dim">Nothing launched yet. Be the first — the form is on the right; any wallet can launch.</p>}
        {launches.map((l) => {
          const p = progress(l);
          return (
            <Link key={l.mint} href={`/launch/${l.mint}`} className="flex gap-4 px-7 py-5 transition-colors hover:bg-white/[0.03]">
              {l.image ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={l.image} alt="" className="mt-0.5 h-12 w-12 shrink-0 rounded-xl object-cover" />
              ) : (
                <span className="mt-0.5 flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-white/5 font-mono text-xs text-dim">{l.symbol.slice(0, 3)}</span>
              )}
              <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-4">
                <div className="flex items-baseline gap-3">
                  <span className="text-lg">{l.name}</span>
                  <span className="font-mono text-xs text-dim">{l.symbol}</span>
                  {l.amm_pool ? <span className="rounded-full border border-accent/40 px-2 py-0.5 font-mono text-[10px] uppercase text-accent">on Raydium</span>
                    : l.graduated ? <span className="rounded-full border border-accent/40 px-2 py-0.5 font-mono text-[10px] uppercase text-accent">graduated</span> : null}
                </div>
                <span className="text-xs text-dim">{l.block_time ? timeAgo(l.block_time * 1000) : `slot ${l.slot}`}</span>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-white/5">
                <div className="h-full rounded-full bg-accent" style={{ width: barWidth(p) }} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-mute">
                {l.amm_pool
                  ? <span>{fmtAmount(BigInt(l.amm_sol ?? "0"), 9, 2)} SOL + {fmtAmount(BigInt(l.amm_tokens ?? "0"), l.decimals, 0)} {l.symbol} in the pool</span>
                  : <span>{fmtAmount(BigInt(l.real_sol), 9, 3)} / {fmtAmount(BigInt(l.graduation_lamports), 9, 0)} SOL raised · {fmtProgress(p)}</span>}
                <span>{l.buys} buys · {l.sells} sells</span>
                <span>{fmtAmount(BigInt(l.sol_volume), 9, 2)} SOL volume</span>
                <span>{fmtAmount(BigInt(l.tokens_donated), l.decimals, 0)} {l.symbol} paid to holders</span>
              </div>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function CreateCard() {
  const { publicKey, connected, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const launch = useLaunchpad((s) => s.launch);
  const busy = useLaunchpad((s) => s.busy);
  const router = useRouter();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [header, setHeader] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // The same rules listing sites apply, checked before upload so a creator
  // uploads one set of files everywhere: icon 1:1 and ≥ 100 px, header 3:1 and
  // ≥ 600 px wide, PNG/JPEG/GIF/WebP, ≤ 4.5 MB each.
  const pickImage = (file: File | undefined, kind: "icon" | "header") => {
    setErr(null);
    (kind === "icon" ? setImage : setHeader)(null);
    if (!file) return;
    const what = kind === "icon" ? "Icon" : "Header";
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)) return setErr(`${what} must be PNG, JPEG, GIF or WebP`);
    if (file.size > 4.5 * 1024 * 1024) return setErr(`${what} must be 4.5 MB or smaller`);
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      const probe = new Image();
      probe.onload = () => {
        const { naturalWidth: w, naturalHeight: h } = probe;
        if (kind === "icon") {
          if (w < 100) return setErr("Icon must be at least 100 px wide");
          if (Math.abs(w - h) > Math.max(2, w * 0.02)) return setErr(`Icon must be square (1:1); this one is ${w}×${h}`);
          setImage(url);
        } else {
          if (w < 600) return setErr("Header must be at least 600 px wide");
          if (Math.abs(w / h - 3) > 0.06) return setErr(`Header must be 3:1 (for example 1500×500); this one is ${w}×${h}`);
          setHeader(url);
        }
      };
      probe.onerror = () => setErr(`Could not decode the ${what.toLowerCase()}`);
      probe.src = url;
    };
    r.onerror = () => setErr(`Could not read the ${what.toLowerCase()}`);
    r.readAsDataURL(file);
  };

  const submit = async () => {
    setErr(null);
    if (!publicKey) return setErr("Connect a wallet");
    if (!name.trim() || !symbol.trim()) return setErr("Name and symbol are required");
    if (!image) return setErr("An image is required");
    if (name.length > 32 || symbol.length > 10 || description.length > 500) return setErr("Name ≤ 32, symbol ≤ 10, description ≤ 500 characters");
    try {
      const mint = await launch({ name: name.trim(), symbol: symbol.trim().toUpperCase(), description: description.trim(), image, header: header ?? undefined }, publicKey, (tx) => sendTransaction(tx, connection));
      router.push(`/launch/${mint.toBase58()}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <section className="glass p-5">
      <div className="label">Launch a token</div>
      <p className="mt-2 text-xs leading-relaxed text-mute">
        Anyone with a wallet. Two signatures; you pay the rent (about 0.02 SOL) and get nothing else: no allocation, no mint or freeze authority, no fee switch.
        No shielded wallet is needed to launch — only to trade.
      </p>
      <div className="mt-4 space-y-3">
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-line p-3 transition-colors hover:border-accent/50">
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="" className="h-14 w-14 rounded-lg object-cover" />
          ) : (
            <span className="flex h-14 w-14 items-center justify-center rounded-lg bg-white/5 font-mono text-[10px] uppercase text-dim">image</span>
          )}
          <span className="text-xs leading-relaxed text-mute">
            <span className="text-fg">{image ? "Icon chosen" : "Icon (required)"}</span>
            <br />Square, at least 100×100. PNG, JPEG, GIF or WebP, up to 4.5 MB. Hosted immutably, content-addressed.
          </span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => pickImage(e.target.files?.[0], "icon")} />
        </label>
        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-line p-3 transition-colors hover:border-accent/50">
          {header ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={header} alt="" className="h-10 w-[7.5rem] shrink-0 rounded-lg object-cover" />
          ) : (
            <span className="flex h-10 w-[7.5rem] shrink-0 items-center justify-center rounded-lg bg-white/5 font-mono text-[10px] uppercase text-dim">header</span>
          )}
          <span className="text-xs leading-relaxed text-mute">
            <span className="text-fg">{header ? "Header chosen" : "Header (optional)"}</span>
            <br />3:1 banner, at least 600 px wide (1500×500 is typical). Shown on the token page and written into the metadata for listing sites.
          </span>
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => pickImage(e.target.files?.[0], "header")} />
        </label>
        <input className="input" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} />
        <input className="input font-mono uppercase" placeholder="SYMBOL" value={symbol} onChange={(e) => setSymbol(e.target.value)} maxLength={10} />
        <textarea className="input min-h-[4.5rem] text-[13px]" placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
      </div>
      <dl className="mt-4 space-y-1.5 text-xs">
        <Row k="Supply" v="1,000,000,000 · 6 decimals" />
        <Row k="On the curve" v="793,100,000 (79.3%)" />
        <Row k="Graduates at" v="20 SOL raised" />
        <Row k="Then" v="curve SOL + the reserved 20.7% of supply become a Raydium pool; LP burned" />
        <Row k="Trading tax" v="0–5% until graduation, set per token by four AI agents every minute · it funds scash buybacks (burn or airdrop)" />
        <Row k="Your privileges" v="none" strong />
      </dl>
      {err && <p className="mt-3 text-sm text-bad">{err}</p>}
      {connected ? (
        <button className="btn-primary mt-4 h-11 w-full" disabled={busy === "launch"} onClick={submit}>
          {busy === "launch" ? "Launching…" : "Launch"}
        </button>
      ) : (
        <div className="mt-4 flex justify-center"><WalletButton /></div>
      )}
    </section>
  );
}

function WhatIsPublic() {
  return (
    <section className="glass p-5 text-xs leading-relaxed">
      <div className="label">What stays public</div>
      <ul className="mt-3 space-y-2 text-mute">
        <li><span className="text-fg">The curve.</span> Reserves, every trade&apos;s size and time, fees, graduation, the Raydium pool it becomes. Anyone can chart it.</li>
        <li><span className="text-fg">The creator.</span> Whoever paid the launch rent, and the image and text they uploaded.</li>
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
