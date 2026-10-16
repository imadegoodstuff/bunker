// Submission queue with randomized delay. Transact jobs are held for
// `minDelayMs..maxDelayMs` (uniform) so that submission time is decorrelated
// from the request time, then signed and sent one at a time (one EOA, one
// nonce stream). Keeper jobs (drain, createPool, publishAspRoot) share the
// same stream and go out as soon as they are due.
//
// Two optional protections on the way out:
//   * `submit`: a second transport for `eth_sendRawTransaction` only (a private
//     / MEV-protected endpoint). Simulation, nonce and receipts still go through
//     the public RPC; only the signed bytes take the private route, so a
//     withdrawal is not visible in the public mempool before it is mined.
//   * `batchMax > 1`: several due transacts to the same pool go out in one
//     `transactBatch`, so an observer sees one transaction with several
//     unlinked spends instead of one per user.
import { randomInt, randomUUID } from "node:crypto";
import { encodeFunctionData, type PublicClient, type WalletClient, type Account, type Chain, type Transport, type Hex } from "viem";
import { contractErrorName, ShieldedPoolAbi, transactBatchCall, type TransactCall, type TransactArgs, type EvmAddress } from "@bunker/sdk";

export type JobStatus = "queued" | "submitting" | "confirmed" | "failed";
export type JobKind = "transact" | "drain" | "keeper";
export interface AnyCall { address: EvmAddress; abi: any; functionName: string; args: readonly unknown[]; value?: bigint }
export interface Job {
  id: string;
  kind: JobKind;
  call: TransactCall | AnyCall;
  createdAt: number;
  releaseAt: number;
  status: JobStatus;
  txHash?: Hex;
  error?: string;
  attempts: number;
  /** gas limit for this job (estimate with headroom, capped) */
  gas: bigint;
  /** hex nullifiers this job spends; the idempotency key for /relay */
  nullifiers: string[];
  /** unix seconds after which the pool rejects this call (0 = never); from ext.validUntil */
  validUntil: number;
  /** set when the job went out inside a transactBatch */
  batched?: boolean;
}

export interface Chain_ {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  /** where signed transactions are broadcast; defaults to walletClient's transport */
  submit?: { sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex> };
}

/** v2.1 struct-argument transact (`args: [TransactArgs]`) vs the legacy positional v1 call. */
export function transactArgsOf(call: TransactCall | AnyCall): TransactArgs | undefined {
  const a0 = call.args[0] as unknown;
  return a0 && typeof a0 === "object" && "nullifiers" in (a0 as object) ? (a0 as TransactArgs) : undefined;
}
function firstNullifier(call: TransactCall | AnyCall): bigint {
  const a = transactArgsOf(call);
  return a ? a.nullifiers[0] : ((call.args as unknown[])[6] as bigint[])[0];
}

export class SubmitQueue {
  private jobs = new Map<string, Job>();
  /** nullifier hex → job id, for every job that is not failed */
  private byNullifier = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  /** called after every confirmed job */
  onConfirmed?: (job: Job) => void;
  /** batches sent so far (for /info) */
  batchesSent = 0;

  constructor(
    readonly chain: Chain_ | undefined,
    readonly opts: {
      minDelayMs: number;
      maxDelayMs: number;
      gasLimit: bigint;
      /** current gas price (wei), read at submission time */
      gasPrice: () => bigint;
      maxAttempts: number;
      pool: EvmAddress;
      /** most transacts per transactBatch; 1 disables batching */
      batchMax?: number;
    },
  ) {}

  /**
   * A nullifier can be spent once, so a second request carrying a nullifier of
   * a live job is the same payment again (the client lost our first response,
   * or re-proved after a timeout). Return the live job instead of queueing a
   * duplicate that would burn gas and fail on-chain.
   */
  findByNullifiers(nullifiers: string[]): Job | undefined {
    for (const nf of nullifiers) {
      const id = this.byNullifier.get(nf);
      const job = id ? this.jobs.get(id) : undefined;
      if (job && job.status !== "failed") return job;
    }
    return undefined;
  }

  enqueue(call: TransactCall, nullifiers: string[] = [], gas = this.opts.gasLimit): Job {
    const now = Date.now();
    const validUntil = Number(transactArgsOf(call)?.ext.validUntil ?? 0n);
    let releaseAt = now + randomInt(this.opts.minDelayMs, this.opts.maxDelayMs + 1);
    // never hold a call past its own deadline (the /relay check already requires enough room)
    if (validUntil && releaseAt > validUntil * 1000 - 30_000) releaseAt = Math.max(now, validUntil * 1000 - 30_000);
    const job: Job = { id: randomUUID(), kind: "transact", call, createdAt: now, releaseAt, status: "queued", attempts: 0, gas, nullifiers, validUntil };
    this.jobs.set(job.id, job);
    for (const nf of nullifiers) this.byNullifier.set(nf, job.id);
    return job;
  }

  /** A keeper call (drain, createPool, publishAspRoot): no delay, no idempotency key, one live at a time per kind+target. */
  enqueueKeeper(kind: Exclude<JobKind, "transact">, call: AnyCall, gas: bigint): Job {
    const live = this.liveKeeper(kind, call.functionName);
    if (live) return live;
    const now = Date.now();
    const job: Job = { id: randomUUID(), kind, call, createdAt: now, releaseAt: now, status: "queued", attempts: 0, gas, nullifiers: [], validUntil: 0 };
    this.jobs.set(job.id, job);
    return job;
  }

  liveKeeper(kind: JobKind, functionName?: string): Job | undefined {
    for (const j of this.jobs.values()) {
      if (j.kind === kind && (j.status === "queued" || j.status === "submitting") && (!functionName || j.call.functionName === functionName)) return j;
    }
    return undefined;
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  size() {
    return [...this.jobs.values()].filter((j) => j.status === "queued" && j.kind === "transact").length;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), 1000);
    setInterval(() => this.gc(), 60_000).unref?.();
  }

  private gc() {
    const cutoff = Date.now() - 6 * 3600_000;
    for (const [id, j] of this.jobs) {
      if (j.createdAt < cutoff) {
        this.jobs.delete(id);
        for (const nf of j.nullifiers) if (this.byNullifier.get(nf) === id) this.byNullifier.delete(nf);
      }
    }
  }

  private async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      const due = [...this.jobs.values()].filter((j) => j.status === "queued" && j.releaseAt <= now);
      // shuffle so release order != request order
      for (let i = due.length - 1; i > 0; i--) {
        const k = randomInt(i + 1);
        [due[i], due[k]] = [due[k], due[i]];
      }
      const batchMax = this.opts.batchMax ?? 1;
      // bundle due v2 transacts to our pool, several at a time
      const bundle = batchMax > 1 ? due.filter((j) => j.kind === "transact" && j.call.address === this.opts.pool && transactArgsOf(j.call)) : [];
      const bundled = new Set<Job>();
      if (bundle.length >= 2) {
        for (let i = 0; i < bundle.length; i += batchMax) {
          const group = bundle.slice(i, i + batchMax);
          if (group.length < 2) break;
          for (const j of group) bundled.add(j);
          await this.submitBatch(group);
        }
      }
      for (const job of due) if (!bundled.has(job)) await this.submit(job);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Did the payment land? Only the chain decides: a job's first nullifier
   * being spent means its transact executed — ours, a moment ago, unless the
   * user double-submitted elsewhere, in which case the outcome is the same.
   */
  private async landed(job: Job): Promise<boolean> {
    if (!this.chain) return false;
    try {
      if (job.txHash) {
        const rc = await this.chain.publicClient.getTransactionReceipt({ hash: job.txHash }).catch(() => null);
        if (rc) return rc.status === "success";
      }
      if (job.kind !== "transact") return false;
      const nf = firstNullifier(job.call);
      // the job's own pool: v2 by default, the legacy v1 pool for /v1/relay jobs (same `nullifierSpent` view)
      return await this.chain.publicClient.readContract({ address: job.call.address ?? this.opts.pool, abi: ShieldedPoolAbi, functionName: "nullifierSpent", args: [nf] });
    } catch {
      return false;
    }
  }

  /** Sign with the wallet client, broadcast through `submit` if configured, wait for the receipt on the public RPC. */
  private async send(call: AnyCall, gas: bigint): Promise<Hex> {
    const { publicClient, walletClient, submit } = this.chain!;
    const account = walletClient.account;
    if (!submit) return walletClient.writeContract({ ...call, account, chain: walletClient.chain, gas, gasPrice: this.opts.gasPrice() });
    const request = await walletClient.prepareTransactionRequest({
      account, chain: walletClient.chain, to: call.address, value: call.value ?? 0n, gas, gasPrice: this.opts.gasPrice(),
      data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args as unknown[] }),
    });
    const serializedTransaction = await walletClient.signTransaction(request as never);
    const hash = await submit.sendRawTransaction({ serializedTransaction });
    void publicClient;
    return hash;
  }

  private expired(job: Job): boolean {
    return job.validUntil !== 0 && Date.now() / 1000 > job.validUntil;
  }

  private async submit(job: Job) {
    if (!this.chain) return;
    job.status = "submitting";
    job.attempts++;
    try {
      if (job.attempts > 1 && (await this.landed(job))) { job.status = "confirmed"; this.onConfirmed?.(job); return; }
      if (this.expired(job)) throw new Error("simulation failed: Expired");
      const { publicClient, walletClient } = this.chain;
      const account = walletClient.account;
      // simulate again right before sending: the tree may have moved, a note may be spent
      await publicClient.simulateContract({ ...(job.call as AnyCall), account });
      const hash = await this.send(job.call as AnyCall, job.gas);
      job.txHash = hash;
      const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== "success") throw new Error("on-chain error: reverted");
      job.status = "confirmed";
      this.onConfirmed?.(job);
    } catch (e) {
      await this.failed(job, e);
    }
  }

  private async failed(job: Job, e: unknown) {
    const name = contractErrorName(e);
    const msg = name ? `simulation failed: ${name}` : (e as Error).message;
    if (name === "NullifierSpent" && (await this.landed(job))) { job.status = "confirmed"; this.onConfirmed?.(job); return; }
    // someone else drained first: nothing to do
    if (job.kind === "drain" && name === "NothingQueued") { job.status = "confirmed"; return; }
    // a stale root or spent nullifier will never succeed; anything else gets retried
    const permanent = !!name || /on-chain error|simulation failed/i.test(msg);
    if (!permanent && job.attempts < this.opts.maxAttempts) {
      job.status = "queued";
      job.releaseAt = Date.now() + 5000;
    } else if (await this.landed(job)) {
      job.status = "confirmed";
      this.onConfirmed?.(job);
    } else {
      job.status = "failed";
      job.error = msg;
    }
  }

  /**
   * Several transacts in one transaction. Each is simulated alone first; one
   * that fails is handled on its own (so a stale job cannot sink the others),
   * and if the bundle itself fails every member falls back to single
   * submission on the next tick.
   */
  private async submitBatch(group: Job[]) {
    if (!this.chain) return;
    const { publicClient, walletClient } = this.chain;
    const account = walletClient.account;
    const good: Job[] = [];
    for (const job of group) {
      job.status = "submitting";
      job.attempts++;
      try {
        if (job.attempts > 1 && (await this.landed(job))) { job.status = "confirmed"; this.onConfirmed?.(job); continue; }
        if (this.expired(job)) throw new Error("simulation failed: Expired");
        await publicClient.simulateContract({ ...(job.call as AnyCall), account });
        good.push(job);
      } catch (e) {
        await this.failed(job, e);
      }
    }
    if (good.length === 0) return;
    if (good.length === 1) { good[0].status = "queued"; good[0].attempts--; good[0].releaseAt = Date.now(); return; }
    const call = transactBatchCall(this.opts.pool, good.map((j) => j.call as TransactCall));
    const gas = good.reduce((s, j) => s + j.gas, 0n);
    try {
      await publicClient.simulateContract({ ...(call as unknown as AnyCall), account });
      const hash = await this.send(call as unknown as AnyCall, gas);
      for (const j of good) { j.txHash = hash; j.batched = true; }
      const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== "success") throw new Error("on-chain error: reverted");
      this.batchesSent++;
      for (const j of good) { j.status = "confirmed"; this.onConfirmed?.(j); }
    } catch (e) {
      // the bundle failed as a whole: let each member try alone (whoever actually cannot succeed fails there)
      const msg = (e as Error).message;
      for (const j of good) {
        if (await this.landed(j)) { j.status = "confirmed"; this.onConfirmed?.(j); continue; }
        if (j.attempts < this.opts.maxAttempts) { j.status = "queued"; j.releaseAt = Date.now() + 5000; j.txHash = undefined; j.batched = false; }
        else { j.status = "failed"; j.error = msg; }
      }
    }
  }
}
