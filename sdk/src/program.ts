// Instruction builders mirroring programs/scash_vault. Layouts follow
// crates/scash-core/src/lib.rs (borsh enum, u32 length prefixes).
import { PublicKey, SystemProgram, TransactionInstruction, SYSVAR_RENT_PUBKEY, type AccountMeta } from "@solana/web3.js";
import { bigIntToBytesBE, bigIntToBytesLE, concatBytes } from "./field.js";
import { serializeExtData, type ExtData } from "./extdata.js";
import type { TransactProof } from "./prover.js";

export const PROGRAM_ID = new PublicKey("A827Zi2VyPGQrPrQsZMr66hbxp7AaG2NdBYkV8Cj2yoJ");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

export const TREE_ACCOUNT_LEN = 8 + 8 + 8 + 26 * 32 + 128 * 32 + 27 * 32;

const enc = new TextEncoder();

export function configPda(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("config")], programId)[0];
}
export function treePda(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("tree")], programId)[0];
}
export function poolPda(mint: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("pool"), mint.toBytes()], programId)[0];
}
export function nativeVaultPda(programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("vault"), SystemProgram.programId.toBytes()], programId)[0];
}
export function nullifierPda(nf: bigint, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("nf"), bigIntToBytesBE(nf)], programId)[0];
}
export function aspPda(provider: PublicKey, programId = PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("asp"), provider.toBytes()], programId)[0];
}
export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}
export function vaultFor(mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID, programId = PROGRAM_ID): PublicKey {
  if (mint.equals(SystemProgram.programId)) return nativeVaultPda(programId);
  return associatedTokenAddress(poolPda(mint, programId), mint, tokenProgram);
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}
function u64(n: bigint): Uint8Array {
  return bigIntToBytesLE(n, 8);
}
function vec(b: Uint8Array): Uint8Array {
  return concatBytes(u32(b.length), b);
}

// enum VaultInstruction discriminants
const IX_INITIALIZE = 0;
const IX_CREATE_POOL = 1;
const IX_TRANSACT = 2;
const IX_DONATE = 3;
const IX_UPDATE_ASP_ROOT = 4;
const IX_SET_SHIELD_PAUSED = 5;
const IX_LOWER_TVL_CAP = 6;

export function initializeIx(payer: PublicKey, guardian: PublicKey, programId = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
      { pubkey: treePda(programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(new Uint8Array([IX_INITIALIZE]), guardian.toBytes())),
  });
}

export function createPoolIx(payer: PublicKey, mint: PublicKey, tvlCap: bigint, tokenProgram = TOKEN_PROGRAM_ID, programId = PROGRAM_ID): TransactionInstruction {
  const native = mint.equals(SystemProgram.programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: poolPda(mint, programId), isSigner: false, isWritable: true },
      { pubkey: vaultFor(mint, tokenProgram, programId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: native ? SystemProgram.programId : tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(new Uint8Array([IX_CREATE_POOL]), u64(tvlCap))),
  });
}

export interface TransactAccounts {
  payer: PublicKey; // relayer (or the user for a shield)
  mint: PublicKey; // SystemProgram.programId for SOL
  tokenProgram?: PublicKey;
  depositor: PublicKey; // signer when shielding; otherwise any (use payer)
  depositorSource: PublicKey; // depositor's token account, or depositor for SOL
  recipient: PublicKey;
  relayerDest: PublicKey; // relayer's token account, or relayer for SOL
  aspProvider?: PublicKey;
  exitTarget?: PublicKey;
  exitAccounts?: AccountMeta[];
}

export function transactIx(
  acc: TransactAccounts,
  proof: TransactProof,
  root: bigint,
  publicAmountFe: bigint,
  aspRoot: bigint,
  ext: ExtData,
  programId = PROGRAM_ID
): TransactionInstruction {
  const native = acc.mint.equals(SystemProgram.programId);
  const tokenProgram = native ? SystemProgram.programId : acc.tokenProgram ?? TOKEN_PROGRAM_ID;
  const shield = publicAmountFe > 0n && publicAmountFe < 1n << 64n;
  const keys: AccountMeta[] = [
    { pubkey: acc.payer, isSigner: true, isWritable: true },
    { pubkey: configPda(programId), isSigner: false, isWritable: false },
    { pubkey: treePda(programId), isSigner: false, isWritable: true },
    { pubkey: poolPda(acc.mint, programId), isSigner: false, isWritable: true },
    { pubkey: vaultFor(acc.mint, tokenProgram, programId), isSigner: false, isWritable: true },
    { pubkey: acc.mint, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: acc.depositor, isSigner: shield, isWritable: shield },
    { pubkey: acc.depositorSource, isSigner: false, isWritable: shield },
    { pubkey: acc.recipient, isSigner: false, isWritable: true },
    { pubkey: acc.relayerDest, isSigner: false, isWritable: true },
    { pubkey: acc.aspProvider ? aspPda(acc.aspProvider, programId) : programId, isSigner: false, isWritable: false },
    { pubkey: acc.exitTarget ?? SystemProgram.programId, isSigner: false, isWritable: false },
    ...proof.nullifiers.map((nf) => ({ pubkey: nullifierPda(nf, programId), isSigner: false, isWritable: true })),
    ...(acc.exitAccounts ?? []),
  ];

  const data = concatBytes(
    new Uint8Array([IX_TRANSACT]),
    vec(proof.proofBytes),
    bigIntToBytesBE(root),
    bigIntToBytesBE(publicAmountFe),
    bigIntToBytesBE(aspRoot),
    u32(proof.nullifiers.length),
    ...proof.nullifiers.map((n) => bigIntToBytesBE(n)),
    u32(proof.outCommitments.length),
    ...proof.outCommitments.map((c) => bigIntToBytesBE(c)),
    serializeExtData(ext)
  );
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}

export function donateIx(donor: PublicKey, donorSource: PublicKey, mint: PublicKey, amount: bigint, tokenProgram = TOKEN_PROGRAM_ID, programId = PROGRAM_ID): TransactionInstruction {
  const native = mint.equals(SystemProgram.programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: donor, isSigner: true, isWritable: true },
      { pubkey: donorSource, isSigner: false, isWritable: true },
      { pubkey: poolPda(mint, programId), isSigner: false, isWritable: true },
      { pubkey: vaultFor(mint, tokenProgram, programId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: native ? SystemProgram.programId : tokenProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(new Uint8Array([IX_DONATE]), u64(amount))),
  });
}

export function updateAspRootIx(provider: PublicKey, root: bigint, programId = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: provider, isSigner: true, isWritable: true },
      { pubkey: aspPda(provider, programId), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(new Uint8Array([IX_UPDATE_ASP_ROOT]), bigIntToBytesBE(root))),
  });
}

export function setShieldPausedIx(guardian: PublicKey, paused: boolean, programId = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: guardian, isSigner: true, isWritable: false },
      { pubkey: configPda(programId), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(new Uint8Array([IX_SET_SHIELD_PAUSED, paused ? 1 : 0])),
  });
}

export function lowerTvlCapIx(guardian: PublicKey, mint: PublicKey, cap: bigint, programId = PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: guardian, isSigner: true, isWritable: false },
      { pubkey: configPda(programId), isSigner: false, isWritable: false },
      { pubkey: poolPda(mint, programId), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(concatBytes(new Uint8Array([IX_LOWER_TVL_CAP]), u64(cap))),
  });
}

// ---- account decoding (read side)

export interface PoolState {
  decimals: number;
  isNative: boolean;
  mint: PublicKey;
  tokenProgram: PublicKey;
  vault: PublicKey;
  totalShares: bigint;
  totalAssets: bigint;
  totalIn: bigint;
  totalOut: bigint;
  tvlCap: bigint;
}

function readU64(d: Uint8Array, off: number): bigint {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(d[off + i]);
  return x;
}

export function decodePool(d: Uint8Array): PoolState {
  if (d[0] !== 3) throw new Error("not a pool account");
  return {
    decimals: d[2],
    isNative: d[3] !== 0,
    mint: new PublicKey(d.slice(8, 40)),
    tokenProgram: new PublicKey(d.slice(40, 72)),
    vault: new PublicKey(d.slice(72, 104)),
    totalShares: readU64(d, 104),
    totalAssets: readU64(d, 112),
    totalIn: readU64(d, 120),
    totalOut: readU64(d, 128),
    tvlCap: readU64(d, 136),
  };
}

export interface TreeState {
  nextIndex: bigint;
  rootIndex: bigint;
  roots: bigint[];
  currentRoot: bigint;
}

export function decodeTree(d: Uint8Array): TreeState {
  if (d[0] !== 2) throw new Error("not a tree account");
  const nextIndex = readU64(d, 8);
  const rootIndex = readU64(d, 16);
  const offRoots = 24 + 26 * 32;
  const roots: bigint[] = [];
  for (let i = 0; i < 128; i++) {
    let x = 0n;
    for (let k = 0; k < 32; k++) x = (x << 8n) | BigInt(d[offRoots + i * 32 + k]);
    roots.push(x);
  }
  return { nextIndex, rootIndex, roots, currentRoot: roots[Number(rootIndex) % 128] };
}

/** Shares <-> amount using the pool's current rate, matching on-chain rounding. */
export function sharesForDeposit(p: PoolState, amount: bigint): bigint {
  if (p.totalShares === 0n || p.totalAssets === 0n) return amount;
  return (amount * p.totalShares) / p.totalAssets;
}
export function amountForMint(p: PoolState, shares: bigint): bigint {
  if (p.totalShares === 0n || p.totalAssets === 0n) return shares;
  const num = shares * p.totalAssets;
  return (num + p.totalShares - 1n) / p.totalShares;
}
export function amountForBurn(p: PoolState, shares: bigint): bigint {
  if (p.totalShares === 0n) return 0n;
  return (shares * p.totalAssets) / p.totalShares;
}
export function sharesForWithdraw(p: PoolState, amount: bigint): bigint {
  if (p.totalShares === 0n || p.totalAssets === 0n) return amount;
  const num = amount * p.totalShares;
  return (num + p.totalAssets - 1n) / p.totalAssets;
}

export { SYSVAR_RENT_PUBKEY };
