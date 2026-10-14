/**
 * scash agents: four model-driven voters for the launchpad fee policy.
 *
 * Each agent is (keypair, model). Once per epoch the service lists the live
 * launches, shows every agent the same public view of each token, asks its model
 * for a vote, and sends `voteIx` from that agent's key. There is no proposer,
 * guardian, or pause anywhere: if a model fails to answer, that agent simply
 * casts no vote this epoch and its previous vote ages out after VOTE_TTL_SLOTS.
 *
 * Every decision (and every failure to decide) is kept in a public log at
 * GET /log so anyone can audit what each agent said and did.
 *
 * The service is also the launchpad's keeper: it harvests each curve's tax to
 * the treasury once enough has accrued, and when a curve graduates (20 SOL) it
 * sends the permissionless `migrate` that turns the curve into a Raydium pool.
 * From then on the agents have nothing to set for that token.
 *
 * The treasury is agent 0's wallet (`treasury.ts`): it keeps the other keys
 * and the relayer fuelled and, at random moments, buys back the scash token
 * and burns it or airdrops it to holders. The owner funds nothing but the
 * first few transactions.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { LAUNCH_PROGRAM_ID, curvePda, decodeCurve, epochOf, harvestIx, migrateIx, policy, raydium, rolled, voteIx, type CurveState } from "@scash/sdk";
import { parseDecision, prompt, shouldSend, type Decision, type TokenView } from "./decide.js";
import { complete, keyEnvFor, parseModelSpec, type ModelSpec } from "./models.js";
import { Orbio } from "./orbio.js";
import { Treasury } from "./treasury.js";
import { existsSync } from "node:fs";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const INDEXER = (process.env.INDEXER_URL ?? "http://localhost:8788").replace(/\/$/, "");
const PROGRAM = new PublicKey(process.env.LAUNCH_PROGRAM_ID ?? LAUNCH_PROGRAM_ID.toBase58());
const PORT = Number(process.env.PORT ?? 8789);
/** how often to look at the chain; votes are only sent when an epoch has changed or a vote is missing */
const TICK_MS = Number(process.env.TICK_MS ?? 60_000);
/** a curve's accrued tax is swept to the treasury once it reaches this (lamports) */
const HARVEST_MIN = BigInt(Math.round(Number(process.env.HARVEST_MIN_SOL ?? 0.02) * 1e9));
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const PERSONAS = [
  "You lean toward protecting the curve's long-term health over short-term revenue.",
  "You lean toward punishing bots and wash trading hard and briefly.",
  "You lean toward low taxes to maximise volume unless you see manipulation.",
  "You lean toward reacting quickly to the most recent trades over long averages.",
];

/** Four vendors through the one Orbio connection, used when AGENT_i_MODEL is not set. */
const DEFAULT_MODELS = ["orbio:openai/gpt-6-luna", "orbio:anthropic/claude-haiku-5.5", "orbio:google/gemini-3.8-flash", "orbio:x-ai/grok-4.7"];

// Sign in with Orbio (server app). The owner connects once at /auth/orbio/start; tokens live on the volume.
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const orbio = process.env.ORBIO_CLIENT_ID && process.env.ORBIO_CLIENT_SECRET
  ? new Orbio({
      clientId: process.env.ORBIO_CLIENT_ID,
      clientSecret: process.env.ORBIO_CLIENT_SECRET,
      redirectUri: process.env.ORBIO_REDIRECT_URI ?? `${PUBLIC_URL}/auth/orbio/callback`,
      tokenPath: process.env.ORBIO_TOKEN_PATH ?? (existsSync("/data") ? "/data/orbio.json" : "./orbio.json"),
    })
  : null;
/** gates /auth/orbio/start so only the owner can (re)connect; the callback itself is protected by `state` */
const CONNECT_SECRET = process.env.ORBIO_CONNECT_SECRET;

interface Agent {
  index: number;
  key: Keypair;
  model: ModelSpec;
  /** a static provider key, or undefined for Orbio through the OAuth connection */
  apiKey?: string;
}

async function keyFor(a: Agent): Promise<string> {
  if (a.apiKey) return a.apiKey;
  if (!orbio) throw new Error("no key for this model");
  return orbio.token();
}

/** AGENT_{i}_KEYPAIR: JSON byte array of the secret key. AGENT_{i}_MODEL: provider:model (default: four vendors via Orbio). */
function loadAgents(): Agent[] {
  const agents: Agent[] = [];
  for (let i = 0; i < policy.AGENTS; i++) {
    const kp = process.env[`AGENT_${i}_KEYPAIR`];
    if (!kp) throw new Error(`AGENT_${i}_KEYPAIR is required (four agents, no fewer)`);
    const spec = process.env[`AGENT_${i}_MODEL`] ?? DEFAULT_MODELS[i];
    const model = parseModelSpec(spec);
    const apiKey = process.env[keyEnvFor(model.provider)];
    if (!apiKey && !(model.provider === "orbio" && orbio)) {
      throw new Error(`${keyEnvFor(model.provider)}${model.provider === "orbio" ? " or ORBIO_CLIENT_ID + ORBIO_CLIENT_SECRET" : ""} is required for agent ${i} (${spec})`);
    }
    agents.push({ index: i, key: Keypair.fromSecretKey(Uint8Array.from(JSON.parse(kp) as number[])), model, apiKey });
  }
  const distinct = new Set(agents.map((a) => a.key.publicKey.toBase58()));
  if (distinct.size !== policy.AGENTS) throw new Error("the four agent keys must be distinct");
  return agents;
}

interface LogEntry {
  at: number;
  slot: string;
  epoch: string;
  agent: number;
  agentKey: string;
  model: string;
  mint: string;
  symbol: string;
  decision?: Decision;
  sent?: string;
  skipped?: string;
  error?: string;
}

const LOG_MAX = 2000;
const log: LogEntry[] = [];
function record(e: LogEntry) {
  log.unshift(e);
  if (log.length > LOG_MAX) log.length = LOG_MAX;
  const what = e.error ? `error: ${e.error}` : e.skipped ? `skipped: ${e.skipped}` : `${e.decision?.feeBps} bps / ${e.decision?.holderBps} bps → ${e.sent} (${e.decision?.reason})`;
  console.log(`[agents] epoch ${e.epoch} agent ${e.agent} ${e.model} ${e.symbol}: ${what}`);
}

const agents = loadAgents();
const conn = new Connection(RPC, "confirmed");
console.log(`[agents] program ${PROGRAM.toBase58()}, indexer ${INDEXER}`);
agents.forEach((a) => console.log(`[agents] agent ${a.index}: ${a.key.publicKey.toBase58()} via ${a.model.provider}:${a.model.model}`));

// The treasury is agent 0. SCASH_MINT turns buybacks on; RELAYER_PUBKEY adds the relayer to the keys it fuels.
const sol = (env: string, dflt: number) => BigInt(Math.round(Number(process.env[env] ?? dflt) * 1e9));
const treasury = new Treasury(conn, agents[0].key, {
  scashMint: process.env.SCASH_MINT ? new PublicKey(process.env.SCASH_MINT) : undefined,
  reserveLamports: sol("TREASURY_RESERVE_SOL", 0.6),
  floatLamports: sol("GAS_FLOAT_SOL", 0.03),
  funded: [...agents.slice(1).map((a) => a.key.publicKey), ...(process.env.RELAYER_PUBKEY ? [new PublicKey(process.env.RELAYER_PUBKEY)] : [])],
  meanMinutes: Number(process.env.BUYBACK_MEAN_MINUTES ?? 240),
  tickMs: TICK_MS,
  jupiterUrl: (process.env.JUPITER_URL ?? "https://lite-api.jup.ag/swap/v1").replace(/\/$/, ""),
  slippageBps: Number(process.env.BUYBACK_SLIPPAGE_BPS ?? 300),
  maxHolders: Number(process.env.AIRDROP_MAX_HOLDERS ?? 120),
}, (e) => record({ at: Date.now(), slot: "", epoch: "", agent: 0, agentKey: agents[0].key.publicKey.toBase58(), model: "treasury", mint: process.env.SCASH_MINT ?? "", symbol: e.kind, ...(e.kind === "error" ? { error: e.detail } : e.kind === "skip" ? { skipped: e.detail } : { decision: { feeBps: 0, holderBps: 0, reason: e.detail }, sent: e.sig }) }));
console.log(`[agents] treasury ${agents[0].key.publicKey.toBase58()}; buybacks ${process.env.SCASH_MINT ? `of ${process.env.SCASH_MINT}` : "off (SCASH_MINT unset)"}`);

interface LaunchRow { mint: string; symbol: string; decimals: number; graduated: number; amm_pool: string | null }
interface TradeRow { side: "buy" | "sell"; sol: string; private: number; slot: number }

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

async function view(row: LaunchRow, curve: CurveState, slot: bigint): Promise<TokenView> {
  const { trades } = await getJson<{ trades: TradeRow[] }>(`${INDEXER}/launches/${row.mint}?limit=500`);
  const epochAgo = Number(slot - policy.EPOCH_SLOTS);
  const dayAgo = Number(slot - 24n * policy.EPOCH_SLOTS);
  const day = trades.filter((t) => t.slot >= dayAgo);
  return {
    mint: row.mint,
    symbol: row.symbol,
    decimals: row.decimals,
    slot,
    epoch: epochOf(slot),
    curve,
    recent: trades.filter((t) => t.slot >= epochAgo).map((t) => ({ side: t.side, sol: BigInt(t.sol), private: t.private === 1, slot: t.slot })),
    dayBuys: day.filter((t) => t.side === "buy").length,
    daySells: day.filter((t) => t.side === "sell").length,
    daySolVolume: day.reduce((s, t) => s + BigInt(t.sol), 0n),
  };
}

async function sendVote(a: Agent, mint: PublicKey, d: Decision): Promise<string> {
  const tx = new Transaction().add(voteIx(a.key.publicKey, mint, d.feeBps, d.holderBps, PROGRAM));
  if (d.reason) tx.add(new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(`scash-agent-${a.index}: ${d.reason}`, "utf8") }));
  return sendAndConfirmTransaction(conn, tx, [a.key], { commitment: "confirmed" });
}

/** The epoch each (agent, mint) last voted in; a vote is attempted at most once per epoch per pair. */
const votedIn = new Map<string, bigint>();
/**
 * Trade count (buys + sells) of each curve when the agents last looked at it.
 * New volume always earns a fresh look. Without it the agents still speak:
 * once when a token first appears (so a new launch is never "no vote yet"),
 * and again whenever an agent's standing vote is about to age out, so a quiet
 * token keeps a live quorum instead of drifting into "no quorum" every four
 * minutes. The cost is one model call per agent per ~3 minutes per live token.
 */
const seenTrades = new Map<string, bigint>();
function hasNewVolume(mint: string, curve: CurveState): boolean {
  const seen = seenTrades.get(mint);
  return seen === undefined || curve.buys + curve.sells > seen;
}
/** an agent's on-chain vote is within one epoch of expiring (or absent) */
function voteGoingStale(curve: CurveState, agent: number, slot: bigint): boolean {
  const v = curve.votes[agent];
  return v.slot === 0n || slot - v.slot >= policy.VOTE_TTL_SLOTS - policy.EPOCH_SLOTS;
}

/**
 * Keeper duty: a graduated curve is moved to its Raydium pool. The instruction
 * is permissionless and deterministic, so the first agent key simply pays the
 * fee for it; anyone else may send the same instruction. Retried every tick
 * until the curve records the pool.
 */
const migrating = new Set<string>();
async function migrate(row: LaunchRow, curve: CurveState, mint: PublicKey, slot: bigint) {
  if (migrating.has(row.mint)) return;
  migrating.add(row.mint);
  const payer = agents[0].key;
  const base: LogEntry = { at: Date.now(), slot: slot.toString(), epoch: epochOf(slot).toString(), agent: 0, agentKey: payer.publicKey.toBase58(), model: "keeper", mint: row.mint, symbol: row.symbol };
  try {
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 900_000 }))
      .add(migrateIx(mint, curve.protocolTreasury, raydium.AMM_CONFIG, PROGRAM));
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    record({ ...base, decision: { feeBps: 0, holderBps: 0, reason: `graduated at ${(Number(curve.realSol) / 1e9).toFixed(2)} SOL → Raydium pool ${raydium.poolState(mint).toBase58()}` }, sent: sig });
  } catch (e) {
    record({ ...base, error: `migrate: ${(e as Error).message}` });
  } finally {
    migrating.delete(row.mint);
  }
}

/** Keeper duty: sweep a curve's accrued tax to the treasury (permissionless; agent 0 pays the fee). */
const harvesting = new Set<string>();
async function harvest(row: LaunchRow, curve: CurveState, mint: PublicKey, slot: bigint) {
  if (harvesting.has(row.mint)) return;
  harvesting.add(row.mint);
  const payer = agents[0].key;
  const base: LogEntry = { at: Date.now(), slot: slot.toString(), epoch: epochOf(slot).toString(), agent: 0, agentKey: payer.publicKey.toBase58(), model: "keeper", mint: row.mint, symbol: row.symbol };
  try {
    const sig = await sendAndConfirmTransaction(conn, new Transaction().add(harvestIx(mint, curve.protocolTreasury, curve.vaultProgram, PROGRAM)), [payer], { commitment: "confirmed" });
    record({ ...base, decision: { feeBps: 0, holderBps: 0, reason: `harvested ${(Number(curve.feesAccrued) / 1e9).toFixed(4)} SOL of tax to the treasury` }, sent: sig });
  } catch (e) {
    record({ ...base, error: `harvest: ${(e as Error).message}` });
  } finally {
    harvesting.delete(row.mint);
  }
}

async function tick() {
  await treasury.tick();
  // graduated-but-unmigrated curves still need the keeper, so only rows the indexer already shows on the AMM are skipped
  const launches = (await getJson<LaunchRow[]>(`${INDEXER}/launches?limit=200`)).filter((l) => !l.amm_pool);
  if (launches.length === 0) return;
  const mints = launches.map((l) => new PublicKey(l.mint));
  const { context, value } = await conn.getMultipleAccountsInfoAndContext(mints.map((m) => curvePda(m, PROGRAM)));
  const slot = BigInt(context.slot);
  const epoch = epochOf(slot);
  for (let i = 0; i < launches.length; i++) {
    const ai = value[i];
    if (!ai) continue;
    const curve = rolled(decodeCurve(new Uint8Array(ai.data)), slot);
    if (curve.graduated) {
      if (!curve.ammPool) void migrate(launches[i], curve, mints[i], slot);
      continue;
    }
    if (curve.feesAccrued >= HARVEST_MIN) void harvest(launches[i], curve, mints[i], slot);
    const fresh = hasNewVolume(launches[i].mint, curve);
    seenTrades.set(launches[i].mint, curve.buys + curve.sells);
    let v: TokenView | undefined;
    for (const a of agents) {
      if (!fresh && !voteGoingStale(curve, a.index, slot)) continue;
      const k = `${a.index}:${launches[i].mint}`;
      if (votedIn.get(k) === epoch) continue;
      votedIn.set(k, epoch);
      const base: LogEntry = { at: Date.now(), slot: slot.toString(), epoch: epoch.toString(), agent: a.index, agentKey: a.key.publicKey.toBase58(), model: `${a.model.provider}:${a.model.model}`, mint: launches[i].mint, symbol: launches[i].symbol };
      try {
        v ??= await view(launches[i], curve, slot);
        const text = await complete(a.model, prompt(v, PERSONAS[a.index]), await keyFor(a));
        const d = parseDecision(text);
        if (!d) {
          record({ ...base, error: `model returned no usable vote: ${text.slice(0, 120)}` });
          continue;
        }
        if (!voteGoingStale(curve, a.index, slot) && !shouldSend(curve.votes[a.index], d, slot)) {
          record({ ...base, decision: d, skipped: "unchanged and still fresh on chain" });
          continue;
        }
        const sig = await sendVote(a, mints[i], d);
        record({ ...base, decision: d, sent: sig });
      } catch (e) {
        record({ ...base, error: (e as Error).message });
      }
    }
  }
}

let lastTick: { at: number; error?: string } = { at: 0 };
async function loop() {
  for (;;) {
    try {
      await tick();
      lastTick = { at: Date.now() };
    } catch (e) {
      lastTick = { at: Date.now(), error: (e as Error).message };
      console.error("[agents] tick failed:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}
void loop();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });
app.get("/live", async () => ({ ok: true }));

// Sign in with Orbio: owner-only start, state-checked callback. No UI anywhere else mentions it.
app.get<{ Querystring: { key?: string } }>("/auth/orbio/start", async (req, reply) => {
  if (!orbio) return reply.code(404).send("Orbio is not configured");
  if (!CONNECT_SECRET || req.query.key !== CONNECT_SECRET) return reply.code(403).send("forbidden");
  return reply.redirect(orbio.startUrl());
});
app.get<{ Querystring: Record<string, string | undefined> }>("/auth/orbio/callback", async (req, reply) => {
  if (!orbio) return reply.code(404).send("Orbio is not configured");
  const r = await orbio.handleCallback(req.query);
  console.log(`[agents] orbio: ${r.message}`);
  return reply.code(r.ok ? 200 : 400).type("text/plain").send(r.message);
});

app.get("/health", async () => ({
  ok: !lastTick.error,
  lastTick,
  orbio: orbio ? (orbio.connected ? "connected" : orbio.disconnectedReason ? "disconnected" : "not connected") : "unused",
  program: PROGRAM.toBase58(),
  agents: agents.map((a) => ({ index: a.index, key: a.key.publicKey.toBase58(), model: `${a.model.provider}:${a.model.model}` })),
  policy: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
}));
/** Public audit log of every decision, newest first. `?mint=` filters to one token. */
app.get<{ Querystring: { mint?: string; limit?: string } }>("/log", async (req) => {
  const limit = Math.min(Number(req.query.limit ?? 200), LOG_MAX);
  return (req.query.mint ? log.filter((e) => e.mint === req.query.mint) : log).slice(0, limit);
});
await app.listen({ port: PORT, host: "0.0.0.0" });
