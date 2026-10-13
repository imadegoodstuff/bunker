import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import { deserializeExtData, PROGRAM_ID as DEFAULT_PROGRAM, decodePool, poolPda, buildV0, fetchLookupTable } from "@scash/sdk";
import { FeePolicy } from "./policy.js";
import { SubmitQueue } from "./queue.js";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? DEFAULT_PROGRAM.toBase58());
const PORT = Number(process.env.PORT ?? 8787);
const signer = loadKeypair();
const policy = new FeePolicy(process.env.FEE_POLICY, BigInt(process.env.MIN_FEE_LAMPORTS ?? "1500000"));
const conn = new Connection(RPC, "confirmed");
const queue = new SubmitQueue(conn, signer, {
  minDelayMs: Number(process.env.MIN_DELAY_MS ?? 5_000),
  maxDelayMs: Number(process.env.MAX_DELAY_MS ?? 90_000),
  cuLimit: Number(process.env.CU_LIMIT ?? 1_400_000),
  cuPriceMicroLamports: Number(process.env.CU_PRICE ?? 0),
  maxAttempts: 4,
});
if (process.env.LOOKUP_TABLE) {
  queue.table = await fetchLookupTable(conn, new PublicKey(process.env.LOOKUP_TABLE));
  console.log(`[relayer] using lookup table ${process.env.LOOKUP_TABLE} (${queue.table.state.addresses.length} addresses)`);
}
queue.start();

function loadKeypair(): Keypair {
  const raw = process.env.RELAYER_KEYPAIR ?? (process.env.RELAYER_KEYPAIR_PATH ? readFileSync(process.env.RELAYER_KEYPAIR_PATH, "utf8") : undefined);
  if (!raw) {
    const k = Keypair.generate();
    console.warn("[relayer] RELAYER_KEYPAIR not set; using ephemeral key", k.publicKey.toBase58());
    return k;
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

interface RelayBody {
  /** base64 of the Transact instruction data (built by the SDK) */
  data: string;
  /** account metas in order */
  keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
}

/** Parse the fields of a Transact instruction we need to enforce policy. */
function parseTransact(data: Uint8Array) {
  if (data[0] !== 2) throw new Error("not a transact instruction");
  let o = 1;
  const dv = () => new DataView(data.buffer, data.byteOffset);
  const proofLen = dv().getUint32(o, true); o += 4 + proofLen;
  o += 1; // root index
  const signedShares = dv().getBigInt64(o, true); o += 8;
  const hasAsp = data[o]; o += 1 + (hasAsp ? 32 : 0);
  const nNf = dv().getUint32(o, true); o += 4 + 32 * nNf;
  const nCm = dv().getUint32(o, true); o += 4 + 32 * nCm;
  const ext = deserializeExtData(data.slice(o));
  return { signedShares, ext, nNf };
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });
await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });

app.get("/info", async () => ({
  relayer: signer.publicKey.toBase58(),
  program: PROGRAM.toBase58(),
  cluster: RPC.includes("devnet") ? "devnet" : RPC.includes("mainnet") ? "mainnet-beta" : "custom",
  fees: policy.list(),
  delay: { minMs: queue.opts.minDelayMs, maxMs: queue.opts.maxDelayMs },
  lookupTable: process.env.LOOKUP_TABLE ?? null,
  queued: queue.size(),
}));

app.get("/health", async () => {
  const bal = await conn.getBalance(signer.publicKey).catch(() => -1);
  return { ok: bal > 0, balanceLamports: bal, queued: queue.size() };
});

app.post<{ Body: RelayBody }>("/relay", async (req, reply) => {
  const body = req.body;
  if (!body?.data || !Array.isArray(body.keys)) return reply.code(400).send({ error: "data and keys required" });
  const data = Uint8Array.from(Buffer.from(body.data, "base64"));
  if (data.length > 1100) return reply.code(400).send({ error: "instruction too large" });
  const keys: AccountMeta[] = body.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: !!k.isSigner, isWritable: !!k.isWritable }));

  // --- structural policy
  let parsed;
  try {
    parsed = parseTransact(data);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  if (keys.length < 14) return reply.code(400).send({ error: "too few accounts" });
  if (!keys[0].pubkey.equals(signer.publicKey)) return reply.code(400).send({ error: "payer must be the relayer", relayer: signer.publicKey.toBase58() });
  // nobody but the relayer may be required to sign
  for (let i = 1; i < keys.length; i++) if (keys[i].isSigner) return reply.code(400).send({ error: "extra signer not allowed (shields are self-paid)" });
  if (parsed.signedShares > 0n) return reply.code(400).send({ error: "shields are not relayed" });
  if (!parsed.ext.relayer.equals(signer.publicKey)) return reply.code(400).send({ error: "ext.relayer must be the relayer" });
  const mint = keys[5].pubkey;
  if (!policy.supports(mint.toBase58())) return reply.code(400).send({ error: "unsupported asset" });
  const relayerDest = keys[11].pubkey;
  const expectedDest = policy.get(mint.toBase58())?.dest;
  if (mint.equals(SystemProgram.programId) ? !relayerDest.equals(signer.publicKey) : expectedDest && !relayerDest.equals(new PublicKey(expectedDest))) {
    return reply.code(400).send({ error: "relayer destination mismatch" });
  }

  // --- fee check (convert shares -> amount using the pool rate)
  let amount = 0n;
  if (parsed.signedShares < 0n) {
    const info = await conn.getAccountInfo(poolPda(mint, PROGRAM));
    if (!info) return reply.code(400).send({ error: "pool not found" });
    const pool = decodePool(new Uint8Array(info.data));
    const shares = -parsed.signedShares;
    amount = pool.totalShares === 0n ? 0n : (shares * pool.totalAssets) / pool.totalShares;
  }
  const required = policy.required(mint.toBase58(), amount);
  if (parsed.ext.relayerFee < required) return reply.code(402).send({ error: "fee too low", required: required.toString() });

  // --- simulate before accepting (catches bad proofs / stale roots / spent notes)
  const ix = new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.from(data) });
  const sim = buildV0(signer.publicKey, [ix], (await conn.getLatestBlockhash()).blockhash, queue.table, { cuLimit: queue.opts.cuLimit });
  sim.sign([signer]);
  if (sim.serialize().length > 1232) return reply.code(400).send({ error: "transaction too large", bytes: sim.serialize().length });
  const res = await conn.simulateTransaction(sim, { sigVerify: false });
  if (res.value.err) {
    return reply.code(422).send({ error: "simulation failed", details: res.value.err, logs: res.value.logs?.slice(-8) });
  }

  const job = queue.enqueue(ix);
  return { id: job.id, releaseAt: job.releaseAt, cu: res.value.unitsConsumed };
});

app.get<{ Params: { id: string } }>("/job/:id", async (req, reply) => {
  const j = queue.get(req.params.id);
  if (!j) return reply.code(404).send({ error: "unknown job" });
  return { id: j.id, status: j.status, signature: j.signature, error: j.error, releaseAt: j.releaseAt };
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[relayer] ${signer.publicKey.toBase58()} on ${RPC} port ${PORT}`);
