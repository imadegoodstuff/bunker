"use client";
import { useMemo, useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { passphraseStrength, PASSPHRASE_MIN_BITS, PASSPHRASE_STRONG_BITS } from "@bunker/sdk";
import { useBunker } from "@/lib/store";
import { CONFIGURED } from "@/lib/config";

type Mode = "sign" | "restore";

export function Unlock() {
  const { isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { phase, error, unlock, unlockFromSeed } = useBunker();
  const [mode, setMode] = useState<Mode>("sign");
  const [pass, setPass] = useState("");
  const [sigOnly, setSigOnly] = useState(false);
  const [ack, setAck] = useState(false);
  const [backup, setBackup] = useState("");
  const [show, setShow] = useState(false);
  const strength = useMemo(() => passphraseStrength(pass), [pass]);
  const busy = phase === "deriving" || phase === "syncing";
  const canSign = sigOnly ? ack : strength.bits >= PASSPHRASE_MIN_BITS;

  return (
    <div className="max-w-xl mx-auto rise">
      <div className="label-signal mb-3">Open the vault</div>
      <h1 className="display text-4xl md:text-5xl mb-4">Your keys never exist on a server.</h1>
      <p className="text-mute leading-relaxed mb-8">
        The spending key is derived in this tab from a wallet signature stretched with a passphrase. The signature alone is not enough: any page that
        gets you to sign the same message would otherwise own your vault. Same wallet, same passphrase, same key, on any device.
      </p>

      <div className="slab brackets p-6 md:p-8"><span className="bk" />
        <div className="flex gap-1 border-b rule mb-6">
          <button className="tab" data-active={mode === "sign"} onClick={() => setMode("sign")}>Wallet signature</button>
          <button className="tab" data-active={mode === "restore"} onClick={() => setMode("restore")}>Seed backup</button>
        </div>

        {mode === "sign" ? (
          <div className="space-y-5">
            {!sigOnly ? (
              <div>
                <label className="label block mb-2">Passphrase</label>
                <div className="relative">
                  <input className="field pr-16" type={show ? "text" : "password"} value={pass} onChange={(e) => setPass(e.target.value)} placeholder="a sentence you will not forget" autoComplete="off" spellCheck={false} />
                  <button className="absolute right-2 top-1/2 -translate-y-1/2 btn btn-ghost btn-sm" onClick={() => setShow(!show)} type="button">{show ? "hide" : "show"}</button>
                </div>
                <div className="mt-3 flex items-center gap-3">
                  <div className="meter flex-1"><i style={{ width: `${Math.min(100, (strength.bits / PASSPHRASE_STRONG_BITS) * 100)}%`, background: strength.level === "weak" ? "var(--color-bad)" : strength.level === "fair" ? "var(--color-warn)" : "var(--color-signal)" }} /></div>
                  <span className="font-mono text-[11px] text-mute w-24 text-right">{strength.level} · {Math.round(strength.bits)} bits</span>
                </div>
                <p className="mt-2 font-mono text-[11px] text-dim">
                  {strength.reason ?? (strength.bits < PASSPHRASE_MIN_BITS ? `need at least ${PASSPHRASE_MIN_BITS} bits: more words, not more symbols` : "losing this passphrase loses the vault; nobody can reset it")}
                </p>
              </div>
            ) : (
              <div className="border border-warn/40 bg-warn/5 p-4 space-y-3">
                <p className="text-sm text-fg">Signature-only mode: whoever can get your wallet to sign the BUNKER message owns this vault. Phishing pages ask for exactly that. Use it only for amounts you would hand to a stranger.</p>
                <label className="flex items-start gap-3 text-sm text-mute cursor-pointer">
                  <input type="checkbox" className="mt-1 accent-[#b6ff2e]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  I understand a signature is not a secret.
                </label>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn btn-signal" disabled={!isConnected || busy || !canSign || !CONFIGURED} onClick={() => unlock((m) => signMessageAsync({ message: m }), sigOnly ? null : pass)}>
                {busy ? (phase === "deriving" ? "deriving key" : "syncing notes") : isConnected ? "sign & open" : "connect a wallet first"}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setSigOnly(!sigOnly); setAck(false); }}>{sigOnly ? "use a passphrase instead" : "signature only (weaker)"}</button>
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <label className="label block mb-2">Backup string</label>
              <textarea className="field font-mono text-[12px]" rows={3} value={backup} onChange={(e) => setBackup(e.target.value)} placeholder="bunkerseed1…" spellCheck={false} />
              <p className="mt-2 font-mono text-[11px] text-dim">Exported from an open vault under Backup. It is the key itself: paste it only on a device you trust.</p>
            </div>
            <button className="btn btn-signal" disabled={busy || !backup.trim() || !CONFIGURED} onClick={() => unlockFromSeed(backup)}>{busy ? "opening" : "restore & open"}</button>
          </div>
        )}
        {error ? <p className="mt-5 font-mono text-[12px] text-bad break-words">{error}</p> : null}
        {!CONFIGURED ? <p className="mt-5 font-mono text-[12px] text-warn">This build has no contract addresses configured.</p> : null}
      </div>
    </div>
  );
}
