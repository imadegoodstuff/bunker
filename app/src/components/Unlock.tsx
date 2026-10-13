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
    <div className="mx-auto max-w-md pt-24 text-center">
      <h1 className="text-3xl tracking-[-0.02em]">
        Your wallet is <span className="serif italic">a signature.</span>
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-mute">
        Sign one fixed message. It becomes your spending key, derived locally and never stored. The same wallet always opens the same notes.
      </p>
      <div className="mt-8 flex flex-col items-center gap-3">
        {!connected ? (
          <WalletButton />
        ) : (
          <button className="btn-primary px-5" disabled={busy || !signMessage} onClick={() => signMessage && unlock(signMessage)}>
            {phase === "deriving" ? "Deriving keys…" : phase === "syncing" ? `Scanning ${syncedTo} / ${totalLeaves || "…"}` : "Unlock"}
          </button>
        )}
        {connected && !signMessage && <p className="text-xs text-bad">This wallet cannot sign messages.</p>}
        {error && <p className="max-w-sm text-xs text-bad">{error}</p>}
      </div>
    </div>
  );
}
