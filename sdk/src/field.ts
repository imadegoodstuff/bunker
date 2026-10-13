// BN254 scalar field helpers. Field elements are bigint in [0, P).

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
/** BN254 base field modulus (coordinates of G1/G2 points live here, not in P). */
export const Q = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// Baby Jubjub prime-order subgroup order.
export const BJJ_SUBGROUP_ORDER = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

export const TREE_DEPTH = 26;
export const ROOT_HISTORY = 128;
export const MAX_U64 = (1n << 64n) - 1n;

export function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m;
  return r < 0n ? r + m : r;
}

export function bytesToBigIntBE(b: Uint8Array): bigint {
  let x = 0n;
  for (const v of b) x = (x << 8n) | BigInt(v);
  return x;
}

export function bytesToBigIntLE(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
  return x;
}

export function bigIntToBytesBE(x: bigint, len = 32): Uint8Array {
  if (x < 0n) throw new Error("negative");
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  if (x !== 0n) throw new Error("integer does not fit");
  return out;
}

export function bigIntToBytesLE(x: bigint, len = 32): Uint8Array {
  return bigIntToBytesBE(x, len).reverse();
}

export function randomField(): bigint {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return mod(bytesToBigIntBE(b));
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Encode a signed 64-bit-ish amount as a field element the way the circuit expects. */
export function encodePublicAmount(amount: bigint): bigint {
  if (amount >= 0n) return amount;
  return P + amount;
}

export function decodePublicAmount(fe: bigint): bigint {
  if (fe > P / 2n) return fe - P;
  return fe;
}

export function modPow(base: bigint, exp: bigint, m: bigint = P): bigint {
  let r = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return r;
}

export function modInv(a: bigint, m: bigint = P): bigint {
  return modPow(a, m - 2n, m);
}

/** Tonelli-Shanks square root in F_p; null if `n` is a non-residue. */
export function sqrtMod(n: bigint, p: bigint = P): bigint | null {
  n = mod(n, p);
  if (n === 0n) return 0n;
  if (modPow(n, (p - 1n) / 2n, p) !== 1n) return null;
  let q = p - 1n;
  let s = 0n;
  while ((q & 1n) === 0n) {
    q >>= 1n;
    s++;
  }
  let z = 2n;
  while (modPow(z, (p - 1n) / 2n, p) !== p - 1n) z++;
  let m = s;
  let c = modPow(z, q, p);
  let t = modPow(n, q, p);
  let r = modPow(n, (q + 1n) / 2n, p);
  while (t !== 1n) {
    let i = 0n;
    let tt = t;
    while (tt !== 1n) {
      tt = (tt * tt) % p;
      i++;
      if (i === m) return null;
    }
    const b = modPow(c, 1n << (m - i - 1n), p);
    m = i;
    c = (b * b) % p;
    t = (t * c) % p;
    r = (r * b) % p;
  }
  return r;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
  if (h.startsWith("0x")) h = h.slice(2);
  if (h.length % 2) h = "0" + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
