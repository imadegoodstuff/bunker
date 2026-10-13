// Key derivation per SPEC.md section 2 and diversified addresses per section 3.
import { blake2b } from "@noble/hashes/blake2.js";
import { bech32m } from "bech32";
import { BabyJub, poseidon, type Point } from "./crypto.js";
import { P, mod, bytesToBigIntLE, concatBytes, randomBytes } from "./field.js";

const PERSON_EXPAND = new TextEncoder().encode("scash_ExpandSeed");
const PERSON_DIVERSIFY = new TextEncoder().encode("scash_Diversify_");

export const SPENDING_KEY_MESSAGE = "scash:v1:spending-key";

export interface SpendingKey {
  sk: Uint8Array; // 32 bytes
  ask: bigint;
  nsk: bigint;
  ovk: Uint8Array; // 32 bytes
}

export interface FullViewingKey {
  ak: bigint;
  nk: bigint;
  ovk: Uint8Array;
  ivk: bigint;
}

export interface Address {
  d: Uint8Array; // 11 bytes
  pkd: Point;
}

function expand(sk: Uint8Array, tag: number): Uint8Array {
  return blake2b(concatBytes(sk, new Uint8Array([tag])), { dkLen: 64, personalization: PERSON_EXPAND });
}

/** Derive the spending key from 32 bytes of seed material. */
export function spendingKeyFromSeed(sk: Uint8Array): SpendingKey {
  if (sk.length !== 32) throw new Error("seed must be 32 bytes");
  const ask = mod(bytesToBigIntLE(expand(sk, 0x00)));
  const nsk = mod(bytesToBigIntLE(expand(sk, 0x01)));
  const ovk = expand(sk, 0x02).slice(0, 32);
  return { sk, ask, nsk, ovk };
}

/** Derive the seed from a wallet signature over SPENDING_KEY_MESSAGE. */
export function seedFromSignature(signature: Uint8Array): Uint8Array {
  return blake2b(signature, { dkLen: 32, personalization: new TextEncoder().encode("scash_WalletSeed") });
}

export async function fullViewingKey(spend: SpendingKey): Promise<FullViewingKey> {
  const ak = await poseidon([spend.ask]);
  const nk = await poseidon([spend.nsk]);
  const ivkFull = await poseidon([ak, nk]);
  const ivk = ivkFull & ((1n << 251n) - 1n);
  return { ak, nk, ovk: spend.ovk, ivk };
}

/** GroupHash_BJJ(d): deterministic diversifier to subgroup point, or null. */
export function groupHash(bjj: BabyJub, d: Uint8Array): Point | null {
  if (d.length !== 11) throw new Error("diversifier must be 11 bytes");
  const h = blake2b(d, { dkLen: 32, personalization: PERSON_DIVERSIFY });
  const y = mod(bytesToBigIntLE(h), P);
  return bjj.pointFromY(y);
}

export function diversifiedAddress(bjj: BabyJub, ivk: bigint, d: Uint8Array): Address | null {
  const gd = groupHash(bjj, d);
  if (!gd) return null;
  return { d, pkd: bjj.mulScalar(gd, ivk) };
}

/** Pick a fresh random diversifier that maps to a valid point. */
export function newAddress(bjj: BabyJub, ivk: bigint): Address {
  for (let i = 0; i < 64; i++) {
    const d = randomBytes(11);
    const a = diversifiedAddress(bjj, ivk, d);
    if (a) return a;
  }
  throw new Error("could not find a valid diversifier");
}

/** Derive the i-th deterministic address (d = LE(i) padded), skipping invalid ones. */
export function addressAtIndex(bjj: BabyJub, ivk: bigint, index: number): Address {
  let i = index;
  for (let tries = 0; tries < 256; tries++, i++) {
    const d = new Uint8Array(11);
    let v = i;
    for (let k = 0; k < 11 && v > 0; k++) {
      d[k] = v & 0xff;
      v = Math.floor(v / 256);
    }
    const a = diversifiedAddress(bjj, ivk, d);
    if (a) return a;
  }
  throw new Error("no valid diversifier near index");
}

export function encodeAddress(bjj: BabyJub, addr: Address, hrp: "scash" | "tscash" = "scash"): string {
  const payload = concatBytes(addr.d, bjj.compress(addr.pkd));
  return bech32m.encode(hrp, bech32m.toWords(payload), 120);
}

export function decodeAddress(bjj: BabyJub, s: string): { hrp: string; address: Address } {
  const { prefix, words } = bech32m.decode(s, 120);
  const payload = new Uint8Array(bech32m.fromWords(words));
  if (payload.length !== 43) throw new Error("bad address length");
  const d = payload.slice(0, 11);
  const pkd = bjj.decompress(payload.slice(11));
  if (!pkd) throw new Error("bad address point");
  if (!bjj.inSubgroup(pkd)) throw new Error("address point not in subgroup");
  return { hrp: prefix, address: { d, pkd } };
}
