import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";
import { Figures } from "@/components/landing/Figures";
import { Contracts } from "@/components/landing/Contracts";
import { Walkthrough } from "@/components/landing/Walkthrough";
import { GITHUB } from "@/lib/config";

const PILLARS = [
  { n: "01", t: "One pool, every asset", d: "BNB and any ERC-20 share one Merkle tree. A withdrawal hides among everything ever shielded, not only among the same token." },
  { n: "02", t: "Proofs on your device", d: "Groth16 proofs are generated in the browser. The relayer sees a proof and a ciphertext; it cannot learn what you own or where it came from." },
  { n: "03", t: "A launchpad inside the pool", d: "Buy and sell on bonding curves from shielded funds. Tokens return to the vault through a throwaway claim key that links one trade and nothing else." },
  { n: "04", t: "Fees set by four agents", d: "Trading fees move toward the median of fresh votes from four independent model-driven keys, one step per epoch, bounded 0–5 %. Nobody can set it directly." },
];

export default function Landing() {
  return (
    <div className="min-h-screen grain">
      <header className="h-14 flex items-center justify-between px-5 md:px-10 border-b rule">
        <Wordmark className="h-7" />
        <nav className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.18em]">
          <Link href="/launch" className="btn btn-ghost btn-sm hidden sm:inline-flex">Launchpad</Link>
          <Link href="/agents" className="btn btn-ghost btn-sm hidden sm:inline-flex">Agents</Link>
          <Link href="/docs" className="btn btn-ghost btn-sm hidden sm:inline-flex">Docs</Link>
          <Link href="/android" className="btn btn-ghost btn-sm hidden md:inline-flex">Android</Link>
          <Link href="/ios" className="btn btn-ghost btn-sm hidden md:inline-flex">iPhone</Link>
          <Link href="/app" className="btn btn-signal btn-sm ml-2">Open vault</Link>
        </nav>
      </header>

      {/* hero */}
      <section className="relative overflow-hidden border-b rule grid-bg">
        <div className="scanline" />
        <div className="max-w-7xl mx-auto px-5 md:px-10 pt-16 md:pt-24 pb-16 md:pb-24">
          <div className="grid lg:grid-cols-[1fr_auto] gap-10 lg:gap-16 items-center">
            <div>
              <div className="label-signal mb-6 rise">Shielded pool · private launchpad · BNB Smart Chain</div>
              <h1 className="display text-[18vw] md:text-[11rem] leading-[0.85] font-bold rise" style={{ animationDelay: ".05s" }}>
                BUN<span className="text-signal">K</span>ER
              </h1>
            </div>
            <div className="relative justify-self-center lg:justify-self-end rise" style={{ animationDelay: ".1s" }}>
              <div className="absolute inset-0 rounded-full blur-3xl opacity-40" style={{ background: "radial-gradient(closest-side, var(--color-signal), transparent 70%)" }} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/mark-512.png" alt="BUNKER vault mark" className="relative w-[220px] md:w-[300px] lg:w-[340px] h-auto select-none" draggable={false} />
            </div>
          </div>
          <div className="grid md:grid-cols-[1fr_auto] gap-8 items-end mt-10">
            <p className="text-lg md:text-2xl text-mute max-w-2xl leading-snug rise" style={{ animationDelay: ".15s" }}>
              Shield once. Then send, trade and launch tokens with no trace back to your wallet. Zcash-Sapling cryptography, proofs made in your browser, contracts you can read.
            </p>
            <div className="flex gap-2 rise" style={{ animationDelay: ".25s" }}>
              <Link href="/app" className="btn btn-signal h-12 px-6">Open vault</Link>
              <a href={GITHUB} target="_blank" rel="noreferrer" className="btn h-12 px-6">Source</a>
            </div>
          </div>
        </div>
      </section>

      <Contracts />

      <Figures />

      {/* pillars */}
      <section className="border-b rule">
        <div className="max-w-7xl mx-auto grid md:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((p, i) => (
            <div key={p.n} className={`p-8 md:p-10 border-b md:border-b-0 rule ${i < PILLARS.length - 1 ? "lg:border-r md:[&:nth-child(odd)]:border-r lg:[&:nth-child(odd)]:border-r" : ""}`}>
              <div className="font-mono text-[11px] text-signal mb-6">{p.n}</div>
              <h3 className="display text-xl mb-3">{p.t}</h3>
              <p className="text-sm text-mute leading-relaxed">{p.d}</p>
            </div>
          ))}
        </div>
      </section>

      <Walkthrough />

      {/* honesty block */}
      <section className="border-b rule">
        <div className="max-w-7xl mx-auto px-5 md:px-10 py-16 grid lg:grid-cols-[1fr_1fr] gap-10">
          <div>
            <div className="label-signal mb-4">What it is not</div>
            <h2 className="display text-3xl md:text-4xl">Privacy with the fine print printed large.</h2>
          </div>
          <ul className="space-y-4 text-sm text-mute leading-relaxed">
            <li className="pl-4 border-l rule"><b className="text-fg">Amounts and timing leak.</b> Shield 3.1415 BNB and withdraw 3.1415 BNB an hour later and anyone can connect the two. Use round amounts and wait.</li>
            <li className="pl-4 border-l rule"><b className="text-fg">The relayer is a server.</b> It cannot steal or deanonymise notes, but it can refuse to serve you. You can always submit a transaction yourself.</li>
            <li className="pl-4 border-l rule"><b className="text-fg">There is a guardian.</b> One key can pause new shields and lower the deposit cap. It cannot touch funds, block withdrawals, or change the circuits.</li>
            <li className="pl-4 border-l rule"><b className="text-fg">Not audited.</b> The circuits, contracts and this site are open source and new. Treat the pool as experimental software.</li>
          </ul>
        </div>
      </section>

      <footer className="max-w-7xl mx-auto px-5 md:px-10 h-16 flex items-center justify-between font-mono text-[10.5px] text-dim">
        <span>BUNKER · bunkeronbnb.com</span>
        <div className="flex gap-5">
          <Link href="/docs" className="hover:text-fg">docs</Link>
          <a href={GITHUB} target="_blank" rel="noreferrer" className="hover:text-fg">github</a>
        </div>
      </footer>
    </div>
  );
}
