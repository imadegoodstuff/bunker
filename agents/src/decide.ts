import { policy, voteInBounds, type CurveState, type Vote } from "@bunker/sdk";

/** What one agent sees about one token before it votes. Everything here is public on-chain or indexer data. */
export interface TokenView {
  token: string;
  symbol: string;
  decimals: number;
  block: bigint;
  epoch: bigint;
  curve: CurveState;
  /** the launchpad's graduation threshold (wei) */
  graduationWei: bigint;
  /** trades in the last ~epoch, newest first */
  recent: { side: "buy" | "sell"; bnb: bigint; block: number }[];
  /** trades over the last ~24 epochs */
  dayBuys: number;
  daySells: number;
  dayBnbVolume: bigint;
}

export interface Decision {
  feeBps: number;
  reason: string;
}

/** Votes are placed on a quarter-point grid (0, 25, 50 … 500 bps); the contract accepts any integer in bounds. */
export const VOTE_GRID_BPS = 25;

/** What the prompt calls an orderly market's tax; the launch fee the contract starts every curve at. */
export const BASELINE_BPS = 100;

/** Snap any fee to what the contract accepts: the nearest grid point inside the bounds. */
export function snap(feeBps: number): number {
  if (!Number.isFinite(feeBps)) return policy.FEE_MIN_BPS;
  const k = Math.round((feeBps - policy.FEE_MIN_BPS) / VOTE_GRID_BPS);
  return Math.min(policy.FEE_MAX_BPS, Math.max(policy.FEE_MIN_BPS, policy.FEE_MIN_BPS + k * VOTE_GRID_BPS));
}

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

/**
 * Pull a vote out of whatever text a model returned. Accepts a JSON object anywhere
 * in the text with `fee_bps` (or `fee_pct`) and an optional `reason`; snaps to
 * the grid; returns null if nothing usable is there.
 */
export function parseDecision(text: string): Decision | null {
  let o: Record<string, unknown> | undefined;
  for (const cand of jsonObjects(text)) {
    try {
      const parsed = JSON.parse(cand) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && ("fee_bps" in parsed || "fee_pct" in parsed)) { o = parsed; break; }
    } catch { /* try the next candidate */ }
  }
  if (!o) {
    // A reply cut off mid-JSON still names its fee; take it and let the reason be whatever is there.
    const m = /"fee_(bps|pct)"\s*:\s*"?(-?\d+(?:\.\d+)?)/.exec(text);
    if (!m) return null;
    o = { [`fee_${m[1]}`]: Number(m[2]), reason: /"reason"\s*:\s*"([^"]*)/.exec(text)?.[1] ?? "" };
  }
  const num = (k: string) => (typeof o[k] === "number" ? (o[k] as number) : typeof o[k] === "string" ? Number(o[k]) : NaN);
  let fee = num("fee_bps");
  if (Number.isNaN(fee)) fee = num("fee_pct") * 100;
  if (Number.isNaN(fee)) return null;
  const feeBps = snap(fee);
  if (!voteInBounds(feeBps)) return null;
  const reason = typeof o.reason === "string" ? o.reason.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  return { feeBps, reason };
}

/**
 * Whether this agent needs to send a vote now. A vote that is still identical to
 * the standing one and younger than half the TTL is not re-sent: the chain
 * already says it, and re-sending costs gas without changing anything.
 */
export function shouldSend(standing: Vote, d: Decision, block: bigint): boolean {
  if (standing.blockNumber === 0n) return true;
  if (standing.feeBps !== d.feeBps) return true;
  return block - standing.blockNumber >= policy.VOTE_TTL_BLOCKS / 2n;
}

const fmtBnb = (wei: bigint) => (Number(wei) / 1e18).toFixed(3);

/** The prompt every agent gets; the agents differ only in which model answers it and the persona line. */
export function prompt(view: TokenView, persona: string): string {
  const c = view.curve;
  const votes = c.votes.map((v, i) => (v.blockNumber === 0n ? `agent ${i}: none` : `agent ${i}: ${v.feeBps} bps (block ${v.blockNumber})`)).join("; ");
  const recent = view.recent.slice(0, 20).map((t) => `${t.side} ${fmtBnb(t.bnb)} BNB`).join(", ") || "none";
  const graduationWei = view.graduationWei;
  const progress = Number(c.realBnb) / Number(graduationWei || 1n);
  return [
    `You are one of four independent AI agents that set the trading tax of a token on BUNKER, a shielded launchpad on BNB Smart Chain. ${persona}`,
    `There is no human proposer, guardian, or veto: once a minute (every ${policy.EPOCH_BLOCKS} blocks) the contract takes the median of the four agents' fresh votes and moves the tax at most ${policy.FEE_STEP_BPS / 100} percentage point toward it.`,
    `Allowed values: fee_bps from ${policy.FEE_MIN_BPS} to ${policy.FEE_MAX_BPS} in steps of ${VOTE_GRID_BPS} (basis points of each trade; 100 bps = 1 %). The whole tax goes to the agents' treasury, which buys back and burns or airdrops the BUNKER token.`,
    `Goals, in order: keep the curve liquid and attractive to honest traders; make rapid wash-trading, sniping, bots and sell-pressure spikes expensive (raise the tax while they last, up to the maximum); bring the tax back toward the baseline as soon as the market calms.`,
    `Baseline: an orderly market pays about ${BASELINE_BPS} bps. The tax is what funds the buybacks, so 0 is not the resting state: go to 0 only for a deliberate reason you can name (for example a dead curve that needs any volume at all). Vary your vote with the data: a quiet minute after activity is worth a step toward the baseline, a burst of same-side trades a step or two away from it, a fresh curve with its first buys a little below the baseline to help discovery. Prefer a small move every time you are asked over repeating the same number.`,
    ``,
    `Token ${view.symbol} (${view.token}), block ${view.block}, epoch ${view.epoch}.`,
    `Tax now ${c.tradeFeeBps} bps. Standing votes: ${votes}.`,
    `Raised ${fmtBnb(c.realBnb)} BNB of ${fmtBnb(graduationWei)} to graduate (${(progress * 100).toFixed(1)}%). Lifetime ${c.buys} buys, ${c.sells} sells, ${fmtBnb(c.bnbVolume)} BNB volume. Tax waiting to be harvested: ${fmtBnb(c.feesAccrued)} BNB.`,
    `Last ~24 minutes: ${view.dayBuys} buys, ${view.daySells} sells, ${fmtBnb(view.dayBnbVolume)} BNB. Last minute's trades (newest first): ${recent}.`,
    ``,
    `Answer with one JSON object only: {"fee_bps": <int>, "reason": "<one sentence, under 160 characters>"}`,
  ].join("\n");
}
