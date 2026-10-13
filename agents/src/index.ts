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
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { LAUNCH_PROGRAM_ID, curvePda, decodeCurve, epochOf, policy, rolled, voteIx, type CurveState } from "@scash/sdk";
import { parseDecision, prompt, shouldSend, type Decision, type TokenView } from "./decide.js";
import { complete, keyEnvFor, parseModelSpec, type ModelSpec } from "./models.js";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const INDEXER = (process.env.INDEXER_URL ?? "http://localhost:8788").replace(/\/$/, "");
const PROGRAM = new PublicKey(process.env.LAUNCH_PROGRAM_ID ?? LAUNCH_PROGRAM_ID.toBase58());
const PORT = Number(process.env.PORT ?? 8789);
/** how often to look at the chain; votes are only sent when an epoch has changed or a vote is missing */
const TICK_MS = Number(process.env.TICK_MS ?? 60_000);
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const PERSONAS = [
  "You lean toward protecting the treasury's runway and the curve's long-term health.",
  "You lean toward rewarding holders generously whenever trading is orderly.",
  "You lean toward low fees to maximise volume unless you see manipulation.",
  "You lean toward reacting quickly to the most recent trades over long averages.",
];

interface Agent {
  index: number;
  key: Keypair;
  model: ModelSpec;
  apiKey: string;
}

/** AGENT_{i}_KEYPAIR: JSON byte array of the secret key. AGENT_{i}_MODEL: provider:model. The provider's key comes from its own env var. */
function loadAgents(): Agent[] {
  const agents: Agent[] = [];
  for (let i = 0; i < policy.AGENTS; i++) {
    const kp = process.env[`AGENT_${i}_KEYPAIR`];
    const spec = process.env[`AGENT_${i}_MODEL`];
    if (!kp || !spec) throw new Error(`AGENT_${i}_KEYPAIR and AGENT_${i}_MODEL are required (four agents, no fewer)`);
    const model = parseModelSpec(spec);
    const apiKey = process.env[keyEnvFor(model.provider)];
    if (!apiKey) throw new Error(`${keyEnvFor(model.provider)} is required for agent ${i} (${spec})`);
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

interface LaunchRow { mint: string; symbol: string; decimals: number; graduated: number }
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

async function tick() {
  const launches = (await getJson<LaunchRow[]>(`${INDEXER}/launches?limit=200`)).filter((l) => l.graduated === 0);
  if (launches.length === 0) return;
  const mints = launches.map((l) => new PublicKey(l.mint));
  const { context, value } = await conn.getMultipleAccountsInfoAndContext(mints.map((m) => curvePda(m, PROGRAM)));
  const slot = BigInt(context.slot);
  const epoch = epochOf(slot);
  for (let i = 0; i < launches.length; i++) {
    const ai = value[i];
    if (!ai) continue;
    const curve = rolled(decodeCurve(new Uint8Array(ai.data)), slot);
    if (curve.graduated) continue;
    let v: TokenView | undefined;
    for (const a of agents) {
      const k = `${a.index}:${launches[i].mint}`;
      if (votedIn.get(k) === epoch) continue;
      votedIn.set(k, epoch);
      const base: LogEntry = { at: Date.now(), slot: slot.toString(), epoch: epoch.toString(), agent: a.index, agentKey: a.key.publicKey.toBase58(), model: `${a.model.provider}:${a.model.model}`, mint: launches[i].mint, symbol: launches[i].symbol };
      try {
        v ??= await view(launches[i], curve, slot);
        const text = await complete(a.model, prompt(v, PERSONAS[a.index]), a.apiKey);
        const d = parseDecision(text);
        if (!d) {
          record({ ...base, error: `model returned no usable vote: ${text.slice(0, 120)}` });
          continue;
        }
        if (!shouldSend(curve.votes[a.index], d, slot)) {
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
app.get("/health", async () => ({
  ok: !lastTick.error,
  lastTick,
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
