// Builds circuit inputs and produces Groth16 proofs with snarkjs. Works in
// Node and in the browser (pass artifact URLs or bytes).
import { groth16 } from "snarkjs";
import { TREE_DEPTH, Q, encodePublicAmount, bigIntToBytesBE, concatBytes, fromHex } from "./field.js";
import type { MerklePath } from "./merkle.js";
import type { Note, SpendableNote } from "./note.js";
import { noteCommitment, nullifier } from "./note.js";
import type { SpendingKey, FullViewingKey } from "./keys.js";

export type CircuitName = "transact2x2" | "transact4x2";

export interface CircuitArtifacts {
  wasm: string | Uint8Array;
  zkey: string | Uint8Array;
}

export interface SpendInput {
  note: SpendableNote;
  path: MerklePath;
  aspPath?: MerklePath;
}

export interface TransactParams {
  spend: SpendingKey;
  fvk: FullViewingKey;
  root: bigint;
  asset: bigint;
  publicAmount: bigint; // signed: + shield, - unshield, 0 private send
  extDataHash: bigint;
  aspRoot?: bigint;
  inputs: SpendInput[]; // length 2 or 4 (pad with dummies)
  outputs: Note[]; // length 2
  dummyPath: MerklePath;
  /** An address owned by the prover (g_d, pk_d); dummy spends are formed on it. */
  self: { gd: [bigint, bigint]; pkd: [bigint, bigint] };
}

export interface Groth16Proof {
  piA: [bigint, bigint];
  piB: [[bigint, bigint], [bigint, bigint]];
  piC: [bigint, bigint];
}

export interface TransactProof {
  circuit: CircuitName;
  proof: Groth16Proof;
  publicSignals: bigint[];
  /** 256 bytes: A(64) || B(128) || C(64), big-endian, as the on-chain verifier expects. */
  proofBytes: Uint8Array;
  nullifiers: bigint[];
  outCommitments: bigint[];
}

export function circuitFor(nIns: number): CircuitName {
  if (nIns <= 2) return "transact2x2";
  if (nIns <= 4) return "transact4x2";
  throw new Error("too many inputs");
}

export async function buildWitnessInput(p: TransactParams) {
  const nIns = p.inputs.length <= 2 ? 2 : 4;
  if (p.inputs.length > nIns) throw new Error("too many inputs");
  if (p.outputs.length !== 2) throw new Error("exactly two outputs required");

  const nullifiers: bigint[] = [];
  const inValue: bigint[] = [];
  const inGd: bigint[][] = [];
  const inPkd: bigint[][] = [];
  const inRho: bigint[] = [];
  const inRcm: bigint[] = [];
  const inPathElements: bigint[][] = [];
  const inPathIndices: number[][] = [];
  const inAspPathElements: bigint[][] = [];
  const inAspPathIndices: number[][] = [];

  for (let i = 0; i < nIns; i++) {
    const inp = p.inputs[i];
    if (inp) {
      const pos = BigInt(inp.note.position);
      nullifiers.push(await nullifier(p.fvk.nk, inp.note.rho, pos));
      inValue.push(inp.note.value);
      inGd.push([inp.note.gd[0], inp.note.gd[1]]);
      inPkd.push([inp.note.pkd[0], inp.note.pkd[1]]);
      inRho.push(inp.note.rho);
      inRcm.push(inp.note.rcm);
      inPathElements.push(inp.path.elements);
      inPathIndices.push(inp.path.indices);
      const asp = inp.aspPath ?? p.dummyPath;
      inAspPathElements.push(asp.elements);
      inAspPathIndices.push(asp.indices);
    } else {
      // dummy spend: value 0, fresh randomness, zero path, nullifier still unique
      const rho = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(31)), (b) => b.toString(16).padStart(2, "0")).join(""));
      const rcm = BigInt("0x" + Array.from(crypto.getRandomValues(new Uint8Array(31)), (b) => b.toString(16).padStart(2, "0")).join(""));
      nullifiers.push(await nullifier(p.fvk.nk, rho, 0n));
      inValue.push(0n);
      inGd.push([p.self.gd[0], p.self.gd[1]]);
      inPkd.push([p.self.pkd[0], p.self.pkd[1]]);
      inRho.push(rho);
      inRcm.push(rcm);
      inPathElements.push(p.dummyPath.elements);
      inPathIndices.push(p.dummyPath.indices);
      inAspPathElements.push(p.dummyPath.elements);
      inAspPathIndices.push(p.dummyPath.indices);
    }
  }

  const outCommitments: bigint[] = [];
  for (const o of p.outputs) outCommitments.push(await noteCommitment(o));

  const input = {
    root: p.root.toString(),
    publicAmount: encodePublicAmount(p.publicAmount).toString(),
    asset: p.asset.toString(),
    extDataHash: p.extDataHash.toString(),
    aspRoot: (p.aspRoot ?? 0n).toString(),
    nullifiers: nullifiers.map(String),
    outCommitments: outCommitments.map(String),
    ask: p.spend.ask.toString(),
    nsk: p.spend.nsk.toString(),
    inValue: inValue.map(String),
    inGd: inGd.map((g) => g.map(String)),
    inPkd: inPkd.map((g) => g.map(String)),
    inRho: inRho.map(String),
    inRcm: inRcm.map(String),
    inPathElements: inPathElements.map((e) => e.map(String)),
    inPathIndices: inPathIndices.map((e) => e.map(String)),
    inAspPathElements: inAspPathElements.map((e) => e.map(String)),
    inAspPathIndices: inAspPathIndices.map((e) => e.map(String)),
    outValue: p.outputs.map((o) => o.value.toString()),
    outGd: p.outputs.map((o) => [o.gd[0].toString(), o.gd[1].toString()]),
    outPkd: p.outputs.map((o) => [o.pkd[0].toString(), o.pkd[1].toString()]),
    outRho: p.outputs.map((o) => o.rho.toString()),
    outRcm: p.outputs.map((o) => o.rcm.toString()),
  };

  return { input, nullifiers, outCommitments, circuit: circuitFor(nIns) };
}

export async function prove(p: TransactParams, artifacts: Record<CircuitName, CircuitArtifacts>): Promise<TransactProof> {
  const { input, nullifiers, outCommitments, circuit } = await buildWitnessInput(p);
  const art = artifacts[circuit];
  const { proof, publicSignals } = await groth16.fullProve(input, art.wasm as any, art.zkey as any);
  const g: Groth16Proof = {
    piA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    piB: [
      [BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1])],
      [BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])],
    ],
    piC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
  };
  return {
    circuit,
    proof: g,
    publicSignals: publicSignals.map((s) => BigInt(s)),
    proofBytes: encodeProof(g),
    nullifiers,
    outCommitments,
  };
}

/**
 * Serialize for groth16-solana: A as (x,y) big-endian, B as (x_im, x_re, y_im, y_re)?
 * groth16-solana expects B in the same order snarkjs prints it: [[x0,x1],[y0,y1]] with
 * each coordinate big-endian, and it negates A internally. We therefore negate A here
 * so the verifier's pairing equation holds (Light Protocol convention).
 */
export function encodeProof(p: Groth16Proof): Uint8Array {
  // negation is in the base field Q (point coordinates), not the scalar field P
  const negAy = p.piA[1] === 0n ? 0n : Q - p.piA[1];
  return concatBytes(
    bigIntToBytesBE(p.piA[0]),
    bigIntToBytesBE(negAy),
    bigIntToBytesBE(p.piB[0][1]),
    bigIntToBytesBE(p.piB[0][0]),
    bigIntToBytesBE(p.piB[1][1]),
    bigIntToBytesBE(p.piB[1][0]),
    bigIntToBytesBE(p.piC[0]),
    bigIntToBytesBE(p.piC[1])
  );
}

export function publicSignalsToBytes(signals: bigint[]): Uint8Array[] {
  return signals.map((s) => bigIntToBytesBE(s));
}

export { fromHex };
