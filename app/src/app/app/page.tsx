"use client";
import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { AnimatePresence, motion } from "framer-motion";
import { Nav } from "@/components/Nav";
import { useScash } from "@/lib/store";
import { Unlock } from "@/components/Unlock";
import { AddressCard } from "@/components/AddressCard";
import { TransactPanel } from "@/components/TransactPanel";
import { AnonymityPanel } from "@/components/AnonymityPanel";
import { Activity } from "@/components/Activity";
import { TxOverlay } from "@/components/TxOverlay";
import { BackupCard } from "@/components/BackupCard";

export default function AppPage() {
  const { connected } = useWallet();
  const phase = useScash((s) => s.phase);
  const lock = useScash((s) => s.lock);
  useEffect(() => {
    if (!connected && phase !== "idle") lock();
  }, [connected, phase, lock]);

  return (
    <>
      <div className="hero-glow pointer-events-none absolute inset-x-0 top-0 -z-10 h-[40rem]" />
      <Nav app />
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-10">
        <AnimatePresence mode="wait">
          {phase !== "ready" ? (
            <motion.div key="unlock" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Unlock />
            </motion.div>
          ) : (
            <motion.div key="app" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="grid gap-5 lg:grid-cols-[1fr_19rem]">
              <div className="space-y-5">
                <TransactPanel />
                <Activity />
              </div>
              <aside className="space-y-4">
                <AddressCard />
                <AnonymityPanel />
                <BackupCard />
              </aside>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <TxOverlay />
    </>
  );
}
