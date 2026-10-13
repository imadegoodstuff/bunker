import { test } from "node:test";
import assert from "node:assert/strict";
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { SubmitQueue } from "./queue.js";

const ix = () => new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) });
const opts = { minDelayMs: 0, maxDelayMs: 0, cuLimit: 1, cuPriceMicroLamports: 0, maxAttempts: 1 };

test("a second /relay carrying a nullifier of a live job resolves to that job; a failed job frees its nullifiers", () => {
  const q = new SubmitQueue({} as unknown as Connection, Keypair.generate(), opts);
  const a = q.enqueue(ix(), ["aa", "bb"]);
  assert.equal(q.findByNullifiers(["bb"])?.id, a.id, "same payment again → same job");
  assert.equal(q.findByNullifiers(["cc"]), undefined);
  // A 4-input transaction sharing one input with a queued 2-input one is also the same notes being spent twice.
  assert.equal(q.findByNullifiers(["cc", "aa"])?.id, a.id);
  // Confirmed jobs keep their nullifiers claimed: the chain has them, a retry is pointless.
  a.status = "confirmed";
  assert.equal(q.findByNullifiers(["aa"])?.id, a.id);
  // Failed jobs do not: the user may legitimately re-prove with the same notes.
  a.status = "failed";
  assert.equal(q.findByNullifiers(["aa"]), undefined);
  const b = q.enqueue(ix(), ["aa"]);
  assert.equal(q.findByNullifiers(["aa"])?.id, b.id);
});
