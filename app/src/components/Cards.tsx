"use client";
import { useEffect, useState } from "react";
import { useBunker } from "@/lib/store";
import { indexer } from "@/lib/api";
import { explorerTx } from "@/lib/config";
import { fmtAmount, short, timeAgo } from "@/lib/format";

export function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="slab p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="label">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function AddressCard() {
  const { address, rotateAddress } = useBunker();
  const [copied, setCopied] = useState(false);
  if (!address) return null;
  return (
    <Card title="Receiving address" right={<button className="btn btn-ghost btn-sm" onClick={rotateAddress}>new</button>}>
      <button
        className="w-full text-left font-mono text-[11px] leading-relaxed break-all text-fg hover:text-signal transition"
        onClick={() => { void navigator.clipboard.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      >
        {address}
      </button>
      <p className="mt-3 font-mono text-[10.5px] text-dim">{copied ? "copied" : "click to copy · every address of yours pays into the same vault; hand out a fresh one per counterparty"}</p>
    </Card>
  );
}

export function BackupCard() {
  const exportSeed = useBunker((s) => s.exportSeed);
  const [shown, setShown] = useState<string>();
  return (
    <Card title="Backup">
      {shown ? (
        <>
          <code className="block font-mono text-[11px] break-all p-3 bg-bg border rule select-all">{shown}</code>
          <p className="mt-3 font-mono text-[10.5px] text-warn">This is the spending key. Anyone who reads it can spend everything.</p>
          <button className="btn btn-ghost btn-sm mt-3" onClick={() => setShown(undefined)}>hide</button>
        </>
      ) : (
        <>
          <p className="text-sm text-mute leading-relaxed">Your vault is reproducible from wallet + passphrase. Export the raw seed only if you want to open it without the wallet.</p>
          <button className="btn btn-sm mt-3" onClick={() => setShown(exportSeed())}>reveal seed</button>
        </>
      )}
    </Card>
  );
}

export function Activity() {
  const activity = useBunker((s) => s.activity);
  return (
    <Card title="This session">
      {activity.length === 0 ? <p className="font-mono text-[11px] text-dim">nothing yet</p> : (
        <ul className="divide-y rule">
          {activity.map((a) => (
            <li key={a.id} className="py-2.5 flex items-center gap-3 font-mono text-[11px]">
              <span className={`w-1.5 h-1.5 ${a.status === "confirmed" ? "bg-ok" : a.status === "failed" ? "bg-bad" : "bg-warn blink"}`} />
              <span className="uppercase tracking-[0.15em] text-mute w-16">{a.kind}</span>
              <span className="text-fg num">{a.amount > 0n ? `${fmtAmount(a.amount, a.decimals)} ` : ""}{a.asset}</span>
              <span className="ml-auto text-dim">{timeAgo(a.at)}</span>
              {a.txHash ? <a className="text-steel hover:text-fg" href={explorerTx(a.txHash)} target="_blank" rel="noreferrer">{short(a.txHash, 4)}</a> : null}
              {a.error ? <span className="text-bad truncate max-w-[40%]" title={a.error}>{a.error}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function AnonymityPanel() {
  const { totalLeaves, syncedTo, notes, lastProveMs } = useBunker();
  const [stats, setStats] = useState<Awaited<ReturnType<typeof indexer.stats>>>();
  useEffect(() => { indexer.stats(7).then(setStats).catch(() => undefined); }, [totalLeaves]);
  const week = stats?.daily.reduce((n, d) => n + d.txs, 0) ?? 0;
  return (
    <Card title="Crowd">
      <div className="grid grid-cols-3 gap-px bg-line border rule">
        <Stat label="notes in tree" v={totalLeaves.toLocaleString()} />
        <Stat label="txs · 7d" v={week.toLocaleString()} />
        <Stat label="your notes" v={String(notes.length)} />
      </div>
      <p className="mt-3 font-mono text-[10.5px] text-dim leading-relaxed">
        Synced {syncedTo.toLocaleString()} / {totalLeaves.toLocaleString()}. Your withdrawal hides among everything shielded before it; a bigger, busier tree is a better hiding place.
        {lastProveMs ? ` Last proof on this device: ${(lastProveMs / 1000).toFixed(1)} s.` : ""}
      </p>
    </Card>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return <div className="bg-slab p-3"><div className="label mb-1 text-[9.5px]">{label}</div><div className="font-mono text-base num">{v}</div></div>;
}
