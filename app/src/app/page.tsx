import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Veil } from "@/components/landing/Veil";
import { Figures } from "@/components/landing/Figures";
import { LedgerDemo } from "@/components/landing/LedgerDemo";
import { Anatomy } from "@/components/landing/Anatomy";
import { Reveal } from "@/components/landing/Reveal";

const GH = "https://github.com/imadegoodstuff/scash";

const steps = [
  { n: "01", t: "Shield", b: "Move SOL or tokens from your wallet into the pool. This is the only public step." , icon: ShieldIcon },
  { n: "02", t: "Send", b: "Pay any scash address. Amount, sender and recipient are encrypted; a relayer pays gas.", icon: SendIcon },
  { n: "03", t: "Withdraw", b: "Exit to a fresh wallet whenever you like. Nothing links it to the deposit.", icon: ExitIcon },
];

const guarantees = [
  ["Nobody can freeze a note", "No upgrade authority, no admin path to a note. The one privileged key can only pause new deposits or lower the cap."],
  ["The pool cannot overpay", "A per-asset turnstile enforces total out ≤ total in outside the circuit. A broken proof could never drain more than was deposited."],
  ["Proofs never leave your device", "Keys, notes and proofs live in the page. The indexer serves ciphertext, the relayer forwards bytes. Neither can read a thing."],
  ["Private, still provable", "Show one payment to one party with a receipt, and nothing else, when you must."],
];

const faq = [
  ["Is the deposit private?", "No. Shielding is public: an address put X SOL into the pool. Everything after it is private. You hide among the other notes of the same asset, so use round amounts and wait before withdrawing."],
  ["Who pays the network fee?", "A relayer. Its fee is deducted inside the proof from your notes, so the address that receives funds never needs SOL for gas."],
  ["Where does the yield come from?", "Creator fees from SCASH trading are harvested and donated into the SCASH pool. Balances there are shares, so every SCASH note grows at once. It only applies to the SCASH pool and depends on trading volume."],
  ["What if this site disappears?", "Your keys come from your wallet signature (plus passphrase), and every ciphertext is on-chain. Any copy of the open-source app recovers the same notes."],
  ["Is it audited?", "Not yet. This is a devnet pre-release with development proving keys. The code, the ceremony transcript and the audit package are public; SECURITY.md lists every known limitation."],
  ["Can a phishing site steal my keys?", "Any site can ask your wallet to sign the fixed message, which is why the app asks for a passphrase mixed into the key. A stolen signature alone is useless. If another site asks you to sign it, refuse."],
];

export default function Landing() {
  return (
    <>
      <Nav />
      <main className="relative">
        {/* hero */}
        <section className="hero-glow relative overflow-hidden">
          <div className="dots pointer-events-none absolute inset-0 -z-10" />
          <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 pb-20 pt-20 md:pt-28 lg:grid-cols-[1fr_1fr] lg:gap-10">
            <div>
              <Reveal>
                <span className="eyebrow">shielded pool · solana</span>
                <h1 className="display mt-5 text-[2.9rem] sm:text-6xl xl:text-[5.4rem]">
                  Money on Solana,
                  <br />
                  <span className="serif italic font-normal gradient-text">without an audience.</span>
                </h1>
              </Reveal>
              <Reveal delay={0.1}>
                <p className="mt-7 max-w-md text-[17px] leading-relaxed text-mute">
                  Balances live in encrypted notes. The chain only ever sees proofs. Shield, send, withdraw — three steps, one wallet signature.
                </p>
                <div className="mt-9 flex flex-wrap items-center gap-3">
                  <Link href="/app" className="btn-primary px-6">Open app</Link>
                  <a href="#how" className="btn-ghost">See how it works</a>
                </div>
                <p className="mt-5 text-xs text-dim">Devnet pre-release · open source · Zcash Sapling design</p>
              </Reveal>
            </div>
            <Reveal delay={0.15}><Veil /></Reveal>
          </div>
          <div className="mx-auto max-w-6xl px-6 pb-16">
            <Reveal><div className="border-t border-line pt-8"><Figures /></div></Reveal>
          </div>
        </section>

        {/* three steps */}
        <section id="how" className="band">
          <div className="mx-auto max-w-6xl px-6 py-28">
            <Reveal>
              <span className="eyebrow">how it works</span>
              <h2 className="display mt-4 max-w-2xl text-4xl md:text-5xl">Three moves. <span className="serif italic font-normal text-mute">That&apos;s the whole product.</span></h2>
            </Reveal>
            <div className="mt-14 grid gap-4 md:grid-cols-3">
              {steps.map((s, i) => (
                <Reveal key={s.t} delay={i * 0.08}>
                  <div className="glass h-full p-7">
                    <div className="flex items-center justify-between">
                      <s.icon />
                      <span className="font-mono text-[11px] text-dim">{s.n}</span>
                    </div>
                    <h3 className="mt-8 text-2xl tracking-tight">{s.t}</h3>
                    <p className="mt-3 text-[15px] leading-relaxed text-mute">{s.b}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ledger */}
        <section className="border-t border-line">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-28 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
            <Reveal>
              <span className="eyebrow">the public record</span>
              <h2 className="display mt-4 text-4xl md:text-5xl">Same chain. <span className="serif italic font-normal text-mute">Nothing to read.</span></h2>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-mute">
                A normal transfer publishes who paid whom and how much, forever. A scash transfer publishes a nullifier, a commitment and ciphertext. Flip the switch.
              </p>
            </Reveal>
            <Reveal delay={0.1}><LedgerDemo /></Reveal>
          </div>
        </section>

        {/* follow one payment */}
        <section className="border-t border-line band">
          <div className="mx-auto max-w-6xl px-6 py-28">
            <Reveal>
              <span className="eyebrow">follow one payment</span>
              <h2 className="display mt-4 text-4xl md:text-5xl">Who learns what.</h2>
              <p className="mt-4 max-w-lg text-[15px] text-mute">Send 0.4 SOL to a friend and watch what each party on the way can see.</p>
            </Reveal>
            <Reveal delay={0.1}><div className="mt-14"><Anatomy /></div></Reveal>
          </div>
        </section>

        {/* yield */}
        <section id="yield" className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-28 lg:grid-cols-[1fr_1fr] lg:gap-20">
            <Reveal>
              <span className="eyebrow">holder yield</span>
              <h2 className="display mt-4 text-4xl md:text-5xl">Shares, <span className="serif italic font-normal text-mute">not tokens.</span></h2>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-mute">
                A SCASH note holds a share of the SCASH pool. Creator fees from every trade are donated into the pool, so every private SCASH balance grows without a transaction, a claim, or a link to you. SOL and other pools keep a fixed rate of 1.
              </p>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="glass p-7">
                <div className="text-xs text-mute">SCASH per share</div>
                <div className="mt-2 font-mono text-5xl tabular-nums tracking-tight">1.0000</div>
                <div className="mt-2 text-xs text-dim">at launch · rises with every donation · the program has no instruction that lowers it</div>
                <ol className="mt-8 space-y-4 border-t border-line pt-6 text-sm">
                  {[["Trade", "every SCASH trade pays a creator fee"], ["Harvest", "anyone calls the harvester; it swaps the fee to SCASH and donates it"], ["Grow", "the pool grows, every share is backed by more SCASH"]].map(([t, b], i) => (
                    <li key={t} className="grid grid-cols-[2rem_6rem_1fr] items-baseline gap-2">
                      <span className="font-mono text-[11px] text-dim">0{i + 1}</span>
                      <span className="font-medium">{t}</span>
                      <span className="text-mute">{b}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </Reveal>
          </div>
        </section>

        {/* guarantees */}
        <section id="security" className="border-t border-line band">
          <div className="mx-auto max-w-6xl px-6 py-28">
            <Reveal>
              <span className="eyebrow">guarantees</span>
              <h2 className="display mt-4 text-4xl md:text-5xl">No keys but yours.</h2>
            </Reveal>
            <div className="mt-12 grid gap-4 md:grid-cols-2">
              {guarantees.map(([t, b], i) => (
                <Reveal key={t} delay={i * 0.06}>
                  <div className="glass p-7">
                    <h3 className="text-lg font-medium tracking-tight">{t}</h3>
                    <p className="mt-3 text-[15px] leading-relaxed text-mute">{b}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal>
              <div className="mt-8 flex flex-wrap gap-x-8 gap-y-2 font-mono text-[11px] text-dim">
                <span>Groth16 · BN254 · 33k constraints</span>
                <span>Poseidon · 2²⁶ leaves · 128-root ring</span>
                <span>Verified in CI against the exact on-chain verifier</span>
                <a className="link" href={`${GH}/blob/main/SECURITY.md`}>Known limitations →</a>
              </div>
            </Reveal>
          </div>
        </section>

        {/* faq */}
        <section id="faq" className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-28 lg:grid-cols-[18rem_1fr]">
            <Reveal>
              <h2 className="display text-4xl">Questions.</h2>
              <p className="mt-3 text-sm text-mute">Everything else is in the <a href={`${GH}/blob/main/SPEC.md`} className="link underline underline-offset-4">spec</a>.</p>
            </Reveal>
            <Reveal delay={0.1}>
              {faq.map(([q, a]) => (
                <details key={q} className="faq">
                  <summary>{q}</summary>
                  <p>{a}</p>
                </details>
              ))}
            </Reveal>
          </div>
        </section>

        {/* cta */}
        <section className="relative overflow-hidden border-t border-line">
          <div className="hero-glow absolute inset-0 -z-10" />
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-6 py-24 md:flex-row md:items-center">
            <Reveal>
              <h2 className="display text-4xl md:text-5xl">Your balance is <span className="serif italic font-normal gradient-text">nobody&apos;s business.</span></h2>
            </Reveal>
            <Reveal delay={0.1}><Link href="/app" className="btn-primary px-6">Open app</Link></Reveal>
          </div>
        </section>

        <footer className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 text-sm md:grid-cols-[1fr_repeat(3,10rem)]">
            <div>
              <div className="flex items-center gap-2 font-medium"><img src="/icon.svg" alt="" className="h-5 w-5 rounded-md" /> scash</div>
              <p className="mt-3 max-w-xs text-xs leading-relaxed text-dim">Shielded notes on Solana. Pre-release: not audited, development proving keys. MIT licensed.</p>
              <p className="mt-3 font-mono text-[11px] text-dim">
                build{" "}
                <a className="underline-offset-2 hover:underline" href={`${GH}/commit/${process.env.NEXT_PUBLIC_GIT_SHA ?? "main"}`}>
                  {(process.env.NEXT_PUBLIC_GIT_SHA ?? "unknown").slice(0, 12)}
                </a>
                {" · "}program {process.env.NEXT_PUBLIC_PROGRAM_ID?.slice(0, 8) ?? "default"}…
              </p>
            </div>
            <Col title="Product" links={[["App", "/app"], ["Spec", `${GH}/blob/main/SPEC.md`]]} />
            <Col title="Security" links={[["Policy", `${GH}/blob/main/SECURITY.md`], ["Ceremony", `${GH}/blob/main/ceremony/README.md`], ["Audit package", `${GH}/tree/main/audit`]]} />
            <Col title="Code" links={[["GitHub", GH], ["Program", `${GH}/tree/main/programs/scash_vault`]]} />
          </div>
        </footer>
      </main>
    </>
  );
}

function Col({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="text-xs text-dim">{title}</div>
      <ul className="mt-3 space-y-2">
        {links.map(([l, h]) => (
          <li key={l}><a href={h} className="link">{l}</a></li>
        ))}
      </ul>
    </div>
  );
}

function ShieldIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-accent" aria-hidden>
      <path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}
function SendIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-accent" aria-hidden>
      <path d="M4 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
function ExitIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-accent" aria-hidden>
      <path d="M12 4v11M7 10l5 5 5-5" />
      <path d="M4 20h16" />
    </svg>
  );
}
