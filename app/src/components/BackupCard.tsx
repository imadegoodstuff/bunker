"use client";
import { useState } from "react";
import { useScash } from "@/lib/store";

export function BackupCard() {
  const exportSeed = useScash((s) => s.exportSeed);
  const [shown, setShown] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!shown) return;
    await navigator.clipboard.writeText(shown);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  return (
    <section className="glass p-5">
      <div className="flex items-center justify-between">
        <span className="label">Backup</span>
        {shown ? (
          <button className="link text-xs" onClick={() => setShown(null)}>Hide</button>
        ) : (
          <button className="link text-xs" onClick={() => setShown(exportSeed() ?? null)}>Reveal seed</button>
        )}
      </div>
      {shown ? (
        <>
          <button onClick={copy} className="mt-3 w-full break-all rounded-xl border border-bad/40 bg-black/30 p-3.5 text-left font-mono text-[12px] leading-5 text-fg hover:border-bad/70">{shown}</button>
          <p className="mt-2 text-[11px] text-bad">{copied ? "Copied." : "Anyone with this string can spend your balance. Store it offline."}</p>
        </>
      ) : (
        <p className="mt-3 text-[11px] leading-relaxed text-dim">
          Your keys come from your wallet signature and passphrase. Lose the passphrase and this backup is the only way back in. It is the raw seed: anyone holding it can spend, so keep it offline, never in a screenshot or chat.
        </p>
      )}
    </section>
  );
}
