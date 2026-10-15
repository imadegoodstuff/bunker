import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { readFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, http, defineChain, getAddress, isAddress, type Hex } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { bsc, bscTestnet, hardhat } from "viem/chains";
import {
  transactCallFromJson, contractErrorName, readPool, readCurve, decodeExitData, EXIT_BUY, EXIT_SELL, ZERO_ADDRESS, NATIVE_UNIT,
  type TransactCallJson, type EvmAddress,
} from "@bunker/sdk";
import { FeePolicy, NATIVE } from "./policy.js";
import { SubmitQueue } from "./queue.js";
import { GasPriceOracle } from "./fees.js";
import { DynamicAssets } from "./assets.js";

// ---- configuration

const RPC = process.env.RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 56);
const deployments = loadDeployments(CHAIN_ID);
const POOL = getAddress(process.env.POOL_ADDRESS ?? deployments?.pool ?? fail("POOL_ADDRESS"));
// The one exit target the relayer will forward to: the launchpad. Set LAUNCHPAD_ADDRESS="" to refuse all exits.
const LAUNCHPAD: EvmAddress | undefined = process.env.LAUNCHPAD_ADDRESS === "" ? undefined : getAddress(process.env.LAUNCHPAD_ADDRESS ?? deployments?.launchpad ?? fail("LAUNCHPAD_ADDRESS"));
const ROUTER = getAddress(process.env.PANCAKE_ROUTER ?? deployments?.router ?? "0x10ED43C718714eb63d5aA57B78B54704E256024E");
const WBNB = getAddress(process.env.WBNB ?? (CHAIN_ID === 97 ? "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd" : "0xbb4CdB9CBd36B01bD1cBaEbF2De08d9173bc095c"));
const PORT = Number(process.env.PORT ?? 8787);

const chain = CHAIN_ID === 56 ? bsc : CHAIN_ID === 97 ? bscTestnet : CHAIN_ID === 31337 ? hardhat : defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const account = loadAccount();
const publicClient = createPublicClient({ chain, transport: http(RPC) });
const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

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
const GAS_LIMIT = BigInt(process.env.GAS_LIMIT ?? 1_600_000);
const queue = new SubmitQueue({ publicClient, walletClient }, {
  minDelayMs: Number(process.env.MIN_DELAY_MS ?? 5_000),
  maxDelayMs: Number(process.env.MAX_DELAY_MS ?? 90_000),
  gasLimit: GAS_LIMIT,
  gasPrice: () => gas.current(),
  maxAttempts: 4,
  pool: POOL,
});
queue.start();
// Any ERC-20 with a pool: fee priced off PancakeSwap. DYNAMIC_ASSETS=0 limits the relayer to FEE_POLICY.
const dynamic = new DynamicAssets(publicClient, POOL, {
  router: ROUTER,
  wbnb: WBNB,
  marginBps: Number(process.env.DYNAMIC_MARGIN_BPS ?? 5_000),
  bps: Number(process.env.DYNAMIC_FEE_BPS ?? 5),
  priceTtlMs: Number(process.env.PRICE_TTL_MS ?? 60_000),
  enabled: process.env.DYNAMIC_ASSETS !== "0",
});

function fail(name: string): never {
  throw new Error(`${name} not set and no deployments file for chain ${CHAIN_ID}`);
}
function loadDeployments(chainId: number): { pool?: string; launchpad?: string; router?: string } | undefined {
  const p = process.env.DEPLOYMENTS ?? `contracts/deployments/${chainId}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}
function loadAccount() {
  const raw = process.env.RELAYER_KEY ?? (process.env.RELAYER_KEY_PATH ? readFileSync(process.env.RELAYER_KEY_PATH, "utf8").trim() : undefined);
  if (!raw) {
    const k = generatePrivateKey();
    const a = privateKeyToAccount(k);
    console.warn("[relayer] RELAYER_KEY not set; using ephemeral key", a.address);
    return a;
  }
  return privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
}

/**
 * What one relayed transact costs the relayer in wei: gas limit × gas price.
 * The fee check at /relay prices gas at the *cap*, not the current reading,
 * because submission happens up to MAX_DELAY_MS later and the price may have
 * moved: a fee that clears the cap is sufficient whatever the market does
 * inside the window.
 */
const COST_MARGIN_BPS = Number(process.env.COST_MARGIN_BPS ?? 2_000); // 20 % over cost by default
const relayCostWei = (gasPrice = gas.opts.cap): bigint => GAS_LIMIT * gasPrice;
const floorWei = (): bigint => { const c = relayCostWei(); return c + (c * BigInt(COST_MARGIN_BPS)) / 10_000n; };
console.log(`[relayer] cost per relayed transact at gas cap ${gas.opts.cap} wei: ${relayCostWei()} wei; BNB fee floor = ${floorWei()} wei; current gas price ${gas.current()}`);

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
await app.register(cors, { origin: true });
await app.register(rateLimit, { max: 60, timeWindow: "1 minute" });

app.get("/info", async () => ({
  commit: process.env.GIT_SHA ?? "unknown",
  relayer: account.address,
  chainId: CHAIN_ID,
  pool: POOL,
  launchpad: LAUNCHPAD ?? null,
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
  return { ok: bal > 0n && runway >= 10, balanceWei: bal.toString(), worstCaseCostWei: worst.toString(), runwayTransacts: runway, queued: queue.size(), gasPrice: gas.info() };
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
  const [, token, , publicAmount, , , nullifiers, , ext] = call.args;
  if (!isAddress(token)) return reply.code(400).send({ error: "bad token" });

  // --- structural policy
  if (publicAmount > 0n) return reply.code(400).send({ error: "shields are not relayed" });
  if (call.value !== 0n) return reply.code(400).send({ error: "relayed calls carry no value" });
  if (getAddress(ext.relayer) !== account.address) return reply.code(400).send({ error: "ext.relayer must be the relayer", relayer: account.address });

  // --- exit target: none, or the launchpad (a private buy or sell on a curve)
  let launch: { kind: number; tip: bigint } | undefined;
  if (ext.exitTarget !== ZERO_ADDRESS) {
    if (!LAUNCHPAD || getAddress(ext.exitTarget) !== LAUNCHPAD) return reply.code(400).send({ error: "unsupported exit target" });
    if (getAddress(ext.recipient) !== LAUNCHPAD) return reply.code(400).send({ error: "an exit pays the launchpad" });
    let ed;
    try { ed = decodeExitData(Uint8Array.from(Buffer.from(ext.exitData.slice(2), "hex"))); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
    if (ed.kind !== EXIT_BUY && ed.kind !== EXIT_SELL) return reply.code(400).send({ error: "unknown exit kind" });
    if (ed.kind === EXIT_SELL && getAddress(token) !== getAddress(ed.token)) return reply.code(400).send({ error: "a sell spends the token being sold" });
    if (ed.kind === EXIT_BUY && token !== ZERO_ADDRESS) return reply.code(400).send({ error: "a buy spends BNB" });
    const curve = await readCurve(publicClient, LAUNCHPAD, getAddress(ed.token));
    if (!curve) return reply.code(400).send({ error: "curve not found" });
    if (curve.graduated) return reply.code(400).send({ error: curve.ammPair ? "this token trades on PancakeSwap now" : "this curve has graduated and is moving to PancakeSwap" });
    launch = { kind: ed.kind, tip: ed.relayerTip };
  }

  const sell = launch?.kind === EXIT_SELL;
  // The relayer pays gas. For BNB the fee (in gwei units) must cover that cost
  // plus a margin; for ERC-20 assets the fee is in tokens: FEE_POLICY if the
  // operator priced the token, otherwise a live PancakeSwap quote with its own margin.
  const costWei = relayCostWei();
  const floor = floorWei();
  let dyn: Awaited<ReturnType<typeof dynamic.policyFor>>;
  if (!sell && !policy.supports(token)) {
    dyn = await dynamic.policyFor(getAddress(token), floor);
    if (!dyn) return reply.code(400).send({ error: "unsupported asset" });
  }

  // --- fee check (convert shares -> amount using the pool rate)
  const pool = await readPool(publicClient, POOL, getAddress(token));
  if (!pool.exists) return reply.code(400).send({ error: "pool not found" });
  let amount = 0n;
  if (publicAmount < 0n) {
    const shares = -publicAmount;
    amount = pool.totalShares === 0n ? 0n : (shares * pool.totalAssets) / pool.totalShares;
  }
  if (sell) {
    // A private sell's pool fee would be in the token being sold, which this
    // relayer does not price; the launchpad pays the relayer a BNB tip out of
    // the proceeds instead (exit data), and that tip must clear the floor.
    const nativeMin = policy.required(NATIVE, 0n) * NATIVE_UNIT;
    const required = nativeMin > floor ? nativeMin : floor;
    if (launch!.tip < required) {
      return reply.code(402).send({ error: "relayer tip too low", requiredWei: required.toString(), relayerCostWei: costWei.toString() });
    }
  } else {
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
    if (ext.relayerFee < required) {
      return reply.code(402).send({ error: "fee too low", required: required.toString(), relayerCostWei: costWei.toString() });
    }
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
  if (gasEstimate > GAS_LIMIT) return reply.code(400).send({ error: "transaction exceeds the relayer's gas limit", gas: gasEstimate.toString() });

  const job = queue.enqueue(call, nfHex);
  return { id: job.id, releaseAt: job.releaseAt, gas: gasEstimate.toString() };
});

app.get<{ Params: { id: string } }>("/job/:id", async (req, reply) => {
  const j = queue.get(req.params.id);
  if (!j) return reply.code(404).send({ error: "unknown job" });
  return { id: j.id, status: j.status, txHash: j.txHash, error: j.error, releaseAt: j.releaseAt };
});

await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`[relayer] ${account.address} on ${RPC} (chain ${CHAIN_ID}) port ${PORT}`);
