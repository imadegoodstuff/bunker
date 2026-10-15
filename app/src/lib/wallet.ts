"use client";
// The public wallet: any EIP-1193 provider injected into the page (MetaMask,
// Rabby, Trust, Binance Wallet…). Kept deliberately small: viem's wallet
// client over `window.ethereum`, no connector SDKs, so nothing in this bundle
// phones home to a wallet vendor.
import { create } from "zustand";
import { createWalletClient, custom, getAddress, numberToHex, type Abi, type EIP1193Provider, type Hex, type WalletClient } from "viem";
import type { EvmAddress } from "@bunker/sdk";
import { chain } from "./chain";
import { CHAIN_ID, CHAIN_NAME, RPC_URL } from "./config";

declare global {
  interface Window { ethereum?: EIP1193Provider & { isMetaMask?: boolean; providers?: EIP1193Provider[] } }
}

export interface WalletState {
  address?: EvmAddress;
  chainId?: number;
  connecting: boolean;
  error?: string;
  /** false before the first render on the client, so SSR and hydration agree */
  ready: boolean;
  available: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  switchChain: () => Promise<void>;
  signMessage: (message: string) => Promise<Hex>;
  writeContract: (req: { address: EvmAddress; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; value?: bigint }) => Promise<Hex>;
}

const provider = () => (typeof window !== "undefined" ? window.ethereum : undefined);
let client: WalletClient | undefined;
let listening = false;
const DISCONNECTED = "bunker.wallet.disconnected";

export const useWallet = create<WalletState>((set, get) => {
  function listen() {
    const p = provider();
    if (!p || listening) return;
    listening = true;
    p.on("accountsChanged", (accs: string[]) => set({ address: accs[0] ? getAddress(accs[0]) : undefined }));
    p.on("chainChanged", (id: string) => set({ chainId: Number(id) }));
    p.on("disconnect", () => set({ address: undefined }));
  }
  function wc(): WalletClient {
    const p = provider();
    if (!p) throw new Error("no wallet found in this browser");
    if (!client) client = createWalletClient({ chain, transport: custom(p) });
    return client;
  }
  function account(): EvmAddress {
    const a = get().address;
    if (!a) throw new Error("wallet not connected");
    return a;
  }
  if (typeof window !== "undefined") {
    // after hydration: notice an injected provider and silently restore a prior session
    queueMicrotask(async () => {
      const p = provider();
      set({ ready: true, available: !!p });
      if (!p || localStorage.getItem(DISCONNECTED) === "1") return;
      listen();
      try {
        const [accs, id] = await Promise.all([p.request({ method: "eth_accounts" }) as Promise<string[]>, p.request({ method: "eth_chainId" }) as Promise<string>]);
        if (accs[0]) set({ address: getAddress(accs[0]), chainId: Number(id) });
      } catch { /* not connected */ }
    });
  }
  return {
    connecting: false,
    ready: false,
    available: false,
    async connect() {
      const p = provider();
      if (!p) { set({ error: "no wallet found in this browser" }); return; }
      set({ connecting: true, error: undefined });
      try {
        listen();
        const accs = (await p.request({ method: "eth_requestAccounts" })) as string[];
        const id = Number((await p.request({ method: "eth_chainId" })) as string);
        localStorage.removeItem(DISCONNECTED);
        set({ address: accs[0] ? getAddress(accs[0]) : undefined, chainId: id });
      } catch (e) {
        set({ error: (e as Error).message });
      } finally {
        set({ connecting: false });
      }
    },
    disconnect() {
      localStorage.setItem(DISCONNECTED, "1");
      set({ address: undefined });
    },
    async switchChain() {
      const p = provider();
      if (!p) return;
      try {
        await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(CHAIN_ID) }] });
      } catch (e) {
        // 4902: the chain is not in the wallet yet
        if ((e as { code?: number }).code !== 4902) throw e;
        await p.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: numberToHex(CHAIN_ID), chainName: CHAIN_NAME, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: [RPC_URL], blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined }],
        });
      }
    },
    signMessage(message) {
      return wc().signMessage({ account: account(), message });
    },
    writeContract(req) {
      return wc().writeContract({ account: account(), chain, address: req.address, abi: req.abi as Abi, functionName: req.functionName, args: req.args as unknown[], value: req.value });
    },
  };
});
