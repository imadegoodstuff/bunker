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
 * farm manages on the order of 10^5 guesses per second, not 10^9. At that rate
 * the *expected* time to find a uniformly random secret of b bits is
 * 2^(b-1) / 10^5 seconds:
 *
 *   40 bits →  64 days      50 bits → 178 years
 *   55 bits → 5.7k years    64 bits → 2.9M years
 *
 * The score below is a HEURISTIC, not a measurement of entropy. Human-chosen
 * text is never uniform; attackers order guesses by word frequency, phrase
 * templates and leaked corpora, so the real work can be far below the score.
 * The heuristic therefore only discounts (0.6 on nominal character entropy,
 * repeats and runs ignored, common words credited 4 bits instead of 11, known
 * leaked passwords credited 0) and never adds. A high score is permission to
 * proceed, not a promise.
 */
export const PASSPHRASE_GUESSES_PER_SECOND = 100_000;
/** Below this the UI refuses the passphrase (≈178 years expected at 10^5 guesses/s if the score were true entropy). */
export const PASSPHRASE_MIN_BITS = 50;
/** At or above this the UI calls it strong (≈1.9·10^8 years expected under the same caveat). */
export const PASSPHRASE_STRONG_BITS = 70;

/** Expected seconds to find a uniformly random b-bit secret at PASSPHRASE_GUESSES_PER_SECOND. */
export function expectedSecondsToCrack(bits: number): number {
  return bits <= 0 ? 0 : Math.pow(2, bits - 1) / PASSPHRASE_GUESSES_PER_SECOND;
}

/** The most-used leaked passwords; any passphrase that is one of these (optionally with trailing digits or a symbol) scores 0. */
const LEAKED = new Set([
  "password", "passphrase", "123456", "12345678", "123456789", "1234567890", "qwerty", "qwertyuiop", "abc123", "111111", "iloveyou",
  "admin", "welcome", "monkey", "dragon", "letmein", "login", "princess", "football", "baseball", "sunshine", "master", "shadow",
  "superman", "trustno1", "solana", "scash", "bitcoin", "crypto", "wallet", "secret", "changeme", "default", "freedom", "whatever",
  "correcthorsebatterystaple", "correct horse battery staple", "tothemoon", "hodl", "satoshi", "nakamoto", "ethereum", "privatekey",
  "seedphrase", "password1", "password123", "p@ssw0rd", "passw0rd", "letmein1", "qwerty123", "1q2w3e4r", "zaq12wsx", "asdfgh", "zxcvbn",
]);

/** Very common English words: an attacker's phrase dictionary starts here, so they are worth ~4 bits each, not 11. */
const COMMON_WORDS = new Set((
  "the be to of and a in that have i it for not on with he as you do at this but his by from they we say her she or an will my one all would " +
  "there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could " +
  "them see other than then now look only come its over think also back after use two how our work first well way even new want because any these " +
  "give day most us is are was were been has had did does am love hate life money cash coin crypto bitcoin solana wallet secret private key seed " +
  "phrase pass word password horse battery staple correct dog cat house car tree sun moon star sky blue red green black white water fire earth " +
  "wind king queen dragon monkey tiger lion bear wolf eagle apple banana orange summer winter spring autumn happy sad big small fast slow hello " +
  "world test admin user root god jesus angel baby girl boy man woman family friend home open close yes no ok free trust strong weak hard easy " +
  "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday " +
  "quick brown fox jump jumps over lazy today tomorrow yesterday night morning never always forever again still here where why very much many more " +
  "long great little old right high different large next early young important few public bad same able last own under while should through " +
  "before between both each such down off thing place case part week company system program question number point hand eye state school " +
  "mother father son daughter brother sister child children music light dark heart soul mind body dream hope faith peace power magic future past " +
  "gold silver diamond rose flower river ocean mountain forest rain snow storm cloud thunder lightning rock stone wood iron steel door window " +
  "road street city town country nation america china india london paris york angel devil heaven hell live die born death kill run walk fly " +
  "swim dance sing play read write learn teach work rest sleep wake eat drink coffee tea beer wine pizza chocolate sugar salt bread milk egg " +
  "one two three four five six seven eight nine ten hundred thousand million first second third zero number letmein qwerty abc xyz asdf"
).split(/\s+/));

/** Phrases attackers try verbatim; any passphrase containing one gets 4 bits for the whole phrase, not 11 per word. */
const FAMOUS_PHRASES = [
  "the quick brown fox", "jumps over the lazy dog", "to be or not to be", "may the force be with you", "i have a dream", "correct horse battery staple",
  "once upon a time", "all you need is love", "let it be", "in god we trust", "to the moon", "not your keys not your coins", "be your own bank",
  "hello world", "open sesame", "mary had a little lamb", "twinkle twinkle little star", "happy birthday to you", "god is great", "carpe diem",
  "live laugh love", "never gonna give you up", "winter is coming", "i am the one", "trust no one", "the cake is a lie", "keep calm and carry on",
];

export interface PassphraseStrength {
  /** Heuristic score in bits; an upper bound on what the attacker has to search, never a lower bound. */
  bits: number;
  level: "weak" | "fair" | "strong";
  /** expectedSecondsToCrack(bits) — valid only if the passphrase were uniformly random, which human text is not. */
  secondsToCrack: number;
  /** Why the score is low, when it is. */
  reason?: string;
}

export function passphraseStrength(passphrase: string): PassphraseStrength {
  const p = passphrase.normalize("NFKC").trim();
  if (p.length === 0) return { bits: 0, level: "weak", secondsToCrack: 0 };
  const lower = p.toLowerCase();
  const stripped = lower.replace(/[\d!@#$%^&*.?_-]+$/, "");
  if (LEAKED.has(lower) || LEAKED.has(stripped) || LEAKED.has(lower.replace(/\s+/g, ""))) {
    return { bits: 0, level: "weak", secondsToCrack: 0, reason: "this is on every attacker's list" };
  }
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
  // Word model. Anything with three or more words IS a phrase and is scored as
  // one, never by its characters: a 35-letter sentence of common words looks
  // like 90 bits to a character model and like 30 to the attacker who guesses
  // phrases word by word. 11 bits per word (2048-word list), 4 for words
  // everyone picks first, nothing for repeats, +3 if digits/symbols/case are
  // mixed in (attackers try the obvious mutations early).
  const words = lower.split(/\s+/).filter((w) => w.length >= 2);
  const isPhrase = words.length >= 3;
  let bits: number;
  let commonCount = 0;
  if (isPhrase) {
    // Famous phrases are one dictionary entry each, whatever their length.
    let text = lower.replace(/[^a-z0-9\s]/g, " ");
    let wordBits = 0;
    for (const f of FAMOUS_PHRASES) {
      if (text.includes(f)) {
        text = text.replace(f, " ");
        wordBits += 4;
        commonCount += f.split(" ").length;
      }
    }
    const rest = text.split(/\s+/).filter((w) => w.length >= 2);
    const seen = new Set<string>();
    for (const w of rest) {
      const core = w.replace(/[^a-z]/g, "");
      if (seen.has(core)) continue;
      seen.add(core);
      const common = COMMON_WORDS.has(core) || core.length <= 2;
      if (common) commonCount += 1;
      wordBits += common ? 4 : 11;
    }
    if (/[0-9]/.test(p) || /[^A-Za-z0-9\s]/.test(p) || /[A-Z]/.test(p)) wordBits += 3;
    bits = Math.round(wordBits);
  } else {
    bits = Math.round(charBits);
  }
  const secondsToCrack = expectedSecondsToCrack(bits);
  const level = bits < PASSPHRASE_MIN_BITS ? "weak" : bits < PASSPHRASE_STRONG_BITS ? "fair" : "strong";
  let reason: string | undefined;
  if (level === "weak") {
    reason = isPhrase
      ? commonCount > 0
        ? `${commonCount} of ${words.length} words are among the first an attacker tries; add rarer words`
        : "add another word or two"
      : "too short for the characters it uses";
  }
  return { bits, level, secondsToCrack, reason };
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
