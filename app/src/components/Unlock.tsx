"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { SPENDING_KEY_MESSAGE } from "@scash/sdk";
import { useScash } from "@/lib/store";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export function Unlock() {
  const { connected, signMessage } = useWallet();
  const { phase, error, unlock, unlockFromSeed, syncedTo, totalLeaves } = useScash();
  const busy = phase === "deriving" || phase === "syncing";
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [usePass, setUsePass] = useState(true);
  const [restore, setRestore] = useState(false);
  const [backup, setBackup] = useState("");
  const [showMsg, setShowMsg] = useState(false);

  const passOk = !usePass || (pass.length >= 8 && pass === pass2);
  const label = phase === "deriving" ? "Deriving keys…" : phase === "syncing" ? `Scanning ${syncedTo} / ${totalLeaves || "…"}` : "Unlock";

  if (restore) {
    return (
      <div className="mx-auto max-w-md pt-20">
        <h1 className="text-3xl tracking-[-0.02em]">Restore from <span className="serif italic">a backup.</span></h1>
        <p className="mt-4 text-[15px] leading-relaxed text-mute">Paste the <span className="font-mono text-fg">scashseed1…</span> string you exported. No wallet signature is needed; this works on any device.</p>
        <textarea className="input mt-6 h-24 resize-none py-3 font-mono text-[12px]" placeholder="scashseed1…" value={backup} onChange={(e) => setBackup(e.target.value)} spellCheck={false} />
        <div className="mt-4 flex items-center gap-4">
          <button className="btn-primary px-5" disabled={busy || !backup.trim()} onClick={() => unlockFromSeed(backup)}>{label}</button>
          <button className="link text-sm" onClick={() => setRestore(false)}>Back</button>
        </div>
        {error && <p className="mt-3 text-xs text-bad">{error}</p>}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md pt-20">
      <h1 className="text-3xl tracking-[-0.02em]">
        Your wallet is <span className="serif italic">a signature.</span>
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-mute">
        Your wallet signs one fixed message. The signature, plus an optional passphrase, becomes your spending key. It is derived here and never stored.
      </p>

      {!connected ? (
        <div className="mt-8"><WalletButton /></div>
      ) : (
        <div className="mt-8 space-y-5">
          <div className="card bg-raise p-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="text-sm font-medium">Passphrase</div>
                <p className="mt-1 text-xs leading-relaxed text-dim">
                  Recommended. A site that tricks your wallet into signing the message still cannot spend without it. Losing it loses the balance; there is no reset.
                </p>
              </div>
              <button className="segment shrink-0" onClick={() => setUsePass(!usePass)} aria-pressed={usePass}>
                <span data-active={usePass} className="rounded-full px-2.5 py-1" style={usePass ? { background: "var(--color-fg)", color: "#000" } : undefined}>on</span>
                <span data-active={!usePass} className="rounded-full px-2.5 py-1" style={!usePass ? { background: "var(--color-fg)", color: "#000" } : undefined}>off</span>
              </button>
            </div>
            {usePass && (
              <div className="mt-4 space-y-2">
                <input className="input" type="password" placeholder="At least 8 characters" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
                <input className="input" type="password" placeholder="Repeat" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
                {pass && pass2 && pass !== pass2 && <p className="text-xs text-bad">Passphrases do not match.</p>}
              </div>
            )}
          </div>

          <div className="text-xs text-dim">
            <button className="link" onClick={() => setShowMsg(!showMsg)}>{showMsg ? "Hide" : "Show"} the exact message you will sign</button>
            {showMsg && <pre className="card mt-2 whitespace-pre-wrap bg-raise p-3 font-mono text-[11px] leading-5 text-mute">{SPENDING_KEY_MESSAGE}</pre>}
            <p className="mt-2">Your wallet shows this text before signing. If any other site asks you to sign it, refuse.</p>
          </div>

          <button className="btn-primary px-5" disabled={busy || !signMessage || !passOk} onClick={() => signMessage && unlock(signMessage, usePass ? pass : "")}>
            {label}
          </button>
          {!signMessage && <p className="text-xs text-bad">This wallet cannot sign messages.</p>}
          {error && <p className="max-w-sm text-xs text-bad">{error}</p>}
        </div>
      )}

      <p className="mt-10 text-xs text-dim">
        Have a seed backup? <button className="link underline underline-offset-4" onClick={() => setRestore(true)}>Restore without a wallet</button>
      </p>
    </div>
  );
}
