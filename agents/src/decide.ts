import { policy, voteInBounds, type CurveState, type Vote } from "@scash/sdk";

/** What one agent sees about one token before it votes. Everything here is public on-chain or indexer data. */
export interface TokenView {
  mint: string;
  symbol: string;
  decimals: number;
  slot: bigint;
  epoch: bigint;
  curve: CurveState;
  /** trades in the last ~epoch, newest first */
  recent: { side: "buy" | "sell"; sol: bigint; private: boolean; slot: number }[];
  /** trades over the last ~24 epochs */
  dayBuys: number;
  daySells: number;
  daySolVolume: bigint;
}

export interface Decision {
  feeBps: number;
  holderBps: number;
  reason: string;
}

/** Snap any (fee, holder) to the lattice the program accepts: the nearest value on the bounded step grid. */
export function snap(feeBps: number, holderBps: number): { feeBps: number; holderBps: number } {
  const grid = (x: number, min: number, max: number, step: number) => {
    if (!Number.isFinite(x)) return min;
    const k = Math.round((x - min) / step);
    return Math.min(max, Math.max(min, min + k * step));
  };
  return {
    feeBps: grid(feeBps, policy.FEE_MIN_BPS, policy.FEE_MAX_BPS, policy.FEE_STEP_BPS),
    holderBps: grid(holderBps, policy.HOLDER_MIN_BPS, policy.HOLDER_MAX_BPS, policy.HOLDER_STEP_BPS),
  };
}

/**
 * Pull a vote out of whatever text a model returned. Accepts a JSON object anywhere
 * in the text with `fee_bps`/`holder_bps` (or `fee_pct`/`holder_pct`) and an
 * optional `reason`; snaps to the grid; returns null if nothing usable is there.
 */
export function parseDecision(text: string): Decision | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const num = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : typeof o[k] === "string" ? Number(o[k]) : NaN);
  let fee = num("fee_bps");
  let holder = num("holder_bps");
  if (Number.isNaN(fee)) fee = num("fee_pct") * 100;
  if (Number.isNaN(holder)) holder = num("holder_pct") * 100;
  if (Number.isNaN(fee) || Number.isNaN(holder)) return null;
  const s = snap(fee, holder);
  if (!voteInBounds(s.feeBps, s.holderBps)) return null;
  const reason = typeof o.reason === "string" ? o.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return { ...s, reason };
}

/**
 * Whether this agent needs to send a vote now. A vote that is still identical to
 * the standing one and younger than half the TTL is not re-sent: the chain
 * already says it, and re-sending costs a fee without changing anything.
 */
export function shouldSend(standing: Vote, d: Decision, slot: bigint): boolean {
  if (standing.slot === 0n) return true;
  if (standing.feeBps !== d.feeBps || standing.holderBps !== d.holderBps) return true;
  return slot - standing.slot >= policy.VOTE_TTL_SLOTS / 2n;
}

const fmtSol = (l: bigint) => (Number(l) / 1e9).toFixed(3);

/** The prompt every agent gets; the agents differ only in which model answers it and the persona line. */
export function prompt(view: TokenView, persona: string): string {
  const c = view.curve;
  const votes = c.votes.map((v, i) => (v.slot === 0n ? `agent ${i}: none` : `agent ${i}: fee ${v.feeBps} bps, holders ${v.holderBps} bps (slot ${v.slot})`)).join("; ");
  const recent = view.recent.slice(0, 20).map((t) => `${t.side} ${fmtSol(t.sol)} SOL${t.private ? " (shielded)" : ""}`).join(", ") || "none";
  const progress = Number(c.realSol) / Number(c.graduationLamports || 1n);
  return [
    `You are one of four independent AI agents that set the trading fee of a token on a shielded launchpad on Solana. ${persona}`,
    `There is no human proposer, guardian, or veto: the program takes the median of the four agents' fresh votes every ${policy.EPOCH_SLOTS} slots (~6 minutes) and moves the fee one step toward it.`,
    `Allowed values: fee_bps in {${range(policy.FEE_MIN_BPS, policy.FEE_MAX_BPS, policy.FEE_STEP_BPS).join(", ")}} (basis points of each trade), holder_bps in {${range(policy.HOLDER_MIN_BPS, policy.HOLDER_MAX_BPS, policy.HOLDER_STEP_BPS).join(", ")}} (share of the fee bought back as tokens for holders; the rest goes to the protocol treasury).`,
    `Goals, in order: keep the curve liquid and attractive to honest traders; make rapid wash-trading, sniping and sell-pressure spikes expensive; reward holders more when the curve is healthy and the treasury does not need the revenue.`,
    ``,
    `Token ${view.symbol} (${view.mint}), slot ${view.slot}, epoch ${view.epoch}.`,
    `Fee now ${c.tradeFeeBps} bps, holders' share ${c.holderShareBps} bps. Standing votes: ${votes}.`,
    `Raised ${fmtSol(c.realSol)} SOL of ${fmtSol(c.graduationLamports)} to graduate (${(progress * 100).toFixed(1)}%). Lifetime ${c.buys} buys, ${c.sells} sells, ${fmtSol(c.solVolume)} SOL volume. Fees waiting to be harvested: ${fmtSol(c.feesAccrued)} SOL.`,
    `Last ~24 epochs: ${view.dayBuys} buys, ${view.daySells} sells, ${fmtSol(view.daySolVolume)} SOL. Last epoch's trades (newest first): ${recent}.`,
    ``,
    `Answer with one JSON object only: {"fee_bps": <int>, "holder_bps": <int>, "reason": "<one sentence, under 160 characters>"}`,
  ].join("\n");
}

function range(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let x = min; x <= max; x += step) out.push(x);
  return out;
}
