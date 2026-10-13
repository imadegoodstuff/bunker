// Address lookup table support. A transact instruction references ~10 accounts
// that never change for a given pool; putting them in a lookup table keeps a
// 2-in/2-out transaction under the 1232-byte packet limit with room for memos.
import {
  AddressLookupTableAccount, AddressLookupTableProgram, ComputeBudgetProgram, Connection, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction, type Signer,
} from "@solana/web3.js";
import { PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, configPda, treePda, poolPda, vaultFor } from "./program.js";

/**
 * Accounts worth putting in the table: protocol singletons, one entry set per
 * pool, and — if a relayer is given — its fee destinations (its own key and
 * its token account per SPL pool). Those are static per deployment and the
 * SPL-token send with a full memo does not fit in a packet without them;
 * see the size test in sdk.test.ts.
 */
export function staticAddresses(
  mints: { mint: PublicKey; tokenProgram?: PublicKey }[],
  programId = PROGRAM_ID,
  relayer?: PublicKey
): PublicKey[] {
  const set = new Map<string, PublicKey>();
  const add = (k: PublicKey) => set.set(k.toBase58(), k);
  [programId, configPda(programId), treePda(programId), SystemProgram.programId, ComputeBudgetProgram.programId,
    TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID].forEach(add);
  if (relayer) add(relayer);
  for (const m of mints) {
    const native = m.mint.equals(SystemProgram.programId);
    const tp = native ? SystemProgram.programId : m.tokenProgram ?? TOKEN_PROGRAM_ID;
    add(m.mint);
    add(poolPda(m.mint, programId));
    add(vaultFor(m.mint, tp, programId));
    if (relayer && !native) add(ataFor(relayer, m.mint, tp));
  }
  return [...set.values()];
}

/** Associated token account address (no on-chain lookup). */
export function ataFor(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/** Create a lookup table owned by `authority` and fill it. Returns the table address. */
export async function createLookupTable(conn: Connection, payer: Signer, addresses: PublicKey[], authority: PublicKey = payer.publicKey): Promise<PublicKey> {
  const slot = await conn.getSlot("finalized");
  const [createIx, table] = AddressLookupTableProgram.createLookupTable({ authority, payer: payer.publicKey, recentSlot: slot });
  const ixs: TransactionInstruction[] = [createIx];
  for (let i = 0; i < addresses.length; i += 20) {
    ixs.push(AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority, payer: payer.publicKey, addresses: addresses.slice(i, i + 20) }));
  }
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer]);
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return table;
}

export async function fetchLookupTable(conn: Connection, table: PublicKey): Promise<AddressLookupTableAccount> {
  const res = await conn.getAddressLookupTable(table);
  if (!res.value) throw new Error(`lookup table ${table.toBase58()} not found`);
  return res.value;
}

/** Build a v0 transaction with a compute budget, optional priority fee and the lookup table. */
export function buildV0(
  payer: PublicKey,
  ixs: TransactionInstruction[],
  recentBlockhash: string,
  table?: AddressLookupTableAccount,
  opts: { cuLimit?: number; cuPriceMicroLamports?: number } = {}
): VersionedTransaction {
  const pre: TransactionInstruction[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit ?? 1_400_000 })];
  if (opts.cuPriceMicroLamports) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.cuPriceMicroLamports }));
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions: [...pre, ...ixs] }).compileToV0Message(table ? [table] : []);
  return new VersionedTransaction(msg);
}
