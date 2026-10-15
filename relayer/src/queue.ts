// Submission queue with randomized delay. Jobs are held for
// `minDelayMs..maxDelayMs` (uniform) so that submission time is decorrelated
// from the request time, then signed and sent one at a time (one EOA, one
// nonce stream).
import { randomInt, randomUUID } from "node:crypto";
import type { PublicClient, WalletClient, Account, Chain, Transport, Hex } from "viem";
import { contractErrorName, ShieldedPoolAbi, type TransactCall, type EvmAddress } from "@bunker/sdk";

export type JobStatus = "queued" | "submitting" | "confirmed" | "failed";
export interface Job {
  id: string;
  call: TransactCall;
  createdAt: number;
  releaseAt: number;
  status: JobStatus;
  txHash?: Hex;
  error?: string;
  attempts: number;
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

  enqueue(call: TransactCall, nullifiers: string[] = []): Job {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      call,
      createdAt: now,
      releaseAt: now + randomInt(this.opts.minDelayMs, this.opts.maxDelayMs + 1),
      status: "queued",
      attempts: 0,
      nullifiers,
    };
    this.jobs.set(job.id, job);
    for (const nf of nullifiers) this.byNullifier.set(nf, job.id);
    return job;
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  size() {
    return [...this.jobs.values()].filter((j) => j.status === "queued").length;
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
      const nf = job.call.args[6][0];
      return await this.chain.publicClient.readContract({ address: this.opts.pool, abi: ShieldedPoolAbi, functionName: "nullifierSpent", args: [nf] });
    } catch {
      return false;
    }
  }

  private async submit(job: Job) {
    if (!this.chain) return;
    job.status = "submitting";
    job.attempts++;
    try {
      if (job.attempts > 1 && (await this.landed(job))) { job.status = "confirmed"; return; }
      const { publicClient, walletClient } = this.chain;
      const account = walletClient.account;
      // simulate again right before sending: the tree may have moved, a note may be spent
      await publicClient.simulateContract({ ...job.call, account });
      const hash = await walletClient.writeContract({ ...job.call, account, chain: walletClient.chain, gas: this.opts.gasLimit, gasPrice: this.opts.gasPrice() });
      job.txHash = hash;
      const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (rc.status !== "success") throw new Error("on-chain error: reverted");
      job.status = "confirmed";
    } catch (e) {
      const name = contractErrorName(e);
      const msg = name ? `simulation failed: ${name}` : (e as Error).message;
      if (name === "NullifierSpent" && (await this.landed(job))) { job.status = "confirmed"; return; }
      // a stale root or spent nullifier will never succeed; anything else gets retried
      const permanent = !!name || /on-chain error/i.test(msg);
      if (!permanent && job.attempts < this.opts.maxAttempts) {
        job.status = "queued";
        job.releaseAt = Date.now() + 5000;
      } else if (await this.landed(job)) {
        job.status = "confirmed";
      } else {
        job.status = "failed";
        job.error = msg;
      }
    }
  }
}
