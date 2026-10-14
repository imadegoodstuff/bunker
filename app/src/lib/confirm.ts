// Confirmation by polling, not by WebSocket subscription.
//
// web3.js's `confirmTransaction(signature)` opens a signatureSubscribe over
// WebSocket and gives up after 30 s with "Transaction was not confirmed in
// 30.00 seconds. It is unknown if it succeeded or failed" — even when the
// transaction landed in the first second. Browser WebSockets are the first
// thing a corporate proxy, a strict RPC plan or a flaky mobile network drops,
// so that message was mostly noise. Here the chain is asked directly with
// getSignatureStatuses until the transaction is seen or its blockhash expires.
import type { Connection } from "@solana/web3.js";

export class ConfirmError extends Error {
  constructor(message: string, readonly signature: string, readonly expired = false) {
    super(message);
  }
}

/**
 * Resolve once `signature` is confirmed (or finalized); reject with the on-chain
 * error if it failed, or with `expired` once the blockhash is dead and the
 * transaction was never seen. Checks the status one last time after expiry so a
 * late-landing transaction is never reported as lost.
 */
export async function awaitConfirmation(
  conn: Connection,
  signature: string,
  o: { blockhash?: string; lastValidBlockHeight?: number; pollMs?: number; maxMs?: number } = {}
): Promise<void> {
  const pollMs = o.pollMs ?? 1_500;
  const deadline = Date.now() + (o.maxMs ?? 180_000);
  let misses = 0;
  for (;;) {
    let seen = false;
    try {
      const { value: [st] } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: misses > 10 });
      if (st) {
        seen = true;
        if (st.err) throw new ConfirmError(`transaction failed on-chain: ${JSON.stringify(st.err)}`, signature);
        if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return;
      }
    } catch (e) {
      if (e instanceof ConfirmError) throw e;
      // transient RPC error: keep polling
    }
    if (!seen) misses++;
    if (o.lastValidBlockHeight !== undefined && !seen) {
      const height = await conn.getBlockHeight("confirmed").catch(() => 0);
      if (height > o.lastValidBlockHeight) {
        // the blockhash is dead; anything not visible now will never land
        const { value: [last] } = await conn.getSignatureStatuses([signature], { searchTransactionHistory: true }).catch(() => ({ value: [null] }));
        if (last && !last.err && (last.confirmationStatus === "confirmed" || last.confirmationStatus === "finalized")) return;
        if (last?.err) throw new ConfirmError(`transaction failed on-chain: ${JSON.stringify(last.err)}`, signature);
        throw new ConfirmError("the transaction expired before it was included; nothing was spent, try again", signature, true);
      }
    }
    if (Date.now() > deadline) {
      throw new ConfirmError(`still waiting for the network after ${Math.round((o.maxMs ?? 180_000) / 1000)} s; check the signature on an explorer`, signature);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
