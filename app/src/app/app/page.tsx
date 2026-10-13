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
      <main className="mx-auto max-w-7xl px-6 pb-24 pt-10">
        <AnimatePresence mode="wait">
          {phase !== "ready" ? (
            <motion.div key="unlock" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
              <Unlock />
            </motion.div>
          ) : (
            <motion.div key="app" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
              <div className="space-y-6">
                <BalanceCard />
                <TransactPanel />
                <Activity />
              </div>
              <div className="space-y-6">
                <AddressCard />
                <AnonymityPanel />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
      <TxOverlay />
    </>
  );
}
