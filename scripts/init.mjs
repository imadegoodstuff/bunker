// One-time protocol initialization: config + tree, then a pool per asset.
//   node scripts/init.mjs --keypair keypairs/deployer.json --relayer RELAYER_PUBKEY [--rpc URL] [--guardian PUBKEY] [--tvl-cap-sol 1000]
// The relayer's key (and its token accounts for SPL pools) go into the lookup
// table; without them an SPL send with a memo does not fit in a packet.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { initializeIx, createPoolIx, configPda, treePda, poolPda, TREE_ACCOUNT_LEN, PROGRAM_ID, createLookupTable, staticAddresses } from "../sdk/dist/index.js";

const { values } = parseArgs({
  options: {
    keypair: { type: "string", default: "keypairs/deployer.json" },
    rpc: { type: "string", default: "https://api.devnet.solana.com" },
    guardian: { type: "string" },
    "tvl-cap-sol": { type: "string", default: "1000" },
    program: { type: "string" },
    relayer: { type: "string" },
  },
});
const programId = values.program ? new PublicKey(values.program) : PROGRAM_ID;
const relayerPubkey = values.relayer ? new PublicKey(values.relayer) : undefined;
if (!relayerPubkey) console.warn("warning: no --relayer given; SPL sends with memos will not fit without the relayer's accounts in the table");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(values.keypair, "utf8"))));
const guardian = values.guardian ? new PublicKey(values.guardian) : payer.publicKey;
const conn = new Connection(values.rpc, "confirmed");

console.log("program  ", programId.toBase58());
console.log("payer    ", payer.publicKey.toBase58(), (await conn.getBalance(payer.publicKey)) / 1e9, "SOL");
console.log("guardian ", guardian.toBase58());
console.log("tree size", TREE_ACCOUNT_LEN, "bytes; rent", (await conn.getMinimumBalanceForRentExemption(TREE_ACCOUNT_LEN)) / 1e9, "SOL");

if (!(await conn.getAccountInfo(configPda(programId)))) {
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(initializeIx(payer.publicKey, guardian, programId)), [payer]);
  console.log("initialize ", sig);
} else {
  console.log("config exists", configPda(programId).toBase58(), "tree", treePda(programId).toBase58());
}

const solPool = poolPda(SystemProgram.programId, programId);
if (!(await conn.getAccountInfo(solPool))) {
  const cap = BigInt(Math.round(Number(values["tvl-cap-sol"]) * 1e9));
  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(createPoolIx(payer.publicKey, SystemProgram.programId, cap, undefined, programId)), [payer]);
  console.log("create SOL pool", sig);
} else {
  console.log("SOL pool exists", solPool.toBase58());
}

const table = await createLookupTable(conn, payer, staticAddresses([{ mint: SystemProgram.programId }], programId, relayerPubkey));
console.log("lookup table", table.toBase58(), "→ set LOOKUP_TABLE on the relayer");
process.exit(0);
