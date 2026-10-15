// Submission queue with randomized delay. Transact jobs are held for
// `minDelayMs..maxDelayMs` (uniform) so that submission time is decorrelated
// from the request time, then signed and sent one at a time (one EOA, one
// nonce stream). Keeper jobs (drain, createPool) share the same stream and go
// out as soon as they are due.
import { randomInt, randomUUID } from "node:crypto";
import type { PublicClient, WalletClient, Account, Chain, Transport, Hex } from "viem";
import { contractErrorName, ShieldedPoolAbi, type TransactCall, type EvmAddress } from "@bunker/sdk";

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
}

export interface Chain_ {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
}

export class SubmitQueue {
  private jobs = new Map<string, Job>();
  /** nullifier hex → job id, for every job that is not failed */
  private byNullifier = new Map<string, string>();
  private timer?: NodeJS.Timeout;
  private busy = false;
  /** called after every confirmed job */
  onConfirmed?: (job: Job) => void;

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
    const job: Job = {
      id: randomUUID(),
      kind: "transact",
      call,
      createdAt: now,
      releaseAt: now + randomInt(this.opts.minDelayMs, this.opts.maxDelayMs + 1),
      status: "queued",
      attempts: 0,
      gas,
      nullifiers,
    };
    this.jobs.set(job.id, job);
    for (const nf of nullifiers) this.byNullifier.set(nf, job.id);
    return job;
  }

  /** A keeper call (drain, createPool): no delay, no idempotency key, one live at a time per kind+target. */
  enqueueKeeper(kind: Exclude<JobKind, "transact">, call: AnyCall, gas: bigint): Job {
    const live = this.liveKeeper(kind, call.functionName);
    if (live) return live;
    const now = Date.now();
    const job: Job = { id: randomUUID(), kind, call, createdAt: now, releaseAt: now, status: "queued", attempts: 0, gas, nullifiers: [] };
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
      for (const job of due) await this.submit(job);
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
      const nf = (job.call as TransactCall).args[6][0];
      // the job's own pool: v2 by default, the legacy v1 pool for /v1/relay jobs (same `nullifierSpent` view)
      return await this.chain.publicClient.readContract({ address: job.call.address ?? this.opts.pool, abi: ShieldedPoolAbi, functionName: "nullifierSpent", args: [nf] });
    } catch {
      return false;
    }
  }

  private async submit(job: Job) {
    if (!this.chain) return;
    job.status = "submitting";
    job.attempts++;
    try {
      if (job.attempts > 1 && (await this.landed(job))) { job.status = "confirmed"; this.onConfirmed?.(job); return; }
      const { publicClient, walletClient } = this.chain;
      const account = walletClient.account;
      // simulate again right before sending: the tree may have moved, a note may be spent
      await publicClient.simulateContract({ ...(job.call as AnyCall), account });
      const hash = await walletClient.writeContract({ ...(job.call as AnyCall), account, chain: walletClient.chain, gas: job.gas, gasPrice: this.opts.gasPrice() });
      job.txHash = hash;
      const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== "success") throw new Error("on-chain error: reverted");
      job.status = "confirmed";
      this.onConfirmed?.(job);
    } catch (e) {
      const name = contractErrorName(e);
      const msg = name ? `simulation failed: ${name}` : (e as Error).message;
      if (name === "NullifierSpent" && (await this.landed(job))) { job.status = "confirmed"; this.onConfirmed?.(job); return; }
      // someone else drained first: nothing to do
      if (job.kind === "drain" && name === "NothingQueued") { job.status = "confirmed"; return; }
      // a stale root or spent nullifier will never succeed; anything else gets retried
      const permanent = !!name || /on-chain error/i.test(msg);
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
  }
}
