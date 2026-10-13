// Notes, commitments and nullifiers per SPEC.md section 4.
import { sha256 } from "@noble/hashes/sha2.js";
import { PublicKey } from "@solana/web3.js";
import { poseidon, type Point } from "./crypto.js";
import { MAX_U64, mod, bytesToBigIntBE, concatBytes, randomField } from "./field.js";

export interface Note {
  asset: bigint;
  value: bigint; // shares, u64
  gd: Point;
  pkd: Point;
  rho: bigint;
  rcm: bigint;
}

export interface SpendableNote extends Note {
  commitment: bigint;
  position: number; // leaf index in the commitment tree
  memo?: Uint8Array;
}

export function assetId(mint: PublicKey): bigint {
  const h = sha256(concatBytes(new TextEncoder().encode("scash_asset"), mint.toBytes()));
  return mod(bytesToBigIntBE(h));
}

export const NATIVE_MINT = new PublicKey("11111111111111111111111111111111");

export function newNote(asset: bigint, value: bigint, gd: Point, pkd: Point, memoRandom = true): Note {
  if (value < 0n || value > MAX_U64) throw new Error("value out of range");
  return { asset, value, gd, pkd, rho: randomField(), rcm: randomField() };
}

export async function noteCommitment(n: Note): Promise<bigint> {
  return poseidon([n.asset, n.value, n.gd[0], n.gd[1], n.pkd[0], n.pkd[1], n.rho, n.rcm]);
}

export async function nullifier(nk: bigint, rho: bigint, position: number | bigint): Promise<bigint> {
  return poseidon([nk, rho, BigInt(position)]);
}

/** A zero-value placeholder spend. The circuit skips its membership proof. */
export function dummyNote(asset: bigint, gd: Point, pkd: Point): Note {
  return { asset, value: 0n, gd, pkd, rho: randomField(), rcm: randomField() };
}
