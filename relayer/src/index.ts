import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { bsc, bscTestnet, hardhat } from "viem/chains";
import {
  transactCallFromJson, contractErrorName, readPool, readCurve, decodeExitData, decodeSwapExitData, EXIT_BUY, EXIT_SELL, ZERO_ADDRESS, NATIVE_UNIT,
  ShieldedWallet, BabyJub, tryDecryptNote, groupHash, noteCommitment, assetId, amountForBurn, encodeAddress, addressAtIndex,
  drainCall, readInsertedIndex, readNextIndex, ShieldedPoolAbi, IERC20MetadataAbi, PROTOCOL_VERSION, MAX_DRAIN,
  type TransactCallJson, type EvmAddress,
} from "@bunker/sdk";
import { FeePolicy, NATIVE } from "./policy.js";
import { SubmitQueue } from "./queue.js";
import { GasPriceOracle } from "./fees.js";
import { DynamicAssets } from "./assets.js";
import { Sweeper } from "./sweep.js";
import { registerLegacy } from "./legacy.js";

// ---- configuration

const RPC = process.env.RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 56);
const deployments = loadDeployments(CHAIN_ID);
if (deployments && (deployments.protocolVersion ?? 1) !== PROTOCOL_VERSION) throw new Error(`deployments file is protocol v${deployments.protocolVersion ?? 1}; this relayer speaks v${PROTOCOL_VERSION}`);
const POOL = getAddress(process.env.POOL_ADDRESS ?? deployments?.pool ?? fail("POOL_ADDRESS"));
// Exit targets the relayer forwards to: the launchpad and SwapExit. Set either to "" to refuse that kind.
const LAUNCHPAD: EvmAddress | undefined = process.env.LAUNCHPAD_ADDRESS === "" ? undefined : getAddress(process.env.LAUNCHPAD_ADDRESS ?? deployments?.launchpad ?? fail("LAUNCHPAD_ADDRESS"));
const SWAP_EXIT: EvmAddress | undefined = process.env.SWAP_EXIT_ADDRESS === "" ? undefined : (process.env.SWAP_EXIT_ADDRESS ?? deployments?.swapExit) ? getAddress(process.env.SWAP_EXIT_ADDRESS ?? deployments!.swapExit!) : undefined;
const ROUTER = getAddress(process.env.PANCAKE_ROUTER ?? deployments?.router ?? "0x10ED43C718714eb63d5aA57B78B54704E256024E");
const WBNB = getAddress(process.env.WBNB ?? deployments?.wbnb ?? (CHAIN_ID === 97 ? "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" : "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"));
const PORT = Number(process.env.PORT ?? 8787);

const chain = CHAIN_ID === 56 ? bsc : CHAIN_ID === 97 ? bscTestnet : CHAIN_ID === 31337 ? hardhat : defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const { account, key } = loadAccount();
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

// The relayer's shielded wallet: fee notes are paid to it. Its seed is derived
// from the relayer key (RELAYER_SEED overrides), so one secret runs the service.
const seed = process.env.RELAYER_SEED ? hexToBytes(process.env.RELAYER_SEED) : new Uint8Array(createHash("sha256").update("bunker-relayer-notes-v2").update(hexToBytes(key)).digest());
const shielded = await ShieldedWallet.fromSeed(seed);
const bjj = await BabyJub.load();
const HRP = CHAIN_ID === 56 ? "bunker" : "tbunker";
const feeAddress = addressAtIndex(bjj, shielded.fvk.ivk, 0);
const SHIELDED_ADDRESS = encodeAddress(bjj, feeAddress, HRP);

const policy = new FeePolicy(process.env.FEE_POLICY, BigInt(process.env.MIN_FEE_UNITS ?? "300000")); // 0.0003 BNB in gwei
// GAS_PRICE_FLOOR_GWEI is the floor, GAS_PRICE_CAP_GWEI the cap; between them the price follows eth_gasPrice.
const gwei = (s: string) => BigInt(Math.round(Number(s) * 1e9));
const gas = new GasPriceOracle(publicClient, {
  floor: gwei(process.env.GAS_PRICE_FLOOR_GWEI ?? "0.1"),
  cap: gwei(process.env.GAS_PRICE_CAP_GWEI ?? "5"),
  refreshMs: Number(process.env.FEE_REFRESH_MS ?? 30_000),
});
await gas.refresh();
gas.start();
/** gas priced into the fee: a transact with an exit + reshield runs ~850k; the headroom covers an auto-drain of a few leaves */
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT ?? 1_600_000);
/** the most the relayer will attach to any single transaction (a 512-leaf drain stays far under this) */
const GAS_MAX = BigInt(process.env.GAS_MAX ?? 12_000_000);
const queue = new SubmitQueue({ publicClient, walletClient }, {
  minDelayMs: Number(process.env.MIN_DELAY_MS ?? 5_000),
  maxDelayMs: Number(process.env.MAX_DELAY_MS ?? 90_000),
  gasLimit: GAS_LIMIT,
  gasPrice: () => gas.current(),
  maxAttempts: 4,
  pool: POOL,
});
queue.start();
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });
await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });
// Any ERC-20 with a pool: fee priced off PancakeSwap (or the launchpad curve). DYNAMIC_ASSETS=0 limits the relayer to FEE_POLICY.
const QUOTER_V3 = process.env.QUOTER_V3 ?? (CHAIN_ID === 56 ? "0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997" : "");
const dynamic = new DynamicAssets(publicClient, POOL, {
  router: ROUTER,
  wbnb: WBNB,
  launchpad: LAUNCHPAD,
  // BSC mainnet: USDT, USDC as routing stables; PancakeSwap V3 QuoterV2. Other chains: set STABLES / QUOTER_V3.
  stables: (process.env.STABLES ?? (CHAIN_ID === 56 ? "0x55d398326f99059fF775485246999027B3197955,0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d" : "")).split(",").map((s) => s.trim()).filter(Boolean).map((s) => getAddress(s)),
  quoterV3: QUOTER_V3 ? getAddress(QUOTER_V3) : undefined,
  marginBps: Number(process.env.DYNAMIC_MARGIN_BPS ?? 5_000),
  bps: Number(process.env.DYNAMIC_FEE_BPS ?? 5),
  priceTtlMs: Number(process.env.PRICE_TTL_MS ?? 60_000),
  enabled: process.env.DYNAMIC_ASSETS !== "0",
});

function fail(name: string): never {
  throw new Error(`${name} not set and no deployments file for chain ${CHAIN_ID}`);
}
function loadDeployments(chainId: number): { protocolVersion?: number; pool?: string; launchpad?: string; swapExit?: string; router?: string; wbnb?: string } | undefined {
  const p = process.env.DEPLOYMENTS ?? `contracts/deployments/${chainId}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}
function loadAccount() {
  const raw = process.env.RELAYER_KEY ?? (process.env.RELAYER_KEY_PATH ? readFileSync(process.env.RELAYER_KEY_PATH, "utf8").trim() : undefined);
  if (!raw) {
    const k = generatePrivateKey();
    const a = privateKeyToAccount(k);
    console.warn("[relayer] RELAYER_KEY not set; using ephemeral key", a.address);
    return { account: a, key: k as string };
  }
  const k = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  return { account: privateKeyToAccount(k), key: k as string };
}
function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  return Uint8Array.from(Buffer.from(s, "hex"));
}

/**
 * What one relayed transact costs the relayer in wei: gas limit × gas price.
 * The fee check at /relay prices gas at the *cap*, not the current reading,
 * because submission happens up to MAX_DELAY_MS later and the price may have
 * moved: a fee that clears the cap is sufficient whatever the market does
 * inside the window. The drain the relayer runs for everyone is amortised in
 * the margin.
 */
const COST_MARGIN_BPS = Number(process.env.COST_MARGIN_BPS ?? 2_000); // 20 % over cost by default
const relayCostWei = (gasPrice = gas.opts.cap): bigint => GAS_LIMIT * gasPrice;
const floorWei = (): bigint => { const c = relayCostWei(); return c + (c * BigInt(COST_MARGIN_BPS)) / 10_000n; };
console.log(`[relayer] cost per relayed transact at gas cap ${gas.opts.cap} wei: ${relayCostWei()} wei; BNB fee floor = ${floorWei()} wei; current gas price ${gas.current()}`);
console.log(`[relayer] fee notes go to ${SHIELDED_ADDRESS}`);

// ---- drain keeper: fold queued leaves into the tree so they become spendable

const DRAIN_AFTER_MS = Number(process.env.DRAIN_AFTER_MS ?? 15_000); // oldest queued leaf waits at most this long
const DRAIN_AT = Number(process.env.DRAIN_AT ?? 32); // or this many leaves, whichever first
const DRAINS = process.env.DRAIN !== "0";
let firstQueuedAt: number | undefined;
let lastPending = 0;
/** gas for a drain of n leaves: level hashing dominates; measured ~800k for 3-4 leaves, grows ~90k per extra leaf */
const drainGas = (n: number) => { const g = 700_000n + 95_000n * BigInt(Math.min(n, MAX_DRAIN)); return g > GAS_MAX ? GAS_MAX : g; };
async function pendingCount(): Promise<number> {
  const [next, inserted] = await Promise.all([readNextIndex(publicClient, POOL), readInsertedIndex(publicClient, POOL)]);
  return next - inserted;
}
async function requestDrain(reason: string) {
  const n = await pendingCount();
  if (n === 0) return { pending: 0 };
  const job = queue.enqueueKeeper("drain", drainCall(POOL, MAX_DRAIN), drainGas(n));
  app.log.info({ pending: n, job: job.id, reason }, "drain queued");
  return { pending: n, job: job.id };
}
async function keeperTick() {
  try {
    const n = await pendingCount();
    if (n === 0) { firstQueuedAt = undefined; lastPending = 0; return; }
    if (n > 0 && (lastPending === 0 || firstQueuedAt === undefined)) firstQueuedAt = Date.now();
    lastPending = n;
    if (queue.liveKeeper("drain")) return;
    if (n >= DRAIN_AT || Date.now() - (firstQueuedAt ?? Date.now()) >= DRAIN_AFTER_MS) await requestDrain(n >= DRAIN_AT ? "batch full" : "age");
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, "keeper tick failed");
  }
}
if (DRAINS) setInterval(() => void keeperTick(), 3_000).unref?.();
// a relayed transact adds leaves: start the clock right away
queue.onConfirmed = (job) => { if (job.kind === "transact" && firstQueuedAt === undefined) firstQueuedAt = Date.now(); };

// ---- sweeper: turn accumulated fee notes into gas money

const sweeper = new Sweeper({
  publicClient, walletClient, pool: POOL, seed,
  indexerUrl: process.env.INDEXER_URL,
  artifactsDir: process.env.ARTIFACTS_DIR,
  minBalanceWei: BigInt(process.env.SWEEP_BELOW_WEI ?? (2n * 10n ** 17n).toString()), // top the EOA up when under 0.2 BNB
  minSweepUnits: BigInt(process.env.SWEEP_MIN_UNITS ?? "50000000"), // and only when ≥ 0.05 BNB of notes are spendable
  enabled: process.env.SWEEP !== "0",
  log: (o, m) => app.log.info(o, m),
});
sweeper.use((call, g) => queue.enqueueKeeper("keeper", call as never, g));
sweeper.start();

/** Operator: sweep now (token-gated when ADMIN_TOKEN is set). */
app.post("/sweep", { config: { rateLimit: { max: 2, timeWindow: "1 minute" } } }, async (req, reply) => {
  if (process.env.ADMIN_TOKEN && req.headers["x-admin-token"] !== process.env.ADMIN_TOKEN) return reply.code(403).send({ error: "forbidden" });
  return { result: await sweeper.tick(true) };
});

app.get("/info", async () => ({
  commit: process.env.GIT_SHA ?? "unknown",
  protocolVersion: PROTOCOL_VERSION,
  /** v1 notes and curves are still served under /v1/* when this is set */
  legacy: POOL_V1 ? { pool: POOL_V1, info: "/v1/info" } : null,
  relayer: account.address,
  shieldedAddress: SHIELDED_ADDRESS,
  chainId: CHAIN_ID,
  pool: POOL,
  launchpad: LAUNCHPAD ?? null,
  swapExit: SWAP_EXIT ?? null,
  // For BNB, advertise the effective minimum (policy or cost floor, whichever is higher) in internal units (gwei).
  fees: policy.list().map((f) => {
    if (f.token !== NATIVE) return f;
    const floorUnits = (floorWei() + NATIVE_UNIT - 1n) / NATIVE_UNIT;
    return { ...f, min: (floorUnits > BigInt(f.min) ? floorUnits : BigInt(f.min)).toString(), costWei: relayCostWei().toString() };
  }),
  delay: { minMs: queue.opts.minDelayMs, maxMs: queue.opts.maxDelayMs },
  /** what the relayer will attach at submission; the fee floor above is priced at `cap` */
  gasPrice: gas.info(),
  gasLimit: GAS_LIMIT.toString(),
  /** any ERC-20 with a pool can be relayed; ask /asset/:token for its fee */
  dynamicAssets: dynamic.opts.enabled,
  queued: queue.size(),
  pending: lastPending,
  drains: DRAINS,
}));

/** Fee quote for one ERC-20 (BNB is in /info), in the token pool's internal units. */
app.get<{ Params: { token: string } }>("/asset/:token", async (req, reply) => {
  if (!isAddress(req.params.token)) return reply.code(400).send({ error: "bad token address" });
  const token = getAddress(req.params.token);
  if (token === ZERO_ADDRESS) return reply.code(400).send({ error: "BNB is quoted in /info" });
  try {
    return await dynamic.quote(token, floorWei());
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
});

app.get("/health", async () => {
  const bal = await publicClient.getBalance({ address: account.address }).catch(() => -1n);
  // Runway in relayed transactions at the cap-priced cost; an operator alarm, not a user-facing number.
  const worst = relayCostWei();
  const runway = bal > 0n ? Number(bal / worst) : 0;
  return { ok: bal > 0n && runway >= 10, balanceWei: bal.toString(), worstCaseCostWei: worst.toString(), runwayTransacts: runway, queued: queue.size(), pending: lastPending, gasPrice: gas.info(), sweeper: sweeper.status() };
});

/** Hurry the keeper: drain the queue now. Anyone may call; the drain is one transaction however many ask. */
app.post("/drain", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (_req, reply) => {
  if (!DRAINS) return reply.code(503).send({ error: "this relayer does not drain" });
  const r = await requestDrain("requested");
  const live = queue.liveKeeper("drain");
  return { pending: r.pending, job: live?.id, txHash: live?.txHash };
});

/** Open the shielded pool of an ERC-20 (one-time, permissionless) so it can be received privately or swapped into. */
app.post<{ Body: { token?: string } }>("/pool", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
  const t = req.body?.token;
  if (!t || !isAddress(t) || getAddress(t) === ZERO_ADDRESS) return reply.code(400).send({ error: "token address required" });
  const token = getAddress(t);
  const p = await readPool(publicClient, POOL, token);
  if (p.exists) return { exists: true };
  let decimals: number;
  try { decimals = Number(await publicClient.readContract({ address: token, abi: IERC20MetadataAbi, functionName: "decimals" })); } catch { return reply.code(400).send({ error: "not an ERC-20 token" }); }
  const call = { address: POOL, abi: ShieldedPoolAbi, functionName: "createPool", args: [token, Math.max(0, decimals - 9), (1n << 256n) - 1n] };
  try { await publicClient.simulateContract({ ...call, account } as never); } catch (e) { return reply.code(422).send({ error: contractErrorName(e) ?? (e as Error).message }); }
  const job = queue.enqueueKeeper("keeper", call, 250_000n);
  return { exists: false, job: job.id };
});

app.post<{ Body: TransactCallJson }>("/relay", async (req, reply) => {
  const body = req.body;
  if (!body || typeof body !== "object" || !body.proof || !body.ext) return reply.code(400).send({ error: "transact call required" });
  let call;
  try {
    call = transactCallFromJson(POOL, body);
  } catch (e) {
    return reply.code(400).send({ error: (e as Error).message });
  }
  const [, token, , publicAmount, , , nullifiers, outCommitments, ext] = call.args;
  if (!isAddress(token)) return reply.code(400).send({ error: "bad token" });

  // --- structural policy
  if (publicAmount > 0n) return reply.code(400).send({ error: "shields are not relayed" });
  if (call.value !== 0n) return reply.code(400).send({ error: "relayed calls carry no value" });

  // --- exit target: none, the launchpad (a private buy or sell), or SwapExit (a private swap)
  if (ext.exitTarget !== ZERO_ADDRESS) {
    const target = getAddress(ext.exitTarget);
    if (getAddress(ext.recipient) !== target) return reply.code(400).send({ error: "an exit pays its target" });
    if (ext.reshield.ownerHash === 0n) return reply.code(400).send({ error: "an exit must reshield its proceeds; without it they would be stranded" });
    const reToken = getAddress(ext.reshield.token);
    const bytes = Uint8Array.from(Buffer.from(ext.exitData.slice(2), "hex"));
    if (LAUNCHPAD && target === LAUNCHPAD) {
      let ed;
      try { ed = decodeExitData(bytes); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
      if (ed.kind !== EXIT_BUY && ed.kind !== EXIT_SELL) return reply.code(400).send({ error: "unknown exit kind" });
      const curveToken = getAddress(ed.token);
      if (ed.kind === EXIT_SELL && (getAddress(token) !== curveToken || reToken !== ZERO_ADDRESS)) return reply.code(400).send({ error: "a sell spends the token being sold and reshields BNB" });
      if (ed.kind === EXIT_BUY && (token !== ZERO_ADDRESS || reToken !== curveToken)) return reply.code(400).send({ error: "a buy spends BNB and reshields the token" });
      const curve = await readCurve(publicClient, LAUNCHPAD, curveToken);
      if (!curve) return reply.code(400).send({ error: "curve not found" });
      if (curve.graduated) return reply.code(400).send({ error: curve.ammPair ? "this token trades on PancakeSwap now; use a private swap" : "this curve has graduated and is moving to PancakeSwap" });
    } else if (SWAP_EXIT && target === SWAP_EXIT) {
      let sd;
      try { sd = decodeSwapExitData(bytes); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
      if (sd.path.length < 2 || sd.path.length > 3) return reply.code(400).send({ error: "swap path must have 2 or 3 tokens" });
      const first = getAddress(sd.path[0]), last = getAddress(sd.path[sd.path.length - 1]);
      const inTok = token === ZERO_ADDRESS ? WBNB : getAddress(token);
      if (first !== inTok) return reply.code(400).send({ error: "swap path must start with the token being spent" });
      const outTok = last === WBNB ? ZERO_ADDRESS : last;
      if (reToken !== outTok) return reply.code(400).send({ error: "the swap's output must be reshielded" });
      if (!(await readPool(publicClient, POOL, outTok)).exists) return reply.code(400).send({ error: "no pool for the output token; POST /pool first" });
    } else {
      return reply.code(400).send({ error: "unsupported exit target" });
    }
  } else if (ext.reshield.ownerHash !== 0n) {
    return reply.code(400).send({ error: "reshield without an exit" });
  }

  // --- the fee: output 2 must be a note to this relayer's shielded address, in the asset being spent
  const pool = await readPool(publicClient, POOL, getAddress(token));
  if (!pool.exists) return reply.code(400).send({ error: "pool not found" });
  const asset = assetId(token.toLowerCase());
  const ct2 = Uint8Array.from(Buffer.from(ext.ciphertext2.slice(2), "hex"));
  const dec = ct2.length ? tryDecryptNote(bjj, shielded.fvk.ivk, ct2) : null;
  if (!dec) return reply.code(402).send({ error: "no fee note: output 2 must be encrypted to the relayer's shielded address", shieldedAddress: SHIELDED_ADDRESS });
  const gd = groupHash(bjj, dec.plaintext.d);
  if (!gd) return reply.code(400).send({ error: "fee note has a bad diversifier" });
  const pkd = bjj.mulScalar(gd, shielded.fvk.ivk);
  const feeNote = { asset, value: dec.plaintext.value, gd, pkd, rseed: dec.plaintext.rseed, rho: dec.plaintext.rho, rcm: dec.plaintext.rcm };
  if ((await noteCommitment(feeNote)) !== outCommitments[2]) return reply.code(400).send({ error: "fee note does not match output commitment 2" });
  const feeUnits = amountForBurn(pool, feeNote.value);

  // The relayer pays gas. For BNB the fee (in gwei units) must cover that cost
  // plus a margin; for ERC-20 assets the fee is in tokens: FEE_POLICY if the
  // operator priced the token, otherwise a live PancakeSwap / curve quote with its own margin.
  const costWei = relayCostWei();
  const floor = floorWei();
  let dyn: Awaited<ReturnType<typeof dynamic.policyFor>>;
  if (!policy.supports(token)) {
    dyn = await dynamic.policyFor(getAddress(token), floor);
    if (!dyn) return reply.code(400).send({ error: "unsupported asset" });
  }
  let amount = 0n;
  if (publicAmount < 0n) amount = amountForBurn(pool, -publicAmount);
  let required: bigint;
  if (dyn) {
    const pct = (amount * BigInt(dyn.bps)) / 10_000n;
    required = pct > dyn.min ? pct : dyn.min;
  } else {
    required = policy.required(token, amount);
    if (token === ZERO_ADDRESS) {
      const floorUnits = (floor + NATIVE_UNIT - 1n) / NATIVE_UNIT;
      if (floorUnits > required) required = floorUnits;
    }
  }
  if (feeUnits < required) {
    return reply.code(402).send({ error: "fee too low", required: required.toString(), offered: feeUnits.toString(), relayerCostWei: costWei.toString() });
  }

  // --- idempotency: same nullifier ⇒ same payment ⇒ same job
  const nfHex = nullifiers.map((n) => n.toString(16));
  const live = queue.findByNullifiers(nfHex);
  if (live) {
    return reply.code(200).send({ id: live.id, releaseAt: live.releaseAt, duplicate: true, status: live.status, txHash: live.txHash });
  }

  // --- simulate before accepting (catches bad proofs / stale roots / spent notes)
  let gasEstimate: bigint;
  try {
    await publicClient.simulateContract({ ...call, account });
    gasEstimate = await publicClient.estimateContractGas({ ...call, account }).catch(() => 0n);
  } catch (e) {
    // `contractError` is the contract with clients (SDK `RelayRejection`); `details` is the raw message for humans.
    const contractError = contractErrorName(e);
    return reply.code(422).send({ error: contractError ? `simulation failed: ${contractError}` : "simulation failed", contractError, details: (e as { shortMessage?: string }).shortMessage ?? (e as Error).message });
  }
  // an auto-drain inside the transact can push it past the priced limit; allow it with headroom, within the hard cap
  const gasFor = gasEstimate === 0n ? GAS_LIMIT : (gasEstimate * 13n) / 10n;
  if (gasFor > GAS_MAX) return reply.code(400).send({ error: "transaction exceeds the relayer's gas limit", gas: gasEstimate.toString() });

  const job = queue.enqueue(call, nfHex, gasFor > GAS_LIMIT ? gasFor : GAS_LIMIT);
  return { id: job.id, releaseAt: job.releaseAt, gas: gasEstimate.toString() };
});

// ---- protocol v1 (legacy pool + launchpad, and the v1 -> v2 migration bridge). LEGACY=0 turns it off.
const legacyDeployments = loadLegacyDeployments(CHAIN_ID);
const POOL_V1: EvmAddress | undefined = process.env.LEGACY === "0" ? undefined : (process.env.POOL_V1_ADDRESS ?? legacyDeployments?.pool) ? getAddress(process.env.POOL_V1_ADDRESS ?? legacyDeployments!.pool!) : undefined;
if (POOL_V1) {
  const LAUNCHPAD_V1 = (process.env.LAUNCHPAD_V1_ADDRESS ?? legacyDeployments?.launchpad) ? getAddress(process.env.LAUNCHPAD_V1_ADDRESS ?? legacyDeployments!.launchpad!) : undefined;
  const MIGRATE_EXIT = (process.env.MIGRATE_EXIT_ADDRESS ?? legacyDeployments?.migrateExit) ? getAddress(process.env.MIGRATE_EXIT_ADDRESS ?? legacyDeployments!.migrateExit!) : undefined;
  const dynamicV1 = new DynamicAssets(publicClient, POOL_V1, dynamic.opts);
  registerLegacy(app, { pool: POOL_V1, launchpad: LAUNCHPAD_V1, migrateExit: MIGRATE_EXIT }, {
    publicClient, account, queue, policy, dynamic: dynamicV1, relayCostWei, floorWei, gasLimit: GAS_LIMIT, gasInfo: () => gas.info(), v2Pool: POOL,
  });
  console.log(`[relayer] legacy v1 routes on: pool ${POOL_V1} launchpad ${LAUNCHPAD_V1 ?? "-"} migrateExit ${MIGRATE_EXIT ?? "-"}`);
}
function loadLegacyDeployments(chainId: number): { pool?: string; launchpad?: string; migrateExit?: string } | undefined {
  const p = process.env.LEGACY_DEPLOYMENTS ?? `contracts/deployments/${chainId}.v1.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

app.get<{ Params: { id: string } }>("/job/:id", async (req, reply) => {
  const j = queue.get(req.params.id);
  if (!j) return reply.code(404).send({ error: "unknown job" });
  return { id: j.id, status: j.status, txHash: j.txHash, error: j.error, releaseAt: j.releaseAt };
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[relayer] ${account.address} on ${RPC} (chain ${CHAIN_ID}) port ${PORT}`);
