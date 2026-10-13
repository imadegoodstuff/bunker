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
    <section>
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
          <button onClick={copy} className="card mt-3 w-full break-all p-4 text-left font-mono text-[12px] leading-5 text-fg hover:border-white/30">{shown}</button>
          <p className="mt-2 text-xs text-bad">{copied ? "Copied." : "Anyone with this string can spend your balance. Store it offline."}</p>
        </>
      ) : (
        <p className="mt-3 text-xs leading-relaxed text-dim">
          Your keys come from your wallet signature and passphrase. Export the raw seed to recover without either, on any device.
        </p>
      )}
    </section>
  );
}
