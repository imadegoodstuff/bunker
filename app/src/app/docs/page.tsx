import type { Metadata } from "next";
import { BUNKER_TOKEN, LAUNCHPAD_ADDRESS, POOL_ADDRESS, SWAP_EXIT_ADDRESS, CONFIGURED, explorerAddr } from "@/lib/config";

export const metadata: Metadata = { title: "Docs" };

const SECTIONS: { h: string; p: React.ReactNode }[] = [
  {
    h: "What the pool is",
    p: <>A single shielded pool contract on BNB Smart Chain holding BNB and any ERC-20, each as its own sub-pool with share accounting, under one depth-26 Poseidon Merkle tree. Notes are Zcash-Sapling style: a commitment binds an asset, an amount and a diversified Baby Jubjub address; spending reveals a nullifier and a Groth16 proof over BN254 (<code>transact2x3</code> or <code>transact4x3</code>: two or four inputs, always three outputs). The contract keeps the last 128 roots so a proof made a minute ago still verifies.</>,
  },
  {
    h: "Batched insertion",
    p: <>New commitments are queued on-chain and folded into the tree in batches by <code>drain()</code>, which anyone may call and the relayer's keeper calls within seconds. A shield or a send therefore costs a fraction of the hashing it used to, and the queue is a public fact, not a secret: a note is visible the moment it lands and spendable the moment its batch is in. The app shows the difference as <em>settling</em>. Nullifiers are never deferred; a spend is final in its own block.</>,
  },
  {
    h: "Private fees",
    p: <>Every transaction has three outputs: the payment, the change, and a note to the relayer. The relayer's fee is therefore a shielded note like any other, encrypted to the relayer's own <code>bunker1…</code> address, so nothing public says what the fee was or who was paid. A withdrawal delivers exactly the amount typed. The relayer periodically unshields its fee notes to pay for gas.</>,
  },
  {
    h: "Pay a plain address",
    p: <>A wallet can register its <code>bunker1…</code> address under its public account (<code>register</code>, one transaction). From then on anyone can type the <code>0x…</code> address in the vault and the payment lands as a shielded note, unlinkable to the sender. The registry is public; which payments reach it is not.</>,
  },
  {
    h: "Viewing keys",
    p: <>A full viewing key (<code>bunkerview1…</code>) decrypts every note, memo and spend of a vault and signs nothing. Paste it into a second device for a read-only mirror, or hand it to whoever needs to audit you. The spending seed never leaves the device that holds it.</>,
  },
  {
    h: "Keys",
    p: <>The spending key is derived in the browser from a wallet signature over a fixed message, stretched with scrypt together with a passphrase. The signature alone is not a secret (any site can ask for one); the passphrase is what stops a phished signature from opening the vault. A raw seed backup (<code>bunkerseed1…</code>) is available for people who prefer it. Nothing is stored server-side.</>,
  },
  {
    h: "Relayer",
    p: <>Sends, withdrawals, trades and swaps go through a relayer so your public wallet never signs them. The relayer receives a finished proof and ciphertexts, decrypts the fee note addressed to it, checks it covers gas, waits a random delay, and submits. It cannot alter, redirect or front-run a note; it can only decline. Anyone can run one; the app picks the cheapest healthy relayer it knows. Fees are quoted per asset at <code>/info</code> and ERC-20 fees are priced through PancakeSwap or the launchpad curve.</>,
  },
  {
    h: "Launchpad",
    p: <>Tokens launch on a constant-product curve with virtual reserves. A private buy is one pool transaction: the pool pays the launchpad through its exit hook, the curve fills the order and sends the tokens straight back to the pool, which mints them as a fresh note of yours before the transaction ends. Sells are the mirror image. No claim key, no gas from you, nothing to recover. At the graduation threshold the curve closes, liquidity is added to PancakeSwap V2 and the LP tokens are burned.</>,
  },
  {
    h: "Private swaps",
    p: <>The same exit hook reaches PancakeSwap V2: <code>SwapExit</code> takes the withdrawn asset, trades it along a path you chose (BNB, USDT, any pair through WBNB), and returns the output to the pool as a note of yours, atomically. A shielded BNB balance becomes a shielded USDT balance without any account on-chain ever holding either.</>,
  },
  {
    h: "Fee policy",
    p: <>Four agent keys vote a fee per curve. Each 80-block epoch the fee moves toward the median of fresh votes by at most 100 bps, bounded 0–500 bps, with a quorum of two. Because only votes cast before an epoch began count, a trade knows its fee before the proof is generated.</>,
  },
  {
    h: "Trust and limits",
    p: <>A guardian key can pause new shields and lower the deposit cap; it cannot touch funds, block withdrawals or alter circuits. The indexer is a convenience: anyone can rebuild the tree from chain events. Amount and timing correlations are not hidden by cryptography; the interface nudges round denominations and patience. The proving keys come from a deterministic development setup, not a multi-party ceremony; a ceremony is the next step before the pool should hold serious value. The code is new and unaudited.</>,
  },
  {
    h: "Android",
    p: (
      <>
        An Android app is available as a direct download at{" "}
        <a className="text-steel hover:text-fg" href="/android">bunkeronbnb.com/android</a>{" "}
        (<a className="text-steel hover:text-fg" href="/download/bunker-android.apk">bunker-android.apk</a>, <a className="text-steel hover:text-fg" href="/download/bunker-android.apk.sha256">sha256</a>). It needs no wallet app: on first launch it creates a vault on the phone with a built-in BNB account to shield from, proves on the device, and never backs the key up to the cloud. One backup string restores everything. On iPhone, install from Safari with Share → Add to Home Screen (<a className="text-steel hover:text-fg" href="/ios">bunkeronbnb.com/ios</a>): the same vault and proving, no App Store needed; the App Store build is in preparation.
      </>
    ),
  },
  {
    h: "Developers",
    p: (
      <>
        <span className="block mb-3">
          <code>@bunker/sdk</code> connects to this deployment directly: the same contracts, indexer, relayer and proving keys as this site, so what you build shares one anonymity set with everyone here. Proofs are generated locally; the seed never leaves your process. Full guide in the{" "}
          <a className="text-steel hover:text-fg" href="https://github.com/imadegoodstuff/bunker/tree/launchpad/sdk#readme" target="_blank" rel="noreferrer">SDK README</a>.
        </span>
        <pre className="slab p-4 overflow-x-auto font-mono text-[12px] leading-relaxed text-fg">{`import { BunkerClient } from "@bunker/sdk";
import { parseEther } from "viem";

const bunker = await BunkerClient.connect({ seed });   // BSC mainnet preset
await bunker.sync();
await bunker.shield("BNB", parseEther("0.01"), { signer: account });
await bunker.send("BNB", parseEther("0.004"), "bunker1…");
await bunker.unshield("BNB", parseEther("0.003"), "0x…");

await bunker.launchpad.buy(token, parseEther("0.05"));  // tokens land as a note, same tx
await bunker.swap("BNB", parseEther("0.1"), usdt);      // private PancakeSwap swap
await bunker.register(account);                          // let people pay your 0x privately
const mirror = await BunkerClient.connect({ viewingKey: bunker.viewingKey() });`}</pre>
        <span className="block mt-3 font-mono text-[11px]">
          indexer <code>bunker-indexer.fly.dev</code> · relayer <code>bunker-relayer.fly.dev</code> · agents <code>bunker-agents.fly.dev</code> · proving keys <code>/circuits/</code>
        </span>
      </>
    ),
  },
];

export default function Docs() {
  return (
    <div className="max-w-3xl mx-auto rise">
      <div className="label-signal mb-2">04 · Docs</div>
      <h1 className="display text-3xl md:text-4xl mb-8">How BUNKER works, briefly.</h1>
      <div className="slab p-5 mb-8 font-mono text-[11px] space-y-1.5">
        <div className="flex justify-between gap-4"><span className="text-mute">$BUNKER token</span><a className="text-signal hover:text-fg break-all" href={explorerAddr(BUNKER_TOKEN)} target="_blank" rel="noreferrer">{BUNKER_TOKEN}</a></div>
        <div className="flex justify-between gap-4"><span className="text-mute">pool</span>{CONFIGURED ? <a className="text-steel hover:text-fg break-all" href={explorerAddr(POOL_ADDRESS)} target="_blank" rel="noreferrer">{POOL_ADDRESS}</a> : <span className="text-warn">not configured</span>}</div>
        <div className="flex justify-between gap-4"><span className="text-mute">launchpad</span>{CONFIGURED ? <a className="text-steel hover:text-fg break-all" href={explorerAddr(LAUNCHPAD_ADDRESS)} target="_blank" rel="noreferrer">{LAUNCHPAD_ADDRESS}</a> : <span className="text-warn">not configured</span>}</div>
        {SWAP_EXIT_ADDRESS ? <div className="flex justify-between gap-4"><span className="text-mute">swap exit</span><a className="text-steel hover:text-fg break-all" href={explorerAddr(SWAP_EXIT_ADDRESS)} target="_blank" rel="noreferrer">{SWAP_EXIT_ADDRESS}</a></div> : null}
      </div>
      <div className="divide-y rule">
        {SECTIONS.map((s, i) => (
          <section key={s.h} className="py-8 grid md:grid-cols-[200px_1fr] gap-4">
            <h2 className="display text-lg"><span className="font-mono text-[11px] text-signal mr-3">0{i + 1}</span>{s.h}</h2>
            <div className="text-mute leading-relaxed text-[15px] [&_code]:font-mono [&_code]:text-fg [&_code]:text-[12px]">{s.p}</div>
          </section>
        ))}
      </div>
    </div>
  );
}
