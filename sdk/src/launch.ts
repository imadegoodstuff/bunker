// Client for programs/scash_launch: a bonding curve traded from inside the
// shielded pool. Layouts mirror programs/scash_launch/src/{state,processor}.rs.
import { AddressLookupTableProgram, Keypair, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bigIntToBytesLE, concatBytes } from "./field.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, PROGRAM_ID as VAULT_PROGRAM_ID, associatedTokenAddress, configPda, poolPda, vaultFor } from "./program.js";

export const LAUNCH_PROGRAM_ID = new PublicKey("BqPGKmEpvrSiMwrzh2zS2XT9rAS8k1FsjTz2uD5XSYE");
const enc = new TextEncoder();
const dec = new TextDecoder();

export function launchpadPda(programId = LAUNCH_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("launchpad")], programId)[0];
}
export function curvePda(mint: PublicKey, programId = LAUNCH_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("curve"), mint.toBytes()], programId)[0];
}
export function intakePda(mint: PublicKey, programId = LAUNCH_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("intake"), mint.toBytes()], programId)[0];
}
export function curveTokenVault(mint: PublicKey, programId = LAUNCH_PROGRAM_ID): PublicKey {
  return associatedTokenAddress(curvePda(mint, programId), mint, TOKEN_2022_PROGRAM_ID);
}
export function intakeAta(mint: PublicKey, programId = LAUNCH_PROGRAM_ID): PublicKey {
  return associatedTokenAddress(intakePda(mint, programId), mint, TOKEN_2022_PROGRAM_ID);
}
/** Where a private buy parks its tokens: the claim key's own associated token account. */
export function claimAta(claimKey: PublicKey, mint: PublicKey): PublicKey {
  return associatedTokenAddress(claimKey, mint, TOKEN_2022_PROGRAM_ID);
}

/**
 * The claim key is a throwaway ed25519 key the buyer derives from their
 * shielded seed and a per-trade nonce. The curve funds it (tokens in its ATA,
 * lamports for its own fees), and it then signs an ordinary vault shield. It
 * appears on-chain twice — in the buy's exit data and as the shield's payer —
 * and nowhere else, so it links the two halves of one trade and nothing more.
 * Deterministic, so a seed backup recovers unclaimed trades.
 */
export function claimKeypair(seed: Uint8Array, nonce: bigint): Keypair {
  return Keypair.fromSeed(sha256(concatBytes(enc.encode("scash-claim-v1"), seed, bigIntToBytesLE(nonce, 8))));
}

// ---- parameters

export interface LaunchpadParams {
  protocolTreasury: PublicKey;
  tradeFeeBps: number;
  holderShareBps: number;
  virtualSol: bigint;
  virtualToken: bigint;
  curveSupply: bigint;
  totalSupply: bigint;
  graduationLamports: bigint;
  decimals: number;
}

/** 1 % fee, half of it donated to holders; 1e9 supply at 6 decimals, ~79 % on the curve; graduation at 85 SOL. */
export function defaultLaunchpadParams(protocolTreasury: PublicKey): LaunchpadParams {
  return {
    protocolTreasury,
    tradeFeeBps: 100,
    holderShareBps: 5_000,
    virtualSol: 30_000_000_000n,
    virtualToken: 1_073_000_000_000_000n,
    curveSupply: 793_100_000_000_000n,
    totalSupply: 1_000_000_000_000_000n,
    graduationLamports: 85_000_000_000n,
    decimals: 6,
  };
}

// ---- account decoding

export interface CurveState {
  bump: number;
  intakeBump: number;
  mint: PublicKey;
  tokenVault: PublicKey;
  virtualSol: bigint;
  virtualToken: bigint;
  realSol: bigint;
  realToken: bigint;
  feesAccrued: bigint;
  graduated: boolean;
  createdSlot: bigint;
  totalSupply: bigint;
  curveSupply: bigint;
  tradeFeeBps: number;
  holderShareBps: number;
  graduationLamports: bigint;
  protocolTreasury: PublicKey;
  vaultProgram: PublicKey;
  buys: bigint;
  sells: bigint;
  solVolume: bigint;
  /** frozen per-token address lookup table (hint; verify with `lookupTableCovers`) */
  lookupTable: PublicKey;
}

function readU64(d: Uint8Array, off: number): bigint {
  let x = 0n;
  for (let i = 7; i >= 0; i--) x = (x << 8n) | BigInt(d[off + i]);
  return x;
}
function readU16(d: Uint8Array, off: number): number {
  return d[off] | (d[off + 1] << 8);
}

export const CURVE_LEN = 264;

export function decodeCurve(d: Uint8Array): CurveState {
  if (d[0] !== 2 || d.length < CURVE_LEN) throw new Error("not a curve account");
  let o = 1;
  const bump = d[o++];
  const intakeBump = d[o++];
  const mint = new PublicKey(d.slice(o, o + 32)); o += 32;
  const tokenVault = new PublicKey(d.slice(o, o + 32)); o += 32;
  const u64 = () => { const v = readU64(d, o); o += 8; return v; };
  const virtualSol = u64(), virtualToken = u64(), realSol = u64(), realToken = u64(), feesAccrued = u64();
  const graduated = d[o++] !== 0;
  const createdSlot = u64(), totalSupply = u64(), curveSupply = u64();
  const tradeFeeBps = readU16(d, o); o += 2;
  const holderShareBps = readU16(d, o); o += 2;
  const graduationLamports = u64();
  const protocolTreasury = new PublicKey(d.slice(o, o + 32)); o += 32;
  const vaultProgram = new PublicKey(d.slice(o, o + 32)); o += 32;
  const buys = u64(), sells = u64(), solVolume = u64();
  const lookupTable = new PublicKey(d.slice(o, o + 32)); o += 32;
  return { bump, intakeBump, mint, tokenVault, virtualSol, virtualToken, realSol, realToken, feesAccrued, graduated, createdSlot, totalSupply, curveSupply, tradeFeeBps, holderShareBps, graduationLamports, protocolTreasury, vaultProgram, buys, sells, solVolume, lookupTable };
}

export interface LaunchpadState extends LaunchpadParams {
  bump: number;
  vaultProgram: PublicKey;
}
export function decodeLaunchpad(d: Uint8Array): LaunchpadState {
  if (d[0] !== 1) throw new Error("not a launchpad account");
  let o = 1;
  const bump = d[o++];
  const vaultProgram = new PublicKey(d.slice(o, o + 32)); o += 32;
  const protocolTreasury = new PublicKey(d.slice(o, o + 32)); o += 32;
  const tradeFeeBps = readU16(d, o); o += 2;
  const holderShareBps = readU16(d, o); o += 2;
  const u64 = () => { const v = readU64(d, o); o += 8; return v; };
  const virtualSol = u64(), virtualToken = u64(), curveSupply = u64(), totalSupply = u64(), graduationLamports = u64();
  const decimals = d[o];
  return { bump, vaultProgram, protocolTreasury, tradeFeeBps, holderShareBps, virtualSol, virtualToken, curveSupply, totalSupply, graduationLamports, decimals };
}

/** Name / symbol / uri from a Token-2022 mint that carries the TokenMetadata extension (type 19). */
export function decodeTokenMetadata(mint: Uint8Array): { name: string; symbol: string; uri: string } | undefined {
  if (mint.length <= 166 || mint[165] !== 1) return undefined;
  let off = 166;
  while (off + 4 <= mint.length) {
    const ty = mint[off] | (mint[off + 1] << 8);
    const len = mint[off + 2] | (mint[off + 3] << 8);
    if (ty === 0) break;
    if (ty === 19) {
      let o = off + 4 + 64; // update authority + mint
      const str = () => { const n = new DataView(mint.buffer, mint.byteOffset + o).getUint32(0, true); o += 4; const s = dec.decode(mint.slice(o, o + n)); o += n; return s; };
      return { name: str(), symbol: str(), uri: str() };
    }
    off += 4 + len;
  }
  return undefined;
}

// ---- curve math (mirrors curve.rs: k from current reserves, rounding for the curve)

export interface Reserves { virtualSol: bigint; realSol: bigint; virtualToken: bigint; realToken: bigint }

const divCeil = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function curveBuy(r: Reserves, solIn: bigint): { out: bigint; virtualToken: bigint } {
  if (solIn <= 0n) throw new Error("nothing");
  const x = r.virtualSol + r.realSol, y = r.virtualToken, k = x * y;
  const y2 = divCeil(k, x + solIn);
  const out = y - y2;
  if (out <= 0n) throw new Error("nothing");
  if (out > r.realToken) throw new Error("sold out");
  return { out, virtualToken: y2 };
}
export function curveSell(r: Reserves, tokenIn: bigint): { out: bigint; virtualToken: bigint } {
  if (tokenIn <= 0n) throw new Error("nothing");
  const x = r.virtualSol + r.realSol, y = r.virtualToken, k = x * y;
  const y2 = y + tokenIn;
  const out = x - divCeil(k, y2);
  if (out <= 0n) throw new Error("nothing");
  if (out > r.realSol) throw new Error("insufficient reserve");
  return { out, virtualToken: y2 };
}
export function quoteBuyExactOut(r: Reserves, tokenOut: bigint): bigint {
  if (tokenOut <= 0n || tokenOut > r.realToken) throw new Error("sold out");
  const x = r.virtualSol + r.realSol, y = r.virtualToken, k = x * y;
  return divCeil(k, y - tokenOut) - x;
}
export const feeOf = (amount: bigint, bps: number) => (amount * BigInt(bps)) / 10_000n;
/** Spot price in lamports per whole token (10^decimals base units). */
export function spotPrice(r: Reserves, decimals: number): number {
  return (Number(r.virtualSol + r.realSol) / Number(r.virtualToken)) * 10 ** decimals;
}

// ---- exit data / accounts for a private buy or sell

export const EXIT_BUY = 0;
export const EXIT_SELL = 1;

/**
 * `claimBudget`: lamports parked at the claim key beyond the rents its shield needs (its own transaction fee).
 * `relayerTip`: lamports paid from the SOL leg to the exit call's payer — the relayer. A relayed *sell* has
 * to pay its relayer this way, since the vault's own fee would be denominated in the token being sold.
 */
export const EXIT_DATA_LEN = 1 + 32 + 8 + 4 + 4;
const U32_MAX = 0xffff_ffffn;
/** Layout: kind u8 ‖ claim_key 32 ‖ min_out u64 ‖ claim_budget u32 ‖ relayer_tip u32 (lamports; both < 4.3 SOL). */
export function exitData(kind: 0 | 1, claimKey: PublicKey, claimBudget: bigint, minOut: bigint, relayerTip = 0n): Uint8Array {
  if (claimBudget > U32_MAX || relayerTip > U32_MAX) throw new Error("claim budget and relayer tip are u32 lamports");
  return concatBytes(new Uint8Array([kind]), claimKey.toBytes(), bigIntToBytesLE(minOut, 8), bigIntToBytesLE(claimBudget, 4), bigIntToBytesLE(relayerTip, 4));
}
export function decodeExitData(d: Uint8Array): { kind: number; claimKey: PublicKey; claimBudget: bigint; minOut: bigint; relayerTip: bigint } {
  if (d.length !== EXIT_DATA_LEN) throw new Error("bad exit data length");
  const le = (o: number, n: number) => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };
  return { kind: d[0], claimKey: new PublicKey(d.subarray(1, 33)), minOut: le(33, 8), claimBudget: le(41, 4), relayerTip: le(45, 4) };
}

/** Accounts the vault forwards to the launch program after the nullifier PDAs. */
export function exitAccounts(kind: 0 | 1, mint: PublicKey, claimKey: PublicKey, payer: PublicKey, programId = LAUNCH_PROGRAM_ID): AccountMeta[] {
  return [
    { pubkey: curvePda(mint, programId), isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: curveTokenVault(mint, programId), isSigner: false, isWritable: true },
    { pubkey: intakePda(mint, programId), isSigner: false, isWritable: true },
    { pubkey: intakeAta(mint, programId), isSigner: false, isWritable: true },
    { pubkey: claimKey, isSigner: false, isWritable: true },
    { pubkey: kind === EXIT_BUY ? claimAta(claimKey, mint) : claimKey, isSigner: false, isWritable: true },
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ];
}

/**
 * The per-token lookup table's contents: everything a relayed private trade of
 * this token references besides the vault's own static accounts (which live in
 * the relayer's table). Created, extended and frozen in the launch transaction;
 * `Curve.lookupTable` records its address.
 */
export function launchStaticAddresses(mint: PublicKey, vaultProgram = VAULT_PROGRAM_ID, programId = LAUNCH_PROGRAM_ID): PublicKey[] {
  return [
    programId, launchpadPda(programId), curvePda(mint, programId), curveTokenVault(mint, programId), intakePda(mint, programId), intakeAta(mint, programId),
    SYSVAR_INSTRUCTIONS_PUBKEY, mint, poolPda(mint, vaultProgram), vaultFor(mint, TOKEN_2022_PROGRAM_ID, vaultProgram),
  ];
}
/** Checks a table found via `Curve.lookupTable` really holds `launchStaticAddresses(mint)` (clients never trust the hint blindly). */
export function lookupTableCovers(addresses: PublicKey[], mint: PublicKey, vaultProgram = VAULT_PROGRAM_ID, programId = LAUNCH_PROGRAM_ID): boolean {
  const have = new Set(addresses.map((a) => a.toBase58()));
  return launchStaticAddresses(mint, vaultProgram, programId).every((a) => have.has(a.toBase58()));
}
/**
 * The three address-lookup-table instructions that precede `launchIx` in a
 * launch transaction: create (authority = payer), extend with the token's
 * statics, freeze (no authority remains, so nobody can ever close or alter it).
 */
export function launchLookupTableIxs(payer: PublicKey, mint: PublicKey, recentSlot: number, vaultProgram = VAULT_PROGRAM_ID, programId = LAUNCH_PROGRAM_ID): { table: PublicKey; ixs: TransactionInstruction[] } {
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority: payer, payer, recentSlot });
  const extendIx = AddressLookupTableProgram.extendLookupTable({ payer, authority: payer, lookupTable: table, addresses: launchStaticAddresses(mint, vaultProgram, programId) });
  const freezeIx = AddressLookupTableProgram.freezeLookupTable({ authority: payer, lookupTable: table });
  return { table, ixs: [createIx, extendIx, freezeIx] };
}

/** Rents the exit handler reserves out of a buy for the later claim (must match processor.rs). */
export interface ClaimRents { claimRent: bigint; nullifierRent: bigint; tokenAccountRent: bigint }
export async function fetchClaimRents(conn: { getMinimumBalanceForRentExemption(n: number): Promise<number> }): Promise<ClaimRents> {
  const [c, n, t] = await Promise.all([conn.getMinimumBalanceForRentExemption(0), conn.getMinimumBalanceForRentExemption(1), conn.getMinimumBalanceForRentExemption(165)]);
  return { claimRent: BigInt(c), nullifierRent: BigInt(n), tokenAccountRent: BigInt(t) };
}
export function buyReserve(rents: ClaimRents, claimBudget: bigint, relayerTip = 0n, claimExists = false, claimAtaExists = false): bigint {
  return (claimExists ? 0n : rents.claimRent) + 2n * rents.nullifierRent + claimBudget + (claimAtaExists ? 0n : rents.tokenAccountRent) + relayerTip;
}
/** Tokens a private buy of `amountIn` lamports (what the vault delivers after the relayer fee) will park at the claim key. */
export function quotePrivateBuy(curve: CurveState, amountIn: bigint, rents: ClaimRents, claimBudget: bigint, relayerTip = 0n): { out: bigint; net: bigint; fee: bigint; reserve: bigint } {
  const reserve = buyReserve(rents, claimBudget, relayerTip);
  if (amountIn <= reserve) throw new Error("amount too small to cover claim rents and budget");
  const gross = amountIn - reserve;
  const fee = feeOf(gross, curve.tradeFeeBps);
  const net = gross - fee;
  return { out: curveBuy(curve, net).out, net, fee, reserve };
}
/** Lamports a private sell of `tokenIn` parks at the claim key, after the curve fee and the relayer tip. */
export function quotePrivateSell(curve: CurveState, tokenIn: bigint, relayerTip = 0n): { out: bigint; gross: bigint; fee: bigint } {
  const { out: gross } = curveSell(curve, tokenIn);
  const fee = feeOf(gross, curve.tradeFeeBps);
  if (gross - fee <= relayerTip) throw new Error("sale does not cover the relayer tip");
  return { out: gross - fee - relayerTip, gross, fee };
}

// ---- instructions

const u16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
const u64 = (n: bigint) => bigIntToBytesLE(n, 8);
const str = (s: string) => { const b = enc.encode(s); return concatBytes(bigIntToBytesLE(BigInt(b.length), 4), b); };

export function initLaunchpadIx(payer: PublicKey, p: LaunchpadParams, vaultProgram = VAULT_PROGRAM_ID, programId = LAUNCH_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: launchpadPda(programId), isSigner: false, isWritable: true },
      { pubkey: vaultProgram, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(
      new Uint8Array([0]), p.protocolTreasury.toBytes(), u16(p.tradeFeeBps), u16(p.holderShareBps),
      u64(p.virtualSol), u64(p.virtualToken), u64(p.curveSupply), u64(p.totalSupply), u64(p.graduationLamports), new Uint8Array([p.decimals]),
    )),
  });
}

export function launchIx(payer: PublicKey, mint: PublicKey, meta: { name: string; symbol: string; uri: string }, lookupTable: PublicKey, vaultProgram = VAULT_PROGRAM_ID, programId = LAUNCH_PROGRAM_ID): TransactionInstruction {
  const curve = curvePda(mint, programId);
  const intake = intakePda(mint, programId);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: launchpadPda(programId), isSigner: false, isWritable: false },
      { pubkey: curve, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(curve, mint, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: intake, isSigner: false, isWritable: true },
      { pubkey: associatedTokenAddress(intake, mint, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: configPda(vaultProgram), isSigner: false, isWritable: false },
      { pubkey: poolPda(mint, vaultProgram), isSigner: false, isWritable: true },
      { pubkey: vaultFor(mint, TOKEN_2022_PROGRAM_ID, vaultProgram), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: vaultProgram, isSigner: false, isWritable: false },
      { pubkey: lookupTable, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(new Uint8Array([1]), str(meta.name), str(meta.symbol), str(meta.uri))),
  });
}

/**
 * The claim is an ordinary vault shield signed by the claim key; these are the
 * `buildTransact` account options for it. The claim key is payer, depositor,
 * relayer and relayer destination; `depositorSource` is its ATA for a token
 * claim or the key itself for SOL.
 */
export function claimShieldAccounts(claimKey: PublicKey, mint: PublicKey) {
  const native = mint.equals(SystemProgram.programId);
  return {
    payer: claimKey,
    depositor: claimKey,
    depositorSource: native ? claimKey : claimAta(claimKey, mint),
    relayer: claimKey,
    relayerDest: claimKey,
    relayerFee: 0n,
    tokenProgram: native ? undefined : TOKEN_2022_PROGRAM_ID,
  };
}

/** Token-2022 CloseAccount(9): after the claim's shield, the empty ATA's rent goes to `dest`. */
export function closeTokenAccountIx(account: PublicKey, dest: PublicKey, owner: PublicKey, tokenProgram = TOKEN_2022_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(new Uint8Array([9])),
  });
}

export function harvestIx(mint: PublicKey, protocolTreasury: PublicKey, vaultProgram = VAULT_PROGRAM_ID, programId = LAUNCH_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: curvePda(mint, programId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curveTokenVault(mint, programId), isSigner: false, isWritable: true },
      { pubkey: protocolTreasury, isSigner: false, isWritable: true },
      { pubkey: vaultProgram, isSigner: false, isWritable: false },
      { pubkey: poolPda(mint, vaultProgram), isSigner: false, isWritable: true },
      { pubkey: vaultFor(mint, TOKEN_2022_PROGRAM_ID, vaultProgram), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(new Uint8Array([3])),
  });
}

export function graduateIx(mint: PublicKey, programId = LAUNCH_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({ programId, keys: [{ pubkey: curvePda(mint, programId), isSigner: false, isWritable: true }], data: Buffer.from(new Uint8Array([4])) });
}

export function publicBuyIx(buyer: PublicKey, mint: PublicKey, lamports: bigint, minOut: bigint, programId = LAUNCH_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: curvePda(mint, programId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curveTokenVault(mint, programId), isSigner: false, isWritable: true },
      { pubkey: buyer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(buyer, mint, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(new Uint8Array([5]), u64(lamports), u64(minOut))),
  });
}

export function publicSellIx(seller: PublicKey, mint: PublicKey, tokens: bigint, minOut: bigint, programId = LAUNCH_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: curvePda(mint, programId), isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: curveTokenVault(mint, programId), isSigner: false, isWritable: true },
      { pubkey: seller, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(seller, mint, TOKEN_2022_PROGRAM_ID), isSigner: false, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(concatBytes(new Uint8Array([6]), u64(tokens), u64(minOut))),
  });
}

/** Mirrors `LaunchError` in programs/scash_launch/src/lib.rs, in declaration order. */
export const LAUNCH_ERRORS = [
  "InvalidInstruction", "BadAccount", "AlreadyInitialized", "BadPda", "AccountMismatch", "Overflow", "Slippage", "SoldOut",
  "InsufficientReserve", "AmountTooSmall", "NotGraduated", "NotFromVault", "Nothing", "StringTooLong", "BadParams", "BadClaimAccount",
] as const;
