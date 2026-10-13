import Link from "next/link";
import { Nav } from "@/components/Nav";
import { LedgerDemo } from "@/components/landing/LedgerDemo";
import { Figures } from "@/components/landing/Figures";
import { Anatomy } from "@/components/landing/Anatomy";

const GH = "https://github.com/imadegoodstuff/scash";

const guarantees = [
  ["No one can freeze a note", "The program has no upgrade authority and no admin path to a note. The only privileged key can pause new deposits or lower the TVL cap. Sends and withdrawals never pause."],
  ["The pool cannot overpay", "A per-asset turnstile enforces total out ≤ total in, outside the circuit. Even a broken proof system could not drain more than was deposited."],
  ["Proofs stay on your device", "Keys, notes and proofs live in the page. The indexer serves ciphertext; the relayer forwards bytes. Neither can read a thing."],
  ["Private, still provable", "Scoped viewing keys and per-payment receipts let you show one payment to one party, and nothing else, when you must."],
];

const yieldFlow = [
  ["Every trade", "SCASH launches on a Meteora bonding curve and graduates to DAMM v2. Each trade pays a creator fee."],
  ["Harvester", "An on-chain program anyone can call claims the fee, swaps it and donates it into the shielded pool."],
  ["Every note", "Notes hold pool shares. A donation raises the share rate, so every private balance grows without a transaction."],
];

const faq = [
  ["What is scash, in one sentence?", "A shielded pool on Solana built on the Zcash Sapling design: diversified addresses, note commitments in a Merkle tree, position-bound nullifiers and Groth16 proofs verified by an immutable program."],
  ["Is shielding private?", "The deposit itself is public: an address put X SOL into the pool. Everything after it is not. You hide among the other notes of the same asset, not among every note in the tree, so use round amounts and wait before withdrawing."],
  ["Who pays the network fee?", "For sends and withdrawals, a relayer does. Its fee is deducted inside the proof from your notes, so the address that receives funds never has to hold SOL for gas."],
  ["Where does the yield come from?", "Creator fees from SCASH trading are harvested and donated into the pool. Balances are denominated in shares; a donation lifts the share rate for everyone at once."],
  ["Can anyone take or freeze my notes?", "No. The program cannot be upgraded and has no instruction that moves a note without its owner's proof. The guardian can only pause new deposits and lower the TVL cap."],
  ["What if this website disappears?", "Your keys come from your wallet's signature, and every ciphertext is on-chain. Any copy of the open-source app, or your own, recovers the same notes."],
  ["Is it audited?", "No. This is a pre-release with development proving keys and no independent audit of the circuits or programs. The code is open source and cross-tested in CI, which is not the same thing. SECURITY.md lists the known limitations in priority order."],
  ["Can a phishing site steal my keys?", "Keys come from a wallet signature over a fixed message, and any site can request a signature. That is why the app asks for a passphrase: it is mixed into the key and a stolen signature is useless without it. Read the message your wallet shows; if any other site asks you to sign it, refuse."],
  ["How large can a memo be?", "64 bytes. A private payment already uses most of Solana's 1,232-byte packet, and the SDK test suite asserts that one 64-byte bucket fits and a second does not."],
];

export default function Landing() {
  return (
    <>
      <Nav />
      <main>
        {/* hero */}
        <section className="accent-glow">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-16 pt-16 md:pt-24 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
            <div>
              <h1 className="display text-5xl md:text-6xl xl:text-7xl">
                Money on Solana,
                <br />
                <span className="serif italic font-normal">without an audience.</span>
              </h1>
              <p className="mt-7 max-w-md text-[17px] leading-relaxed text-mute">
                scash is a shielded pool built on the Zcash Sapling design. Balances live in encrypted notes; the chain only ever sees proofs. Every private balance earns.
              </p>
              <div className="mt-9 flex flex-wrap items-center gap-4">
                <Link href="/app" className="btn-primary px-5">Open app</Link>
                <a href={`${GH}/blob/main/SPEC.md`} target="_blank" rel="noreferrer" className="btn-ghost">Read the spec</a>
              </div>
            </div>
            <LedgerDemo />
          </div>
          <div className="mx-auto max-w-6xl px-6 pb-20">
            <Figures />
          </div>
        </section>

        {/* anatomy */}
        <section id="how" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-24">
            <p className="font-mono text-xs text-accent">how it works</p>
            <h2 className="display mt-3 text-4xl md:text-5xl">Follow one payment.</h2>
            <p className="mt-4 max-w-lg text-[15px] text-mute">Send 0.4 SOL to a friend and watch what each party learns along the way.</p>
            <div className="mt-14">
              <Anatomy />
            </div>
          </div>
        </section>

        {/* yield */}
        <section id="yield" className="grid-bg border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-24">
            <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:gap-16">
              <div>
                <p className="font-mono text-xs text-accent">holder yield</p>
                <h2 className="display mt-3 text-4xl md:text-5xl">Shares, <span className="serif italic font-normal">not tokens.</span></h2>
                <p className="mt-5 max-w-md text-[15px] leading-relaxed text-mute">
                  A note doesn&apos;t hold SOL; it holds a share of the pool. When fees are donated, the pool grows and every share is worth more. No staking, no claiming, no transaction linking you to the yield.
                </p>
                <div className="card mt-8 inline-block bg-raise px-5 py-4">
                  <div className="text-xs text-mute">Value of one share</div>
                  <div className="mt-1 font-mono text-3xl tabular-nums">1.0000 <span className="text-base text-dim">at launch</span></div>
                  <div className="mt-1 text-xs text-dim">rises with every donation; can never fall</div>
                </div>
              </div>
              <ol className="divide-y divide-line border-y border-line">
                {yieldFlow.map(([t, b], i) => (
                  <li key={t} className="grid gap-2 py-6 md:grid-cols-[3rem_10rem_1fr]">
                    <span className="font-mono text-xs text-dim">0{i + 1}</span>
                    <span className="font-medium">{t}</span>
                    <span className="text-[15px] leading-relaxed text-mute">{b}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* guarantees */}
        <section id="security" className="border-t border-line">
          <div className="mx-auto max-w-6xl px-6 py-24">
            <p className="font-mono text-xs text-accent">guarantees</p>
            <h2 className="display mt-3 text-4xl md:text-5xl">No keys but yours.</h2>
            <div className="mt-12 grid gap-px overflow-hidden rounded-xl border border-line bg-line md:grid-cols-2">
              {guarantees.map(([t, b]) => (
                <div key={t} className="bg-bg p-7">
                  <h3 className="text-lg font-medium tracking-tight">{t}</h3>
                  <p className="mt-3 text-[15px] leading-relaxed text-mute">{b}</p>
                </div>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap gap-x-8 gap-y-2 text-xs text-dim">
              <span>Groth16 · BN254 · 33k constraints</span>
              <span>Poseidon commitments · 2²⁶ leaves · 128-root ring</span>
              <span>Verified in CI against the exact on-chain verifier</span>
            </div>
          </div>
        </section>

        {/* faq */}
        <section id="faq" className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-24 lg:grid-cols-[18rem_1fr]">
            <div>
              <h2 className="display text-4xl">Questions.</h2>
              <p className="mt-3 text-sm text-mute">The details are in the <a href={`${GH}/blob/main/SPEC.md`} className="link underline underline-offset-4">spec</a>.</p>
            </div>
            <div>
              {faq.map(([q, a]) => (
                <details key={q} className="faq">
                  <summary>{q}</summary>
                  <p>{a}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* cta */}
        <section className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-6 px-6 py-20 md:flex-row md:items-center">
            <h2 className="display text-3xl md:text-4xl">Your balance is <span className="serif italic font-normal">nobody&apos;s business.</span></h2>
            <Link href="/app" className="btn-primary px-5">Open app</Link>
          </div>
        </section>

        <footer className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-10 px-6 py-14 text-sm md:grid-cols-[1fr_repeat(3,10rem)]">
            <div>
              <div className="font-medium">scash</div>
              <p className="mt-2 max-w-xs text-xs leading-relaxed text-dim">Shielded notes on Solana. Pre-release: not audited, development proving keys. MIT licensed.</p>
            </div>
            <Col title="Product" links={[["App", "/app"], ["Spec", `${GH}/blob/main/SPEC.md`]]} />
            <Col title="Security" links={[["Policy", `${GH}/blob/main/SECURITY.md`], ["Ceremony", `${GH}/blob/main/ceremony/README.md`]]} />
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
