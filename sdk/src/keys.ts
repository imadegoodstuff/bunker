// Key derivation per SPEC.md section 2 and diversified addresses per section 3.
import { blake2b } from "@noble/hashes/blake2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import bech32pkg from "bech32";
const { bech32m } = bech32pkg;
import { BabyJub, poseidon, type Point } from "./crypto.js";
import { P, mod, bytesToBigIntLE, concatBytes, randomBytes } from "./field.js";

const PERSON_EXPAND = new TextEncoder().encode("scash_ExpandSeed");
const PERSON_DIVERSIFY = new TextEncoder().encode("scash_Diversify_");

/**
 * The message a wallet signs to derive the shielded spending key.
 *
 * Threat model: any web page can ask a connected wallet to sign arbitrary
 * text, and wallets will show this text verbatim. The message therefore
 * says exactly what it is for, so a phishing site presenting it has to
 * show the user a warning in the user's own wallet. On its own that is a
 * speed bump, not a wall — the real mitigation is the optional passphrase
 * mixed into `seedFromSignature`, which a stolen signature cannot replay.
 */
export const SPENDING_KEY_MESSAGE = [
  "scash shielded wallet",
  "",
  "Signing this message derives the key that can SPEND your private balance.",
  "Only sign it inside the scash app. Never sign it for any other site,",
  "no matter what it claims.",
  "",
  "version: 2",
].join("\n");

const SEED_SALT = new TextEncoder().encode("scash:v2:wallet-seed");

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

/**
 * Derive the 32-byte seed from a wallet signature over SPENDING_KEY_MESSAGE and
 * an optional passphrase.
 *
 *   seed = scrypt(password = sig || NFKC(passphrase), salt = "scash:v2:wallet-seed", N = 2^15, r = 8, p = 1)
 *
 * The signature alone is high-entropy, so scrypt is not there to stretch it;
 * it is there so that an attacker who phished the signature still has to
 * grind the passphrase at ~100 ms per guess. An empty passphrase is allowed
 * (and is what "sign only" means), but the UI recommends setting one.
 * ~100 ms on a laptop, ~0.5 s on a phone.
 */
export async function seedFromSignature(signature: Uint8Array, passphrase = ""): Promise<Uint8Array> {
  if (signature.length < 32) throw new Error("signature too short");
  const pw = concatBytes(signature, new TextEncoder().encode(passphrase.normalize("NFKC")));
  return scryptAsync(pw, SEED_SALT, { N: 2 ** 15, r: 8, p: 1, dkLen: 32 });
}

/**
 * Offline guessing budget the passphrase has to survive if the signature leaks.
 *
 * One scrypt(N=2^15, r=8, p=1) evaluation needs 32 MiB of memory; a tuned GPU
 * farm manages on the order of 10^5 guesses per second, not 10^9. The strength
 * estimate below is deliberately conservative: it assumes the attacker knows the
 * character classes in use and that human-chosen text carries about 60% of its
 * nominal entropy. Dictionary-word phrases are credited 11 bits per word (a
 * 2048-word list), which is what a diceware attacker would get.
 */
export const PASSPHRASE_GUESSES_PER_SECOND = 100_000;
/** Below this the UI refuses the passphrase; the signature-only model is explicit instead. */
export const PASSPHRASE_MIN_BITS = 40;
/** At or above this the UI calls it strong (~10^5 guesses/s → centuries). */
export const PASSPHRASE_STRONG_BITS = 64;

export interface PassphraseStrength {
  bits: number;
  level: "weak" | "fair" | "strong";
  /** Expected time to exhaust half the space at PASSPHRASE_GUESSES_PER_SECOND, in seconds. */
  secondsToCrack: number;
}

export function passphraseStrength(passphrase: string): PassphraseStrength {
  const p = passphrase.normalize("NFKC");
  if (p.length === 0) return { bits: 0, level: "weak", secondsToCrack: 0 };
  let charset = 0;
  if (/[a-z]/.test(p)) charset += 26;
  if (/[A-Z]/.test(p)) charset += 26;
  if (/[0-9]/.test(p)) charset += 10;
  if (/[^A-Za-z0-9\s]/.test(p)) charset += 33;
  if (/[^\x00-\x7f]/.test(p)) charset += 100;
  if (/\s/.test(p)) charset += 1;
  // Repeated and sequential characters add nothing.
  let effective = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    const prev = i > 0 ? p.charCodeAt(i - 1) : NaN;
    if (c === prev || c === prev + 1 || c === prev - 1) continue;
    effective += 1;
  }
  const charBits = effective * Math.log2(Math.max(charset, 2)) * 0.6;
  const words = p.split(/\s+/).filter((w) => w.length >= 3);
  const wordBits = words.length >= 3 ? words.length * 11 : 0;
  const bits = Math.round(Math.max(charBits, wordBits));
  const secondsToCrack = Math.pow(2, bits - 1) / PASSPHRASE_GUESSES_PER_SECOND;
  const level = bits < PASSPHRASE_MIN_BITS ? "weak" : bits < PASSPHRASE_STRONG_BITS ? "fair" : "strong";
  return { bits, level, secondsToCrack };
}

/** Hex encoding of a seed for backup. 64 hex chars; anyone holding it can spend. */
export function seedToBackup(seed: Uint8Array): string {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  return "scashseed1" + Array.from(seed, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function seedFromBackup(s: string): Uint8Array {
  const t = s.trim().toLowerCase();
  if (!t.startsWith("scashseed1")) throw new Error("not a scash seed backup");
  const hex = t.slice("scashseed1".length);
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error("malformed seed backup");
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}

/**
 * Scalars fed to Baby Jubjub point multiplication are truncated to 250 bits.
 * Because l ≈ 2^250.6, every 250-bit value is below l; a 251-bit mask (what
 * Sapling uses on Jubjub, whose l ≈ 2^251.8) would not guarantee that here.
 * The circuit uses the same width (circuits/src/keys.circom).
 */
export const SCALAR_BITS = 250n;
export const SCALAR_MASK = (1n << SCALAR_BITS) - 1n;

export async function fullViewingKey(spend: SpendingKey): Promise<FullViewingKey> {
  const ak = await poseidon([spend.ask]);
  const nk = await poseidon([spend.nsk]);
  const ivkFull = await poseidon([ak, nk]);
  const ivk = ivkFull & SCALAR_MASK;
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
