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
  /** extra lookup tables this job needs besides the relayer's (a launched token's frozen table) */
  tables?: AddressLookupTableAccount[];
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

  enqueue(ix: TransactionInstruction, nullifiers: string[] = [], tables?: AddressLookupTableAccount[]): Job {
    const now = Date.now();
    const job: Job = {
      id: randomUUID(),
      ix,
      createdAt: now,
      releaseAt: now + randomInt(this.opts.minDelayMs, this.opts.maxDelayMs + 1),
      status: "queued",
      attempts: 0,
      nullifiers,
      tables,
    };
    this.jobs.set(job.id, job);
    for (const nf of nullifiers) this.byNullifier.set(nf, job.id);
    return job;
  }

  get(id: string) {
    return this.jobs.get(id);
  }

  /** the relayer's own table plus whatever the job brought */
  tablesFor(job: Pick<Job, "tables">): AddressLookupTableAccount[] {
    return [...(this.table ? [this.table] : []), ...(job.tables ?? [])];
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

  /**
   * Did an earlier attempt land? Asked before every retry and whenever a
   * resend is refused with NullifierSpent (0x9): that error means the payment
   * happened — most likely ours, a moment ago — so the job is confirmed, not
   * failed. Only the chain decides; a WebSocket that went quiet does not.
   */
  private async landed(job: Job): Promise<boolean> {
    if (!job.signature) return false;
    try {
      const { value: [st] } = await this.conn.getSignatureStatuses([job.signature], { searchTransactionHistory: true });
      return !!st && !st.err && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized");
    } catch {
      return false;
    }
  }

  /** Poll for confirmation until the blockhash expires. No subscriptions, no fixed timeout. */
  private async awaitConfirmation(sig: string, lastValidBlockHeight: number): Promise<void> {
    for (;;) {
      const { value: [st] } = await this.conn.getSignatureStatuses([sig]).catch(() => ({ value: [null] }));
      if (st?.err) throw new Error(`on-chain error ${JSON.stringify(st.err)}`);
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return;
      const height = await this.conn.getBlockHeight("confirmed").catch(() => 0);
      if (height > lastValidBlockHeight) {
        const { value: [last] } = await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true }).catch(() => ({ value: [null] }));
        if (last && !last.err && (last.confirmationStatus === "confirmed" || last.confirmationStatus === "finalized")) return;
        if (last?.err) throw new Error(`on-chain error ${JSON.stringify(last.err)}`);
        throw new Error("Blockhash not found: expired before inclusion");
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  private async submit(job: Job) {
    job.status = "submitting";
    job.attempts++;
    try {
      if (job.attempts > 1 && (await this.landed(job))) { job.status = "confirmed"; return; }
      const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
      const tx = buildV0(this.signer.publicKey, [job.ix], blockhash, this.tablesFor(job), {
        cuLimit: this.opts.cuLimit,
        cuPriceMicroLamports: this.opts.cuPrice?.() ?? this.opts.cuPriceMicroLamports,
      });
      tx.sign([this.signer]);
      let sig: string;
      try {
        sig = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      } catch (e) {
        // preflight says the nullifier is spent: our earlier send did it
        if (/0x9\b|NullifierSpent|nullifier already spent/i.test((e as Error).message) && (await this.landed(job))) { job.status = "confirmed"; return; }
        throw e;
      }
      job.signature = sig;
      await this.awaitConfirmation(sig, lastValidBlockHeight);
      job.status = "confirmed";
    } catch (e) {
      const msg = (e as Error).message;
      // a stale root or spent nullifier will never succeed; anything else gets retried
      const permanent = /custom program error|on-chain error|already in use/i.test(msg);
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
