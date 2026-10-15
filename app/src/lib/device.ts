"use client";
// A vault that lives on this device: a random spending seed kept in local
// storage plus a built-in public "gas account" derived from it, exposed as an
// EIP-1193 provider so the rest of the app treats it like any wallet. This is
// what the Android app runs on, where nothing injects window.ethereum, and it
// works the same in any browser for people without a wallet extension.
import { createWalletClient, http, keccak256, concat, stringToBytes, numberToHex, hexToBigInt, type Hex, type EIP1193Provider } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { seedFromBackup, seedToBackup } from "@bunker/sdk";
import { chain, publicClient } from "./chain";
import { CHAIN_ID, RPC_URL } from "./config";

const KEY = "bunker.device.seed";

export function deviceSeed(): Uint8Array | null {
  if (typeof window === "undefined") return null;
  const s = localStorage.getItem(KEY);
  if (!s) return null;
  try { return seedFromBackup(s); } catch { return null; }
}
export const hasDeviceVault = () => deviceSeed() !== null;
export function rememberDeviceSeed(seed: Uint8Array) { localStorage.setItem(KEY, seedToBackup(seed)); }
export function forgetDeviceSeed() { localStorage.removeItem(KEY); }
export function newSeed(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }

/** The public account that pays for shields and claims: a secp256k1 key derived from the spending seed, so one backup restores both. */
export function gasAccount(seed: Uint8Array): PrivateKeyAccount {
  const pk = keccak256(concat([stringToBytes("bunker/gas-account/v1"), seed]));
  return privateKeyToAccount(pk);
}

type Listener = (...args: unknown[]) => void;

/** An EIP-1193 provider over the gas account: signs locally, broadcasts over the app's RPC. */
export function deviceProvider(account: PrivateKeyAccount): EIP1193Provider & { isBunkerDevice: true } {
  const wc = createWalletClient({ account, chain, transport: http(RPC_URL) });
  const listeners = new Map<string, Set<Listener>>();
  const p = {
    isBunkerDevice: true as const,
    async request({ method, params }: { method: string; params?: unknown }) {
      const a = (params ?? []) as unknown[];
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [account.address];
        case "eth_chainId":
          return numberToHex(CHAIN_ID);
        case "net_version":
          return String(CHAIN_ID);
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          return null;
        case "personal_sign": {
          const [data] = a as [Hex];
          return account.signMessage({ message: { raw: data } });
        }
        case "eth_sign": {
          const [, data] = a as [string, Hex];
          return account.signMessage({ message: { raw: data } });
        }
        case "eth_signTypedData_v4": {
          const [, json] = a as [string, string];
          const t = JSON.parse(json);
          return account.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
        }
        case "eth_sendTransaction": {
          const [tx] = a as [{ to?: Hex; data?: Hex; value?: Hex; gas?: Hex; gasPrice?: Hex; nonce?: Hex }];
          return wc.sendTransaction({
            account, chain,
            to: tx.to, data: tx.data,
            value: tx.value ? hexToBigInt(tx.value) : undefined,
            gas: tx.gas ? hexToBigInt(tx.gas) : undefined,
            gasPrice: tx.gasPrice ? hexToBigInt(tx.gasPrice) : undefined,
            nonce: tx.nonce ? Number(hexToBigInt(tx.nonce)) : undefined,
          });
        }
        default:
          // reads (eth_call, eth_estimateGas, receipts…) go straight to the node
          return publicClient.request({ method, params } as never);
      }
    },
    on(event: string, fn: Listener) { (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(fn); return p; },
    removeListener(event: string, fn: Listener) { listeners.get(event)?.delete(fn); return p; },
  };
  return p as unknown as EIP1193Provider & { isBunkerDevice: true };
}

/** True inside the Android/iOS shell (Capacitor) — no wallet can be injected there. */
export const isNativeShell = () => typeof window !== "undefined" && !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
