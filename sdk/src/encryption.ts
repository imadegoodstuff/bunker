// Note encryption per SPEC.md section 12. All of this is off-circuit; the
// ciphertexts are bound to the proof through ext_data_hash.
//
// Two envelope versions are in use, chosen by the recipient's address:
//   0x03  Baby Jubjub ECDH (cofactor-cleared) → ChaCha20-Poly1305. For `bunker1…` addresses.
//   0x04  Hybrid: the same ECDH plus ML-KEM-768, both shared secrets mixed into
//         the payload key. For `bunkerq1…` addresses, which carry the recipient's
//         ML-KEM encapsulation key. A quantum adversary who breaks the curve
//         still faces ML-KEM for the payload (value, randomness, asset, memo).
//         The diversifier is sealed under the ECDH key alone (the receiver has
//         to learn it before it knows which ML-KEM key to decapsulate with), so
//         what such an adversary gains is the diversifier: which notes share an
//         address, never what they hold.
// Both carry a one-byte view tag after the version so a scanner can discard
// most foreign notes after the key agreement, before any AEAD work.
import { blake2b } from "@noble/hashes/blake2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { BabyJub, type Point } from "./crypto.js";
import { BJJ_SUBGROUP_ORDER, bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntLE, concatBytes, randomBytes } from "./field.js";
import { SCALAR_MASK, isPqAddress, kemKeyPairFor, type Address, type PqAddress } from "./keys.js";
import { noteRandomness, type Note } from "./note.js";

const PERSON_ENC = new TextEncoder().encode("bunkerNoteEncKey");
const PERSON_ENC_PQ = new TextEncoder().encode("bunkerNoteEncPQ_");
const PERSON_TAG = new TextEncoder().encode("bunkerViewTag___");
const PERSON_OUT = new TextEncoder().encode("bunkerOutKey____");
const NONCE = new Uint8Array(12);
const NONCE_D = new Uint8Array(12); NONCE_D[0] = 1;

/**
 * Maximum memo length. On BNB Chain calldata is cheap enough that this is a
 * privacy choice, not a transport limit: every note ciphertext is padded to
 * the same 64-byte bucket so memo length leaks nothing. Raising it changes
 * the ciphertext size every client must agree on; treat it as a protocol constant.
 */
export const MEMO_MAX = 64;
/** Memos are padded to a multiple of this so lengths leak only a bucket. */
export const MEMO_BUCKET = 64;
/** Classic envelope: Baby Jubjub ECDH + ChaCha20-Poly1305. */
export const NOTE_VERSION = 0x03;
/** Hybrid envelope: ECDH + ML-KEM-768. */
export const NOTE_VERSION_PQ = 0x04;
/** The v2.0 envelope (no token, no view tag); still recognised so old ciphertexts can be read, never produced. */
export const NOTE_VERSION_LEGACY = 0x02;

export const KEM_PUBLIC_KEY_LEN = 1184;
export const KEM_CIPHERTEXT_LEN = 1088;

/** d(11) + value(8) + rseed(32) + token(20) */
const PLAINTEXT_LEN_NO_MEMO = 11 + 8 + 32 + 20;
const LEGACY_PLAINTEXT_LEN_NO_MEMO = 11 + 8 + 32;
/** version(1) + viewTag(1) + epk(32) + tag(16) + plaintext */
export const NOTE_CIPHERTEXT_LEN_NO_MEMO = 1 + 1 + 32 + 16 + PLAINTEXT_LEN_NO_MEMO;
export const NOTE_CIPHERTEXT_LEN = NOTE_CIPHERTEXT_LEN_NO_MEMO + MEMO_MAX;
/** version(1) + viewTag(1) + epk(32) + kemCt(1088) + sealed d (11 + 16) + tag(16) + value/rseed/token */
export const NOTE_CIPHERTEXT_PQ_LEN_NO_MEMO = 1 + 1 + 32 + KEM_CIPHERTEXT_LEN + (11 + 16) + 16 + (8 + 32 + 20);
const LEGACY_CIPHERTEXT_LEN_NO_MEMO = 1 + 32 + 16 + LEGACY_PLAINTEXT_LEN_NO_MEMO;

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
  /** the note's asset, as the 20-byte token address (BNB = zero). Null only for legacy (0x02) ciphertexts. */
  token: `0x${string}` | null;
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
function encKeyPq(bjj: BabyJub, shared: Point, epk: Point, kemShared: Uint8Array): Uint8Array {
  return blake2b(concatBytes(bjj.compress(shared), bjj.compress(epk), kemShared), { dkLen: 32, personalization: PERSON_ENC_PQ });
}
/** One byte derived from the shared secret: a scanner compares it before decrypting. 1/256 of foreign notes get past it. */
export function viewTag(bjj: BabyJub, shared: Point, epk: Point): number {
  return blake2b(concatBytes(bjj.compress(shared), bjj.compress(epk)), { dkLen: 1, personalization: PERSON_TAG })[0];
}

function tokenBytes(token: string): Uint8Array {
  const hex = token.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(hex)) throw new Error(`not an EVM address: ${token}`);
  return Uint8Array.from(hex.match(/../g)!, (h) => parseInt(h, 16));
}
function tokenHex(b: Uint8Array): `0x${string}` {
  return `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Encrypt a note to `to`. The envelope follows the address: a `PqAddress`
 * gets the hybrid envelope, a plain one the classic. `note.token` is required:
 * since v2.1 the asset travels inside the ciphertext (a private send names no
 * token on-chain).
 */
export function encryptNote(
  bjj: BabyJub,
  to: Address | PqAddress,
  note: Note,
  memo: Uint8Array = new Uint8Array(0),
  includeMemo = true,
  esk: bigint = randomScalar()
): { ciphertext: Uint8Array; esk: bigint; epk: Point } {
  if (!note.token) throw new Error("note.token required to encrypt (the asset travels inside the ciphertext)");
  const gd = note.gd;
  const epk = bjj.mulScalar(gd, esk);
  const shared = agree(bjj, to.pkd, esk);
  const tag = new Uint8Array([viewTag(bjj, shared, epk)]);
  const memoBuf = new Uint8Array(includeMemo ? memoBucketLen(memo.length) : 0);
  if (includeMemo) memoBuf.set(memo.slice(0, MEMO_MAX));
  const body = concatBytes(bigIntToBytesLE(note.value, 8), note.rseed, tokenBytes(note.token), memoBuf);
  if (isPqAddress(to)) {
    const { cipherText: kemCt, sharedSecret } = ml_kem768.encapsulate(to.kemPk);
    const k1 = encKey(bjj, shared, epk);
    const k2 = encKeyPq(bjj, shared, epk, sharedSecret);
    const sealedD = chacha20poly1305(k1, NONCE_D).encrypt(to.d);
    const ct = chacha20poly1305(k2, NONCE).encrypt(body);
    return { ciphertext: concatBytes(new Uint8Array([NOTE_VERSION_PQ]), tag, bjj.compress(epk), kemCt, sealedD, ct), esk, epk };
  }
  const key = encKey(bjj, shared, epk);
  const ct = chacha20poly1305(key, NONCE).encrypt(concatBytes(to.d, body));
  return { ciphertext: concatBytes(new Uint8Array([NOTE_VERSION]), tag, bjj.compress(epk), ct), esk, epk };
}

/** Which envelope a ciphertext uses, or null if it is none we speak or its length is wrong for that version. */
export function ciphertextVersion(ciphertext: Uint8Array): number | null {
  const v = ciphertext[0];
  const okMemo = (extra: number) => extra >= 0 && extra <= MEMO_MAX && extra % MEMO_BUCKET === 0;
  if (v === NOTE_VERSION && okMemo(ciphertext.length - NOTE_CIPHERTEXT_LEN_NO_MEMO)) return v;
  if (v === NOTE_VERSION_PQ && okMemo(ciphertext.length - NOTE_CIPHERTEXT_PQ_LEN_NO_MEMO)) return v;
  if (v === NOTE_VERSION_LEGACY && okMemo(ciphertext.length - LEGACY_CIPHERTEXT_LEN_NO_MEMO)) return v;
  return null;
}

/**
 * Trial-decrypt with an incoming viewing key. Returns null if not ours (or not
 * a version we speak). The view tag rejects ~255/256 of foreign notes after
 * one scalar multiplication; the AEAD tag rejects the rest.
 */
export function tryDecryptNote(bjj: BabyJub, ivk: bigint, ciphertext: Uint8Array): { plaintext: NotePlaintext; epk: Point } | null {
  const v = ciphertextVersion(ciphertext);
  if (v === null) return null;
  if (v === NOTE_VERSION_LEGACY) return tryDecryptLegacy(bjj, ivk, ciphertext);
  const epk = bjj.decompress(ciphertext.slice(2, 34));
  if (!epk || !bjj.inCurve(epk)) return null;
  const shared = agree(bjj, epk, ivk);
  if (viewTag(bjj, shared, epk) !== ciphertext[1]) return null;
  const k1 = encKey(bjj, shared, epk);
  try {
    if (v === NOTE_VERSION) {
      return { plaintext: parsePlaintext(chacha20poly1305(k1, NONCE).decrypt(ciphertext.slice(34))), epk };
    }
    // hybrid: learn d, derive this diversifier's KEM key, decapsulate, open the payload
    let o = 34;
    const kemCt = ciphertext.slice(o, (o += KEM_CIPHERTEXT_LEN));
    const d = chacha20poly1305(k1, NONCE_D).decrypt(ciphertext.slice(o, (o += 11 + 16)));
    const kem = kemKeyPairFor(ivk, d);
    const kemShared = ml_kem768.decapsulate(kemCt, kem.secretKey);
    const body = chacha20poly1305(encKeyPq(bjj, shared, epk, kemShared), NONCE).decrypt(ciphertext.slice(o));
    return { plaintext: parsePlaintext(concatBytes(d, body)), epk };
  } catch {
    return null;
  }
}

function tryDecryptLegacy(bjj: BabyJub, ivk: bigint, ciphertext: Uint8Array): { plaintext: NotePlaintext; epk: Point } | null {
  const epk = bjj.decompress(ciphertext.slice(1, 33));
  if (!epk || !bjj.inCurve(epk)) return null;
  const shared = agree(bjj, epk, ivk);
  const key = encKey(bjj, shared, epk);
  try {
    const pt = chacha20poly1305(key, NONCE).decrypt(ciphertext.slice(33));
    const rseed = pt.slice(19, 51);
    return { plaintext: { d: pt.slice(0, 11), value: bytesToBigIntLE(pt.slice(11, 19)), rseed, ...noteRandomness(rseed), token: null, memo: pt.slice(51) }, epk };
  } catch {
    return null;
  }
}

function parsePlaintext(pt: Uint8Array): NotePlaintext {
  const rseed = pt.slice(19, 51);
  return {
    d: pt.slice(0, 11),
    value: bytesToBigIntLE(pt.slice(11, 19)),
    rseed,
    ...noteRandomness(rseed),
    token: tokenHex(pt.slice(51, 71)),
    memo: pt.slice(71),
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

/**
 * With ovk, recover the note plaintext of an outgoing ciphertext we produced.
 * For a hybrid ciphertext the sender has no ML-KEM secret, so only the
 * diversifier is recoverable; `kemShared` (kept by the sender at encryption
 * time) is not part of the outgoing record. Returns null for those.
 */
export function decryptNoteAsSender(bjj: BabyJub, pkd: Point, esk: bigint, ciphertext: Uint8Array): NotePlaintext | null {
  const v = ciphertextVersion(ciphertext);
  if (v !== NOTE_VERSION) return null;
  const epk = bjj.decompress(ciphertext.slice(2, 34));
  if (!epk) return null;
  const shared = agree(bjj, pkd, esk);
  const key = encKey(bjj, shared, epk);
  try {
    return parsePlaintext(chacha20poly1305(key, NONCE).decrypt(ciphertext.slice(34)));
  } catch {
    return null;
  }
}