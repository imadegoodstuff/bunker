"use client";
import { useMemo } from "react";
import { useAccount, useWriteContract } from "wagmi";
import type { Abi } from "viem";
import type { Signer } from "./store";

/** The connected wallet as the store's `Signer`, or undefined while nothing is connected. */
export function useSigner(): Signer | undefined {
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  return useMemo(() => {
    if (!address) return undefined;
    return {
      address,
      writeContract: (req) =>
        writeContractAsync({ address: req.address, abi: req.abi as Abi, functionName: req.functionName, args: req.args as unknown[], value: req.value }),
    };
  }, [address, writeContractAsync]);
}
