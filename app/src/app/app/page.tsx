"use client";
import { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { AnimatePresence, motion } from "framer-motion";
import { Nav } from "@/components/Nav";
import { useScash } from "@/lib/store";
import { Unlock } from "@/components/Unlock";
import { BalanceCard } from "@/components/BalanceCard";
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
      <Nav app />
      <main className="mx-auto max-w-5xl px-6 pb-24 pt-8">
        <AnimatePresence mode="wait">
          {phase !== "ready" ? (
            <motion.div key="unlock" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <Unlock />
            </motion.div>
          ) : (
            <motion.div key="app" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="grid gap-12 lg:grid-cols-[1fr_20rem] lg:gap-16">
              <div className="space-y-12">
                <BalanceCard />
                <TransactPanel />
                <Activity />
              </div>
              <aside className="space-y-10 lg:pt-1">
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
