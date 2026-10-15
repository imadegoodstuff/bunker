import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";
import { Figures } from "@/components/landing/Figures";
import { Contracts } from "@/components/landing/Contracts";
import { Walkthrough } from "@/components/landing/Walkthrough";
import { GITHUB } from "@/lib/config";

const PILLARS = [
  { n: "01", t: "One pool, every asset", d: "BNB and any ERC-20 share one Merkle tree. A withdrawal hides among everything ever shielded, not only among the same token." },
  { n: "02", t: "Proofs on your device, fees in notes", d: "Groth16 proofs are generated in the browser. Every transaction has three shielded outputs, payment, change and the relayer's fee, so even what you paid to be relayed is private." },
  { n: "03", t: "Trade and swap without leaving", d: "Buy on a bonding curve or swap on PancakeSwap from shielded funds. The pool pays the venue and the venue pays the pool back, in one transaction; the result is a fresh note of yours." },
  { n: "04", t: "Pay a plain address, privately", d: "Register your vault under your 0x account once. Anyone can then pay the address they already know, and the money lands shielded, unlinkable to them." },
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
      <section className="relative overflow-hidden border-b rule">
        <div className="aurora" />
        <div className="absolute inset-0 grid-bg" />
        <div className="relative max-w-7xl mx-auto px-5 md:px-10 pt-16 md:pt-28 pb-16 md:pb-28">
          <div className="grid lg:grid-cols-[1fr_auto] gap-10 lg:gap-16 items-center">
            <div>
              <div className="inline-flex items-center gap-3 mb-8 rise">
                <span className="inline-block w-1.5 h-1.5 bg-ok dot-ok blink" />
                <span className="label-signal">Shielded pool · private launchpad · BNB Smart Chain</span>
              </div>
              <h1 className="display text-[18vw] md:text-[11rem] leading-[0.85] font-bold rise" style={{ animationDelay: ".05s" }}>
                <span className="metal">BUN</span><span className="gold">K</span><span className="metal">ER</span>
              </h1>
            </div>
            <div className="relative justify-self-center lg:justify-self-end rise" style={{ animationDelay: ".1s" }}>
              <div className="absolute -inset-10 rounded-full blur-3xl opacity-50" style={{ background: "radial-gradient(closest-side, var(--color-signal), transparent 70%)" }} />
              <div className="absolute inset-0 rounded-full" style={{ boxShadow: "0 0 120px 20px rgb(246 183 60 / 0.12)" }} />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/mark-512.png" alt="BUNKER vault mark" className="relative w-[220px] md:w-[300px] lg:w-[360px] h-auto select-none drop-shadow-[0_30px_60px_rgba(0,0,0,0.8)]" draggable={false} />
            </div>
          </div>
          <div className="grid md:grid-cols-[1fr_auto] gap-8 items-end mt-12">
            <p className="text-lg md:text-2xl text-mute max-w-2xl leading-snug rise" style={{ animationDelay: ".15s" }}>
              Shield once. Then send, trade and launch tokens with no trace back to your wallet. <span className="text-fg">Zcash-Sapling cryptography</span>, proofs made in your browser, contracts you can read.
            </p>
            <div className="flex gap-3 rise" style={{ animationDelay: ".25s" }}>
              <Link href="/app" className="btn btn-signal h-12 px-7">Open vault</Link>
              <a href={GITHUB} target="_blank" rel="noreferrer" className="btn h-12 px-7">Source</a>
            </div>
          </div>
        </div>
        <div className="hair absolute bottom-0 left-0 right-0" />
      </section>

      <Contracts />

      <Figures />

      {/* pillars */}
      <section className="border-b rule">
        <div className="max-w-7xl mx-auto grid md:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((p, i) => (
            <div key={p.n} className={`group relative p-8 md:p-10 border-b md:border-b-0 rule transition hover:bg-[rgb(255_255_255/0.015)] ${i < PILLARS.length - 1 ? "lg:border-r md:[&:nth-child(odd)]:border-r lg:[&:nth-child(odd)]:border-r" : ""}`}>
              <div className="absolute top-0 left-0 right-0 h-px bg-signal opacity-0 group-hover:opacity-100 transition" />
              <div className="font-mono text-[11px] text-signal mb-8 flex items-center gap-3"><span>{p.n}</span><span className="h-px w-8 bg-signal/40" /></div>
              <h3 className="display text-xl md:text-[22px] mb-3">{p.t}</h3>
              <p className="text-[15px] text-mute leading-relaxed">{p.d}</p>
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
