"use client";
import { useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { ASSETS, type AssetMeta } from "@/lib/config";
import { useScash } from "@/lib/store";
import { fmtAmount, parseAmount } from "@/lib/format";
import { amountForBurn } from "@scash/sdk";

type Mode = "shield" | "send" | "unshield" | "swap";

export function TransactPanel() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { balances, pools, relayer, shield, send, unshield } = useScash();
  const [mode, setMode] = useState<Mode>("shield");
  const [asset, setAsset] = useState<AssetMeta>(ASSETS[0]);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [memo, setMemo] = useState("");
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

  const submit = async () => {
    setErr(null);
    if (!parsed || parsed <= 0n) return setErr("Enter an amount");
    setBusy(true);
    try {
      if (mode === "shield") {
        if (!publicKey) throw new Error("connect a wallet");
        await shield(asset, parsed, publicKey, (tx) => sendTransaction(tx, connection), to || undefined);
      } else if (mode === "send") {
        if (!to.startsWith("scash1") && !to.startsWith("tscash1")) throw new Error("enter a shielded address");
        await send(asset, parsed, to, memo || undefined);
      } else if (mode === "unshield") {
        await unshield(asset, parsed, new PublicKey(to));
      }
      setAmount(""); setMemo("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-xl bg-ink-900 p-1">
          {(["shield", "send", "unshield", "swap"] as Mode[]).map((m) => (
            <button key={m} className="tab capitalize" data-active={mode === m} onClick={() => { setMode(m); setErr(null); }}>{m}</button>
          ))}
        </div>
        <select className="input !w-auto !py-2" value={asset.symbol} onChange={(e) => setAsset(ASSETS.find((a) => a.symbol === e.target.value)!)}>
          {ASSETS.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
        </select>
      </div>

      {mode === "swap" ? (
        <div className="mt-6 rounded-xl border border-dashed border-white/10 p-8 text-center">
          <div className="font-mono text-xs text-mint-400">exit_target → adapter</div>
          <h3 className="mt-2 text-lg font-semibold">Private swaps ship with the exit adapter</h3>
          <p className="mx-auto mt-2 max-w-md text-sm text-ink-200">
            The vault already supports CPI exits bound inside the proof. The Jupiter/Meteora adapter program is under review and will
            appear here once deployed; no change to your notes is needed.
          </p>
        </div>
      ) : (
        <div className="mt-6 space-y-4">
          <div>
            <div className="mb-1.5 flex justify-between text-xs text-ink-400">
              <span>Amount</span>
              <span>
                {mode === "shield" ? "from your public wallet" : `shielded: ${fmtAmount(shieldedAmount, asset.decimals)} ${asset.symbol}`}
              </span>
            </div>
            <div className="relative">
              <input className="input pr-20 text-lg" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
              <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-ink-200">{asset.symbol}</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {asset.denominations.map((d) => (
                <button key={d} className="rounded-lg border border-white/10 px-2.5 py-1 font-mono text-xs text-ink-200 hover:border-mint-500/40 hover:text-ink-100" onClick={() => setAmount(String(d))}>
                  {d}
                </button>
              ))}
              {mode !== "shield" && (
                <button className="rounded-lg border border-white/10 px-2.5 py-1 font-mono text-xs text-ink-200 hover:border-mint-500/40" onClick={() => setAmount(fmtAmount(shieldedAmount, asset.decimals, asset.decimals).replace(/,/g, ""))}>
                  max
                </button>
              )}
              <span className="ml-auto self-center text-[11px] text-ink-400">Standard denominations blend in better.</span>
            </div>
          </div>

          {mode !== "shield" || to ? (
            <div>
              <div className="mb-1.5 text-xs text-ink-400">
                {mode === "unshield" ? "Public recipient (Solana address)" : "Shielded recipient (scash1…)"}
              </div>
              <input className="input" placeholder={mode === "unshield" ? "Solana address" : "scash1…"} value={to} onChange={(e) => setTo(e.target.value.trim())} />
            </div>
          ) : (
            <button className="text-xs text-mint-400 hover:text-mint-300" onClick={() => setTo(" ")}>Shield directly to someone else&apos;s address →</button>
          )}

          {mode === "send" && (
            <div>
              <div className="mb-1.5 text-xs text-ink-400">Encrypted memo (optional, 512 bytes, only the recipient can read it)</div>
              <input className="input" placeholder="invoice #1234" value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={512} />
            </div>
          )}

          <div className="rounded-xl border border-white/5 bg-ink-900/60 p-4 font-mono text-xs text-ink-200">
            <Row k="network fee" v={mode === "shield" ? "paid by you" : "paid by relayer"} />
            <Row k="relayer fee" v={mode === "shield" ? "0" : feePolicy ? `${fmtAmount(fee, asset.decimals)} ${asset.symbol}` : "relayer offline"} />
            <Row k="proof" v="Groth16 · transact2x2 · in-browser" />
            <Row k="timing privacy" v={mode === "shield" ? "n/a" : relayer ? `${relayer.delay.minMs / 1000}-${relayer.delay.maxMs / 1000}s random delay` : "—"} />
          </div>

          {err && <p className="text-sm text-rose-400">{err}</p>}
          <button className="btn-primary w-full" disabled={busy || !pool || (mode !== "shield" && !relayer)} onClick={submit}>
            {busy ? "Working…" : mode === "shield" ? `Shield ${asset.symbol}` : mode === "send" ? "Send privately" : `Unshield ${asset.symbol}`}
          </button>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between py-0.5">
      <span className="text-ink-400">{k}</span>
      <span>{v}</span>
    </div>
  );
}
