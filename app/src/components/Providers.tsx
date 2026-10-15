"use client";
// No provider tree is needed: wallet and vault state are zustand stores. This
// is where a vault remembered on the device is reopened on launch.
import { useEffect } from "react";
import { deviceSeed } from "@/lib/device";
import { useBunker } from "@/lib/store";

export function Providers({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const seed = deviceSeed();
    if (seed && useBunker.getState().phase === "idle") void useBunker.getState().openDevice(seed);
  }, []);
  return <>{children}</>;
}
