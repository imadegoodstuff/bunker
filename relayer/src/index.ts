import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { readFileSync } from "node:fs";
import { Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction, type AccountMeta } from "@solana/web3.js";
import {
  deserializeExtData, PROGRAM_ID as DEFAULT_PROGRAM, decodePool, poolPda, buildV0, fetchLookupTable, vaultErrorName,
  LAUNCH_PROGRAM_ID as DEFAULT_LAUNCH, decodeCurve, decodeExitData, lookupTableCovers, EXIT_BUY, EXIT_SELL, curvePda,
} from "@scash/sdk";
import { FeePolicy } from "./policy.js";
import { SubmitQueue } from "./queue.js";
import { PriorityFeeOracle } from "./fees.js";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? DEFAULT_PROGRAM.toBase58());
// The one exit target the relayer will forward to: the launchpad. Set to "" to refuse all exits.
const LAUNCH = process.env.LAUNCH_PROGRAM_ID === "" ? undefined : new PublicKey(process.env.LAUNCH_PROGRAM_ID ?? DEFAULT_LAUNCH.toBase58());
const PORT = Number(process.env.PORT ?? 8787);
const signer = loadKeypair();
const policy = new FeePolicy(process.env.FEE_POLICY, BigInt(process.env.MIN_FEE_LAMPORTS ?? "1500000"));
const conn = new Connection(RPC, "confirmed");
// CU_PRICE is the floor, CU_PRICE_MAX the cap; between them the price follows
// getRecentPrioritizationFees (p75, refreshed every FEE_REFRESH_MS).
const priority = new PriorityFeeOracle(conn, {
  floor: Number(process.env.CU_PRICE ?? 0),
  cap: Number(process.env.CU_PRICE_MAX ?? 20_000),
  refreshMs: Number(process.env.FEE_REFRESH_MS ?? 30_000),
});
await priority.refresh();
priority.start();
const queue = new SubmitQueue(conn, signer, {
  minDelayMs: Number(process.env.MIN_DELAY_MS ?? 5_000),
  maxDelayMs: Number(process.env.MAX_DELAY_MS ?? 90_000),
  cuLimit: Number(process.env.CU_LIMIT ?? 1_400_000),
  cuPriceMicroLamports: priority.opts.floor,
  cuPrice: () => priority.current(),
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

/**
 * What one relayed transact costs the relayer in lamports: nullifier rent +
 * signature + priority fee. The fee check at /relay prices the priority fee
 * at the *cap*, not the current reading, because submission happens up to
 * MAX_DELAY_MS later and the price may have moved: a fee that clears the cap
 * is sufficient whatever the market does inside the window.
 */
const COST_MARGIN_BPS = Number(process.env.COST_MARGIN_BPS ?? 2_000); // 20 % over cost by default
let rentPerNullifier: bigint | undefined;
async function relayCostLamports(nNullifiers: number, cuPrice = priority.opts.cap): Promise<bigint> {
  rentPerNullifier ??= BigInt(await conn.getMinimumBalanceForRentExemption(1));
  const signature = 5_000n;
  const priorityLamports = (BigInt(cuPrice) * BigInt(queue.opts.cuLimit)) / 1_000_000n;
  return rentPerNullifier * BigInt(nNullifiers) + signature + priorityLamports;
}
{
  const c2 = await relayCostLamports(2), c4 = await relayCostLamports(4);
  console.log(`[relayer] cost per relayed transact at CU price cap ${priority.opts.cap}: 2-in ${c2} lamports, 4-in ${c4} lamports; SOL fee floor = cost + ${COST_MARGIN_BPS} bps; current CU price ${priority.current()}`);
  for (const f of policy.list()) {
    if (f.mint !== SystemProgram.programId.toBase58()) console.log(`[relayer] ${f.mint}: min ${f.min} base units — make sure this exceeds ~${c4} lamports at market rate`);
  }
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
  const nNf = dv().getUint32(o, true); o += 4;
  const nullifiers: string[] = [];
  for (let i = 0; i < nNf; i++, o += 32) nullifiers.push(Buffer.from(data.subarray(o, o + 32)).toString("hex"));
  const nCm = dv().getUint32(o, true); o += 4 + 32 * nCm;
  const ext = deserializeExtData(data.slice(o));
  return { signedShares, ext, nNf, nullifiers };
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });
await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });

app.get("/info", async () => ({
  commit: process.env.GIT_SHA ?? "unknown",
  relayer: signer.publicKey.toBase58(),
  program: PROGRAM.toBase58(),
  cluster: RPC.includes("mainnet") ? "mainnet-beta" : "custom",
  // For SOL, advertise the effective minimum (policy or 4-input cost floor,
  // whichever is higher) so clients never build a fee the relayer refuses.
  fees: await Promise.all(policy.list().map(async (f) => {
    if (f.mint !== SystemProgram.programId.toBase58()) return f;
    const cost = await relayCostLamports(4);
    const floor = cost + (cost * BigInt(COST_MARGIN_BPS)) / 10_000n;
    return { ...f, min: (floor > BigInt(f.min) ? floor : BigInt(f.min)).toString(), costLamports: cost.toString() };
  })),
  delay: { minMs: queue.opts.minDelayMs, maxMs: queue.opts.maxDelayMs },
  /** what the relayer will attach at submission; the fee floor above is priced at `cap` */
  priorityFee: priority.info(),
  cuLimit: queue.opts.cuLimit,
  lookupTable: process.env.LOOKUP_TABLE ?? null,
  /** exit target accepted for relayed private buys/sells; sells pay the SOL floor as an exit-data tip */
  launchProgram: LAUNCH?.toBase58() ?? null,
  queued: queue.size(),
}));

app.get("/health", async () => {
  const bal = await conn.getBalance(signer.publicKey).catch(() => -1);
  // Runway in relayed transactions at the worst-case (4-input, cap-priced) cost; an operator alarm, not a user-facing number.
  const worst = await relayCostLamports(4).catch(() => 0n);
  const runway = worst > 0n && bal > 0 ? Number(BigInt(bal) / worst) : 0;
  return { ok: bal > 0 && runway >= 10, balanceLamports: bal, worstCaseCostLamports: worst.toString(), runwayTransacts: runway, queued: queue.size(), priorityFee: priority.info() };
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
  if (parsed.signedShares > 0n) return reply.code(400).send({ error: "shields are not relayed" });
  if (!parsed.ext.relayer.equals(signer.publicKey)) return reply.code(400).send({ error: "ext.relayer must be the relayer" });
  const mint = keys[5].pubkey;

  // --- exit target: none, or the launchpad (a private buy or sell on a curve)
  // Exit accounts follow the nullifier PDAs; the launch program's `payer` slot
  // (index 7) is the relayer, which is why it may appear as a signer there.
  const exitStart = 14 + parsed.nNf;
  let launch: { kind: number; tip: bigint; tables: Awaited<ReturnType<typeof fetchLookupTable>>[] } | undefined;
  if (!parsed.ext.exitTarget.equals(SystemProgram.programId)) {
    if (!LAUNCH || !parsed.ext.exitTarget.equals(LAUNCH)) return reply.code(400).send({ error: "unsupported exit target" });
    if (keys.length !== exitStart + 13) return reply.code(400).send({ error: "launch exit needs exactly 13 trailing accounts" });
    let ed;
    try { ed = decodeExitData(parsed.ext.exitData); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    if (ed.kind !== EXIT_BUY && ed.kind !== EXIT_SELL) return reply.code(400).send({ error: "unknown exit kind" });
    if (!keys[exitStart + 7].pubkey.equals(signer.publicKey)) return reply.code(400).send({ error: "exit payer must be the relayer" });
    if (!keys[exitStart + 12].pubkey.equals(LAUNCH)) return reply.code(400).send({ error: "exit accounts must end with the launch program" });
    if (ed.kind === EXIT_SELL && mint.equals(SystemProgram.programId)) return reply.code(400).send({ error: "a sell spends the token, not SOL" });
    if (ed.kind === EXIT_BUY && !mint.equals(SystemProgram.programId)) return reply.code(400).send({ error: "a buy spends SOL" });
    // the token's frozen lookup table, recorded on its curve (verified, not trusted)
    const curveKey = keys[exitStart].pubkey;
    const tokenMint = ed.kind === EXIT_BUY ? keys[exitStart + 1].pubkey : mint;
    if (!curveKey.equals(curvePda(tokenMint, LAUNCH))) return reply.code(400).send({ error: "curve/mint mismatch" });
    const curveInfo = await conn.getAccountInfo(curveKey);
    if (!curveInfo) return reply.code(400).send({ error: "curve not found" });
    const curve = decodeCurve(new Uint8Array(curveInfo.data));
    const tables = [];
    try {
      const t = await fetchLookupTable(conn, curve.lookupTable);
      if (lookupTableCovers(t.state.addresses, tokenMint, PROGRAM, LAUNCH)) tables.push(t);
    } catch { /* fall back to the relayer's table alone; the size check below decides */ }
    launch = { kind: ed.kind, tip: ed.relayerTip, tables };
  }
  // nobody but the relayer may be required to sign
  for (let i = 1; i < keys.length; i++) {
    if (keys[i].isSigner && !(launch && i === exitStart + 7)) return reply.code(400).send({ error: "extra signer not allowed (shields are self-paid)" });
  }

  const sell = launch?.kind === EXIT_SELL;
  if (!sell && !policy.supports(mint.toBase58())) return reply.code(400).send({ error: "unsupported asset" });
  const relayerDest = keys[11].pubkey;
  const expectedDest = policy.get(mint.toBase58())?.dest;
  if (!sell && (mint.equals(SystemProgram.programId) ? !relayerDest.equals(signer.publicKey) : expectedDest && !relayerDest.equals(new PublicKey(expectedDest)))) {
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
  // The relayer is `payer`: it funds one rent-exempt 1-byte PDA per nullifier
  // (dummy inputs included, so a 2-in tx costs 2 rents, a 4-in tx 4), the
  // signature fee and any priority fee. For SOL the fee must cover that cost
  // plus a margin; a policy minimum below cost would make every relayed
  // transaction a loss, and a zero-value "no-op" transact can never pay it.
  // For SPL assets the fee is in tokens, so the operator must price FEE_POLICY
  // above the SOL cost themselves (we log the cost at startup).
  const costLamports = await relayCostLamports(parsed.nNf);
  const solFloor = costLamports + (costLamports * BigInt(COST_MARGIN_BPS)) / 10_000n;
  if (sell) {
    // A private sell's vault fee would be in the token being sold, which this
    // relayer does not price; the launch program pays the relayer a SOL tip
    // out of the proceeds instead (exit data), and that tip must clear the floor.
    const solMin = policy.required(SystemProgram.programId.toBase58(), 0n);
    const required = solMin > solFloor ? solMin : solFloor;
    if (launch!.tip < required) {
      return reply.code(402).send({ error: "relayer tip too low", required: required.toString(), relayerCostLamports: costLamports.toString() });
    }
  } else {
    let required = policy.required(mint.toBase58(), amount);
    if (mint.equals(SystemProgram.programId) && solFloor > required) required = solFloor;
    if (parsed.ext.relayerFee < required) {
      return reply.code(402).send({ error: "fee too low", required: required.toString(), relayerCostLamports: costLamports.toString() });
    }
  }

  // --- idempotency: same nullifier ⇒ same payment ⇒ same job
  const live = queue.findByNullifiers(parsed.nullifiers);
  if (live) {
    return reply.code(200).send({ id: live.id, releaseAt: live.releaseAt, duplicate: true, status: live.status, signature: live.signature });
  }

  // --- simulate before accepting (catches bad proofs / stale roots / spent notes)
  const ix = new TransactionInstruction({ programId: PROGRAM, keys, data: Buffer.from(data) });
  const sim = buildV0(signer.publicKey, [ix], (await conn.getLatestBlockhash()).blockhash, queue.tablesFor({ tables: launch?.tables }), { cuLimit: queue.opts.cuLimit });
  sim.sign([signer]);
  if (sim.serialize().length > 1232) return reply.code(400).send({ error: "transaction too large", bytes: sim.serialize().length });
  const res = await conn.simulateTransaction(sim, { sigVerify: false });
  if (res.value.err) {
    // `vaultError` is the contract with clients (SDK `RelayRejection`); `details` is raw RPC output for humans.
    const vaultError = vaultErrorName(res.value.err);
    return reply.code(422).send({ error: vaultError ? `simulation failed: ${vaultError}` : "simulation failed", vaultError, details: res.value.err, logs: res.value.logs?.slice(-8) });
  }

  const job = queue.enqueue(ix, parsed.nullifiers, launch?.tables);
  return { id: job.id, releaseAt: job.releaseAt, cu: res.value.unitsConsumed };
});

app.get<{ Params: { id: string } }>("/job/:id", async (req, reply) => {
  const j = queue.get(req.params.id);
  if (!j) return reply.code(404).send({ error: "unknown job" });
  return { id: j.id, status: j.status, signature: j.signature, error: j.error, releaseAt: j.releaseAt };
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[relayer] ${signer.publicKey.toBase58()} on ${RPC} port ${PORT}`);
