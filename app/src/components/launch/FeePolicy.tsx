"use client";
import { useEffect, useState } from "react";
import { policy, epochOf, rolled, type CurveState } from "@bunker/sdk";
import { agents, type AgentLogEntry } from "@/lib/api";
import { short, timeAgo } from "@/lib/format";
import { explorerAddr } from "@/lib/config";

/**
 * The agent-set fee for one curve: where it is, where the fresh votes want it,
 * and what each agent last said. Nothing here is editable; the rules are
 * constants in the contract.
 */
export function FeePolicy({ curve, block, agentKeys }: { curve: CurveState; block: bigint; agentKeys: readonly string[] }) {
  const now = rolled(curve, block);
  const epoch = epochOf(block);
  const fresh = curve.votes.filter((v) => v.blockNumber > 0n && block - v.blockNumber <= policy.VOTE_TTL_BLOCKS);
  const [log, setLog] = useState<AgentLogEntry[]>([]);
  useEffect(() => { agents.log(curve.token, 8).then(setLog).catch(() => undefined); }, [curve.token, epoch]);

  return (
    <section className="slab p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="label">Fee policy</h3>
        <span className="font-mono text-[10.5px] text-dim">epoch {epoch.toString()} · {policy.EPOCH_BLOCKS.toString()} blocks</span>
      </div>
      <div className="grid grid-cols-3 gap-px bg-line border rule mb-4">
        <div className="bg-slab p-3"><div className="label text-[9.5px] mb-1">fee now</div><div className="display text-2xl num">{(now.tradeFeeBps / 100).toFixed(2)}%</div></div>
        <div className="bg-slab p-3"><div className="label text-[9.5px] mb-1">fresh votes</div><div className="display text-2xl num">{fresh.length}<span className="text-dim text-base">/{policy.AGENTS}</span></div></div>
        <div className="bg-slab p-3"><div className="label text-[9.5px] mb-1">bounds</div><div className="font-mono text-sm num mt-1.5">{policy.FEE_MIN_BPS / 100}–{policy.FEE_MAX_BPS / 100}% · ±{policy.FEE_STEP_BPS / 100}%/epoch</div></div>
      </div>
      <ul className="space-y-1.5 font-mono text-[11px] mb-4">
        {curve.votes.map((v, i) => {
          const stale = v.blockNumber === 0n || block - v.blockNumber > policy.VOTE_TTL_BLOCKS;
          return (
            <li key={i} className="flex items-center gap-3">
              <span className={`w-1.5 h-1.5 ${stale ? "bg-dim" : "bg-signal"}`} />
              <span className="text-mute">agent {i}</span>
              {agentKeys[i] ? <a href={explorerAddr(agentKeys[i])} target="_blank" rel="noreferrer" className="text-dim hover:text-fg">{short(agentKeys[i], 4)}</a> : null}
              <span className={`ml-auto num ${stale ? "text-dim" : "text-fg"}`}>{v.blockNumber === 0n ? "no vote" : `${(v.feeBps / 100).toFixed(2)}% · blk ${v.blockNumber.toString()}`}</span>
            </li>
          );
        })}
      </ul>
      {log.length ? (
        <div className="border-t rule pt-3 space-y-2">
          {log.map((e, i) => (
            <div key={i} className="text-[11px] leading-relaxed">
              <span className="font-mono text-dim">{timeAgo(e.at)} · agent {e.agent} · {e.model}</span>
              {e.decision ? <p className="text-mute">{(e.decision.feeBps / 100).toFixed(2)}% — {e.decision.reason}</p> : e.skipped ? <p className="text-dim">{e.skipped}</p> : e.error ? <p className="text-bad">{e.error}</p> : null}
            </div>
          ))}
        </div>
      ) : null}
      <p className="mt-4 font-mono text-[10.5px] text-dim leading-relaxed">Four keys vote; the fee moves toward the median of votes younger than {policy.VOTE_TTL_BLOCKS.toString()} blocks by at most one step per epoch. With fewer than {policy.QUORUM} fresh votes it stays put. The fee of the epoch a trade lands in is fixed before the proof is made.</p>
    </section>
  );
}
