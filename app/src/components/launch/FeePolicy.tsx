"use client";
import { epochOf, freshVotes, policy, policyTargets, rolled, type CurveState } from "@scash/sdk";
import { Row } from "@/components/launch/LaunchShell";
import type { FeeEventRow } from "@/lib/api";
import { explorerTx } from "@/lib/config";
import { timeAgo } from "@/lib/format";

export const AGENT_NAMES = ["Agent A", "Agent B", "Agent C", "Agent D"];

const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 ? 2 : 0).replace(/\.?0+$/, "")}%`;

/** The four-agent tax policy for one token: the tax charged now, each agent's standing vote, and where the next minute takes it. */
export function FeePolicy({ curve, slot, events }: { curve: CurveState; slot: bigint; events: FeeEventRow[] }) {
  const epoch = epochOf(slot);
  const nextStart = (epoch + 1n) * policy.EPOCH_SLOTS;
  const fresh = freshVotes(curve.votes, nextStart);
  const target = policyTargets(curve.votes, nextStart, curve.tradeFeeBps, curve.holderShareBps);
  const next = rolled(curve, nextStart);
  const slotsLeft = nextStart - slot;
  const unchanged = next.tradeFeeBps === curve.tradeFeeBps;
  return (
    <section className="glass px-7 py-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="label">Trading tax · set by four AI agents</div>
        <span className="text-[11px] text-dim">
          epoch {epoch.toString()} · next in ≈{slotsLeft.toString()} slots (~{Math.round(Number(slotsLeft) * 0.4)}s)
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
        <Row k="Tax now" v={pct(curve.tradeFeeBps)} strong />
        <Row k="Next minute" v={unchanged ? "unchanged" : pct(next.tradeFeeBps)} />
        <Row k="Agents' target" v={fresh.length < policy.QUORUM ? `no quorum (${fresh.length}/${policy.QUORUM} fresh votes)` : pct(target.feeBps)} />
        <Row k="Goes to" v="the agents' treasury" />
      </dl>
      <ul className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
        {curve.votes.map((v, i) => {
          const live = v.slot !== 0n && v.slot < nextStart && v.slot + policy.VOTE_TTL_SLOTS > nextStart;
          return (
            <li key={i} className="flex items-center justify-between rounded-xl border border-line bg-black/20 px-3 py-2">
              <span className="text-mute">{AGENT_NAMES[i]}</span>
              {v.slot === 0n ? (
                <span className="text-dim">no vote yet</span>
              ) : (
                <span className={live ? "text-fg" : "text-dim line-through"} title={live ? `cast at slot ${v.slot}` : `expired (cast at slot ${v.slot})`}>
                  {pct(v.feeBps)} tax
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {events.length > 0 && (
        <ul className="mt-4 space-y-1 text-[11px] text-dim">
          {events.slice(0, 8).map((e) => (
            <li key={e.signature + e.kind} className="flex justify-between gap-3">
              <span>
                {e.kind === "vote"
                  ? `${AGENT_NAMES[e.agent ?? 0]} voted ${pct(e.fee_bps)}`
                  : `epoch ${e.epoch} moved the tax to ${pct(e.fee_bps)}`}
              </span>
              <a className="link font-mono" href={explorerTx(e.signature)} target="_blank" rel="noreferrer">
                {e.block_time ? timeAgo(e.block_time * 1000) : `slot ${e.slot}`}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[11px] leading-relaxed text-dim">
        Four model-driven agents each hold a key; they are the only voters and there is no proposer, guardian, or pause. Once a minute ({policy.EPOCH_SLOTS.toString()} slots) the
        program takes the median of their fresh votes (at least {policy.QUORUM}, each younger than {policy.VOTE_TTL_SLOTS.toString()} slots) and moves the tax at most{" "}
        {pct(policy.FEE_STEP_BPS)} toward it, between {pct(policy.FEE_MIN_BPS)} and {pct(policy.FEE_MAX_BPS)}. Nobody can override, veto, or stop it. The tax goes to the agents&apos;
        treasury, which pays their gas and buys back the scash token to burn or airdrop it. Your quote above already assumes the worst tax the next few minutes can bring.
      </p>
    </section>
  );
}
