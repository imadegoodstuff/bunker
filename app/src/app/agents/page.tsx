"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { policy } from "@bunker/sdk";
import { agents, type AgentLogEntry } from "@/lib/api";
import { explorerAddr } from "@/lib/config";
import { short, timeAgo } from "@/lib/format";

export default function AgentsPage() {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof agents.health>> | null>();
  const [log, setLog] = useState<AgentLogEntry[]>([]);
  useEffect(() => {
    const tick = () => { agents.health().then(setHealth).catch(() => setHealth(null)); agents.log(undefined, 60).then(setLog).catch(() => undefined); };
    tick();
    const id = setInterval(tick, 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="max-w-6xl mx-auto rise">
      <div className="label-signal mb-2">03 · Agents</div>
      <h1 className="display text-3xl md:text-4xl mb-3">Four keys decide the fee. None of them can set it.</h1>
      <p className="text-mute max-w-2xl leading-relaxed mb-8">
        Each curve&apos;s trading fee is governed by four independent agents, each a model with its own key. Every epoch ({policy.EPOCH_BLOCKS.toString()} blocks) the curve moves toward the
        median of their fresh votes by at most {policy.FEE_STEP_BPS / 100} %, within {policy.FEE_MIN_BPS / 100}–{policy.FEE_MAX_BPS / 100} %. Votes expire after {policy.VOTE_TTL_BLOCKS.toString()} blocks; below {policy.QUORUM} fresh votes nothing moves.
        The rules are constants in the contract. The reasoning below is what the agents said when they voted.
      </p>

      <div className="grid md:grid-cols-4 gap-px bg-line border rule mb-8">
        {health === undefined ? <div className="bg-slab p-4 font-mono text-[11px] text-dim md:col-span-4">loading…</div>
          : health === null ? <div className="bg-slab p-4 font-mono text-[11px] text-bad md:col-span-4">agent service unreachable; votes already on chain still apply</div>
          : health.agents.map((a) => (
            <div key={a.index} className="bg-slab p-4">
              <div className="label mb-1">agent {a.index}</div>
              <div className="display text-lg truncate">{a.model}</div>
              <a href={explorerAddr(a.key)} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-dim hover:text-fg">{short(a.key, 5)} ↗</a>
            </div>
          ))}
      </div>

      <section className="slab p-5">
        <h3 className="label mb-4">Decision log</h3>
        {log.length === 0 ? <p className="font-mono text-[11px] text-dim">no decisions recorded yet</p> : (
          <ul className="divide-y rule">
            {log.map((e, i) => (
              <li key={i} className="py-3 grid md:grid-cols-[150px_90px_1fr] gap-2 text-[12px]">
                <div className="font-mono text-[10.5px] text-dim">{timeAgo(e.at)} · blk {e.block}</div>
                <div className="font-mono text-[11px]"><span className="text-mute">agent {e.agent}</span> · <Link href={`/launch/${e.token}`} className="text-steel hover:text-fg">{e.symbol}</Link></div>
                <div className="text-mute leading-relaxed">
                  {e.decision ? <><span className="text-signal font-mono">{(e.decision.feeBps / 100).toFixed(2)}%</span> — {e.decision.reason}</> : e.skipped ? <span className="text-dim">{e.skipped}</span> : e.error ? <span className="text-bad">{e.error}</span> : null}
                  {e.sent ? <span className="font-mono text-[10px] text-dim"> · sent</span> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
