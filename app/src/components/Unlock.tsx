"use client";
import { useEffect, useMemo, useState } from "react";
import { passphraseStrength, seedFromBackup, seedToBackup, PASSPHRASE_MIN_BITS, PASSPHRASE_STRONG_BITS } from "@bunker/sdk";
import { useBunker } from "@/lib/store";
import { useWallet } from "@/lib/wallet";
import { CONFIGURED } from "@/lib/config";
import { deviceSeed, forgetDeviceSeed, gasAccount, isNativeShell, newSeed } from "@/lib/device";

type Mode = "device" | "sign" | "restore" | "view";

export function Unlock() {
  const isConnected = useWallet((w) => !!w.address);
  const signMessage = useWallet((w) => w.signMessage);
  const walletReady = useWallet((w) => w.ready);
  const injected = useWallet((w) => w.available && !w.device);
  const { phase, error, unlock, unlockFromSeed, unlockFromViewingKey, openDevice } = useBunker();
  const [mode, setMode] = useState<Mode>("sign");
  const [autoMode, setAutoMode] = useState(false);
  const [pass, setPass] = useState("");
  const [viewKey, setViewKey] = useState("");
  const [sigOnly, setSigOnly] = useState(false);
  const [ack, setAck] = useState(false);
  const [backup, setBackup] = useState("");
  const [remember, setRemember] = useState(false);
  const [show, setShow] = useState(false);
  const [fresh, setFresh] = useState<{ seed: Uint8Array; backup: string; account: string }>();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const strength = useMemo(() => passphraseStrength(pass), [pass]);
  const busy = phase === "deriving" || phase === "syncing";
  const canSign = sigOnly ? ack : strength.bits >= PASSPHRASE_MIN_BITS;
  const native = isNativeShell();
  const [remembered, setRemembered] = useState<Uint8Array | null>(null);

  // with no wallet extension (the Android app, a plain phone browser) the device vault is the natural default
  useEffect(() => {
    if (walletReady && !autoMode) {
      setAutoMode(true);
      const seed = deviceSeed();
      setRemembered(seed);
      if (!injected || seed) setMode("device");
    }
  }, [walletReady, injected, autoMode]);

  const create = () => {
    const seed = newSeed();
    setFresh({ seed, backup: seedToBackup(seed), account: gasAccount(seed).address });
    setSaved(false);
    setCopied(false);
  };

  return (
    <div className="max-w-xl mx-auto rise">
      <div className="label-signal mb-3">Open the vault</div>
      <h1 className="display text-4xl md:text-5xl mb-4">Your keys never exist on a server.</h1>
      <p className="text-mute leading-relaxed mb-8">
        {mode === "device"
          ? <>A vault on this device: a random key kept only here, with a built-in BNB account to pay for shields. One backup string restores both. Nothing to install, nothing to sign.</>
          : mode === "view"
          ? <>A viewing key opens a read-only mirror of a vault: every note, memo and spend, exactly as the owner sees them, and no way to sign. For a second device, an accountant, or proving what you hold.</>
          : <>The spending key is derived in this tab from a wallet signature stretched with a passphrase. The signature alone is not enough: any page that gets you to sign the same message would otherwise own your vault. Same wallet, same passphrase, same key, on any device.</>}
      </p>

      <div className="slab brackets p-6 md:p-8"><span className="bk" />
        <div className="flex gap-1 border-b rule mb-6 overflow-x-auto">
          <button className="tab" data-active={mode === "device"} onClick={() => setMode("device")}>This device</button>
          {native ? null : <button className="tab" data-active={mode === "sign"} onClick={() => setMode("sign")}>Wallet signature</button>}
          <button className="tab" data-active={mode === "restore"} onClick={() => setMode("restore")}>Seed backup</button>
          <button className="tab" data-active={mode === "view"} onClick={() => setMode("view")}>Viewing key</button>
        </div>

        {mode === "device" ? (
          <div className="space-y-5">
            {remembered ? (
              <>
                <p className="text-sm text-mute leading-relaxed">A vault is remembered on this device.</p>
                <div className="flex flex-wrap items-center gap-3">
                  <button className="btn btn-signal" disabled={busy || !CONFIGURED} onClick={() => openDevice(remembered)}>{busy ? (phase === "deriving" ? "deriving key" : "syncing notes") : "open the vault"}</button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => { forgetDeviceSeed(); setRemembered(null); }}>forget it and start over</button>
                </div>
              </>
            ) : !fresh ? (
              <>
                <ul className="text-sm text-mute space-y-2 leading-relaxed">
                  <li><span className="text-signal font-mono text-[11px] mr-2">01</span>A new spending key is generated here and remembered on this device.</li>
                  <li><span className="text-signal font-mono text-[11px] mr-2">02</span>A public BNB account is derived from it. Send BNB there to shield; everything after that (sends, trades, swaps) is relayed and needs no gas from you.</li>
                  <li><span className="text-signal font-mono text-[11px] mr-2">03</span>Write the backup string down. Lose the device and the string, lose the vault.</li>
                </ul>
                <button className="btn btn-signal" disabled={busy || !CONFIGURED} onClick={create}>{busy ? "opening" : "create a vault on this device"}</button>
              </>
            ) : (
              <>
                <div>
                  <label className="label block mb-2">Backup string — write it down now</label>
                  <code className="block font-mono text-[11px] break-all p-3 bg-bg border rule select-all">{fresh.backup}</code>
                  <div className="mt-2 flex items-center gap-3">
                    <button className="btn btn-ghost btn-sm" type="button" onClick={async () => { try { await navigator.clipboard.writeText(fresh.backup); setCopied(true); } catch { /* clipboard blocked */ } }}>{copied ? "copied" : "copy"}</button>
                    <span className="font-mono text-[10.5px] text-warn">This is the spending key. Anyone who reads it can spend everything.</span>
                  </div>
                </div>
                <div>
                  <label className="label block mb-2">Built-in BNB account</label>
                  <code className="block font-mono text-[11px] break-all p-3 bg-bg border rule select-all">{fresh.account}</code>
                  <p className="mt-2 font-mono text-[10.5px] text-dim">fund this address with BNB (and any token you want to shield); the vault spends from here</p>
                </div>
                <label className="flex items-start gap-3 text-sm text-mute cursor-pointer">
                  <input type="checkbox" className="mt-1 accent-[#ffb02e]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
                  I have saved the backup string somewhere that is not this device.
                </label>
                <div className="flex flex-wrap items-center gap-3">
                  <button className="btn btn-signal" disabled={!saved || busy || !CONFIGURED} onClick={() => openDevice(fresh.seed)}>{busy ? (phase === "deriving" ? "deriving key" : "syncing notes") : "open the vault"}</button>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setFresh(undefined)}>back</button>
                </div>
              </>
            )}
          </div>
        ) : mode === "sign" ? (
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
                  <input type="checkbox" className="mt-1 accent-[#ffb02e]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  I understand a signature is not a secret.
                </label>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn btn-signal" disabled={!isConnected || busy || !canSign || !CONFIGURED} onClick={() => unlock(signMessage, sigOnly ? null : pass)}>
                {busy ? (phase === "deriving" ? "deriving key" : "syncing notes") : isConnected ? "sign & open" : "connect a wallet first"}
              </button>
              <button className="btn btn-ghost btn-sm" type="button" onClick={() => { setSigOnly(!sigOnly); setAck(false); }}>{sigOnly ? "use a passphrase instead" : "signature only (weaker)"}</button>
            </div>
          </div>
        ) : mode === "view" ? (
          <div className="space-y-5">
            <div>
              <label className="label block mb-2">Viewing key</label>
              <textarea className="field font-mono text-[12px]" rows={3} value={viewKey} onChange={(e) => setViewKey(e.target.value)} placeholder="bunkerview1…" spellCheck={false} />
              <p className="mt-2 font-mono text-[11px] text-dim">Exported from an open vault under Backup → viewing key. It reveals the vault's history to whoever holds it; it cannot move a single note.</p>
            </div>
            <button className="btn btn-signal" disabled={busy || !viewKey.trim() || !CONFIGURED} onClick={() => unlockFromViewingKey(viewKey)}>
              {busy ? (phase === "deriving" ? "deriving key" : "syncing notes") : "open read-only"}
            </button>
          </div>
        ) : (
          <div className="space-y-5">
            <div>
              <label className="label block mb-2">Backup string</label>
              <textarea className="field font-mono text-[12px]" rows={3} value={backup} onChange={(e) => setBackup(e.target.value)} placeholder="bunkerseed1…" spellCheck={false} />
              <p className="mt-2 font-mono text-[11px] text-dim">Exported from an open vault under Backup. It is the key itself: paste it only on a device you trust.</p>
            </div>
            <label className="flex items-start gap-3 text-sm text-mute cursor-pointer">
              <input type="checkbox" className="mt-1 accent-[#ffb02e]" checked={remember || native} disabled={native} onChange={(e) => setRemember(e.target.checked)} />
              Keep it on this device and use its built-in BNB account{native ? " (how the app works)" : ""}.
            </label>
            <button
              className="btn btn-signal"
              disabled={busy || !backup.trim() || !CONFIGURED}
              onClick={() => {
                if (!(remember || native)) return void unlockFromSeed(backup);
                try { void openDevice(seedFromBackup(backup.trim())); } catch (e) { useBunker.setState({ phase: "error", error: (e as Error).message }); }
              }}
            >
              {busy ? "opening" : "restore & open"}
            </button>
          </div>
        )}
        {error ? <p className="mt-5 font-mono text-[12px] text-bad break-words">{error}</p> : null}
        {!CONFIGURED ? <p className="mt-5 font-mono text-[12px] text-warn">This build has no contract addresses configured.</p> : null}
      </div>
    </div>
  );
}
