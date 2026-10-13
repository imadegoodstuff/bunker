"use client";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { useScash } from "@/lib/store";

const WalletButton = dynamic(() => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton), { ssr: false });

export function Unlock() {
  const { connected, signMessage } = useWallet();
  const { phase, error, unlock, syncedTo, totalLeaves } = useScash();
  const busy = phase === "deriving" || phase === "syncing";

  return (
    <div className="mx-auto mt-10 max-w-xl">
      <div className="panel-strong p-10 text-center">
        <img src="/icon.svg" alt="" className="mx-auto h-14 w-14" />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">Your shielded wallet lives in your signature.</h1>
        <p className="mt-3 text-sm leading-relaxed text-ink-200">
          Sign a fixed message once. The signature is hashed into your spending key locally and never leaves the browser.
          No seed phrase, no backup file: the same wallet always derives the same shielded keys.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          {!connected ? (
            <WalletButton />
          ) : (
            <button className="btn-primary" disabled={busy || !signMessage} onClick={() => signMessage && unlock(signMessage)}>
              {phase === "deriving" ? "Deriving keys…" : phase === "syncing" ? `Scanning notes ${syncedTo}/${totalLeaves || "…"}` : "Unlock shielded wallet"}
            </button>
          )}
          {connected && !signMessage && <p className="text-xs text-rose-400">This wallet cannot sign messages. Use Phantom or Solflare.</p>}
          {error && <p className="max-w-md text-xs text-rose-400">{error}</p>}
        </div>
        <div className="mt-8 grid grid-cols-3 gap-3 text-left font-mono text-[11px] text-ink-400">
          <div className="rounded-lg border border-white/5 p-3">seed = BLAKE2b(sig)</div>
          <div className="rounded-lg border border-white/5 p-3">ivk = Poseidon(ak, nk)</div>
          <div className="rounded-lg border border-white/5 p-3">scan: trial-decrypt locally</div>
        </div>
      </div>
    </div>
  );
}
