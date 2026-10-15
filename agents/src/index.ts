/**
 * BUNKER agents: four model-driven voters for the launchpad fee policy.
 *
 * Each agent is (key, model). Once per epoch the service lists the live
 * launches, shows every agent the same public view of each token, asks its model
 * for a vote, and sends `vote` from that agent's key. There is no proposer,
 * guardian, or pause anywhere: if a model fails to answer, that agent simply
 * casts no vote this epoch and its previous vote ages out after VOTE_TTL_BLOCKS.
 *
 * Every decision (and every failure to decide) is kept in a public log at
 * GET /log so anyone can audit what each agent said and did.
 *
 * The service is also the launchpad's keeper: it harvests each curve's tax to
 * the treasury once enough has accrued, and when a curve graduates it sends
 * the permissionless `migrate` that turns the curve into a PancakeSwap pair.
 * From then on the agents have nothing to set for that token.
 *
 * The treasury is agent 0's wallet (`treasury.ts`): it keeps the other keys
 * and the relayer fuelled and, at random moments, buys back the BUNKER token
 * and burns it or airdrops it to holders. The owner funds nothing but the
 * first few transactions.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, getAddress, stringToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc, bscTestnet, hardhat } from "viem/chains";
import { epochOf, harvestCall, migrateCall, policy, readCurve, readParams, rolled, voteCall, type CurveState, type EvmAddress } from "@bunker/sdk";
import { parseDecision, prompt, shouldSend, type Decision, type TokenView } from "./decide.js";
import { complete, keyEnvFor, parseModelSpec, type ModelSpec } from "./models.js";
import { Orbio } from "./orbio.js";
import { Treasury } from "./treasury.js";

const RPC = process.env.RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 56);
const INDEXER = (process.env.INDEXER_URL ?? "http://localhost:8788").replace(/\/$/, "");
const deployments = loadDeployments(CHAIN_ID);
const LAUNCHPAD = getAddress(process.env.LAUNCHPAD_ADDRESS ?? deployments?.launchpad ?? fail("LAUNCHPAD_ADDRESS"));
const POOL = getAddress(process.env.POOL_ADDRESS ?? deployments?.pool ?? fail("POOL_ADDRESS"));
const ROUTER = getAddress(process.env.PANCAKE_ROUTER ?? deployments?.router ?? "0x10ED43C718714eb63d5aA57B78B54704E256024E");
const WBNB = getAddress(process.env.WBNB ?? (CHAIN_ID === 97 ? "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" : "0xbb4CdB9CBd36B01bD1cBaEbF2De08d9173bc095c"));
const PORT = Number(process.env.PORT ?? 8789);
/** how often to look at the chain; votes are only sent when an epoch has changed or a vote is missing */
const TICK_MS = Number(process.env.TICK_MS ?? 60_000);
/** a curve's accrued tax is swept to the treasury once it reaches this (wei) */
const HARVEST_MIN = bnb(process.env.HARVEST_MIN_BNB ?? "0.01");
const PERSONAS = [
  "You lean toward protecting the curve's long-term health over short-term revenue.",
  "You lean toward punishing bots and wash trading hard and briefly.",
  "You lean toward low taxes to maximise volume unless you see manipulation.",
  "You lean toward reacting quickly to the most recent trades over long averages.",
];

function fail(name: string): never {
  throw new Error(`${name} not set and no deployments file for chain ${CHAIN_ID}`);
}
function loadDeployments(chainId: number): { pool?: string; launchpad?: string; router?: string } | undefined {
  const p = process.env.DEPLOYMENTS ?? `contracts/deployments/${chainId}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}
function bnb(s: string): bigint {
  return BigInt(Math.round(Number(s) * 1e9)) * 10n ** 9n;
}

/** Four vendors through the one Orbio connection, used when AGENT_i_MODEL is not set. */
const DEFAULT_MODELS = ["orbio:openai/gpt-6-luna", "orbio:anthropic/claude-haiku-5.5", "orbio:google/gemini-3.8-flash", "orbio:x-ai/grok-4.7"];
/**
 * Same vendor, older models, tried in order when the gateway says the
 * preferred one is not being served right now. An agent is still one vendor's
 * judgement; it just does not fall silent because one model id is down.
 */
const FALLBACK_MODELS: Record<string, string[]> = {
  openai: ["openai/gpt-5.5", "openai/gpt-5.4-mini", "openai/gpt-4.1-mini"],
  anthropic: ["anthropic/claude-sonnet-4.6", "anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"],
  google: ["google/gemini-3.7-flash", "google/gemini-3.6-flash", "google/gemini-3.5-flash"],
  "x-ai": ["x-ai/grok-4.6", "x-ai/grok-4.5"],
};
const NOT_SERVED = /model_not_available|No provider is currently serving|model not found|does not exist/i;

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

const chain = CHAIN_ID === 56 ? bsc : CHAIN_ID === 97 ? bscTestnet : CHAIN_ID === 31337 ? hardhat : defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const publicClient = createPublicClient({ chain, transport: http(RPC) });
type Wallet = ReturnType<typeof walletFor>;
const walletFor = (key: Hex) => createWalletClient({ account: privateKeyToAccount(key), chain, transport: http(RPC) });

interface Agent {
  index: number;
  wallet: Wallet;
  address: EvmAddress;
  model: ModelSpec;
  /** a static provider key, or undefined for Orbio through the OAuth connection */
  apiKey?: string;
  /** the model id that last answered (the preferred one, or a same-vendor fallback) */
  active?: string;
}

async function keyFor(a: Agent): Promise<string> {
  if (a.apiKey) return a.apiKey;
  if (!orbio) throw new Error("no key for this model");
  return orbio.token();
}

/** Ask the agent's model; on "not served" fall back through the same vendor's older models and remember which one answered. */
async function ask(a: Agent, text: string): Promise<{ text: string; model: string }> {
  const vendor = a.model.model.split("/")[0];
  const chain = [a.active ?? a.model.model, a.model.model, ...(a.model.provider === "orbio" ? FALLBACK_MODELS[vendor] ?? [] : [])].filter((m, i, arr) => arr.indexOf(m) === i);
  let lastErr: Error | undefined;
  for (const model of chain) {
    try {
      const out = await complete({ ...a.model, model }, text, await keyFor(a));
      if (a.active !== model) console.log(`[agents] agent ${a.index} answered by ${model}`);
      a.active = model;
      return { text: out, model };
    } catch (e) {
      lastErr = e as Error;
      if (!NOT_SERVED.test(lastErr.message)) throw e;
    }
  }
  throw lastErr ?? new Error("no model answered");
}

/** AGENT_{i}_KEY: hex private key. AGENT_{i}_MODEL: provider:model (default: four vendors via Orbio). */
function loadAgents(): Agent[] {
  const agents: Agent[] = [];
  for (let i = 0; i < policy.AGENTS; i++) {
    const raw = process.env[`AGENT_${i}_KEY`];
    if (!raw) throw new Error(`AGENT_${i}_KEY is required (four agents, no fewer)`);
    const spec = process.env[`AGENT_${i}_MODEL`] ?? DEFAULT_MODELS[i];
    const model = parseModelSpec(spec);
    const apiKey = process.env[keyEnvFor(model.provider)];
    if (!apiKey && !(model.provider === "orbio" && orbio)) {
      throw new Error(`${keyEnvFor(model.provider)}${model.provider === "orbio" ? " or ORBIO_CLIENT_ID + ORBIO_CLIENT_SECRET" : ""} is required for agent ${i} (${spec})`);
    }
    const wallet = walletFor((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
    agents.push({ index: i, wallet, address: wallet.account.address, model, apiKey });
  }
  if (new Set(agents.map((a) => a.address)).size !== policy.AGENTS) throw new Error("the four agent keys must be distinct");
  return agents;
}

interface LogEntry {
  at: number;
  block: string;
  epoch: string;
  agent: number;
  agentKey: string;
  model: string;
  token: string;
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
  const what = e.error ? `error: ${e.error}` : e.skipped ? `skipped: ${e.skipped}` : `${e.decision?.feeBps} bps → ${e.sent} (${e.decision?.reason})`;
  console.log(`[agents] epoch ${e.epoch} agent ${e.agent} ${e.model} ${e.symbol}: ${what}`);
}

const agents = loadAgents();
const params = await readParams(publicClient, LAUNCHPAD);
console.log(`[agents] launchpad ${LAUNCHPAD}, indexer ${INDEXER}, treasury on-chain ${params.treasury}`);
agents.forEach((a) => console.log(`[agents] agent ${a.index}: ${a.address} via ${a.model.provider}:${a.model.model}`));
for (const a of agents) {
  if (!params.agents.map((x) => x.toLowerCase()).includes(a.address.toLowerCase())) console.warn(`[agents] WARNING: agent ${a.index} ${a.address} is not one of the launchpad's agents; its votes will revert`);
}
if (params.treasury.toLowerCase() !== agents[0].address.toLowerCase()) console.warn(`[agents] WARNING: the launchpad's treasury ${params.treasury} is not agent 0; buybacks will have nothing to spend`);

// The treasury is agent 0. BUNKER_TOKEN turns buybacks on; RELAYER_ADDRESS adds the relayer to the keys it fuels.
const treasury = new Treasury(publicClient, agents[0].wallet, {
  token: process.env.BUNKER_TOKEN ? getAddress(process.env.BUNKER_TOKEN) : undefined,
  tokenStartBlock: BigInt(process.env.BUNKER_TOKEN_START_BLOCK ?? 0),
  router: ROUTER,
  wbnb: WBNB,
  reserveWei: bnb(process.env.TREASURY_RESERVE_BNB ?? "0.05"),
  floatWei: bnb(process.env.GAS_FLOAT_BNB ?? "0.01"),
  funded: [...agents.slice(1).map((a) => a.address), ...(process.env.RELAYER_ADDRESS ? [getAddress(process.env.RELAYER_ADDRESS)] : [])],
  meanMinutes: Number(process.env.BUYBACK_MEAN_MINUTES ?? 240),
  tickMs: TICK_MS,
  slippageBps: Number(process.env.BUYBACK_SLIPPAGE_BPS ?? 300),
  maxHolders: Number(process.env.AIRDROP_MAX_HOLDERS ?? 40),
  exclude: [POOL, LAUNCHPAD],
}, (e) => record({ at: Date.now(), block: "", epoch: "", agent: 0, agentKey: agents[0].address, model: "treasury", token: process.env.BUNKER_TOKEN ?? "", symbol: e.kind, ...(e.kind === "error" ? { error: e.detail } : e.kind === "skip" ? { skipped: e.detail } : { decision: { feeBps: 0, reason: e.detail }, sent: e.txHash }) }));
console.log(`[agents] treasury ${agents[0].address}; buybacks ${process.env.BUNKER_TOKEN ? `of ${process.env.BUNKER_TOKEN}` : "off (BUNKER_TOKEN unset)"}`);

interface LaunchRow { token: string; symbol: string; decimals: number; graduated: number; amm_pair: string | null }
interface TradeRow { side: "buy" | "sell"; bnb: string; block: number }

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as T;
}

async function view(row: LaunchRow, curve: CurveState, block: bigint): Promise<TokenView> {
  const { trades } = await getJson<{ trades: TradeRow[] }>(`${INDEXER}/launches/${row.token}?limit=500`);
  const epochAgo = Number(block - policy.EPOCH_BLOCKS);
  const dayAgo = Number(block - 24n * policy.EPOCH_BLOCKS);
  const day = trades.filter((t) => t.block >= dayAgo);
  return {
    token: row.token,
    symbol: row.symbol,
    decimals: row.decimals,
    block,
    epoch: epochOf(block),
    curve,
    graduationWei: params.graduationWei,
    recent: trades.filter((t) => t.block >= epochAgo).map((t) => ({ side: t.side, bnb: BigInt(t.bnb), block: t.block })),
    dayBuys: day.filter((t) => t.side === "buy").length,
    daySells: day.filter((t) => t.side === "sell").length,
    dayBnbVolume: day.reduce((s, t) => s + BigInt(t.bnb), 0n),
  };
}

async function sendAndWait(wallet: Wallet, call: Parameters<Wallet["writeContract"]>[0]): Promise<string> {
  const hash = await wallet.writeContract(call);
  const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== "success") throw new Error(`${hash} reverted`);
  return hash;
}

async function sendVote(a: Agent, token: EvmAddress, d: Decision): Promise<string> {
  // the reason rides along as calldata suffix so it is auditable on-chain next to the vote
  const call = voteCall(LAUNCHPAD, token, d.feeBps);
  return sendAndWait(a.wallet, { ...call, dataSuffix: d.reason ? stringToHex(`bunker-agent-${a.index}: ${d.reason}`.slice(0, 200)) : undefined } as never);
}

/** The epoch each (agent, token) last voted in; a vote is attempted at most once per epoch per pair. */
const votedIn = new Map<string, bigint>();
/**
 * Trade count (buys + sells) of each curve when the agents last looked at it.
 * New volume always earns a fresh look. Without it the agents still speak:
 * once when a token first appears, and again whenever an agent's standing vote
 * is about to age out, so a quiet token keeps a live quorum.
 */
const seenTrades = new Map<string, bigint>();
function hasNewVolume(token: string, curve: CurveState): boolean {
  const seen = seenTrades.get(token);
  return seen === undefined || curve.buys + curve.sells > seen;
}
/** an agent's on-chain vote is within one epoch of expiring (or absent) */
function voteGoingStale(curve: CurveState, agent: number, block: bigint): boolean {
  const v = curve.votes[agent];
  return v.blockNumber === 0n || block - v.blockNumber >= policy.VOTE_TTL_BLOCKS - policy.EPOCH_BLOCKS;
}

/**
 * Keeper duty: a graduated curve is moved to its PancakeSwap pair. The call is
 * permissionless and deterministic, so the first agent key simply pays the gas
 * for it; anyone else may send the same call. Retried every tick until the
 * curve records the pair.
 */
const migrating = new Set<string>();
async function migrate(row: LaunchRow, curve: CurveState, block: bigint) {
  if (migrating.has(row.token)) return;
  migrating.add(row.token);
  const base: LogEntry = { at: Date.now(), block: block.toString(), epoch: epochOf(block).toString(), agent: 0, agentKey: agents[0].address, model: "keeper", token: row.token, symbol: row.symbol };
  try {
    const hash = await sendAndWait(agents[0].wallet, migrateCall(LAUNCHPAD, curve.token) as never);
    record({ ...base, decision: { feeBps: 0, reason: `graduated at ${(Number(curve.realBnb) / 1e18).toFixed(3)} BNB → PancakeSwap pair` }, sent: hash });
  } catch (e) {
    record({ ...base, error: `migrate: ${(e as Error).message}` });
  } finally {
    migrating.delete(row.token);
  }
}

/** Keeper duty: sweep a curve's accrued tax to the treasury (permissionless; agent 0 pays the gas). */
const harvesting = new Set<string>();
async function harvest(row: LaunchRow, curve: CurveState, block: bigint) {
  if (harvesting.has(row.token)) return;
  harvesting.add(row.token);
  const base: LogEntry = { at: Date.now(), block: block.toString(), epoch: epochOf(block).toString(), agent: 0, agentKey: agents[0].address, model: "keeper", token: row.token, symbol: row.symbol };
  try {
    const hash = await sendAndWait(agents[0].wallet, harvestCall(LAUNCHPAD, curve.token) as never);
    record({ ...base, decision: { feeBps: 0, reason: `harvested ${(Number(curve.feesAccrued) / 1e18).toFixed(4)} BNB of tax to the treasury` }, sent: hash });
  } catch (e) {
    record({ ...base, error: `harvest: ${(e as Error).message}` });
  } finally {
    harvesting.delete(row.token);
  }
}

async function tick() {
  await treasury.tick();
  // graduated-but-unmigrated curves still need the keeper, so only rows the indexer already shows on the AMM are skipped
  const launches = (await getJson<LaunchRow[]>(`${INDEXER}/launches?limit=200`)).filter((l) => !l.amm_pair);
  if (launches.length === 0) return;
  const block = await publicClient.getBlockNumber();
  const epoch = epochOf(block);
  for (const row of launches) {
    const raw = await readCurve(publicClient, LAUNCHPAD, getAddress(row.token));
    if (!raw) continue;
    const curve = rolled(raw, block);
    if (curve.graduated) {
      if (!curve.ammPair) void migrate(row, curve, block);
      continue;
    }
    if (curve.feesAccrued >= HARVEST_MIN) void harvest(row, curve, block);
    const fresh = hasNewVolume(row.token, curve);
    seenTrades.set(row.token, curve.buys + curve.sells);
    let v: TokenView | undefined;
    for (const a of agents) {
      if (!fresh && !voteGoingStale(curve, a.index, block)) continue;
      const k = `${a.index}:${row.token}`;
      if (votedIn.get(k) === epoch) continue;
      votedIn.set(k, epoch);
      const base: LogEntry = { at: Date.now(), block: block.toString(), epoch: epoch.toString(), agent: a.index, agentKey: a.address, model: `${a.model.provider}:${a.model.model}`, token: row.token, symbol: row.symbol };
      try {
        v ??= await view(row, curve, block);
        const { text, model } = await ask(a, prompt(v, PERSONAS[a.index]));
        base.model = `${a.model.provider}:${model}`;
        const d = parseDecision(text);
        if (!d) {
          record({ ...base, error: `model returned no usable vote: ${text.slice(0, 120)}` });
          continue;
        }
        if (!voteGoingStale(curve, a.index, block) && !shouldSend(curve.votes[a.index], d, block)) {
          record({ ...base, decision: d, skipped: "unchanged and still fresh on chain" });
          continue;
        }
        const hash = await sendVote(a, curve.token, d);
        record({ ...base, decision: d, sent: hash });
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
  chainId: CHAIN_ID,
  launchpad: LAUNCHPAD,
  treasury: agents[0].address,
  agents: agents.map((a) => ({ index: a.index, key: a.address, model: `${a.model.provider}:${a.model.model}` })),
  policy: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v])),
}));
/** Public audit log of every decision, newest first. `?token=` filters to one token. */
app.get<{ Querystring: { token?: string; limit?: string } }>("/log", async (req) => {
  const limit = Math.min(Number(req.query.limit ?? 200), LOG_MAX);
  const t = req.query.token?.toLowerCase();
  return (t ? log.filter((e) => e.token.toLowerCase() === t) : log).slice(0, limit);
});
await app.listen({ port: PORT, host: "0.0.0.0" });
