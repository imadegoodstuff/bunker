"use client";
import { useMemo } from "react";
import type { Signer } from "./store";
import { useWallet } from "./wallet";

/** The connected wallet as the store's `Signer`, or undefined while nothing is connected. */
export function useSigner(): Signer | undefined {
  const address = useWallet((s) => s.address);
  const writeContract = useWallet((s) => s.writeContract);
  return useMemo(() => (address ? { address, writeContract } : undefined), [address, writeContract]);
}
