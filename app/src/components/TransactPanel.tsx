"use client";
import { useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { motion } from "framer-motion";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ASSETS, type AssetMeta } from "@/lib/config";
import { useScash } from "@/lib/store";
import { fmtAmount, parseAmount } from "@/lib/format";
import { amountForBurn, MEMO_MAX } from "@scash/sdk";

type Mode = "shield" | "send" | "unshield";
const MODES: { key: Mode; label: string; hint: string }[] = [
  { key: "shield", label: "Shield", hint: "wallet → private" },
  { key: "send", label: "Send", hint: "private → private" },
  { key: "unshield", label: "Withdraw", hint: "private → wallet" },
];

/** Balance + action in one console. */
export function TransactPanel() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { balances, pools, relayer, shield, send, unshield, notes, sync, syncedTo, totalLeaves } = useScash();
  const [mode, setMode] = useState<Mode>("shield");
  const [asset, setAsset] = useState<AssetMeta>(ASSETS[0]);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [memo, setMemo] = useState("");
  const [toOther, setToOther] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pool = pools[asset.symbol];
  const shieldedShares = balances[asset.symbol] ?? 0n;
  const shieldedAmount = pool ? amountForBurn(pool, shieldedShares) : shieldedShares;
  const feePolicy = relayer?.fees.find((f) => f.mint === asset.mint.toBase58());

  const parsed = useMemo(() => {
    try { return parseAmount(amount || "0", asset.decimals); } catch { return null; }
  }, [amount, asset.decimals]);

  const fee = useMemo(() => {
    if (!feePolicy || !parsed || mode === "shield") return 0n;
    const pct = (parsed * BigInt(feePolicy.bps)) / 10_000n;
    return pct > BigInt(feePolicy.min) ? pct : BigInt(feePolicy.min);
  }, [feePolicy, parsed, mode]);

  const receives = parsed && mode !== "shield" ? (parsed > fee ? parsed - fee : 0n) : parsed ?? 0n;
  const tooMuch = mode !== "shield" && parsed !== null && parsed > shieldedAmount;

  const switchMode = (m: Mode) => { setMode(m); setErr(null); setTo(""); setToOther(false); };

  const submit = async () => {
    setErr(null);
    if (!parsed || parsed <= 0n) return setErr("Enter an amount");
    if (tooMuch) return setErr("More than your shielded balance");
    setBusy(true);
    try {
      if (mode === "shield") {
        if (!publicKey) throw new Error("Connect a wallet");
        await shield(asset, parsed, publicKey, (tx) => sendTransaction(tx, connection), toOther && to ? to : undefined);
      } else if (mode === "send") {
        if (!to.startsWith("scash1") && !to.startsWith("tscash1")) throw new Error("Enter a shielded address (scash1…)");
        await send(asset, parsed, to, memo || undefined);
      } else {
        await unshield(asset, parsed, new PublicKey(to));
      }
      setAmount(""); setMemo("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const needsRecipient = mode !== "shield" || toOther;
  const cta = busy ? "Working…" : mode === "shield" ? "Shield" : mode === "send" ? "Send privately" : "Withdraw";

  return (
    <section className="glass noise relative overflow-hidden">
      {/* balance */}
      <div className="flex items-end justify-between gap-4 px-7 pt-7">
        <div>
          <div className="label">Shielded balance</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-[2.75rem] leading-none tracking-[-0.04em] tabular-nums sm:text-6xl">{fmtAmount(shieldedAmount, asset.decimals)}</span>
            <span className="text-xl text-mute">{asset.symbol}</span>
          </div>
          <p className="mt-3 text-xs text-dim">
            {notes.length} note{notes.length === 1 ? "" : "s"} · synced {syncedTo.toLocaleString()} / {totalLeaves.toLocaleString()}
            {" · "}<button onClick={() => sync()} className="link underline-offset-4 hover:underline">rescan</button>
            {!pool && <span className="ml-2 text-warn">pool not created</span>}
          </p>
        </div>
        {ASSETS.length > 1 && (
          <select className="input !h-10 !w-auto" value={asset.symbol} onChange={(e) => setAsset(ASSETS.find((a) => a.symbol === e.target.value)!)}>
            {ASSETS.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
          </select>
        )}
      </div>

      {/* modes */}
      <div className="px-7 pt-7">
        <div className="modes">
          {MODES.map((m) => (
            <button key={m.key} className="mode" data-active={mode === m.key} onClick={() => switchMode(m.key)}>
              {mode === m.key && <motion.span layoutId="mode-pill" className="mode-pill" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
              <span className="relative z-10">{m.label}</span>
            </button>
          ))}
        </div>
        <p className="mt-2 text-center font-mono text-[11px] text-dim">{MODES.find((m) => m.key === mode)!.hint}</p>
      </div>

      {/* form */}
      <div className="space-y-6 px-7 pb-7 pt-6">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="label">Amount</span>
            <span className="text-xs text-dim">
              {mode === "shield" ? "from your public wallet" : `available ${fmtAmount(shieldedAmount, asset.decimals)} ${asset.symbol}`}
            </span>
          </div>
          <div className={`mt-2 flex items-center gap-3 rounded-2xl border px-4 py-3 transition-colors focus-within:border-accent/60 ${tooMuch ? "border-bad/60" : "border-line-strong"}`}>
            <input
              className="w-full bg-transparent text-4xl tracking-[-0.03em] tabular-nums outline-none placeholder:text-dim"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
            <span className="text-sm text-mute">{asset.symbol}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {asset.denominations.map((d) => (
              <button key={d} className="chip" onClick={() => setAmount(String(d))}>{d}</button>
            ))}
            {mode !== "shield" && (
              <button className="chip" onClick={() => setAmount(fmtAmount(shieldedAmount, asset.decimals, asset.decimals).replace(/,/g, ""))}>max</button>
            )}
            {mode === "shield" && <span className="ml-auto self-center text-[11px] text-dim">round amounts blend in better</span>}
          </div>
        </div>

        {needsRecipient ? (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label">{mode === "unshield" ? "To Solana address" : "To shielded address"}</span>
              {mode === "shield" && <button className="link text-xs" onClick={() => { setToOther(false); setTo(""); }}>to myself</button>}
              {mode === "unshield" && <span className="text-xs text-dim">use a fresh wallet</span>}
            </div>
            <input className="input mt-2 font-mono text-[13px]" placeholder={mode === "unshield" ? "Solana address" : "scash1…"} value={to} onChange={(e) => setTo(e.target.value.trim())} />
          </div>
        ) : (
          <button className="link text-xs" onClick={() => setToOther(true)}>Shield to someone else →</button>
        )}

        {mode === "send" && (
          <div>
            <span className="label">Memo <span className="text-dim">· encrypted, optional, {MEMO_MAX} bytes</span></span>
            <input className="input mt-2" placeholder="" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={MEMO_MAX} />
          </div>
        )}

        <dl className="space-y-2 rounded-2xl border border-line bg-black/20 p-4 text-xs">
          <Row k="Network fee" v={mode === "shield" ? "paid by you" : "paid by the relayer"} />
          <Row k="Relayer fee" v={mode === "shield" ? "none" : feePolicy ? `${fmtAmount(fee, asset.decimals)} ${asset.symbol}` : "relayer offline"} />
          {mode !== "shield" && <Row k="Recipient gets" v={`${fmtAmount(receives, asset.decimals)} ${asset.symbol}`} strong />}
          {mode !== "shield" && <Row k="Delay" v={relayer ? `${relayer.delay.minMs / 1000}–${relayer.delay.maxMs / 1000}s, random` : "—"} />}
          {mode === "shield" && <Row k="Visible on-chain" v="your wallet deposited this amount" />}
        </dl>

        {err && <p className="text-sm text-bad">{err}</p>}
        <button className="btn-primary h-12 w-full text-[15px]" disabled={busy || !pool || (mode !== "shield" && !relayer)} onClick={submit}>
          {cta}
        </button>
      </div>
    </section>
  );
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-dim">{k}</dt>
      <dd className={strong ? "text-fg" : "text-mute"}>{v}</dd>
    </div>
  );
}
