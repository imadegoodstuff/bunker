"use client";
import { useEffect, useState } from "react";
import { useBunker } from "@/lib/store";
import { useWallet } from "@/lib/wallet";
import { useSigner } from "@/lib/useSigner";
import { indexer } from "@/lib/api";
import { explorerTx } from "@/lib/config";
import { fmtAmount, short, timeAgo } from "@/lib/format";

export function Card({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="slab p-5 md:p-6">
      <div className="flex items-center justify-between mb-5">
        <h3 className="label flex items-center gap-2.5"><span className="inline-block w-1 h-3 bg-signal/80 rounded-sm" />{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function AddressCard() {
  const { address, rotateAddress, registered, register, unregister, checkRegistry, watchOnly, client, pqAddress } = useBunker();
  const owner = useWallet((w) => w.address);
  const signer = useSigner();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pq, setPq] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (owner && client) void checkRegistry(owner); }, [owner, client]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!address) return null;
  const mine = client?.address();
  const isMine = !!registered && !!mine && registered === mine;
  const shown = pq ? pqAddress() ?? address : address;
  const act = async (f: () => Promise<void>) => { setBusy(true); setErr(undefined); try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <Card title="Receiving address" right={<div className="flex gap-1"><button className="btn btn-ghost btn-sm" data-active={pq} title="Post-quantum: the same vault, with an ML-KEM-768 key attached. Notes sent to it are encrypted under both curves; the address is longer." onClick={() => setPq(!pq)}>{pq ? "pq · on" : "pq"}</button><button className="btn btn-ghost btn-sm" onClick={rotateAddress}>new</button></div>}>
      <button
        className="w-full text-left font-mono text-[11px] leading-relaxed break-all text-fg hover:text-signal transition"
        onClick={() => { void navigator.clipboard.writeText(shown); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      >
        {shown}
      </button>
      <p className="mt-3 font-mono text-[10.5px] text-dim">{copied ? "copied" : pq ? "click to copy · bunkerq1… carries an ML-KEM-768 key: notes to it stay confidential against a future quantum computer (hybrid, never weaker than the classic address)" : "click to copy · every address of yours pays into the same vault; hand out a fresh one per counterparty"}</p>
      {owner && !watchOnly ? (
        <div className="mt-4 border-t rule pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="label mb-1">pay-by-0x</div>
              <p className="font-mono text-[10.5px] text-dim leading-relaxed">
                {isMine ? <>Anyone can now pay <span className="text-fg">{short(owner, 4)}</span> privately: it resolves to this vault on-chain.</>
                  : registered ? <>{short(owner, 4)} points at another vault address.</>
                  : <>Publish this vault under {short(owner, 4)} so people can pay your plain address and it still lands here, unlinkably.</>}
              </p>
            </div>
            {isMine
              ? <button className="btn btn-ghost btn-sm shrink-0" disabled={busy || !signer} onClick={() => act(() => unregister(signer!))}>{busy ? "…" : "clear"}</button>
              : <button className="btn btn-sm shrink-0" disabled={busy || !signer} onClick={() => act(() => register(signer!))}>{busy ? "…" : registered ? "re-register" : "register"}</button>}
          </div>
          {err ? <p className="mt-2 font-mono text-[10.5px] text-bad break-words">{err}</p> : null}
        </div>
      ) : null}
    </Card>
  );
}

export function BackupCard() {
  const exportSeed = useBunker((s) => s.exportSeed);
  const exportViewingKey = useBunker((s) => s.exportViewingKey);
  const exportDisclosure = useBunker((s) => s.exportDisclosure);
  const forgetDevice = useBunker((s) => s.forgetDevice);
  const download = (scope: "notes" | "full") => {
    const text = exportDisclosure(scope);
    if (!text) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    a.download = `bunker-disclosure-${scope}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const watchOnly = useBunker((s) => s.watchOnly);
  const device = useWallet((w) => w.device);
  const account = useWallet((w) => w.address);
  const [shown, setShown] = useState<{ kind: "seed" | "view"; value: string }>();
  const [confirm, setConfirm] = useState(false);
  return (
    <Card title={device ? "Device vault" : watchOnly ? "Watch-only" : "Backup"}>
      {device && account ? (
        <div className="mb-4">
          <div className="label mb-1.5">built-in BNB account</div>
          <code className="block font-mono text-[11px] break-all p-3 bg-bg border rule select-all">{account}</code>
          <p className="mt-2 font-mono text-[10.5px] text-dim">send BNB or tokens here to shield them; trades and sends need no gas from it</p>
        </div>
      ) : null}
      {shown ? (
        <>
          <code className="block font-mono text-[11px] break-all p-3 bg-bg border rule select-all">{shown.value}</code>
          {shown.kind === "seed"
            ? <p className="mt-3 font-mono text-[10.5px] text-warn">This is the spending key. Anyone who reads it can spend everything{device ? ", including the built-in account" : ""}.</p>
            : <p className="mt-3 font-mono text-[10.5px] text-dim">A viewing key shows every note, memo and spend of this vault to whoever holds it, and lets them sign nothing. Hand it to an accountant or paste it into a second device as a read-only mirror.</p>}
          <button className="btn btn-ghost btn-sm mt-3" onClick={() => setShown(undefined)}>hide</button>
        </>
      ) : (
        <>
          <p className="text-sm text-mute leading-relaxed">
            {watchOnly
              ? "Opened from a viewing key. Balances and history are exact; spending needs the seed."
              : device
                ? "This vault exists only on this device. The backup string is the only way to open it anywhere else."
                : "Your vault is reproducible from wallet + passphrase. Export the raw seed only if you want to open it without the wallet."}
          </p>
          <div className="flex flex-wrap gap-2 mt-3">
            {watchOnly ? null : <button className="btn btn-sm" onClick={() => { const v = exportSeed(); if (v) setShown({ kind: "seed", value: v }); }}>reveal seed</button>}
            <button className="btn btn-ghost btn-sm" onClick={() => { const v = exportViewingKey(); if (v) setShown({ kind: "view", value: v }); }}>viewing key</button>
            <button className="btn btn-ghost btn-sm" title="A JSON report of every note of this vault with its opening: whoever you hand it to can recompute each commitment against the chain, and learns nothing else." onClick={() => download("notes")}>disclosure report</button>
            {device ? (
              confirm
                ? <button className="btn btn-sm border-bad text-bad" onClick={() => forgetDevice()}>yes, wipe it from this device</button>
                : <button className="btn btn-ghost btn-sm" onClick={() => setConfirm(true)}>forget this device</button>
            ) : null}
          </div>
          {confirm ? <p className="mt-2 font-mono text-[10.5px] text-warn">Only do this with the backup string saved. The built-in account and every note stay spendable from it.</p> : null}
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
  const { totalLeaves, syncedTo, notes, lastProveMs, pending, relayer } = useBunker();
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
        Synced {syncedTo.toLocaleString()} / {totalLeaves.toLocaleString()}{pending > 0 ? `, ${pending} queued for the next batch` : ""}. Every output is a note; three per transaction (payment, change, relayer fee), so even the fee hides. A bigger, busier tree is a better hiding place.
        {lastProveMs ? ` Last proof on this device: ${(lastProveMs / 1000).toFixed(1)} s.` : ""}
        {relayer?.shieldedAddress ? " The relayer is paid in notes, never in public." : ""}
      </p>
    </Card>
  );
}

function Stat({ label, v }: { label: string; v: string }) {
  return <div className="bg-slab p-3"><div className="label mb-1 text-[9.5px]">{label}</div><div className="font-mono text-base num">{v}</div></div>;
}
