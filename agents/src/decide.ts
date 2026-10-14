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

/** Votes are placed on a quarter-point grid (0, 25, 50 … 500 bps); the program accepts any integer in bounds. */
export const VOTE_GRID_BPS = 25;

/** What the prompt calls an orderly market's tax; the launch fee the program starts every curve at. */
export const BASELINE_BPS = 100;

/** Snap any (fee, holder) to what the program accepts: the fee to the nearest grid point inside the bounds, the holders' share to its pinned value. */
export function snap(feeBps: number, holderBps: number = policy.HOLDER_MIN_BPS): { feeBps: number; holderBps: number } {
  const grid = (x: number, min: number, max: number, step: number) => {
    if (!Number.isFinite(x)) return min;
    if (step === 0) return Math.min(max, Math.max(min, Math.round(x)));
    const k = Math.round((x - min) / step);
    return Math.min(max, Math.max(min, min + k * step));
  };
  return {
    feeBps: grid(feeBps, policy.FEE_MIN_BPS, policy.FEE_MAX_BPS, VOTE_GRID_BPS),
    holderBps: grid(holderBps, policy.HOLDER_MIN_BPS, policy.HOLDER_MAX_BPS, policy.HOLDER_STEP_BPS),
  };
}

/**
 * Pull a vote out of whatever text a model returned. Accepts a JSON object anywhere
 * in the text with `fee_bps`/`holder_bps` (or `fee_pct`/`holder_pct`) and an
 * optional `reason`; snaps to the grid; returns null if nothing usable is there.
 */
/** Every balanced `{…}` in the text, outermost first; models wrap JSON in fences and prose. */
function jsonObjects(text: string): string[] {
  const out: string[] = [];
  for (let i = text.indexOf("{"); i !== -1; i = text.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { out.push(text.slice(i, j + 1)); break; }
    }
  }
  return out;
}

export function parseDecision(text: string): Decision | null {
  let o: Record<string, unknown> | undefined;
  for (const cand of jsonObjects(text)) {
    try {
      const parsed = JSON.parse(cand) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && ("fee_bps" in parsed || "fee_pct" in parsed)) { o = parsed; break; }
    } catch { /* try the next candidate */ }
  }
  if (!o) return null;
  const num = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : typeof o[k] === "string" ? Number(o[k]) : NaN);
  let fee = num("fee_bps");
  if (Number.isNaN(fee)) fee = num("fee_pct") * 100;
  if (Number.isNaN(fee)) return null;
  // the holders' share is pinned by the program; whatever a model says about it is ignored
  const s = snap(fee);
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
  const votes = c.votes.map((v, i) => (v.slot === 0n ? `agent ${i}: none` : `agent ${i}: ${v.feeBps} bps (slot ${v.slot})`)).join("; ");
  const recent = view.recent.slice(0, 20).map((t) => `${t.side} ${fmtSol(t.sol)} SOL${t.private ? " (shielded)" : ""}`).join(", ") || "none";
  const progress = Number(c.realSol) / Number(c.graduationLamports || 1n);
  return [
    `You are one of four independent AI agents that set the trading tax of a token on a shielded launchpad on Solana. ${persona}`,
    `There is no human proposer, guardian, or veto: once a minute (every ${policy.EPOCH_SLOTS} slots) the program takes the median of the four agents' fresh votes and moves the tax at most ${policy.FEE_STEP_BPS / 100} percentage point toward it.`,
    `Allowed values: fee_bps from ${policy.FEE_MIN_BPS} to ${policy.FEE_MAX_BPS} in steps of ${VOTE_GRID_BPS} (basis points of each trade; 100 bps = 1 %). The whole tax goes to the agents' treasury, which buys back and burns or airdrops the scash token.`,
    `Goals, in order: keep the curve liquid and attractive to honest traders; make rapid wash-trading, sniping, bots and sell-pressure spikes expensive (raise the tax while they last, up to the maximum); bring the tax back toward the baseline as soon as the market calms.`,
    `Baseline: an orderly market pays about ${BASELINE_BPS} bps. The tax is what funds the buybacks and the yield, so 0 is not the resting state: go to 0 only for a deliberate reason you can name (for example a dead curve that needs any volume at all). Vary your vote with the data: a quiet minute after activity is worth a step toward the baseline, a burst of same-side trades a step or two away from it, a fresh curve with its first buys a little below the baseline to help discovery. Prefer a small move every time you are asked over repeating the same number.`,
    ``,
    `Token ${view.symbol} (${view.mint}), slot ${view.slot}, epoch ${view.epoch}.`,
    `Tax now ${c.tradeFeeBps} bps. Standing votes: ${votes}.`,
    `Raised ${fmtSol(c.realSol)} SOL of ${fmtSol(c.graduationLamports)} to graduate (${(progress * 100).toFixed(1)}%). Lifetime ${c.buys} buys, ${c.sells} sells, ${fmtSol(c.solVolume)} SOL volume. Tax waiting to be harvested: ${fmtSol(c.feesAccrued)} SOL.`,
    `Last ~24 minutes: ${view.dayBuys} buys, ${view.daySells} sells, ${fmtSol(view.daySolVolume)} SOL. Last minute's trades (newest first): ${recent}.`,
    ``,
    `Answer with one JSON object only: {"fee_bps": <int>, "reason": "<one sentence, under 160 characters>"}`,
  ].join("\n");
}
