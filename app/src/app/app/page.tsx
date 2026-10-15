"use client";
import { useBunker } from "@/lib/store";
import { Unlock } from "@/components/Unlock";
import { VaultPanel } from "@/components/VaultPanel";
import { TxOverlay } from "@/components/TxOverlay";
import { Activity, AddressCard, AnonymityPanel, BackupCard } from "@/components/Cards";

export default function VaultPage() {
  const { phase, lock, error } = useBunker();
  if (phase !== "ready") return <Unlock />;
  return (
    <div className="max-w-6xl mx-auto rise">
      <div className="flex items-end justify-between mb-6">
        <div>
          <div className="label-signal mb-2">01 · Vault</div>
          <h1 className="display text-3xl md:text-4xl">Shielded balance</h1>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={lock}>seal vault</button>
      </div>
      {error ? <p className="mb-4 font-mono text-[11px] text-warn">{error}</p> : null}
      <div className="grid lg:grid-cols-[1fr_360px] gap-4">
        <VaultPanel />
        <div className="space-y-4">
          <AddressCard />
          <AnonymityPanel />
          <Activity />
          <BackupCard />
        </div>
      </div>
      <TxOverlay />
    </div>
  );
}
