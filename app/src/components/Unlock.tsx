"use client";
import { useState } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { SPENDING_KEY_MESSAGE, passphraseStrength, PASSPHRASE_MIN_BITS, PASSPHRASE_GUESSES_PER_SECOND } from "@scash/sdk";
import { useScash } from "@/lib/store";

function crackTime(seconds: number) {
  if (seconds < 60) return "seconds";
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  if (seconds < 86400 * 365) return `${Math.round(seconds / 86400)} days`;
  const years = seconds / (86400 * 365);
  if (years < 1000) return `${Math.round(years)} years`;
  if (years < 1e6) return `${Math.round(years / 1000)}k years`;
  return "longer than the universe";
}

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

  const strength = passphraseStrength(pass);
  const passOk = !usePass || (strength.bits >= PASSPHRASE_MIN_BITS && pass === pass2);
  const label = phase === "deriving" ? "Deriving keys…" : phase === "syncing" ? `Scanning ${syncedTo.toLocaleString()} / ${(totalLeaves || 0).toLocaleString()}` : "Unlock";
  const step = !connected ? 1 : 2;

  return (
    <div className="mx-auto max-w-md pt-10 sm:pt-16">
      <div className="glass noise relative p-8">
        {/* steps */}
        <ol className="flex items-center gap-3 font-mono text-[11px] text-dim">
          {["Connect", "Passphrase", "Unlock"].map((s, i) => (
            <li key={s} className="flex items-center gap-3">
              <span className={`flex h-6 w-6 items-center justify-center rounded-full border ${i + 1 <= step ? "border-accent text-accent" : "border-line-strong"}`}>{i + 1}</span>
              <span className={i + 1 <= step ? "text-fg" : ""}>{s}</span>
              {i < 2 && <span className="h-px w-6 bg-line-strong" />}
            </li>
          ))}
        </ol>

        {restore ? (
          <>
            <h1 className="mt-8 text-3xl tracking-[-0.02em]">Restore from <span className="serif italic">a backup.</span></h1>
            <p className="mt-3 text-sm leading-relaxed text-mute">Paste your <span className="font-mono text-fg">scashseed1…</span> string. No wallet needed; works on any device.</p>
            <textarea className="input mt-6 h-24 resize-none py-3 font-mono text-[12px]" placeholder="scashseed1…" value={backup} onChange={(e) => setBackup(e.target.value)} spellCheck={false} />
            <button className="btn-primary mt-4 w-full" disabled={busy || !backup.trim()} onClick={() => unlockFromSeed(backup)}>{label}</button>
            {busy && <div className="progress mt-4" />}
            {error && <p className="mt-3 text-xs text-bad">{error}</p>}
            <button className="link mt-6 text-sm" onClick={() => setRestore(false)}>← Back</button>
          </>
        ) : (
          <>
            <h1 className="mt-8 text-3xl tracking-[-0.02em]">
              Your wallet is <span className="serif italic">the key.</span>
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-mute">
              Sign one fixed message. Together with your passphrase it becomes your spending key, derived here and never stored.
            </p>

            {!connected ? (
              <div className="mt-8 [&>button]:w-full [&>button]:justify-center"><WalletButton /></div>
            ) : (
              <div className="mt-8 space-y-5">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">Passphrase</span>
                    <button className="segment" onClick={() => setUsePass(!usePass)} aria-pressed={usePass}>
                      <span data-active={usePass} className={`rounded-full px-2.5 py-1 ${usePass ? "bg-fg text-black" : ""}`}>on</span>
                      <span data-active={!usePass} className={`rounded-full px-2.5 py-1 ${!usePass ? "bg-fg text-black" : ""}`}>off</span>
                    </button>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-dim">
                    {usePass
                      ? "If a phishing site ever gets your signature, this is all that stands between it and your balance. There is no reset: losing it loses the balance unless you export a seed backup after unlocking."
                      : "Off: anyone who gets your wallet to sign the message can spend. Not recommended."}
                  </p>
                  {usePass && (
                    <div className="mt-3 space-y-2">
                      <input className="input" type="password" placeholder="Five or more uncommon words, or 14+ mixed characters" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="new-password" />
                      {pass && (
                        <div>
                          <div className="flex h-1 gap-1" aria-hidden>
                            {[0, 1, 2].map((i) => {
                              const on = strength.level === "strong" ? 3 : strength.level === "fair" ? 2 : strength.bits > 0 ? 1 : 0;
                              const col = strength.level === "strong" ? "bg-ok" : strength.level === "fair" ? "bg-accent" : "bg-bad";
                              return <span key={i} className={`flex-1 rounded-full ${i < on ? col : "bg-line-strong"}`} />;
                            })}
                          </div>
                          <p className="mt-1.5 text-[11px] leading-relaxed text-dim">
                            {strength.level === "weak"
                              ? `Too weak${strength.reason ? ` — ${strength.reason}` : ""}. Scored ~${strength.bits} bits; if your signature leaks, that falls in ${crackTime(strength.secondsToCrack)} at ${PASSPHRASE_GUESSES_PER_SECOND.toLocaleString()} guesses/s.`
                              : `Scored ~${strength.bits} bits. If it were random that is ${crackTime(strength.secondsToCrack)} of guessing at ${PASSPHRASE_GUESSES_PER_SECOND.toLocaleString()}/s. The score is a rough estimate, not a measurement: avoid quotes, names and anything about you.`}
                          </p>
                        </div>
                      )}
                      <input className="input" type="password" placeholder="Repeat" value={pass2} onChange={(e) => setPass2(e.target.value)} autoComplete="new-password" />
                      {pass && pass2 && pass !== pass2 && <p className="text-xs text-bad">Passphrases do not match.</p>}
                    </div>
                  )}
                </div>

                <button className="btn-primary w-full" disabled={busy || !signMessage || !passOk} onClick={() => signMessage && unlock(signMessage, usePass ? pass : "")}>
                  {label}
                </button>
                {busy && <div className="progress" />}
                {!signMessage && <p className="text-xs text-bad">This wallet cannot sign messages.</p>}
                {error && <p className="text-xs text-bad">{error}</p>}

                <div className="text-xs text-dim">
                  <button className="link" onClick={() => setShowMsg(!showMsg)}>{showMsg ? "Hide" : "Show"} the exact message you will sign</button>
                  {showMsg && <pre className="mt-2 whitespace-pre-wrap rounded-xl border border-line bg-black/30 p-3 font-mono text-[11px] leading-5 text-mute">{SPENDING_KEY_MESSAGE}</pre>}
                </div>
              </div>
            )}

            <p className="mt-8 border-t border-line pt-5 text-xs text-dim">
              Have a seed backup? <button className="link underline underline-offset-4" onClick={() => setRestore(true)}>Restore without a wallet</button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
