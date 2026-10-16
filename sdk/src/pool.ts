// Client side of contracts/contracts/ShieldedPool.sol (protocol v2): constants,
// share math, proof encoding and the `transact` / `drain` / `register` call
// arguments, plus typed reads.
import type { PublicClient } from "viem";
import { ShieldedPoolAbi } from "./abi/ShieldedPool.js";
import { extDataArg, type EvmAddress, type ExtData } from "./extdata.js";
import type { Groth16Proof, TransactProof } from "./prover.js";

export { ShieldedPoolAbi };

export const PROTOCOL_VERSION = 2;
/** `ShieldedPool.REVISION`: hidden in-pool asset, chain/pool-bound intents with expiry, batches, governance seam. */
export const PROTOCOL_REVISION = 1;
/** Must equal `ShieldedPool.VIRTUAL_OFFSET`: V virtual shares backed by V units from creation (SPEC §9). */
export const VIRTUAL_OFFSET = 1_000_000n;
/** `ShieldedPool.NATIVE_UNIT`: BNB is accounted in gwei inside the pool. */
export const NATIVE_UNIT = 1_000_000_000n;
/** `ShieldedPool.MAX_DRAIN` / `AUTO_DRAIN`. */
export const MAX_DRAIN = 512;
export const AUTO_DRAIN = 64;

/** Mirror of the contract's `Pool` struct. All amounts in internal units (`unit` wei each). */
export interface PoolState {
  exists: boolean;
  decimals: number;
  unit: bigint;
  totalShares: bigint;
  totalAssets: bigint;
  totalIn: bigint;
  totalOut: bigint;
  tvlCap: bigint;
}

export const EMPTY_POOL: PoolState = { exists: false, decimals: 18, unit: 1n, totalShares: 0n, totalAssets: 0n, totalIn: 0n, totalOut: 0n, tvlCap: 0n };

function virt(p: PoolState): { ts: bigint; ta: bigint } {
  return { ts: p.totalShares + VIRTUAL_OFFSET, ta: p.totalAssets + VIRTUAL_OFFSET };
}
export function sharesForDeposit(p: PoolState, amount: bigint): bigint {
  const { ts, ta } = virt(p);
  return (amount * ts) / ta;
}
export function amountForMint(p: PoolState, shares: bigint): bigint {
  const { ts, ta } = virt(p);
  return (shares * ta + ts - 1n) / ts;
}
export function amountForBurn(p: PoolState, shares: bigint): bigint {
  const { ts, ta } = virt(p);
  return (shares * ta) / ts;
}
export function sharesForWithdraw(p: PoolState, amount: bigint): bigint {
  const { ts, ta } = virt(p);
  return (amount * ts + ta - 1n) / ta;
}

/** wei → internal units (floor) and back. */
export const toUnits = (wei: bigint, unit: bigint) => wei / unit;
export const toWei = (units: bigint, unit: bigint) => units * unit;

/**
 * snarkjs → Solidity verifier argument order. The verifier takes A and C as
 * (x, y) and B as [[x_im, x_re], [y_im, y_re]] — the swap snarkjs itself
 * performs in `exportSolidityCallData`. Nothing is negated.
 */
export function proofArg(p: Groth16Proof) {
  return {
    a: [p.piA[0], p.piA[1]] as const,
    b: [
      [p.piB[0][1], p.piB[0][0]],
      [p.piB[1][1], p.piB[1][0]],
    ] as const,
    c: [p.piC[0], p.piC[1]] as const,
  };
}

/** The contract's `TransactArgs` struct. */
export interface TransactArgs {
  proof: ReturnType<typeof proofArg>;
  /** address(0) for a private send: the asset stays inside the proof */
  token: EvmAddress;
  root: bigint;
  publicAmount: bigint;
  aspRoot: bigint;
  aspProvider: EvmAddress;
  nullifiers: readonly bigint[];
  outCommitments: readonly [bigint, bigint, bigint];
  ext: ReturnType<typeof extDataArg>;
}

export interface TransactCall {
  address: EvmAddress;
  abi: typeof ShieldedPoolAbi;
  functionName: "transact";
  args: readonly [TransactArgs];
  /** wei to attach: `amountForMint(shares) * unit` on a shield, else 0 */
  value: bigint;
}

export interface TransactBatchCall {
  address: EvmAddress;
  abi: typeof ShieldedPoolAbi;
  functionName: "transactBatch";
  args: readonly [readonly TransactArgs[]];
  value: 0n;
}

/** Build the `writeContract` / `simulateContract` request for a transact. */
export function transactCall(
  pool: EvmAddress,
  token: EvmAddress,
  proof: TransactProof,
  root: bigint,
  publicAmount: bigint,
  aspRoot: bigint,
  aspProvider: EvmAddress,
  ext: ExtData,
  value: bigint,
): TransactCall {
  if (proof.outCommitments.length !== 3) throw new Error("three outputs required");
  return {
    address: pool,
    abi: ShieldedPoolAbi,
    functionName: "transact",
    args: [{
      proof: proofArg(proof.proof),
      token: publicAmount === 0n ? ZERO : token,
      root,
      publicAmount,
      aspRoot,
      aspProvider,
      nullifiers: proof.nullifiers,
      outCommitments: [proof.outCommitments[0], proof.outCommitments[1], proof.outCommitments[2]],
      ext: extDataArg(ext),
    }],
    value,
  };
}

const ZERO: EvmAddress = "0x0000000000000000000000000000000000000000";

/** `transactBatch([...])`: several non-shield transacts in one transaction (a relayer landing its queue). */
export function transactBatchCall(pool: EvmAddress, calls: readonly TransactCall[]): TransactBatchCall {
  if (calls.length === 0) throw new Error("empty batch");
  for (const c of calls) {
    if (c.args[0].publicAmount > 0n) throw new Error("a batch cannot contain a shield");
    if (c.value !== 0n) throw new Error("a batch carries no value");
  }
  return { address: pool, abi: ShieldedPoolAbi, functionName: "transactBatch", args: [calls.map((c) => c.args[0])], value: 0n };
}

/** `drain(max)`: move queued commitments into the tree. Anyone may call; relayers do it as a keeper. */
export function drainCall(pool: EvmAddress, max = MAX_DRAIN) {
  return { address: pool, abi: ShieldedPoolAbi, functionName: "drain" as const, args: [max] as const };
}

/** `register(bytes)`: publish (or clear, with empty bytes) the caller's shielded address. */
export function registerCall(pool: EvmAddress, shieldedAddress: Uint8Array) {
  const hex = `0x${Array.from(shieldedAddress, (b) => b.toString(16).padStart(2, "0")).join("")}` as const;
  return { address: pool, abi: ShieldedPoolAbi, functionName: "register" as const, args: [hex] as const };
}

// ---- wire format (what a client posts to the relayer's /relay)

export interface TransactCallJson {
  token: EvmAddress;
  root: string;
  publicAmount: string;
  aspRoot: string;
  aspProvider: EvmAddress;
  nullifiers: string[];
  outCommitments: [string, string, string];
  proof: { a: [string, string]; b: [[string, string], [string, string]]; c: [string, string] };
  ext: {
    recipient: EvmAddress;
    exitTarget: EvmAddress;
    exitData: `0x${string}`;
    ciphertext0: `0x${string}`;
    ciphertext1: `0x${string}`;
    ciphertext2: `0x${string}`;
    outCiphertext: `0x${string}`;
    reshield: { token: EvmAddress; ownerHash: string; rho: string; rcm: string; ciphertext: `0x${string}` };
    validUntil: string;
    complianceData: `0x${string}`;
  };
  value: string;
}

export function transactCallToJson(c: TransactCall): TransactCallJson {
  const { proof, token, root, publicAmount, aspRoot, aspProvider, nullifiers, outCommitments, ext } = c.args[0];
  const s = (x: bigint) => x.toString();
  return {
    token,
    root: s(root),
    publicAmount: s(publicAmount),
    aspRoot: s(aspRoot),
    aspProvider,
    nullifiers: nullifiers.map(s),
    outCommitments: [s(outCommitments[0]), s(outCommitments[1]), s(outCommitments[2])],
    proof: { a: [s(proof.a[0]), s(proof.a[1])], b: [[s(proof.b[0][0]), s(proof.b[0][1])], [s(proof.b[1][0]), s(proof.b[1][1])]], c: [s(proof.c[0]), s(proof.c[1])] },
    ext: { ...ext, reshield: { ...ext.reshield, ownerHash: s(ext.reshield.ownerHash), rho: s(ext.reshield.rho), rcm: s(ext.reshield.rcm) }, validUntil: s(ext.validUntil) },
    value: s(c.value),
  };
}

export function transactCallFromJson(pool: EvmAddress, j: TransactCallJson): TransactCall {
  const b = (x: string) => BigInt(x);
  if (j.nullifiers.length !== 2 && j.nullifiers.length !== 4) throw new Error("2 or 4 nullifiers");
  if (j.outCommitments.length !== 3) throw new Error("3 output commitments");
  const proof = {
    a: [b(j.proof.a[0]), b(j.proof.a[1])] as const,
    b: [[b(j.proof.b[0][0]), b(j.proof.b[0][1])], [b(j.proof.b[1][0]), b(j.proof.b[1][1])]] as const,
    c: [b(j.proof.c[0]), b(j.proof.c[1])] as const,
  };
  const r = j.ext.reshield;
  return {
    address: pool,
    abi: ShieldedPoolAbi,
    functionName: "transact",
    args: [{
      proof,
      token: j.token,
      root: b(j.root),
      publicAmount: b(j.publicAmount),
      aspRoot: b(j.aspRoot),
      aspProvider: j.aspProvider,
      nullifiers: j.nullifiers.map(b),
      outCommitments: [b(j.outCommitments[0]), b(j.outCommitments[1]), b(j.outCommitments[2])],
      ext: {
        recipient: j.ext.recipient, exitTarget: j.ext.exitTarget, exitData: j.ext.exitData,
        ciphertext0: j.ext.ciphertext0, ciphertext1: j.ext.ciphertext1, ciphertext2: j.ext.ciphertext2, outCiphertext: j.ext.outCiphertext,
        reshield: { token: r.token, ownerHash: b(r.ownerHash), rho: b(r.rho), rcm: b(r.rcm), ciphertext: r.ciphertext },
        validUntil: b(j.ext.validUntil ?? "0"),
        complianceData: j.ext.complianceData ?? "0x",
      },
    }],
    value: b(j.value),
  };
}

// ---- reads

export async function readPool(client: PublicClient, pool: EvmAddress, token: EvmAddress): Promise<PoolState> {
  const p = await client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "pools", args: [token] });
  return { exists: p.exists, decimals: Number(p.decimals), unit: p.unit, totalShares: p.totalShares, totalAssets: p.totalAssets, totalIn: p.totalIn, totalOut: p.totalOut, tvlCap: p.tvlCap };
}

export async function readLastRoot(client: PublicClient, pool: EvmAddress): Promise<bigint> {
  return client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "getLastRoot" });
}

export async function readIsKnownRoot(client: PublicClient, pool: EvmAddress, root: bigint): Promise<boolean> {
  return client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "isKnownRoot", args: [root] });
}

/** Leaves in the tree plus the queue (the next transact's first output lands here). */
export async function readNextIndex(client: PublicClient, pool: EvmAddress): Promise<number> {
  return Number(await client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "nextIndex" }));
}

/** Leaves actually in the tree; a note at index >= this is queued and not yet spendable. */
export async function readInsertedIndex(client: PublicClient, pool: EvmAddress): Promise<number> {
  return Number(await client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "insertedIndex" }));
}

export async function readNullifierSpent(client: PublicClient, pool: EvmAddress, nf: bigint): Promise<boolean> {
  return client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "nullifierSpent", args: [nf] });
}

export async function readGovernance(client: PublicClient, pool: EvmAddress): Promise<{ guardian: EvmAddress; governance: EvmAddress; shieldPaused: boolean }> {
  const [guardian, governance, shieldPaused] = await Promise.all([
    client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "guardian" }),
    client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "governance" }),
    client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "shieldPaused" }),
  ]);
  return { guardian, governance, shieldPaused };
}

/** The entrance compliance hook of a token, or the zero address when shields of it are ungated. */
export async function readComplianceHook(client: PublicClient, pool: EvmAddress, token: EvmAddress): Promise<EvmAddress> {
  return client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "complianceHook", args: [token] });
}

/** The 43-byte (or 1227-byte post-quantum) shielded address an EOA published, or null. */
export async function readRegistry(client: PublicClient, pool: EvmAddress, owner: EvmAddress): Promise<Uint8Array | null> {
  const hex = await client.readContract({ address: pool, abi: ShieldedPoolAbi, functionName: "registry", args: [owner] });
  const h = hex.slice(2);
  if (h.length === 0) return null;
  return Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
}
