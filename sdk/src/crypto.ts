// Poseidon and Baby Jubjub via circomlibjs (wasm). Both are loaded once and shared.
import { buildPoseidon, buildBabyjub } from "circomlibjs";
import { P, mod, modInv, sqrtMod, bigIntToBytesLE, bytesToBigIntLE } from "./field.js";

export type Point = [bigint, bigint];

let poseidonP: Promise<any> | null = null;
let babyjubP: Promise<any> | null = null;

async function poseidonInst() {
  if (!poseidonP) poseidonP = buildPoseidon();
  return poseidonP;
}
async function babyjubInst() {
  if (!babyjubP) babyjubP = buildBabyjub();
  return babyjubP;
}

export async function poseidon(inputs: bigint[]): Promise<bigint> {
  const h = await poseidonInst();
  const out = h(inputs.map((x) => mod(x)));
  return BigInt(h.F.toString(out));
}

export class BabyJub {
  private constructor(private readonly bj: any) {}

  static async load(): Promise<BabyJub> {
    return new BabyJub(await babyjubInst());
  }

  private toF(x: bigint) {
    return this.bj.F.e(x.toString());
  }
  private fromF(x: any): bigint {
    return BigInt(this.bj.F.toString(x));
  }

  get base8(): Point {
    return [this.fromF(this.bj.Base8[0]), this.fromF(this.bj.Base8[1])];
  }

  mulScalar(p: Point, s: bigint): Point {
    const r = this.bj.mulPointEscalar([this.toF(p[0]), this.toF(p[1])], s);
    return [this.fromF(r[0]), this.fromF(r[1])];
  }

  add(a: Point, b: Point): Point {
    const r = this.bj.addPoint([this.toF(a[0]), this.toF(a[1])], [this.toF(b[0]), this.toF(b[1])]);
    return [this.fromF(r[0]), this.fromF(r[1])];
  }

  inCurve(p: Point): boolean {
    return this.bj.inCurve([this.toF(p[0]), this.toF(p[1])]);
  }

  inSubgroup(p: Point): boolean {
    return this.bj.inSubgroup([this.toF(p[0]), this.toF(p[1])]);
  }

  isIdentity(p: Point): boolean {
    return p[0] === 0n && p[1] === 1n;
  }

  /** 32-byte compressed encoding (circomlib packPoint: y little-endian with sign of x in top bit). */
  compress(p: Point): Uint8Array {
    return new Uint8Array(this.bj.packPoint([this.toF(p[0]), this.toF(p[1])]));
  }

  decompress(b: Uint8Array): Point | null {
    const r = this.bj.unpackPoint(b);
    if (!r) return null;
    return [this.fromF(r[0]), this.fromF(r[1])];
  }

  /**
   * Hash a candidate y to a subgroup point: solve x from y on the twisted
   * Edwards curve, multiply by the cofactor, reject identity. Returns null if y
   * is not on the curve, which happens for about half of all candidates.
   */
  pointFromY(y: bigint): Point | null {
    // a x^2 + y^2 = 1 + d x^2 y^2  =>  x^2 = (1 - y^2) / (a - d y^2)
    const A = 168700n;
    const D = 168696n;
    const yy = mod(y);
    const y2 = (yy * yy) % P;
    const num = mod(1n - y2);
    const den = mod(A - (D * y2) % P);
    if (den === 0n) return null;
    const x2 = (num * modInv(den)) % P;
    const x = sqrtMod(x2);
    if (x === null) return null;
    // choose the even x for determinism
    let xb = x;
    if (xb & 1n) xb = P - xb;
    const pt: Point = [xb, mod(y)];
    const sub = this.mulScalar(pt, 8n);
    if (this.isIdentity(sub)) return null;
    return sub;
  }
}

export { bigIntToBytesLE, bytesToBigIntLE };
