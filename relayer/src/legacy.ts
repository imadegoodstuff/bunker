// Protocol-v1 relaying. The v1 pool (0xD327…12bF) and launchpad (0x1A6b…AaA6)
// are immutable and still hold user notes and bonding curves, so this relayer
// keeps forwarding v1 transacts under /v1/* with the v1 rules: a public
// `ext.relayerFee` paid to our EOA, exits to the v1 launchpad (buy/sell) or to
// MigrateExit (a v1 note becoming a v2 note in one transaction). Same EOA,
// same submit queue, same nonce stream as the v2 routes.
import type { FastifyInstance } from "fastify";
import { getAddress, isAddress, type PublicClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import {
  transactCallFromJson, contractErrorName, readPool, readCurve, decodeExitData, EXIT_BUY, EXIT_SELL, ZERO_ADDRESS, NATIVE_UNIT,
  type TransactCallJson as TransactCallJsonV1, type EvmAddress,
} from "@bunker/sdk-v1";
import type { FeePolicy } from "./policy.js";
import { NATIVE } from "./policy.js";
import type { SubmitQueue } from "./queue.js";
import type { DynamicAssets } from "./assets.js";

export interface LegacyConfig {
  pool: EvmAddress;
  launchpad?: EvmAddress;
  /** the v1 -> v2 bridge; exits to it carry a v2 shield for the same funds */
  migrateExit?: EvmAddress;
}

export interface LegacyDeps {
  publicClient: PublicClient;
  account: PrivateKeyAccount;
  queue: SubmitQueue;
  policy: FeePolicy;
  /** fee pricing bound to the *v1* pool's share rate */
  dynamic: DynamicAssets;
  relayCostWei: () => bigint;
  floorWei: () => bigint;
  gasLimit: bigint;
  gasInfo: () => unknown;
  v2Pool: EvmAddress;
}

export function registerLegacy(app: FastifyInstance, cfg: LegacyConfig, d: LegacyDeps) {
  const { publicClient, account, queue, policy, dynamic, relayCostWei, floorWei, gasLimit } = d;

  app.get("/v1/info", async () => ({
    protocolVersion: 1,
    relayer: account.address,
    pool: cfg.pool,
    launchpad: cfg.launchpad ?? null,
    migrateExit: cfg.migrateExit ?? null,
    v2Pool: d.v2Pool,
    fees: policy.list().map((f) => {
      if (f.token !== NATIVE) return f;
      const floorUnits = (floorWei() + NATIVE_UNIT - 1n) / NATIVE_UNIT;
      return { ...f, min: (floorUnits > BigInt(f.min) ? floorUnits : BigInt(f.min)).toString(), costWei: relayCostWei().toString() };
    }),
    delay: { minMs: queue.opts.minDelayMs, maxMs: queue.opts.maxDelayMs },
    gasPrice: d.gasInfo(),
    gasLimit: gasLimit.toString(),
    dynamicAssets: dynamic.opts.enabled,
    queued: queue.size(),
  }));

  // the v1 SDK polls `<relayerUrl>/job/:id`; with relayerUrl = …/v1 that is this route (same queue as v2)
  app.get<{ Params: { id: string } }>("/v1/job/:id", async (req, reply) => {
    const j = queue.get(req.params.id);
    if (!j) return reply.code(404).send({ error: "unknown job" });
    return { id: j.id, status: j.status, txHash: j.txHash, error: j.error, releaseAt: j.releaseAt };
  });

  app.get<{ Params: { token: string } }>("/v1/asset/:token", async (req, reply) => {
    if (!isAddress(req.params.token)) return reply.code(400).send({ error: "bad token address" });
    const token = getAddress(req.params.token);
    if (token === ZERO_ADDRESS) return reply.code(400).send({ error: "BNB is quoted in /v1/info" });
    try {
      return await dynamic.quote(token, floorWei());
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  app.post<{ Body: TransactCallJsonV1 }>("/v1/relay", async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== "object" || !body.proof || !body.ext) return reply.code(400).send({ error: "transact call required" });
    let call;
    try {
      call = transactCallFromJson(cfg.pool, body);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const [, token, , publicAmount, , , nullifiers, , ext] = call.args;
    if (!isAddress(token)) return reply.code(400).send({ error: "bad token" });

    if (publicAmount > 0n) return reply.code(400).send({ error: "shields are not relayed" });
    if (call.value !== 0n) return reply.code(400).send({ error: "relayed calls carry no value" });
    if (getAddress(ext.relayer) !== account.address) return reply.code(400).send({ error: "ext.relayer must be the relayer", relayer: account.address });

    // --- exit target: none, the v1 launchpad (buy/sell on a v1 curve) or MigrateExit (v1 note -> v2 note)
    let launch: { kind: number; tip: bigint } | undefined;
    let migrating = false;
    if (ext.exitTarget !== ZERO_ADDRESS) {
      const target = getAddress(ext.exitTarget);
      if (getAddress(ext.recipient) !== target) return reply.code(400).send({ error: "an exit pays its target" });
      if (cfg.launchpad && target === cfg.launchpad) {
        let ed;
        try { ed = decodeExitData(Uint8Array.from(Buffer.from(ext.exitData.slice(2), "hex"))); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
        if (ed.kind !== EXIT_BUY && ed.kind !== EXIT_SELL) return reply.code(400).send({ error: "unknown exit kind" });
        if (ed.kind === EXIT_SELL && getAddress(token) !== getAddress(ed.token)) return reply.code(400).send({ error: "a sell spends the token being sold" });
        if (ed.kind === EXIT_BUY && token !== ZERO_ADDRESS) return reply.code(400).send({ error: "a buy spends BNB" });
        const curve = await readCurve(publicClient, cfg.launchpad, getAddress(ed.token));
        if (!curve) return reply.code(400).send({ error: "curve not found" });
        if (curve.graduated) return reply.code(400).send({ error: curve.ammPair ? "this token trades on PancakeSwap now" : "this curve has graduated and is moving to PancakeSwap" });
        launch = { kind: ed.kind, tip: ed.relayerTip };
      } else if (cfg.migrateExit && target === cfg.migrateExit) {
        // exitData = abi.encode(address refund, bytes v2Calldata); the bridge reverts the whole
        // transaction if the v2 shield fails, so simulation below is the real check
        if (ext.exitData.length < 2 + 64 * 4) return reply.code(400).send({ error: "migration exit data too short" });
        migrating = true;
      } else {
        return reply.code(400).send({ error: "unsupported exit target" });
      }
    }

    const sell = launch?.kind === EXIT_SELL;
    const costWei = relayCostWei();
    const floor = floorWei();
    let dyn: Awaited<ReturnType<typeof dynamic.policyFor>>;
    if (!sell && !policy.supports(token)) {
      dyn = await dynamic.policyFor(getAddress(token), floor);
      if (!dyn) return reply.code(400).send({ error: "unsupported asset" });
    }

    const pool = await readPool(publicClient, cfg.pool, getAddress(token));
    if (!pool.exists) return reply.code(400).send({ error: "pool not found" });
    let amount = 0n;
    if (publicAmount < 0n) {
      const shares = -publicAmount;
      amount = pool.totalShares === 0n ? 0n : (shares * pool.totalAssets) / pool.totalShares;
    }
    if (sell) {
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
      // a migration verifies two proofs in one transaction; it costs the relayer about twice a plain transact
      if (migrating) required *= 2n;
      if (ext.relayerFee < required) {
        return reply.code(402).send({ error: "fee too low", required: required.toString(), relayerCostWei: costWei.toString() });
      }
    }

    const nfHex = nullifiers.map((n) => n.toString(16));
    const live = queue.findByNullifiers(nfHex);
    if (live) {
      return reply.code(200).send({ id: live.id, releaseAt: live.releaseAt, duplicate: true, status: live.status, txHash: live.txHash });
    }

    let gasEstimate: bigint;
    try {
      await publicClient.simulateContract({ ...call, account });
      gasEstimate = await publicClient.estimateContractGas({ ...call, account }).catch(() => 0n);
    } catch (e) {
      const contractError = contractErrorName(e);
      return reply.code(422).send({ error: contractError ? `simulation failed: ${contractError}` : "simulation failed", contractError, details: (e as { shortMessage?: string }).shortMessage ?? (e as Error).message });
    }
    // a migration verifies a v1 and a v2 proof (and may auto-drain the v2 queue); allow up to 2x the priced limit
    const limit = migrating ? gasLimit * 2n : gasLimit;
    const gasFor = gasEstimate === 0n ? limit : (gasEstimate * 13n) / 10n;
    if (gasFor > limit) return reply.code(400).send({ error: "transaction exceeds the relayer's gas limit", gas: gasEstimate.toString() });

    // the queue's TransactCall type is v2's; the v1 call has the same shape at the viem level (address/abi/functionName/args/value)
    const job = queue.enqueue(call as unknown as Parameters<SubmitQueue["enqueue"]>[0], nfHex, gasFor > gasLimit ? gasFor : gasLimit);
    return { id: job.id, releaseAt: job.releaseAt, gas: gasEstimate.toString() };
  });
}
