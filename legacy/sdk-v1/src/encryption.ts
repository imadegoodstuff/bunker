// Note encryption per SPEC.md section 12. All of this is off-circuit; the
// ciphertexts are bound to the proof through ext_data_hash.
import { blake2b } from "@noble/hashes/blake2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { BabyJub, type Point } from "./crypto.js";
import { BJJ_SUBGROUP_ORDER, bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntBE, bytesToBigIntLE, concatBytes, randomBytes } from "./field.js";
import { SCALAR_MASK, type Address } from "./keys.js";
import { noteRandomness, type Note } from "./note.js";

const PERSON_ENC = new TextEncoder().encode("bunkerNoteEncKey");
const PERSON_OUT = new TextEncoder().encode("bunkerOutKey____");
const NONCE = new Uint8Array(12);

/**
 * Maximum memo length. On BNB Chain calldata is cheap enough that this is a
 * privacy choice, not a transport limit: every note ciphertext is padded to
 * the same 64-byte bucket so memo length leaks nothing. Raising it changes
 * the ciphertext size every client must agree on; treat it as a protocol constant.
 */
export const MEMO_MAX = 64;
/** Memos are padded to a multiple of this so lengths leak only a bucket. */
export const MEMO_BUCKET = 64;
/** epk(32) + tag(16) + d(11) + value(8) + rseed(32) [+ memo bucket] */
export const NOTE_CIPHERTEXT_LEN_NO_MEMO = 32 + 16 + 11 + 8 + 32;
export const NOTE_CIPHERTEXT_LEN = NOTE_CIPHERTEXT_LEN_NO_MEMO + MEMO_MAX;

export function memoBucketLen(memoLen: number): number {
  if (memoLen <= 0) return 0;
  return Math.min(MEMO_MAX, Math.ceil(memoLen / MEMO_BUCKET) * MEMO_BUCKET);
}
/** tag(16) + pkd(32) + esk(32) */
export const OUT_CIPHERTEXT_LEN = 16 + 32 + 32;

export interface NotePlaintext {
  d: Uint8Array;
  value: bigint;
  rseed: Uint8Array;
  rho: bigint;
  rcm: bigint;
  memo: Uint8Array;
}

function randomScalar(): bigint {
  while (true) {
    const s = bytesToBigIntLE(randomBytes(32)) & SCALAR_MASK;
    if (s > 0n && s < BJJ_SUBGROUP_ORDER) return s;
  }
}

/**
 * Key agreement with cofactor clearing (Sapling KA.Agree): shared = [8·sk]·P.
 * The receiver multiplies a *sender-supplied* epk by its secret ivk; without
 * the cofactor a torsion component in epk (epk' = epk + T, T of order 8) would
 * let the sender learn ivk mod 8 from whether the recipient accepts the note.
 * Multiplying by 8 first kills T on both sides and costs three doublings.
 */
export const KA_COFACTOR = 8n;
function agree(bjj: BabyJub, point: Point, sk: bigint): Point {
  return bjj.mulScalar(point, sk * KA_COFACTOR);
}

function encKey(bjj: BabyJub, shared: Point, epk: Point): Uint8Array {
  return blake2b(concatBytes(bjj.compress(shared), bjj.compress(epk)), { dkLen: 32, personalization: PERSON_ENC });
}

export function encryptNote(
  bjj: BabyJub,
  to: Address,
  note: Note,
  memo: Uint8Array = new Uint8Array(0),
  includeMemo = true,
  esk: bigint = randomScalar()
): { ciphertext: Uint8Array; esk: bigint; epk: Point } {
  const gd = note.gd;
  const epk = bjj.mulScalar(gd, esk);
  const shared = agree(bjj, to.pkd, esk);
  const key = encKey(bjj, shared, epk);
  const memoBuf = new Uint8Array(includeMemo ? memoBucketLen(memo.length) : 0);
  if (includeMemo) memoBuf.set(memo.slice(0, MEMO_MAX));
  const pt = concatBytes(to.d, bigIntToBytesLE(note.value, 8), note.rseed, memoBuf);
  const ct = chacha20poly1305(key, NONCE).encrypt(pt);
  return { ciphertext: concatBytes(bjj.compress(epk), ct), esk, epk };
}

/** Trial-decrypt with an incoming viewing key. Returns null if not ours. */
export function tryDecryptNote(bjj: BabyJub, ivk: bigint, ciphertext: Uint8Array): { plaintext: NotePlaintext; epk: Point } | null {
  const extra = ciphertext.length - NOTE_CIPHERTEXT_LEN_NO_MEMO;
  if (extra < 0 || extra > MEMO_MAX || extra % MEMO_BUCKET !== 0) return null;
  const epk = bjj.decompress(ciphertext.slice(0, 32));
  if (!epk || !bjj.inCurve(epk)) return null;
  const shared = agree(bjj, epk, ivk);
  const key = encKey(bjj, shared, epk);
  let pt: Uint8Array;
  try {
    pt = chacha20poly1305(key, NONCE).decrypt(ciphertext.slice(32));
  } catch {
    return null;
  }
  return { plaintext: parsePlaintext(pt), epk };
}

function parsePlaintext(pt: Uint8Array): NotePlaintext {
  const rseed = pt.slice(19, 51);
  return {
    d: pt.slice(0, 11),
    value: bytesToBigIntLE(pt.slice(11, 19)),
    rseed,
    ...noteRandomness(rseed),
    memo: pt.slice(51),
  };
}

export function encryptOutgoing(bjj: BabyJub, ovk: Uint8Array, cm: bigint, pkd: Point, esk: bigint): Uint8Array {
  const key = blake2b(concatBytes(ovk, bigIntToBytesBE(cm)), { dkLen: 32, personalization: PERSON_OUT });
  return chacha20poly1305(key, NONCE).encrypt(concatBytes(bjj.compress(pkd), bigIntToBytesLE(esk, 32)));
}

export function decryptOutgoing(bjj: BabyJub, ovk: Uint8Array, cm: bigint, ct: Uint8Array): { pkd: Point; esk: bigint } | null {
  const key = blake2b(concatBytes(ovk, bigIntToBytesBE(cm)), { dkLen: 32, personalization: PERSON_OUT });
  try {
    const pt = chacha20poly1305(key, NONCE).decrypt(ct);
    const pkd = bjj.decompress(pt.slice(0, 32));
    if (!pkd) return null;
    return { pkd, esk: bytesToBigIntLE(pt.slice(32, 64)) };
  } catch {
    return null;
  }
}

/** With ovk, recover the note plaintext of an outgoing ciphertext we produced. */
export function decryptNoteAsSender(bjj: BabyJub, pkd: Point, esk: bigint, ciphertext: Uint8Array): NotePlaintext | null {
  const epk = bjj.decompress(ciphertext.slice(0, 32));
  if (!epk) return null;
  const shared = agree(bjj, pkd, esk);
  const key = encKey(bjj, shared, epk);
  try {
    return parsePlaintext(chacha20poly1305(key, NONCE).decrypt(ciphertext.slice(32)));
  } catch {
    return null;
  }
}
