// Note encryption per SPEC.md section 12. All of this is off-circuit; the
// ciphertexts are bound to the proof through ext_data_hash.
import { blake2b } from "@noble/hashes/blake2.js";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { BabyJub, type Point } from "./crypto.js";
import { BJJ_SUBGROUP_ORDER, bigIntToBytesBE, bigIntToBytesLE, bytesToBigIntBE, bytesToBigIntLE, concatBytes, randomBytes } from "./field.js";
import type { Address } from "./keys.js";
import type { Note } from "./note.js";

const PERSON_ENC = new TextEncoder().encode("scash_NoteEncKey");
const PERSON_OUT = new TextEncoder().encode("scash_OutKey____");
const NONCE = new Uint8Array(12);

export const MEMO_LEN = 512;
/** epk(32) + tag(16) + d(11) + value(8) + rho(32) + rcm(32) + memo */
export const NOTE_CIPHERTEXT_LEN = 32 + 16 + 11 + 8 + 32 + 32 + MEMO_LEN;
export const NOTE_CIPHERTEXT_LEN_NO_MEMO = NOTE_CIPHERTEXT_LEN - MEMO_LEN;
/** tag(16) + pkd(32) + esk(32) */
export const OUT_CIPHERTEXT_LEN = 16 + 32 + 32;

export interface NotePlaintext {
  d: Uint8Array;
  value: bigint;
  rho: bigint;
  rcm: bigint;
  memo: Uint8Array;
}

function randomScalar(): bigint {
  while (true) {
    const s = bytesToBigIntLE(randomBytes(32)) & ((1n << 251n) - 1n);
    if (s > 0n && s < BJJ_SUBGROUP_ORDER) return s;
  }
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
  const shared = bjj.mulScalar(to.pkd, esk);
  const key = encKey(bjj, shared, epk);
  const memoBuf = new Uint8Array(includeMemo ? MEMO_LEN : 0);
  if (includeMemo) memoBuf.set(memo.slice(0, MEMO_LEN));
  const pt = concatBytes(to.d, bigIntToBytesLE(note.value, 8), bigIntToBytesBE(note.rho), bigIntToBytesBE(note.rcm), memoBuf);
  const ct = chacha20poly1305(key, NONCE).encrypt(pt);
  return { ciphertext: concatBytes(bjj.compress(epk), ct), esk, epk };
}

/** Trial-decrypt with an incoming viewing key. Returns null if not ours. */
export function tryDecryptNote(bjj: BabyJub, ivk: bigint, ciphertext: Uint8Array): { plaintext: NotePlaintext; epk: Point } | null {
  if (ciphertext.length !== NOTE_CIPHERTEXT_LEN && ciphertext.length !== NOTE_CIPHERTEXT_LEN_NO_MEMO) return null;
  const epk = bjj.decompress(ciphertext.slice(0, 32));
  if (!epk || !bjj.inCurve(epk)) return null;
  const shared = bjj.mulScalar(epk, ivk);
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
  return {
    d: pt.slice(0, 11),
    value: bytesToBigIntLE(pt.slice(11, 19)),
    rho: bytesToBigIntBE(pt.slice(19, 51)),
    rcm: bytesToBigIntBE(pt.slice(51, 83)),
    memo: pt.slice(83),
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
  const shared = bjj.mulScalar(pkd, esk);
  const key = encKey(bjj, shared, epk);
  try {
    return parsePlaintext(chacha20poly1305(key, NONCE).decrypt(ciphertext.slice(32)));
  } catch {
    return null;
  }
}
