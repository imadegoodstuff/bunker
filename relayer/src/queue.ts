// Submission queue with randomized delay and best-effort batching. Jobs are
// held for `minDelayMs..maxDelayMs` (uniform) so that submission time is
// decorrelated from the request time, then signed and sent.
import { randomInt, randomUUID } from "node:crypto";
import { Connection, Keypair, type TransactionInstruction, type AddressLookupTableAccount } from "@solana/web3.js";
import { buildV0 } from "@scash/sdk";

export type JobStatus = "queued" | "submitting" | "confirmed" | "failed";
export interface Job {
  id: string;
  ix: TransactionInstruction;
  createdAt: number;
  releaseAt: number;
  status: JobStatus;
  signature?: string;
  error?: string;
  attempts: number;
  /** hex nullifiers this job spends; the idempotency key for /relay */
  nullifiers: string[];
}

export class SubmitQueue {
  private jobs = new Map<string, Job>();
  /** nullifier hex → job id, for every job that is not failed */
  private byNullifier = new Map<string, string>();
  private timer?: NodeJS.Timeout;

  constructor(
    readonly conn: Connection,
    readonly signer: Keypair,
    readonly opts: {
      minDelayMs: number;
      maxDelayMs: number;
      cuLimit: number;
      /** static CU price, used when no `cuPrice` oracle is given */
      cuPriceMicroLamports: number;
      /** current market CU price (micro-lamports), read at submission time */
      cuPrice?: () => number;
      maxAttempts: number;
    },
    public table?: AddressLookupTableAccount
  ) {}

  /**
   * A nullifier can be spent once, so a second request carrying a nullifier of
   * a live job is the same payment again (the client lost our first response,
   * or re-proved after a timeout). Return the live job instead of queueing a
   * duplicate that would burn the relayer's rent and fail on-chain.
   */
  findByNullifiers(nullifiers: string[]): Job | undefined {
    for (const nf of nullifiers) {
      const id = this.byNullifier.get(nf);
      const job = id ? this.jobs.get(id) : undefined;
      if (job && job.status !== "failed") return job;
    }
    return undefined;
  }

  enqueue(ix: TransactionInstruction, nullifiers: string[] = []): Job {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      ix,
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
    setInterval(() => this.gc(), 60_000);
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
    const now = Date.now();
    const due = [...this.jobs.values()].filter((j) => j.status === "queued" && j.releaseAt <= now);
    // shuffle so release order != request order
    for (let i = due.length - 1; i > 0; i--) {
      const k = randomInt(i + 1);
      [due[i], due[k]] = [due[k], due[i]];
    }
    for (const job of due) await this.submit(job);
  }

  private async submit(job: Job) {
    job.status = "submitting";
    job.attempts++;
    try {
      const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
      const tx = buildV0(this.signer.publicKey, [job.ix], blockhash, this.table, {
        cuLimit: this.opts.cuLimit,
        cuPriceMicroLamports: this.opts.cuPrice?.() ?? this.opts.cuPriceMicroLamports,
      });
      tx.sign([this.signer]);
      const sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      job.signature = sig;
      const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      job.status = "confirmed";
    } catch (e) {
      const msg = (e as Error).message;
      // a stale root or spent nullifier will never succeed; anything else gets retried
      const permanent = /custom program error|already in use|Blockhash not found/i.test(msg) && !/Blockhash not found/i.test(msg);
      if (!permanent && job.attempts < this.opts.maxAttempts) {
        job.status = "queued";
        job.releaseAt = Date.now() + 5000;
      } else {
        job.status = "failed";
        job.error = msg;
      }
    }
  }
}
