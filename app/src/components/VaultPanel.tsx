"use client";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@/lib/wallet";
import { isAddress } from "viem";
import { NATIVE_TOKEN, MEMO_MAX } from "@bunker/sdk";
import { isShieldedAddress, queuedAmount, relayerFeeFor, shieldedAmount, useBunker } from "@/lib/store";
import { useSigner } from "@/lib/useSigner";
import { fmtAmount, parseAmount } from "@/lib/format";
import { SWAP_EXIT_ADDRESS, type AssetMeta } from "@/lib/config";

type Mode = "shield" | "send" | "unshield" | "swap";

export function VaultPanel() {
  const s = useBunker();
  const owner = useWallet((w) => w.address);
  const signer = useSigner();
  const assets = s.assets();
  const [token, setToken] = useState<string>(NATIVE_TOKEN);
  const asset: AssetMeta = assets.find((a) => a.token.toLowerCase() === token.toLowerCase()) ?? assets[0];
  const [mode, setMode] = useState<Mode>(s.watchOnly ? "send" : "shield");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [memo, setMemo] = useState("");
  const [outToken, setOutToken] = useState<string>("");
  const [swapQuote, setSwapQuote] = useState<{ out: bigint; relayerFee: bigint } | { error: string }>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [addr, setAddr] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => { if (owner) void s.scanWallet(owner).catch(() => undefined); }, [owner]); // eslint-disable-line react-hooks/exhaustive-deps

  const pool = s.pools[asset.token.toLowerCase()];
  const shielded = shieldedAmount(s, asset);
  const settling = queuedAmount(s, asset);
  const walletBal = s.walletBalances[asset.token.toLowerCase()] ?? 0n;
  const quote = s.assetQuotes[asset.token.toLowerCase()];
  const feePolicy = s.relayer?.fees.find((f) => f.token.toLowerCase() === asset.token.toLowerCase());
  const relayable = asset.token === NATIVE_TOKEN ? !!feePolicy : !!feePolicy || !!quote?.supported;
  const modes: Mode[] = (s.watchOnly ? [] : (["shield", "send", "unshield"] as Mode[])).concat(SWAP_EXIT_ADDRESS && !s.watchOnly ? ["swap"] : []);
  const outAsset = assets.find((a) => a.token.toLowerCase() === outToken.toLowerCase());
  const swapTargets = assets.filter((a) => a.token.toLowerCase() !== asset.token.toLowerCase() && !a.launched);

  const parsed = useMemo(() => { try { return amount ? parseAmount(amount, asset.decimals) : 0n; } catch { return null; } }, [amount, asset.decimals]);
  const fee = useMemo(() => (mode === "shield" || !parsed ? null : relayerFeeFor(s, asset, parsed)), [s.relayer, s.assetQuotes, s.pools, asset, parsed, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  // swap quotes come from the router; debounce them
  useEffect(() => {
    if (mode !== "swap" || !parsed || parsed <= 0n || !outAsset) { setSwapQuote(undefined); return; }
    let alive = true;
    const id = setTimeout(() => {
      s.quoteSwap(asset, parsed, outAsset).then((q) => alive && setSwapQuote(q)).catch((e) => alive && setSwapQuote({ error: (e as Error).message }));
    }, 400);
    return () => { alive = false; clearTimeout(id); };
  }, [mode, parsed, asset, outAsset]); // eslint-disable-line react-hooks/exhaustive-deps

  const toValid =
    mode === "shield" ? !to || isShieldedAddress(s, to) || isAddress(to)
    : mode === "send" ? isShieldedAddress(s, to) || isAddress(to)
    : mode === "unshield" ? isAddress(to)
    : !!outAsset;
  const max = mode === "shield" ? walletBal : shielded;
  const total = parsed && fee ? parsed + fee : parsed;
  const ok = !!parsed && parsed > 0n && !!total && total <= max && toValid && !busy
    && (mode === "shield" ? !!signer : relayable)
    && (mode !== "swap" || (!!swapQuote && !("error" in swapQuote)));

  async function go() {
    if (!parsed) return;
    setErr(undefined); setBusy(true);
    try {
      if (mode === "shield") await s.shield(asset, parsed, signer!, to || undefined);
      else if (mode === "send") await s.send(asset, parsed, to, memo || undefined);
      else if (mode === "unshield") await s.unshield(asset, parsed, to as `0x${string}`);
      else await s.swap(asset, parsed, outAsset!);
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

  async function settle() {
    setErr(undefined); setBusy(true);
    try { await s.settle(signer); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
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
      <div className={`grid ${s.watchOnly ? "grid-cols-1" : "grid-cols-2"} gap-px bg-line mb-2 border rule`}>
        <div className="bg-slab p-4"><div className="label mb-1">shielded{s.watchOnly ? " · watch-only" : ""}</div><div className="display text-2xl num">{fmtAmount(shielded, asset.decimals)} <span className="text-mute text-base">{asset.symbol}</span></div></div>
        {s.watchOnly ? null : <div className="bg-slab p-4"><div className="label mb-1">in wallet</div><div className="display text-2xl num">{fmtAmount(walletBal, asset.decimals)} <span className="text-mute text-base">{asset.symbol}</span></div></div>}
      </div>
      {settling > 0n || s.pending > 0 ? (
        <div className="mb-5 flex flex-wrap items-center gap-3 font-mono text-[11px] border rule border-warn/40 bg-warn/5 px-3 py-2">
          <span className="w-1.5 h-1.5 bg-warn blink" />
          <span className="text-mute">
            {settling > 0n ? <><span className="text-fg num">{fmtAmount(settling, asset.decimals)} {asset.symbol}</span> of yours is settling</> : null}
            {settling > 0n && s.pending > 0 ? " · " : ""}
            {s.pending > 0 ? `${s.pending} note${s.pending === 1 ? "" : "s"} queued for the next batch` : null}
          </span>
          <button className="btn btn-ghost btn-sm ml-auto" disabled={busy} onClick={settle} title="Notes are hashed into the tree in batches by a keeper. Hurry it along.">settle now</button>
        </div>
      ) : <div className="mb-3" />}

      {modes.length ? (
        <div className="flex gap-1 border-b rule mb-5">
          {modes.map((m) => <button key={m} className="tab" data-active={mode === m} onClick={() => { setMode(m); setErr(undefined); setTo(""); }}>{m}</button>)}
        </div>
      ) : (
        <p className="mb-5 font-mono text-[11px] text-dim">This vault was opened from a viewing key: every note and spend is visible here, nothing can be signed.</p>
      )}

      {modes.length ? (
      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="label">amount</label>
            <button className="font-mono text-[11px] text-steel hover:text-fg" onClick={() => setAmount(fmtAmount(mode === "shield" || !fee ? max : max > fee ? max - fee : 0n, asset.decimals, asset.decimals).replace(/,/g, ""))}>max {fmtAmount(max, asset.decimals)}</button>
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
            <input className="field text-[12px]" value={to} onChange={(e) => setTo(e.target.value)} placeholder="bunker1… or a registered 0x…" spellCheck={false} />
          </div>
        ) : mode === "send" ? (
          <>
            <div>
              <label className="label block mb-2">recipient</label>
              <input className="field text-[12px]" value={to} onChange={(e) => setTo(e.target.value)} placeholder="bunker1… or a registered 0x…" spellCheck={false} />
              <p className="mt-2 font-mono text-[10.5px] text-dim">A plain 0x address works if its owner registered a vault address on-chain; the payment still lands privately.</p>
            </div>
            <div>
              <label className="label block mb-2">memo <span className="text-dim normal-case tracking-normal">(encrypted, {MEMO_MAX} bytes)</span></label>
              <input className="field text-[12px]" value={memo} maxLength={MEMO_MAX} onChange={(e) => setMemo(e.target.value)} placeholder="only the recipient can read it" />
            </div>
          </>
        ) : mode === "unshield" ? (
          <div>
            <label className="label block mb-2">recipient address (BNB chain)</label>
            <input className="field text-[12px]" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} />
            <p className="mt-2 font-mono text-[10.5px] text-dim">The recipient gets exactly this amount; the relayer's fee is a separate private note. Use a fresh address: withdrawing to the wallet that shielded undoes the point.</p>
          </div>
        ) : (
          <div>
            <label className="label block mb-2">receive</label>
            <div className="flex flex-wrap gap-1.5">
              {swapTargets.map((a) => <button key={a.token} className="chip" data-active={a.token.toLowerCase() === outToken.toLowerCase()} onClick={() => setOutToken(a.token)}>{a.symbol}</button>)}
            </div>
            <p className="mt-2 font-mono text-[10.5px] text-dim">PancakeSwap V2 fills it inside the same transaction; the output comes back as a new note of yours. No public account touches it.</p>
          </div>
        )}

        {mode !== "shield" ? (
          <div className="font-mono text-[11px] text-mute space-y-1.5 border-t rule pt-3">
            {mode === "swap" ? (
              <div className="flex items-center justify-between"><span>you receive ≈</span><span className="text-fg num">{swapQuote && !("error" in swapQuote) && outAsset ? `${fmtAmount(swapQuote.out, outAsset.decimals)} ${outAsset.symbol}` : swapQuote && "error" in swapQuote ? <span className="text-bad">{swapQuote.error}</span> : "—"}</span></div>
            ) : null}
            <div className="flex items-center justify-between">
              <span>relayer fee <span className="text-dim">(private note)</span></span>
              <span className="text-fg num">{fee !== null ? `${fmtAmount(fee, asset.decimals)} ${asset.symbol}` : relayable ? "—" : quote?.reason ?? "not relayed for this asset"}</span>
            </div>
            {mode === "swap" ? <div className="flex items-center justify-between"><span>slippage</span><span className="text-fg num">1 % max</span></div> : null}
          </div>
        ) : !pool && asset.token !== NATIVE_TOKEN ? (
          <p className="font-mono text-[10.5px] text-warn">No pool for {asset.symbol} yet. Your first shield opens one (one extra transaction).</p>
        ) : null}

        <button className="btn btn-signal w-full h-12" disabled={!ok} onClick={go}>
          {busy ? "working" : mode === "shield" ? `shield ${asset.symbol}` : mode === "send" ? "send privately" : mode === "unshield" ? "unshield via relayer" : outAsset ? `swap to ${outAsset.symbol} privately` : "swap privately"}
        </button>
        {err ? <p className="font-mono text-[11px] text-bad break-words">{err}</p> : null}
        {s.walletScanError ? <p className="font-mono text-[10.5px] text-dim">{s.walletScanError}</p> : null}
      </div>
      ) : null}
    </div>
  );
}
