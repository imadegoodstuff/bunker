// ExtData: everything a transact binds to its proof besides the circuit's own
// public inputs (SPEC A7). Hashed exactly as `ShieldedPool.extDataHash` does:
// `uint256(sha256(abi.encode(block.chainid, address(pool), ext))) % p`. The
// chain id and the pool address are mixed into the hash rather than carried
// in calldata, so a proof is void on any other chain or deployment; `validUntil`
// lets it expire.
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeAbiParameters, decodeAbiParameters, type Hex } from "viem";
import { mod, bytesToBigIntBE, fromHex, toHex } from "./field.js";

export type EvmAddress = `0x${string}`;

/** Where an exit hook's proceeds go: a note for `token` to the owner behind `ownerHash`. `ownerHash = 0` = no reshield. */
export interface Reshield {
  token: EvmAddress;
  ownerHash: bigint;
  rho: bigint;
  rcm: bigint;
  /** note ciphertext to the owner (value field ignored; the pool publishes the amount) */
  ciphertext: Uint8Array;
}

export interface ExtData {
  /** public recipient of an unshield (the exit target itself when `exitTarget` is set) */
  recipient: EvmAddress;
  /** address(0) = plain unshield */
  exitTarget: EvmAddress;
  exitData: Uint8Array;
  ciphertext0: Uint8Array;
  ciphertext1: Uint8Array;
  /** the relayer's fee note */
  ciphertext2: Uint8Array;
  outCiphertext: Uint8Array;
  reshield: Reshield;
  /** unix seconds after which the pool refuses the proof; 0 = never */
  validUntil: bigint;
  /** input for the entrance compliance hook of the token being shielded (empty when none is set) */
  complianceData: Uint8Array;
}

export const ZERO_ADDRESS: EvmAddress = "0x0000000000000000000000000000000000000000";
export const NO_EXIT = ZERO_ADDRESS;
export const NO_RESHIELD: Reshield = { token: ZERO_ADDRESS, ownerHash: 0n, rho: 0n, rcm: 0n, ciphertext: new Uint8Array(0) };

export const EXT_DATA_ABI = [
  {
    type: "tuple",
    components: [
      { name: "recipient", type: "address" },
      { name: "exitTarget", type: "address" },
      { name: "exitData", type: "bytes" },
      { name: "ciphertext0", type: "bytes" },
      { name: "ciphertext1", type: "bytes" },
      { name: "ciphertext2", type: "bytes" },
      { name: "outCiphertext", type: "bytes" },
      {
        name: "reshield",
        type: "tuple",
        components: [
          { name: "token", type: "address" },
          { name: "ownerHash", type: "uint256" },
          { name: "rho", type: "uint256" },
          { name: "rcm", type: "uint256" },
          { name: "ciphertext", type: "bytes" },
        ],
      },
      { name: "validUntil", type: "uint64" },
      { name: "complianceData", type: "bytes" },
    ],
  },
] as const;

const BOUND_ABI = [{ type: "uint256" }, { type: "address" }, EXT_DATA_ABI[0]] as const;

const hex = (b: Uint8Array): Hex => `0x${toHex(b)}`;

/** The tuple as the contract's `ExtData calldata` argument expects it. */
export function extDataArg(e: ExtData) {
  return {
    recipient: e.recipient,
    exitTarget: e.exitTarget,
    exitData: hex(e.exitData),
    ciphertext0: hex(e.ciphertext0),
    ciphertext1: hex(e.ciphertext1),
    ciphertext2: hex(e.ciphertext2),
    outCiphertext: hex(e.outCiphertext),
    reshield: { token: e.reshield.token, ownerHash: e.reshield.ownerHash, rho: e.reshield.rho, rcm: e.reshield.rcm, ciphertext: hex(e.reshield.ciphertext) },
    validUntil: e.validUntil,
    complianceData: hex(e.complianceData),
  } as const;
}

/** `abi.encode(ext)` alone (what the relayer wire format carries). */
export function serializeExtData(e: ExtData): Uint8Array {
  return fromHex(encodeAbiParameters(EXT_DATA_ABI, [extDataArg(e)]));
}

/** `abi.encode(chainId, pool, ext)` — the exact bytes the contract hashes. */
export function serializeBoundExtData(e: ExtData, chainId: number | bigint, pool: EvmAddress): Uint8Array {
  return fromHex(encodeAbiParameters(BOUND_ABI, [BigInt(chainId), pool, extDataArg(e)]));
}

export function extDataHash(e: ExtData, chainId: number | bigint, pool: EvmAddress): bigint {
  return mod(bytesToBigIntBE(sha256(serializeBoundExtData(e, chainId, pool))));
}

export function deserializeExtData(b: Uint8Array): ExtData {
  const [d] = decodeAbiParameters(EXT_DATA_ABI, hex(b));
  return {
    recipient: d.recipient,
    exitTarget: d.exitTarget,
    exitData: fromHex(d.exitData),
    ciphertext0: fromHex(d.ciphertext0),
    ciphertext1: fromHex(d.ciphertext1),
    ciphertext2: fromHex(d.ciphertext2),
    outCiphertext: fromHex(d.outCiphertext),
    reshield: { token: d.reshield.token, ownerHash: d.reshield.ownerHash, rho: d.reshield.rho, rcm: d.reshield.rcm, ciphertext: fromHex(d.reshield.ciphertext) },
    validUntil: d.validUntil,
    complianceData: fromHex(d.complianceData),
  };
}
