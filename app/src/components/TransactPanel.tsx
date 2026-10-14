"use client";
import { useEffect, useMemo, useState } from "react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
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

/**
 * Proving transact2x2 in the browser peaks at roughly 1 GB of WebAssembly
 * memory and takes ~3 s on a laptop. Phones and low-memory tabs are slower and
 * can fail to allocate; the budget is unmeasured there, so say so up front
 * rather than after a failed proof.
 */
function useDeviceNotice() {
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const mobile = /Android|iPhone|iPad|iPod/i.test(nav.userAgent);
    const lowMem = typeof nav.deviceMemory === "number" && nav.deviceMemory < 4;
    if (lowMem) setNotice(`This device reports ${nav.deviceMemory} GB of memory. Proving needs about 1 GB free and may fail here.`);
    else if (mobile) setNotice("Proofs are made on your device. On a phone this takes longer than the ~3 s quoted for laptops and has not been benchmarked.");
  }, []);
  return notice;
}

/** Balance + action in one console. */
export function TransactPanel() {
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const { balances, pools, relayer, shield, send, unshield, notes, sync, syncedTo, totalLeaves, freezeAuthority, lastProveMs, walletAssets, walletBalances, assetQuotes, scanWallet, walletScanError, walletScannedAt } = useScash();
  const deviceNotice = useDeviceNotice();
  const [mode, setMode] = useState<Mode>("shield");
  const [asset, setAsset] = useState<AssetMeta>(ASSETS[0]);
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [memo, setMemo] = useState("");
  const [toOther, setToOther] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Every token in the connected wallet is shieldable; list them next to SOL.
  const assets = useMemo(() => [...ASSETS, ...Object.values(walletAssets)], [walletAssets]);
  const owner = publicKey?.toBase58();
  useEffect(() => {
    if (!publicKey) return;
    void scanWallet(publicKey).catch(() => undefined);
    const t = setInterval(() => void scanWallet(publicKey).catch(() => undefined), 60_000);
    return () => clearInterval(t);
  }, [owner]); // publicKey is keyed by `owner`; scanWallet is a stable store action
  useEffect(() => {
    if (!assets.some((a) => a.symbol === asset.symbol)) setAsset(ASSETS[0]);
  }, [assets, asset.symbol]);

  const pool = pools[asset.symbol];
  const isSol = asset.mint.equals(SystemProgram.programId);
  const shieldedShares = balances[asset.symbol] ?? 0n;
  const shieldedAmount = pool ? amountForBurn(pool, shieldedShares) : shieldedShares;
  const publicBalance = walletBalances[asset.symbol];
  const quote = isSol ? undefined : assetQuotes[asset.mint.toBase58()];
  const staticPolicy = relayer?.fees.find((f) => f.mint === asset.mint.toBase58());
  const feePolicy = staticPolicy ?? (quote?.supported && quote.fee ? { mint: quote.mint, min: quote.fee.min, bps: quote.fee.bps } : undefined);
  const shieldOnly = !isSol && !staticPolicy && !!quote && !quote.supported && quote.pool;

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
            {!pool && (isSol ? <span className="ml-2 text-warn">pool not created</span> : <span className="ml-2 text-dim">no pool yet · your first shield opens it</span>)}
          </p>
        </div>
        {assets.length > 1 && (
          <select className="input !h-10 !w-auto max-w-[11rem]" value={asset.symbol} onChange={(e) => setAsset(assets.find((a) => a.symbol === e.target.value)!)}>
            {assets.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}{a.fromWallet && walletBalances[a.symbol] !== undefined ? ` · ${fmtAmount(walletBalances[a.symbol], a.decimals)}` : ""}</option>)}
          </select>
        )}
      </div>
      {publicKey && walletScanError && (
        <p className="px-7 pt-3 text-xs text-warn">
          {walletScanError} · <button className="link underline-offset-4 hover:underline" onClick={() => void scanWallet(publicKey).catch(() => undefined)}>retry</button>
        </p>
      )}
      {publicKey && !walletScanError && assets.length === 1 && (
        <p className="px-7 pt-3 text-xs text-dim">
          {walletScannedAt
            ? <>No tokens in {owner!.slice(0, 4)}…{owner!.slice(-4)} right now, only SOL. Any SPL or Token-2022 balance in the connected account shows up here and can be shielded. · <button className="link underline-offset-4 hover:underline" onClick={() => void scanWallet(publicKey).catch(() => undefined)}>rescan wallet</button></>
            : "Reading your wallet's tokens…"}
        </p>
      )}

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
              {mode === "shield"
                ? publicBalance !== undefined ? `wallet holds ${fmtAmount(publicBalance, asset.decimals)} ${asset.symbol}` : "from your public wallet"
                : `available ${fmtAmount(shieldedAmount, asset.decimals)} ${asset.symbol}`}
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
            {mode === "shield" && !isSol && publicBalance !== undefined && publicBalance > 0n && (
              <button className="chip" onClick={() => setAmount(fmtAmount(publicBalance, asset.decimals, asset.decimals).replace(/,/g, ""))}>all</button>
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
          <Row k="Network fee" v={mode === "shield" ? pool ? "paid by you" : "paid by you, plus ~0.002 SOL pool rent (once)" : "paid by the relayer"} />
          <Row k="Relayer fee" v={mode === "shield" ? "none" : feePolicy ? `${fmtAmount(fee, asset.decimals)} ${asset.symbol}` : !relayer ? "relayer offline" : shieldOnly ? "not relayed" : !pool ? "after the pool opens" : "quoting…"} />
          {mode !== "shield" && <Row k="Recipient gets" v={`${fmtAmount(receives, asset.decimals)} ${asset.symbol}`} strong />}
          {mode !== "shield" && <Row k="Delay" v={relayer ? `${relayer.delay.minMs / 1000}–${relayer.delay.maxMs / 1000}s, random` : "—"} />}
          {mode === "shield" && <Row k="Visible on-chain" v="your wallet deposited this amount" />}
          <Row k="Yield" v={asset.yieldBearing ? "creator fees are donated into this pool" : `none — only the SCASH pool earns`} />
          <Row k="Proof time" v={lastProveMs ? `${(lastProveMs / 1000).toFixed(1)} s on this device` : "~3 s on a laptop, longer on phones"} />
        </dl>

        {!isSol && pool && (
          <p className="text-xs leading-relaxed text-dim">
            You hide among {asset.symbol} notes only, not SOL notes: a new pool is a small crowd. Round amounts and patience matter more here.
          </p>
        )}
        {shieldOnly && mode !== "shield" && (
          <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            {quote?.reason ?? "The relayer does not take its fee in this token."} You can still shield {asset.symbol}; private sends and withdrawals need a token the relayer can price.
          </p>
        )}
        {freezeAuthority[asset.symbol] && (
          <p className="rounded-xl border border-warn/40 bg-warn/10 px-3 py-2 text-xs leading-relaxed text-warn">
            {asset.symbol}&apos;s issuer keeps a freeze authority ({freezeAuthority[asset.symbol].slice(0, 4)}…{freezeAuthority[asset.symbol].slice(-4)}).
            If it froze the pool&apos;s token account, withdrawals of {asset.symbol} would stop until it unfroze it. scash cannot prevent this.
          </p>
        )}
        {deviceNotice && <p className="text-xs leading-relaxed text-dim">{deviceNotice}</p>}

        {err && <p className="text-sm text-bad">{err}</p>}
        <button className="btn-primary h-12 w-full text-[15px]" disabled={busy || (!pool && (isSol || mode !== "shield")) || (mode !== "shield" && (!relayer || !feePolicy))} onClick={submit}>
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
