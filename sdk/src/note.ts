// Notes, commitments and nullifiers per SPEC.md section 4.
import { sha256 } from "@noble/hashes/sha2.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { poseidon, type Point } from "./crypto.js";
import { MAX_U64, mod, bytesToBigIntBE, concatBytes, randomBytes } from "./field.js";

export interface Note {
  asset: bigint;
  /** the token behind `asset` (BNB = address(0)); carried inside the ciphertext since v2.1, so a receiver can name the pool */
  token?: `0x${string}`;
  value: bigint; // shares, u64
  gd: Point;
  pkd: Point;
  /** 32-byte seed; rho and rcm are derived from it (ZIP-212 style) so the
   *  ciphertext only has to carry 32 bytes of randomness instead of 64. */
  rseed: Uint8Array;
  rho: bigint;
  rcm: bigint;
}

const PERSON_RHO = new TextEncoder().encode("bunker_rho______");
const PERSON_RCM = new TextEncoder().encode("bunker_rcm______");

/** Derive (rho, rcm) from a 32-byte seed. Both are reduced into the BN254 scalar field. */
export function noteRandomness(rseed: Uint8Array): { rho: bigint; rcm: bigint } {
  if (rseed.length !== 32) throw new Error("rseed must be 32 bytes");
  const rho = mod(bytesToBigIntBE(blake2b(rseed, { dkLen: 64, personalization: PERSON_RHO })));
  const rcm = mod(bytesToBigIntBE(blake2b(rseed, { dkLen: 64, personalization: PERSON_RCM })));
  return { rho, rcm };
}

/** Fresh seed plus the derived randomness, ready to spread into a Note. */
export function freshRandomness(): { rseed: Uint8Array; rho: bigint; rcm: bigint } {
  const rseed = randomBytes(32);
  return { rseed, ...noteRandomness(rseed) };
}

export interface SpendableNote extends Note {
  commitment: bigint;
  position: number; // leaf index in the commitment tree
  memo?: Uint8Array;
}

/** BNB is `address(0)`. */
export const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as const;

/**
 * `asset = SHA-256("bunker_asset" || token left-padded to 32 bytes) mod p`
 * (ShieldedPool.assetId). The address is the 20-byte EVM address as 0x hex.
 */
export function assetId(token: string): bigint {
  const h = sha256(concatBytes(new TextEncoder().encode("bunker_asset"), addressToBytes32(token)));
  return mod(bytesToBigIntBE(h));
}

export function addressToBytes32(addr: string): Uint8Array {
  const hex = addr.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`not an EVM address: ${addr}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 20; i++) out[12 + i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function newNote(asset: bigint, value: bigint, gd: Point, pkd: Point, token?: `0x${string}`): Note {
  if (value < 0n || value > MAX_U64) throw new Error("value out of range");
  return { asset, token, value, gd, pkd, ...freshRandomness() };
}

/** A note of `token` (asset id derived), the usual way to make one. */
export function noteFor(token: string, value: bigint, gd: Point, pkd: Point): Note {
  const t = token.toLowerCase() as `0x${string}`;
  return newNote(assetId(t), value, gd, pkd, t);
}

/** `ownerHash = Poseidon(g_d.x, g_d.y, pk_d.x, pk_d.y)`: the owner half of a v2 commitment (circuits/src/note.circom OwnerHash). */
export async function ownerHash(gd: Point, pkd: Point): Promise<bigint> {
  return poseidon([gd[0], gd[1], pkd[0], pkd[1]]);
}

/** `cm = Poseidon(asset, value, ownerHash, rho, rcm)` (protocol v2; `ShieldedPool.openNoteCommitment` computes the same). */
export async function noteCommitment(n: Note): Promise<bigint> {
  return poseidon([n.asset, n.value, await ownerHash(n.gd, n.pkd), n.rho, n.rcm]);
}

/** Commitment of a note the pool minted on-chain: everything but the owner is public. */
export async function openNoteCommitment(asset: bigint, shares: bigint, owner: bigint, rho: bigint, rcm: bigint): Promise<bigint> {
  return poseidon([asset, shares, owner, rho, rcm]);
}

export async function nullifier(nk: bigint, rho: bigint, position: number | bigint): Promise<bigint> {
  return poseidon([nk, rho, BigInt(position)]);
}

/** A zero-value placeholder spend. The circuit skips its membership proof. */
export function dummyNote(asset: bigint, gd: Point, pkd: Point, token?: `0x${string}`): Note {
  return { asset, token, value: 0n, gd, pkd, ...freshRandomness() };
}
