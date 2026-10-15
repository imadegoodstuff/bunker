// ExtData: everything a transact binds to its proof besides the circuit's own
// public inputs (SPEC §7). Hashed exactly as `ShieldedPool.extDataHash` does:
// `uint256(sha256(abi.encode(ext))) % p`.
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeAbiParameters, decodeAbiParameters, type Hex } from "viem";
import { mod, bytesToBigIntBE, fromHex, toHex } from "./field.js";

export type EvmAddress = `0x${string}`;

export interface ExtData {
  recipient: EvmAddress;
  relayer: EvmAddress;
  /** internal pool units, taken from a negative publicAmount */
  relayerFee: bigint;
  /** address(0) = plain unshield */
  exitTarget: EvmAddress;
  exitData: Uint8Array;
  ciphertext0: Uint8Array;
  ciphertext1: Uint8Array;
  outCiphertext: Uint8Array;
}

export const ZERO_ADDRESS: EvmAddress = "0x0000000000000000000000000000000000000000";
export const NO_EXIT = ZERO_ADDRESS;

export const EXT_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "recipient", type: "address" },
      { name: "relayer", type: "address" },
      { name: "relayerFee", type: "uint256" },
      { name: "exitTarget", type: "address" },
      { name: "exitData", type: "bytes" },
      { name: "ciphertext0", type: "bytes" },
      { name: "ciphertext1", type: "bytes" },
      { name: "outCiphertext", type: "bytes" },
    ],
  },
] as const;

const hex = (b: Uint8Array): Hex => `0x${toHex(b)}`;

/** The tuple as the contract's `ExtData calldata` argument expects it. */
export function extDataArg(e: ExtData) {
  return {
    recipient: e.recipient,
    relayer: e.relayer,
    relayerFee: e.relayerFee,
    exitTarget: e.exitTarget,
    exitData: hex(e.exitData),
    ciphertext0: hex(e.ciphertext0),
    ciphertext1: hex(e.ciphertext1),
    outCiphertext: hex(e.outCiphertext),
  } as const;
}

/** `abi.encode(ext)` — the exact bytes the contract hashes. */
export function serializeExtData(e: ExtData): Uint8Array {
  return fromHex(encodeAbiParameters(EXT_DATA_ABI, [extDataArg(e)]));
}

export function extDataHash(e: ExtData): bigint {
  return mod(bytesToBigIntBE(sha256(serializeExtData(e))));
}

export function deserializeExtData(b: Uint8Array): ExtData {
  const [d] = decodeAbiParameters(EXT_DATA_ABI, hex(b));
  return {
    recipient: d.recipient,
    relayer: d.relayer,
    relayerFee: d.relayerFee,
    exitTarget: d.exitTarget,
    exitData: fromHex(d.exitData),
    ciphertext0: fromHex(d.ciphertext0),
    ciphertext1: fromHex(d.ciphertext1),
    outCiphertext: fromHex(d.outCiphertext),
  };
}
