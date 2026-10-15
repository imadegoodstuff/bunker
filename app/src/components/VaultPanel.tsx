"use client";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { isAddress } from "viem";
import { NATIVE_TOKEN, decodeAddress, MEMO_MAX } from "@bunker/sdk";
import { shieldedAmount, useBunker } from "@/lib/store";
import { useSigner } from "@/lib/useSigner";
import { fmtAmount, parseAmount } from "@/lib/format";
import type { AssetMeta } from "@/lib/config";

type Mode = "shield" | "send" | "unshield";

export function VaultPanel() {
  const s = useBunker();
  const owner = useWallet((w) => w.address);
  const signer = useSigner();
  const assets = s.assets();
  const [token, setToken] = useState<string>(NATIVE_TOKEN);
  const asset: AssetMeta = assets.find((a) => a.token.toLowerCase() === token.toLowerCase()) ?? assets[0];
  const [mode, setMode] = useState<Mode>("shield");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [memo, setMemo] = useState("");
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [addr, setAddr] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => { if (owner) void s.scanWallet(owner).catch(() => undefined); }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps

  const pool = s.pools[asset.token.toLowerCase()];
  const shielded = shieldedAmount(s, asset);
  const walletBal = s.walletBalances[asset.token.toLowerCase()] ?? 0n;
  const quote = s.assetQuotes[asset.token.toLowerCase()];
  const feePolicy = s.relayer?.fees.find((f) => f.token.toLowerCase() === asset.token.toLowerCase());
  const relayable = asset.token === NATIVE_TOKEN ? !!feePolicy : !!feePolicy || !!quote?.supported;

  const parsed = useMemo(() => { try { return amount ? parseAmount(amount, asset.decimals) : 0n; } catch { return null; } }, [amount, asset.decimals]);
  const fee = useMemo(() => {
    if (!pool || !parsed || mode === "shield") return null;
    const p = feePolicy ?? (quote?.supported && quote.fee ? { min: quote.fee.min, bps: quote.fee.bps } : null);
    if (!p) return null;
    const units = parsed / pool.unit;
    const pct = (units * BigInt(p.bps)) / 10_000n;
    return (pct > BigInt(p.min) ? pct : BigInt(p.min)) * pool.unit;
  }, [pool, parsed, mode, feePolicy, quote]);

  const toValid = mode === "shield" ? !to || safe(() => decodeAddress(s.wallet!.bjj, to)) : mode === "send" ? safe(() => decodeAddress(s.wallet!.bjj, to)) : isAddress(to);
  const max = mode === "shield" ? walletBal : shielded;
  const ok = !!parsed && parsed > 0n && parsed <= max && toValid && !busy && (mode === "shield" ? !!signer : relayable) && (!fee || parsed > fee);

  async function go() {
    if (!parsed) return;
    setErr(undefined); setBusy(true);
    try {
      if (mode === "shield") await s.shield(asset, parsed, signer!, to || undefined);
      else if (mode === "send") await s.send(asset, parsed, to, memo || undefined);
      else await s.unshield(asset, parsed, to as `0x${string}`);
      setAmount(""); setMemo("");
      if (owner) void s.scanWallet(owner).catch(() => undefined);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }

  async function addToken() {
    if (!isAddress(addr)) { setErr("not an address"); return; }
    setAdding(true); setErr(undefined);
    try { const m = await s.addToken(addr); setToken(m.token); setAddr(""); if (owner) void s.scanWallet(owner).catch(() => undefined); }
    catch (e) { setErr((e as Error).message); }
    finally { setAdding(false); }
  }

  return (
    <div className="slab brackets p-5 md:p-6"><span className="bk" />
      {/* asset strip */}
      <div className="flex flex-wrap gap-1.5 mb-5">
        {assets.map((a) => (
          <button key={a.token} className="chip" data-active={a.token === asset.token} onClick={() => { setToken(a.token); setAmount(""); }} title={a.name}>
            {a.image ? <img src={a.image} alt="" className="w-3.5 h-3.5 mr-1.5 object-cover" /> : null}{a.symbol}
          </button>
        ))}
        <div className="flex items-stretch ml-auto">
          <input className="field h-7 w-40 text-[11px]" placeholder="0x… add token" value={addr} onChange={(e) => setAddr(e.target.value)} />
          <button className="btn btn-sm h-7" disabled={adding || !addr} onClick={addToken}>{adding ? "…" : "add"}</button>
        </div>
      </div>

      {/* balances */}
      <div className="grid grid-cols-2 gap-px bg-line mb-5 border rule">
        <div className="bg-slab p-4"><div className="label mb-1">shielded</div><div className="display text-2xl num">{fmtAmount(shielded, asset.decimals)} <span className="text-mute text-base">{asset.symbol}</span></div></div>
        <div className="bg-slab p-4"><div className="label mb-1">in wallet</div><div className="display text-2xl num">{fmtAmount(walletBal, asset.decimals)} <span className="text-mute text-base">{asset.symbol}</span></div></div>
      </div>

      <div className="flex gap-1 border-b rule mb-5">
        {(["shield", "send", "unshield"] as Mode[]).map((m) => <button key={m} className="tab" data-active={mode === m} onClick={() => { setMode(m); setErr(undefined); setTo(""); }}>{m}</button>)}
      </div>

      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label">amount</label>
            <button className="font-mono text-[11px] text-steel hover:text-fg" onClick={() => setAmount(fmtAmount(max, asset.decimals, asset.decimals).replace(/,/g, ""))}>max {fmtAmount(max, asset.decimals)}</button>
          </div>
          <input className="field text-lg" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          {asset.denominations.length ? (
            <div className="flex flex-wrap gap-1.5 mt-2">
              {asset.denominations.map((d) => <button key={d} className="chip" data-active={amount === String(d)} onClick={() => setAmount(String(d))}>{d}</button>)}
            </div>
          ) : null}
          {mode === "shield" && asset.denominations.length ? <p className="mt-2 font-mono text-[10.5px] text-dim">Round amounts blend in. An unusual amount in and the same amount out is a link.</p> : null}
        </div>

        {mode === "shield" ? (
          <div>
            <label className="label block mb-2">to <span className="text-dim normal-case tracking-normal">(optional; defaults to your own vault)</span></label>
            <input className="field text-[12px]" value={to} onChange={(e) => setTo(e.target.value)} placeholder="bunker1…" spellCheck={false} />
          </div>
        ) : mode === "send" ? (
          <>
            <div>
              <label className="label block mb-2">recipient vault address</label>
              <input className="field text-[12px]" value={to} onChange={(e) => setTo(e.target.value)} placeholder="bunker1…" spellCheck={false} />
            </div>
            <div>
              <label className="label block mb-2">memo <span className="text-dim normal-case tracking-normal">(encrypted, {MEMO_MAX} bytes)</span></label>
              <input className="field text-[12px]" value={memo} maxLength={MEMO_MAX} onChange={(e) => setMemo(e.target.value)} placeholder="only the recipient can read it" />
            </div>
          </>
        ) : (
          <div>
            <label className="label block mb-2">recipient address (BNB chain)</label>
            <input className="field text-[12px]" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} />
            <p className="mt-2 font-mono text-[10.5px] text-dim">Use a fresh address. Withdrawing to the wallet that shielded undoes the point.</p>
          </div>
        )}

        {mode !== "shield" ? (
          <div className="font-mono text-[11px] text-mute flex items-center justify-between border-t rule pt-3">
            <span>relayer fee</span>
            <span className="text-fg num">{fee !== null ? `${fmtAmount(fee, asset.decimals)} ${asset.symbol}` : relayable ? "—" : quote?.reason ?? "not relayed for this asset"}</span>
          </div>
        ) : !pool && asset.token !== NATIVE_TOKEN ? (
          <p className="font-mono text-[10.5px] text-warn">No pool for {asset.symbol} yet. Your first shield opens one (one extra transaction).</p>
        ) : null}

        <button className="btn btn-signal w-full h-12" disabled={!ok} onClick={go}>
          {busy ? "working" : mode === "shield" ? `shield ${asset.symbol}` : mode === "send" ? "send privately" : "unshield via relayer"}
        </button>
        {err ? <p className="font-mono text-[11px] text-bad break-words">{err}</p> : null}
        {s.walletScanError ? <p className="font-mono text-[10.5px] text-dim">{s.walletScanError}</p> : null}
      </div>
    </div>
  );
}

function safe(f: () => unknown): boolean {
  try { f(); return true; } catch { return false; }
}
