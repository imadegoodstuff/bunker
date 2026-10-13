"use client";
import { useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ASSETS, type AssetMeta } from "@/lib/config";
import { useScash } from "@/lib/store";
import { fmtAmount, parseAmount } from "@/lib/format";
import { amountForBurn } from "@scash/sdk";

type Mode = "shield" | "send" | "unshield";

export function TransactPanel() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { balances, pools, relayer, shield, send, unshield } = useScash();
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

  const switchMode = (m: Mode) => { setMode(m); setErr(null); setTo(""); setToOther(false); };

  const submit = async () => {
    setErr(null);
    if (!parsed || parsed <= 0n) return setErr("Enter an amount");
    setBusy(true);
    try {
      if (mode === "shield") {
        if (!publicKey) throw new Error("Connect a wallet");
        await shield(asset, parsed, publicKey, (tx) => sendTransaction(tx, connection), toOther && to ? to : undefined);
      } else if (mode === "send") {
        if (!to.startsWith("scash1") && !to.startsWith("tscash1")) throw new Error("Enter a shielded address");
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
  const cta = busy ? "Working…" : mode === "shield" ? "Shield" : mode === "send" ? "Send privately" : "Unshield";

  return (
    <section>
      <div className="tabs">
        {(["shield", "send", "unshield"] as Mode[]).map((m) => (
          <button key={m} className="tab" data-active={mode === m} onClick={() => switchMode(m)}>{m}</button>
        ))}
      </div>

      <div className="mt-7 space-y-6">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="label">Amount</span>
            <span className="text-xs text-dim">
              {mode === "shield" ? "from your public wallet" : `available ${fmtAmount(shieldedAmount, asset.decimals)} ${asset.symbol}`}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3 border-b border-line-strong pb-2 focus-within:border-white/50">
            <input
              className="w-full bg-transparent text-4xl tracking-[-0.02em] tabular-nums outline-none placeholder:text-dim"
              placeholder="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
            {ASSETS.length > 1 ? (
              <select className="bg-transparent text-sm text-mute outline-none" value={asset.symbol} onChange={(e) => setAsset(ASSETS.find((a) => a.symbol === e.target.value)!)}>
                {ASSETS.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
              </select>
            ) : (
              <span className="text-sm text-mute">{asset.symbol}</span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {asset.denominations.map((d) => (
              <button key={d} className="chip" onClick={() => setAmount(String(d))}>{d}</button>
            ))}
            {mode !== "shield" && (
              <button className="chip" onClick={() => setAmount(fmtAmount(shieldedAmount, asset.decimals, asset.decimals).replace(/,/g, ""))}>max</button>
            )}
          </div>
        </div>

        {needsRecipient ? (
          <div>
            <div className="flex items-baseline justify-between">
              <span className="label">{mode === "unshield" ? "To Solana address" : "To shielded address"}</span>
              {mode === "shield" && <button className="link text-xs" onClick={() => { setToOther(false); setTo(""); }}>to myself</button>}
            </div>
            <input className="input mt-2 font-mono text-[13px]" placeholder={mode === "unshield" ? "…" : "scash1…"} value={to} onChange={(e) => setTo(e.target.value.trim())} />
          </div>
        ) : (
          <button className="link text-xs" onClick={() => setToOther(true)}>Shield to someone else →</button>
        )}

        {mode === "send" && (
          <div>
            <span className="label">Memo <span className="text-dim">· encrypted, optional</span></span>
            <input className="input mt-2" placeholder="" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={512} />
          </div>
        )}

        <dl className="space-y-1.5 text-xs">
          <Row k="Network fee" v={mode === "shield" ? "you" : "relayer"} />
          <Row k="Relayer fee" v={mode === "shield" ? "—" : feePolicy ? `${fmtAmount(fee, asset.decimals)} ${asset.symbol}` : "relayer offline"} />
          {mode !== "shield" && <Row k="Delay" v={relayer ? `${relayer.delay.minMs / 1000}–${relayer.delay.maxMs / 1000}s, random` : "—"} />}
        </dl>

        {err && <p className="text-sm text-bad">{err}</p>}
        <button className="btn-primary w-full" disabled={busy || !pool || (mode !== "shield" && !relayer)} onClick={submit}>
          {cta}
        </button>
      </div>
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-dim">{k}</dt>
      <dd className="text-mute">{v}</dd>
    </div>
  );
}
