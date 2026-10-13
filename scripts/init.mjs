// One-time protocol initialization: config + tree, a SOL pool, the launchpad, and the relayer's lookup table.
//   node scripts/init.mjs --keypair keypairs/deployer.json --relayer RELAYER_PUBKEY [--rpc URL] [--guardian PUBKEY]
//                         [--tvl-cap-sol 1000] [--treasury PUBKEY] [--agents A,B,C,D] [--lookup-table EXISTING_TABLE] [--no-launchpad]
// --agents: the four fee-policy voter keys (one model each); required to initialise the launchpad, fixed forever once set.
// Every step is idempotent: accounts that already exist are reported and skipped, and an existing
// lookup table (the relayer's LOOKUP_TABLE) is reused when it already covers the static addresses.
// The relayer's key (and its token accounts for SPL pools) go into the lookup table; without them an
// SPL send with a memo does not fit in a packet.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  initializeIx, createPoolIx, configPda, treePda, poolPda, TREE_ACCOUNT_LEN, PROGRAM_ID, createLookupTable, staticAddresses,
  LAUNCH_PROGRAM_ID, launchpadPda, defaultLaunchpadParams, initLaunchpadIx,
} from "../sdk/dist/index.js";

const { values } = parseArgs({
  options: {
    keypair: { type: "string", default: "keypairs/deployer.json" },
    rpc: { type: "string", default: "https://api.mainnet-beta.solana.com" },
    guardian: { type: "string" },
    "tvl-cap-sol": { type: "string", default: "1000" },
    program: { type: "string" },
    "launch-program": { type: "string" },
    relayer: { type: "string" },
    treasury: { type: "string" },
    agents: { type: "string" },
    "lookup-table": { type: "string" },
    "no-launchpad": { type: "boolean", default: false },
  },
});
const programId = values.program ? new PublicKey(values.program) : PROGRAM_ID;
const launchProgramId = values["launch-program"] ? new PublicKey(values["launch-program"]) : LAUNCH_PROGRAM_ID;
const relayerPubkey = values.relayer ? new PublicKey(values.relayer) : undefined;
if (!relayerPubkey) console.warn("warning: no --relayer given; SPL sends with memos will not fit without the relayer's accounts in the table");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(values.keypair, "utf8"))));
const guardian = values.guardian ? new PublicKey(values.guardian) : payer.publicKey;
const treasury = values.treasury ? new PublicKey(values.treasury) : payer.publicKey;
const agents = values.agents ? values.agents.split(",").map((k) => new PublicKey(k.trim())) : [];
const conn = new Connection(values.rpc, "confirmed");

console.log("program  ", programId.toBase58());
console.log("launchpad", launchProgramId.toBase58());
console.log("payer    ", payer.publicKey.toBase58(), (await conn.getBalance(payer.publicKey)) / 1e9, "SOL");
console.log("guardian ", guardian.toBase58());
console.log("treasury ", treasury.toBase58());
console.log("agents   ", agents.map((a) => a.toBase58()).join(" ") || "(none: the launchpad will not be initialised)");
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

if (!values["no-launchpad"]) {
  const pad = launchpadPda(launchProgramId);
  if (!(await conn.getAccountInfo(launchProgramId))) {
    console.log("launch program not deployed on this cluster; skipping launchpad initialisation");
  } else if (!(await conn.getAccountInfo(pad))) {
    if (agents.length !== 4) {
      console.log("launchpad not initialised: pass --agents with exactly four keys");
    } else {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(initLaunchpadIx(payer.publicKey, defaultLaunchpadParams(treasury, agents), programId, launchProgramId)), [payer]);
      console.log("initialise launchpad", sig);
    }
  } else {
    console.log("launchpad exists", pad.toBase58());
  }
}

const wanted = staticAddresses([{ mint: SystemProgram.programId }], programId, relayerPubkey);
let table = values["lookup-table"] ? new PublicKey(values["lookup-table"]) : undefined;
if (table) {
  const existing = await conn.getAddressLookupTable(table);
  const have = new Set((existing.value?.state.addresses ?? []).map((a) => a.toBase58()));
  if (!wanted.every((a) => have.has(a.toBase58()))) {
    console.log("lookup table", table.toBase58(), "does not cover the static addresses; creating a new one");
    table = undefined;
  }
}
if (!table) table = await createLookupTable(conn, payer, wanted);
console.log("lookup table", table.toBase58(), "→ set LOOKUP_TABLE on the relayer");
process.exit(0);
