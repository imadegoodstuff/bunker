"use client";
import { useEffect, useState } from "react";
import { isAddress, getAddress, type Hex } from "viem";
import { useLegacy, type LegacyHolding, type MigrateQuote } from "@/lib/legacy";
import { useBunker } from "@/lib/store";
import { explorerAddr, MIGRATE_EXIT_ADDRESS, POOL_V1_ADDRESS } from "@/lib/config";
import { fmtAmount, parseAmount, short } from "@/lib/format";
import { Card } from "@/components/Cards";

/**
 * Everything a user still has in protocol v1: notes in the first pool, and
 * claim keys a crashed v1 trade may have left funds on. Each holding can be
 * migrated into the v2 pool in one relayed transaction or withdrawn.
 */
export function LegacyPanel() {
  const lg = useLegacy();
  const watchOnly = useBunker((s) => s.watchOnly);
  const [open, setOpen] = useState<string>();
  const [msg, setMsg] = useState<string>();

  useEffect(() => {
    if (lg.phase !== "ready") return;
    const id = setInterval(() => void lg.sync(), 20_000);
    return () => clearInterval(id);
  }, [lg.phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (lg.phase === "off" || watchOnly) return null;

  const right = lg.phase === "ready"
    ? <button className="btn btn-ghost btn-sm" disabled={!!lg.busy} onClick={() => { setMsg(undefined); lg.recover().then((n) => setMsg(n ? `recovered ${n} claim key${n > 1 ? "s" : ""}` : "no stranded claims")).catch((e) => setMsg((e as Error).message)); }}>{lg.busy === "recover" ? "scanning…" : "recover claims"}</button>
    : null;

  return (
    <Card title="Protocol v1 (legacy pool)" right={right}>
      {lg.phase === "opening" ? <p className="font-mono text-[11px] text-dim">scanning the v1 pool…</p> : null}
      {lg.phase === "error" ? <p className="font-mono text-[11px] text-warn break-words">{lg.error}</p> : null}
      {lg.phase === "ready" && lg.holdings.length === 0 ? (
        <p className="font-mono text-[10.5px] text-dim leading-relaxed">
          Nothing of yours is left in the first pool (<a href={explorerAddr(POOL_V1_ADDRESS!)} target="_blank" rel="noreferrer" className="hover:text-fg">{short(POOL_V1_ADDRESS!, 4)} ↗</a>). v1 tokens still trade from the launchpad; what you buy there lands here and can be migrated.
        </p>
      ) : null}
      {lg.holdings.length ? (
        <ul className="divide-y rule">
          {lg.holdings.map((h) => (
            <li key={h.token} className="py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm num text-fg">{fmtAmount(h.amount, h.decimals, h.decimals > 6 ? 5 : 2)} <span className="text-mute">{h.symbol}</span></div>
                  <div className="font-mono text-[10px] text-dim">{h.notes} v1 note{h.notes === 1 ? "" : "s"}</div>
                </div>
                <div className="ml-auto flex gap-1.5">
                  <button className="btn btn-signal btn-sm" disabled={!!lg.busy || !MIGRATE_EXIT_ADDRESS} onClick={() => setOpen(open === `m:${h.token}` ? undefined : `m:${h.token}`)}>migrate to v2</button>
                  <button className="btn btn-ghost btn-sm" disabled={!!lg.busy} onClick={() => setOpen(open === `w:${h.token}` ? undefined : `w:${h.token}`)}>withdraw</button>
                </div>
              </div>
              {open === `m:${h.token}` ? <Migrate h={h} onDone={() => setOpen(undefined)} /> : null}
              {open === `w:${h.token}` ? <Withdraw h={h} onDone={() => setOpen(undefined)} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {msg ? <p className="mt-3 font-mono text-[10.5px] text-mute">{msg}</p> : null}
      <p className="mt-3 font-mono text-[10px] text-dim leading-relaxed">
        The first pool is an immutable contract; your v1 notes stay yours and spend with the v1 circuits. A migration is one relayed transaction: the v1 pool pays the bridge, the bridge shields the same funds into v2, and no public address ever holds them.
      </p>
    </Card>
  );
}

function Migrate({ h, onDone }: { h: LegacyHolding; onDone: () => void }) {
  const lg = useLegacy();
  const [amt, setAmt] = useState(fmtAmount(h.amount, h.decimals, h.decimals).replace(/,/g, ""));
  const [quote, setQuote] = useState<MigrateQuote | { error: string }>();
  const [err, setErr] = useState<string>();
  const [hash, setHash] = useState<Hex>();
  let parsed: bigint | null = null;
  try { parsed = parseAmount(amt, h.decimals); } catch { parsed = null; }

  useEffect(() => {
    if (parsed === null || parsed <= 0n) { setQuote(undefined); return; }
    if (parsed > h.amount) { setQuote({ error: "more than you hold in v1" }); return; }
    let alive = true;
    const id = setTimeout(() => lg.quoteMigrate(h, parsed!).then((q) => alive && setQuote(q)).catch((e) => alive && setQuote({ error: (e as Error).message })), 300);
    return () => { alive = false; clearTimeout(id); };
  }, [amt, h.amount]); // eslint-disable-line react-hooks/exhaustive-deps

  async function go() {
    if (parsed === null || !quote || "error" in quote) return;
    setErr(undefined);
    try { setHash(await lg.migrate(h, parsed)); } catch (e) { setErr((e as Error).message); }
  }

  if (hash) return (
    <div className="mt-3 border-t rule pt-3 font-mono text-[11px]">
      <p className="text-signal">migrated. The v2 note appears in your balance once the batch settles.</p>
      <button className="btn btn-ghost btn-sm mt-2" onClick={onDone}>done</button>
    </div>
  );

  return (
    <div className="mt-3 border-t rule pt-3">
      <div className="flex gap-1">
        <input className="field h-9 text-[12px]" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
        <button className="btn btn-sm h-9" onClick={() => setAmt(fmtAmount(h.amount, h.decimals, h.decimals).replace(/,/g, ""))}>max</button>
      </div>
      <div className="mt-2 space-y-1 font-mono text-[10.5px]">
        {quote && !("error" in quote) ? (
          <>
            <div className="flex justify-between"><span className="text-mute">relayer fee (v1, two proofs)</span><span className="num">{fmtAmount(quote.fee, h.decimals, 6)} {h.symbol}</span></div>
            <div className="flex justify-between"><span className="text-mute">lands in v2</span><span className="num text-fg">{fmtAmount(quote.shielded, h.decimals, 6)} {h.symbol}</span></div>
          </>
        ) : <span className={quote && "error" in quote ? "text-bad" : "text-dim"}>{quote && "error" in quote ? quote.error : "—"}</span>}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button className="btn btn-signal btn-sm" disabled={!quote || "error" in quote || !!lg.busy} onClick={go}>{lg.busy === "migrate" ? "migrating…" : `migrate ${h.symbol}`}</button>
        <button className="btn btn-ghost btn-sm" onClick={onDone}>cancel</button>
      </div>
      {err ? <p className="mt-2 font-mono text-[10.5px] text-bad break-words">{err}</p> : null}
    </div>
  );
}

function Withdraw({ h, onDone }: { h: LegacyHolding; onDone: () => void }) {
  const lg = useLegacy();
  const [amt, setAmt] = useState(fmtAmount(h.amount, h.decimals, h.decimals).replace(/,/g, ""));
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string>();
  const [hash, setHash] = useState<Hex>();
  let parsed: bigint | null = null;
  try { parsed = parseAmount(amt, h.decimals); } catch { parsed = null; }
  const ok = parsed !== null && parsed > 0n && parsed <= h.amount && isAddress(to);

  async function go() {
    if (!ok) return;
    setErr(undefined);
    try { setHash(await lg.unshield(h, parsed!, getAddress(to))); } catch (e) { setErr((e as Error).message); }
  }

  if (hash) return (
    <div className="mt-3 border-t rule pt-3 font-mono text-[11px]">
      <p className="text-signal">withdrawn to {short(to, 6)}.</p>
      <button className="btn btn-ghost btn-sm mt-2" onClick={onDone}>done</button>
    </div>
  );

  return (
    <div className="mt-3 border-t rule pt-3 space-y-2">
      <input className="field h-9 text-[12px]" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} />
      <input className="field h-9 text-[12px] font-mono" placeholder="0x… recipient (public)" value={to} onChange={(e) => setTo(e.target.value)} />
      <p className="font-mono text-[10px] text-dim">A plain unshield from the v1 pool, relayed, fee from the amount. Prefer migrating: a public withdrawal links the recipient to the pool.</p>
      <div className="flex items-center gap-2">
        <button className="btn btn-sm" disabled={!ok || !!lg.busy} onClick={go}>{lg.busy === "unshield" ? "withdrawing…" : "withdraw"}</button>
        <button className="btn btn-ghost btn-sm" onClick={onDone}>cancel</button>
      </div>
      {err ? <p className="font-mono text-[10.5px] text-bad break-words">{err}</p> : null}
    </div>
  );
}
