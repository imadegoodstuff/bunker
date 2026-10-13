// Client for programs/scash_migrator: stage a shield into a new vault, unshield
// from the old vault to the migration PDA, execute. See the program's module
// docs for the trust model.
import { AccountMeta, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { concatBytes } from "./field.js";

export const MIGRATOR_PROGRAM_ID = new PublicKey("42CGrJH6QGjHjH1CK9yQLF44UhrYjN9cQwGqVvrSYz4u");
const enc = new TextEncoder();

/** Staging header size: disc(1) + authority(32) + target(32) + refund(32) + written(4) + len(4). */
export const STAGING_HEADER = 105;
/** Bytes per Write instruction; keeps each staging transaction under the packet limit. */
export const STAGING_CHUNK = 800;

export function migratePda(staging: PublicKey, programId = MIGRATOR_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([enc.encode("migrate"), staging.toBytes()], programId)[0];
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

/**
 * Instructions that stage `payload` (the complete `transact` instruction data
 * for the target vault). The first instruction creates the staging account and
 * must be signed by `staging`; the rest are signed by `authority`.
 */
export function stageInstructions(opts: {
  authority: PublicKey;
  staging: PublicKey;
  target: PublicKey;
  refund: PublicKey;
  payload: Uint8Array;
  rentLamports: number;
  programId?: PublicKey;
}): { create: TransactionInstruction; init: TransactionInstruction; writes: TransactionInstruction[] } {
  const programId = opts.programId ?? MIGRATOR_PROGRAM_ID;
  const space = STAGING_HEADER + opts.payload.length;
  const create = SystemProgram.createAccount({
    fromPubkey: opts.authority,
    newAccountPubkey: opts.staging,
    lamports: opts.rentLamports,
    space,
    programId,
  });
  const keys: AccountMeta[] = [
    { pubkey: opts.staging, isSigner: false, isWritable: true },
    { pubkey: opts.authority, isSigner: true, isWritable: false },
  ];
  const init = new TransactionInstruction({
    programId,
    keys,
    data: Buffer.from(concatBytes(new Uint8Array([0]), opts.target.toBytes(), opts.refund.toBytes(), u32(opts.payload.length))),
  });
  const writes: TransactionInstruction[] = [];
  for (let off = 0; off < opts.payload.length; off += STAGING_CHUNK) {
    const chunk = opts.payload.slice(off, off + STAGING_CHUNK);
    writes.push(new TransactionInstruction({ programId, keys, data: Buffer.from(concatBytes(new Uint8Array([1]), u32(off), chunk)) }));
  }
  return { create, init, writes };
}

/**
 * Execute a staged migration. `targetIx` is the exact instruction that was
 * staged (built with the PDA as payer/depositor/recipient/relayer destination);
 * its account list minus the first (payer) entry is forwarded, and the slots
 * that hold the PDA / the PDA's token account are declared so the program can
 * check them and sign.
 */
export function executeIx(opts: {
  staging: PublicKey;
  refund: PublicKey;
  refundSource?: PublicKey;
  pdaSource?: PublicKey;
  tokenProgram?: PublicKey;
  targetIx: TransactionInstruction;
  programId?: PublicKey;
}): TransactionInstruction {
  const programId = opts.programId ?? MIGRATOR_PROGRAM_ID;
  const pda = migratePda(opts.staging, programId);
  const pdaSource = opts.pdaSource ?? pda;
  const refundSource = opts.refundSource ?? opts.refund;
  const tokenProgram = opts.tokenProgram ?? SystemProgram.programId;
  const target = opts.targetIx.keys.slice(1); // drop payer: the program prepends the PDA
  if (!opts.targetIx.keys[0].pubkey.equals(pda)) throw new Error("staged instruction must have the migration PDA as payer");
  const pdaSlots: number[] = [];
  const sourceSlots: number[] = [];
  target.forEach((k, i) => {
    if (k.pubkey.equals(pda)) pdaSlots.push(i);
    else if (!pdaSource.equals(pda) && k.pubkey.equals(pdaSource)) sourceSlots.push(i);
  });
  const keys: AccountMeta[] = [
    { pubkey: opts.staging, isSigner: false, isWritable: true },
    { pubkey: pda, isSigner: false, isWritable: true },
    { pubkey: pdaSource, isSigner: false, isWritable: true },
    { pubkey: opts.refund, isSigner: false, isWritable: true },
    { pubkey: refundSource, isSigner: false, isWritable: true },
    { pubkey: opts.targetIx.programId, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ...target.map((k) => ({ pubkey: k.pubkey, isSigner: false, isWritable: k.isWritable })),
  ];
  const data = concatBytes(new Uint8Array([2]), new Uint8Array([pdaSlots.length]), Uint8Array.from(pdaSlots), new Uint8Array([sourceSlots.length]), Uint8Array.from(sourceSlots));
  return new TransactionInstruction({ programId, keys, data: Buffer.from(data) });
}
