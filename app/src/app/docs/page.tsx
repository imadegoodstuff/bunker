import type { Metadata } from "next";
import { LAUNCHPAD_ADDRESS, POOL_ADDRESS, CONFIGURED, explorerAddr } from "@/lib/config";

export const metadata: Metadata = { title: "Docs" };

const SECTIONS: { h: string; p: React.ReactNode }[] = [
  {
    h: "What the pool is",
    p: <>A single shielded pool contract on BNB Smart Chain holding BNB and any ERC-20, each as its own sub-pool with share accounting, under one depth-26 Poseidon Merkle tree. Notes are Zcash-Sapling style: a commitment binds an asset, an amount and a diversified Baby Jubjub address; spending reveals a nullifier and a Groth16 proof over BN254 (<code>transact2x2</code> or <code>transact4x2</code>). The contract keeps the last 128 roots so a proof made a minute ago still verifies.</>,
  },
  {
    h: "Keys",
    p: <>The spending key is derived in the browser from a wallet signature over a fixed message, stretched with scrypt together with a passphrase. The signature alone is not a secret (any site can ask for one); the passphrase is what stops a phished signature from opening the vault. A raw seed backup (<code>bunkerseed1…</code>) is available for people who prefer it. Nothing is stored server-side.</>,
  },
  {
    h: "Relayer",
    p: <>Sends and withdrawals go through a relayer so your public wallet never signs them. The relayer receives a finished proof and ciphertexts, checks that its fee is inside the transaction, waits a random delay, and submits. It cannot alter, redirect or front-run a note; it can only decline. Fees are quoted per asset at <code>/info</code> and ERC-20 fees are priced through PancakeSwap.</>,
  },
  {
    h: "Launchpad",
    p: <>Tokens launch on a constant-product curve with virtual reserves. A private buy is a pool withdrawal whose recipient is the launchpad and whose exit data names a one-off claim key; the curve fills it, funds the claim key with the tokens and a little BNB for gas, and the claim key shields them back. Sells are the mirror image. At the graduation threshold the curve closes, liquidity is added to PancakeSwap V2 and the LP tokens are burned.</>,
  },
  {
    h: "Fee policy",
    p: <>Four agent keys vote a fee per curve. Each 80-block epoch the fee moves toward the median of fresh votes by at most 100 bps, bounded 0–500 bps, with a quorum of two. Because only votes cast before an epoch began count, a trade knows its fee before the proof is generated.</>,
  },
  {
    h: "Trust and limits",
    p: <>A guardian key can pause new shields and lower the deposit cap; it cannot touch funds, block withdrawals or alter circuits. The indexer is a convenience: anyone can rebuild the tree from chain events. Amount and timing correlations are not hidden by cryptography; the interface nudges round denominations and patience. The code is new and unaudited.</>,
  },
];

export default function Docs() {
  return (
    <div className="max-w-3xl mx-auto rise">
      <div className="label-signal mb-2">04 · Docs</div>
      <h1 className="display text-3xl md:text-4xl mb-8">How BUNKER works, briefly.</h1>
      <div className="slab p-5 mb-8 font-mono text-[11px] space-y-1.5">
        <div className="flex justify-between gap-4"><span className="text-mute">pool</span>{CONFIGURED ? <a className="text-steel hover:text-fg break-all" href={explorerAddr(POOL_ADDRESS)} target="_blank" rel="noreferrer">{POOL_ADDRESS}</a> : <span className="text-warn">not configured</span>}</div>
        <div className="flex justify-between gap-4"><span className="text-mute">launchpad</span>{CONFIGURED ? <a className="text-steel hover:text-fg break-all" href={explorerAddr(LAUNCHPAD_ADDRESS)} target="_blank" rel="noreferrer">{LAUNCHPAD_ADDRESS}</a> : <span className="text-warn">not configured</span>}</div>
      </div>
      <div className="divide-y rule">
        {SECTIONS.map((s, i) => (
          <section key={s.h} className="py-8 grid md:grid-cols-[200px_1fr] gap-4">
            <h2 className="display text-lg"><span className="font-mono text-[11px] text-signal mr-3">0{i + 1}</span>{s.h}</h2>
            <p className="text-mute leading-relaxed text-[15px] [&_code]:font-mono [&_code]:text-fg [&_code]:text-[12px]">{s.p}</p>
          </section>
        ))}
      </div>
    </div>
  );
}
