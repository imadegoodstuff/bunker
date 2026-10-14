import Link from "next/link";
import { Nav } from "@/components/Nav";
import { Veil } from "@/components/landing/Veil";
import { Figures } from "@/components/landing/Figures";
import { LedgerDemo } from "@/components/landing/LedgerDemo";
import { Anatomy } from "@/components/landing/Anatomy";
import { Reveal } from "@/components/landing/Reveal";
import { Builds } from "@/components/landing/Builds";

const GH = "https://github.com/imadegoodstuff/scash";

const steps = [
  { n: "01", t: "Shield", b: "Move SOL or any token from your wallet into the pool. One signature. This is the only public step you ever take.", icon: ShieldIcon },
  { n: "02", t: "Send, trade, hold", b: "Pay any scash address, buy a launch, or just sit. Amount, sender and recipient are encrypted; a relayer pays gas, so the receiving side never needs SOL.", icon: SendIcon },
  { n: "03", t: "Withdraw", b: "Exit to a fresh wallet whenever you like. Nothing on-chain links it to the deposit; round amounts and patience keep timing from doing so.", icon: ExitIcon },
];

const why: [string, string][] = [
  ["No pause switch. No admin. No multisig.", "There is no key that can freeze, pause or move a note, and no committee that could be pressured into it. The only privileged action in the whole protocol is lowering the cap on new deposits. Once the public ceremony's keys are burned in, the upgrade authority is revoked and the vault is immutable."],
  ["A launchpad that lives inside the pool.", "The first launchpad whose primary market exists only behind the privacy wall. You buy and sell new tokens from your shielded balance; your wallet never appears in a single launchpad transaction. At 20 SOL the curve becomes a Raydium pool with every LP token burned."],
  ["Yield without a transaction.", "Notes hold shares, not fixed amounts. When fees are donated into a pool, every private balance in it grows at once: no claim, no transaction, no link to you. The share rate has no instruction that lowers it."],
  ["Fees set by four AI agents, not a team.", "Each launched token's trading tax (0–5 %) is voted on every minute by four independent model-driven agents holding four keys. No proposer, no guardian, no veto. Every vote is on-chain with its reason, and the tax funds buybacks of the scash token."],
  ["Nothing to enter, move or exit.", "The protocol charges no fee to shield, send or withdraw. You pay the relayer's network fee (0.05 % with a small floor), deducted inside the proof, and nothing else."],
  ["2⁸⁸ addresses from one key.", "Zcash Sapling design: one viewing key yields an endless supply of unlinkable receiving addresses, and nothing has to be registered on-chain to receive. Share a fresh one with every counterparty."],
  ["Built on Solana's 4 KB transactions.", "A full shielded transfer, proof and all, fits in one transaction on the new v1 format. No lookup-table gymnastics, no multi-step settlement, no partial state to clean up."],
  ["Every byte is checkable.", "CI verifies the on-chain bytecode against the build, the proving keys against the circuits, and the ceremony transcript against the chain on every run. The spec, the security policy and the audit package are public, and every ciphertext is on-chain, so any copy of the open-source app recovers your notes."],
];

const guarantees = [
  ["Nobody can freeze a note", "No admin path to a note. The one privileged key can only pause new deposits or lower the cap. The upgrade authority is kept only until the ceremony keys are burned in, then revoked; until then it is the one thing to trust."],
  ["The pool cannot overpay", "A per-asset turnstile enforces total out ≤ total in outside the circuit. A broken proof could never drain more than was deposited."],
  ["Proofs never leave your device", "Keys, notes and proofs live in the page. The indexer serves ciphertext, the relayer forwards bytes. Neither can read a thing."],
  ["Private, still provable", "Show one payment to one party with a receipt, and nothing else, when you must."],
];

const faq = [
  ["Is the deposit private?", "No. Shielding is public: an address put X SOL into the pool. Everything after it is private. You hide among the other notes of the same asset, so use round amounts and wait before withdrawing."],
  ["Who pays the network fee?", "A relayer. Its fee is deducted inside the proof from your notes, so the address that receives funds never needs SOL for gas."],
  ["How does the launchpad stay private?", "A buy is an unshield whose exit target is the token's curve; the tokens land at a one-use key derived from your seed and are shielded straight back into that token's own pool. A sell is the same in reverse. The curve, the relayer and the chain see throwaway keys, never your wallet."],
  ["Where does the yield come from?", "Creator fees from SCASH trading are harvested and donated into the SCASH pool. Balances there are shares, so every SCASH note grows at once. It only applies to the SCASH pool and depends on trading volume."],
  ["What if this site disappears?", "Your keys come from your wallet signature (plus passphrase), and every ciphertext is on-chain. Any copy of the open-source app recovers the same notes."],
  ["Is it audited?", "An independent audit is not published yet. The code, the ceremony transcript and the audit package are public, and the proving keys switch to the public ceremony's keys when it completes."],
  ["Can a phishing site steal my keys?", "Any site can ask your wallet to sign the fixed message, which is why the app asks for a passphrase mixed into the key. With a passphrase set, a stolen signature alone is useless; if you turned the passphrase off, it is the whole key. If another site asks you to sign it, refuse."],
  ["What can the relayer and indexer see?", "Not your notes or keys. They do see your IP address, when you ask and what you ask for: the indexer sees which pages of ciphertext you fetch, the relayer sees when a proof arrives. The relayer's random delay weakens timing correlation; it does not remove it. Use a VPN or Tor and avoid withdrawing right after depositing if that matters to you."],
];

export default function Landing() {
  return (
    <>
      <Nav />
      <main className="relative">
        {/* hero */}
        <section className="hero-glow relative overflow-hidden">
          <div className="dots pointer-events-none absolute inset-0 -z-10" />
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-14 sm:px-6 sm:pt-20 md:pt-28 lg:grid-cols-[1.05fr_0.95fr] lg:gap-10">
            <div>
              <Reveal>
                <span className="eyebrow">solana&apos;s first shielded pool · private launchpad</span>
                <h1 className="display mt-5 text-[2.6rem] sm:text-6xl xl:text-[5.2rem]">
                  Private money on Solana.
                  <br />
                  <span className="serif italic font-normal gradient-text">Private launches, too.</span>
                </h1>
              </Reveal>
              <Reveal delay={0.1}>
                <p className="mt-6 max-w-lg text-[16px] leading-relaxed text-mute sm:mt-7 sm:text-[17px]">
                  A Zcash-Sapling shielded pool on Solana mainnet: balances live in encrypted notes, the chain only sees proofs, and a launchpad runs entirely inside the pool. Shield once; send, trade and launch with no trace back to your wallet.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-3 sm:mt-9">
                  <Link href="/app" className="btn-primary px-6">Open app</Link>
                  <Link href="/launch" className="btn-ghost">Launchpad</Link>
                  <a href="#how" className="btn-ghost hidden sm:inline-flex">See how it works</a>
                </div>
                <ul className="mt-6 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] uppercase tracking-wider text-dim">
                  <li className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-ok" /> live on mainnet</li>
                  <li>no admin key</li>
                  <li>open source</li>
                  <li>zcash sapling design</li>
                </ul>
              </Reveal>
            </div>
            <Reveal delay={0.15}><div className="hidden sm:block"><Veil /></div></Reveal>
          </div>
          <div className="mx-auto max-w-6xl px-5 pb-14 sm:px-6 sm:pb-16">
            <Reveal><div className="border-t border-line pt-8"><Figures /></div></Reveal>
          </div>
        </section>

        {/* three steps */}
        <section id="how" className="band scroll-mt-24">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6 sm:py-28">
            <Reveal>
              <span className="eyebrow">how it works</span>
              <h2 className="display mt-4 max-w-2xl text-4xl md:text-5xl">Three moves. <span className="serif italic font-normal text-mute">That&apos;s the whole product.</span></h2>
            </Reveal>
            <div className="mt-10 grid gap-4 sm:mt-14 md:grid-cols-3">
              {steps.map((s, i) => (
                <Reveal key={s.t} delay={i * 0.08}>
                  <div className="glass h-full p-6 sm:p-7">
                    <div className="flex items-center justify-between">
                      <s.icon />
                      <span className="font-mono text-[11px] text-dim">{s.n}</span>
                    </div>
                    <h3 className="mt-6 text-2xl tracking-tight sm:mt-8">{s.t}</h3>
                    <p className="mt-3 text-[15px] leading-relaxed text-mute">{s.b}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* why */}
        <section id="why" className="scroll-mt-24 border-t border-line">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6 sm:py-28">
            <Reveal>
              <span className="eyebrow">why scash</span>
              <h2 className="display mt-4 max-w-3xl text-4xl md:text-5xl">Built like a protocol, <span className="serif italic font-normal text-mute">not a product.</span></h2>
              <p className="mt-5 max-w-xl text-[15px] leading-relaxed text-mute">
                Everything below is enforced by the programs, mirrored in the SDK and checked in CI. None of it depends on trusting us.
              </p>
            </Reveal>
            <div className="mt-10 grid gap-4 sm:mt-14 md:grid-cols-2">
              {why.map(([t, b], i) => (
                <Reveal key={t} delay={(i % 2) * 0.06}>
                  <div className="glass h-full p-6 sm:p-7">
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="text-xl tracking-tight">{t}</h3>
                      <span className="shrink-0 font-mono text-[11px] text-dim">0{i + 1}</span>
                    </div>
                    <p className="mt-3 text-[15px] leading-relaxed text-mute">{b}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* launchpad */}
        <section id="launchpad" className="scroll-mt-24 border-t border-line band">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 sm:px-6 sm:py-28 lg:grid-cols-[1fr_1fr] lg:gap-20">
            <Reveal>
              <span className="eyebrow">the private launchpad</span>
              <h2 className="display mt-4 text-4xl md:text-5xl">Launch, buy, sell. <span className="serif italic font-normal text-mute">Nobody sees who.</span></h2>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-mute">
                Anyone can launch a token in two transactions. The creator gets no allocation, no authority and no fee switch; the mint has no mint or freeze authority from its first block. Every buy and sell is a shielded transfer that exits onto the curve and comes straight back into the token&apos;s own pool.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Link href="/launch" className="btn-primary px-6">Open the launchpad</Link>
                <a href={`${GH}/blob/main/SPEC.md#16-the-launchpad`} className="btn-ghost">Read the mechanics</a>
              </div>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="glass p-6 sm:p-7">
                <ol className="space-y-5 text-sm">
                  {[
                    ["Curve", "793.1 M of 1 B tokens on a constant-product curve. Buys and sells arrive from the pool through one-use keys; your wallet is in none of them."],
                    ["Tax", "0–5 %, voted every minute by four AI agents. Wash trading and bots get taxed up; calm markets get taxed down. All of it goes to the agents' treasury."],
                    ["Graduation", "At 20 SOL raised the curve sells its last token. The SOL and the reserved 20.7 % of supply become a Raydium pool; every LP token is burned, so the liquidity is permanent."],
                    ["After", "The agents stop setting that token's tax. The treasury buys back the scash token at random moments and burns it or airdrops it to holders."],
                  ].map(([t, b], i) => (
                    <li key={t} className="grid grid-cols-[2rem_1fr] gap-3 sm:grid-cols-[2rem_6.5rem_1fr]">
                      <span className="font-mono text-[11px] text-dim">0{i + 1}</span>
                      <span className="font-medium sm:col-auto">{t}</span>
                      <span className="col-span-2 text-mute sm:col-span-1">{b}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ledger */}
        <section className="border-t border-line">
          <div className="mx-auto grid max-w-6xl items-center gap-10 px-5 py-20 sm:px-6 sm:py-28 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
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
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6 sm:py-28">
            <Reveal>
              <span className="eyebrow">follow one payment</span>
              <h2 className="display mt-4 text-4xl md:text-5xl">Who learns what.</h2>
              <p className="mt-4 max-w-lg text-[15px] text-mute">Send 0.4 SOL to a friend and watch what each party on the way can see.</p>
            </Reveal>
            <Reveal delay={0.1}><div className="mt-10 sm:mt-14"><Anatomy /></div></Reveal>
          </div>
        </section>

        {/* yield */}
        <section id="yield" className="scroll-mt-24 border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-20 sm:px-6 sm:py-28 lg:grid-cols-[1fr_1fr] lg:gap-20">
            <Reveal>
              <span className="eyebrow">holder yield</span>
              <h2 className="display mt-4 text-4xl md:text-5xl">Shares, <span className="serif italic font-normal text-mute">not tokens.</span></h2>
              <p className="mt-5 max-w-md text-[15px] leading-relaxed text-mute">
                A SCASH note holds a share of the SCASH pool. Creator fees from every trade are donated into the pool, so every private SCASH balance grows without a transaction, a claim, or a link to you. SOL and other pools keep a fixed rate of 1.
              </p>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="glass p-6 sm:p-7">
                <div className="text-xs text-mute">SCASH per share</div>
                <div className="mt-2 font-mono text-5xl tabular-nums tracking-tight">1.0000</div>
                <div className="mt-2 text-xs text-dim">at launch · rises with every donation · the program has no instruction that lowers it</div>
                <ol className="mt-8 space-y-4 border-t border-line pt-6 text-sm">
                  {[["Trade", "every SCASH trade pays a creator fee"], ["Harvest", "anyone calls the harvester; it swaps the fee to SCASH and donates it"], ["Grow", "the pool grows, every share is backed by more SCASH"]].map(([t, b], i) => (
                    <li key={t} className="grid grid-cols-[2rem_1fr] gap-2 sm:grid-cols-[2rem_6rem_1fr] sm:items-baseline">
                      <span className="font-mono text-[11px] text-dim">0{i + 1}</span>
                      <span className="font-medium">{t}</span>
                      <span className="col-span-2 text-mute sm:col-span-1">{b}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </Reveal>
          </div>
        </section>

        {/* guarantees */}
        <section id="security" className="scroll-mt-24 border-t border-line band">
          <div className="mx-auto max-w-6xl px-5 py-20 sm:px-6 sm:py-28">
            <Reveal>
              <span className="eyebrow">guarantees</span>
              <h2 className="display mt-4 text-4xl md:text-5xl">No keys but yours.</h2>
            </Reveal>
            <div className="mt-10 grid gap-4 sm:mt-12 md:grid-cols-2">
              {guarantees.map(([t, b], i) => (
                <Reveal key={t} delay={i * 0.06}>
                  <div className="glass h-full p-6 sm:p-7">
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
                <a className="link" href={`${GH}/blob/main/SECURITY.md`}>Security policy →</a>
              </div>
            </Reveal>
          </div>
        </section>

        {/* faq */}
        <section id="faq" className="scroll-mt-24 border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-8 px-5 py-20 sm:px-6 sm:py-28 lg:grid-cols-[18rem_1fr] lg:gap-10">
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
          <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-8 px-5 py-20 sm:px-6 sm:py-24 md:flex-row md:items-center">
            <Reveal>
              <h2 className="display text-4xl md:text-5xl">Your balance is <span className="serif italic font-normal gradient-text">nobody&apos;s business.</span></h2>
            </Reveal>
            <Reveal delay={0.1}>
              <div className="flex flex-wrap gap-3">
                <Link href="/app" className="btn-primary px-6">Open app</Link>
                <Link href="/launch" className="btn-ghost">Launch a token</Link>
              </div>
            </Reveal>
          </div>
        </section>

        <footer className="border-t border-line">
          <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 text-sm sm:px-6 md:grid-cols-[1fr_repeat(3,10rem)]">
            <div>
              <div className="flex items-center gap-2 font-medium"><img src="/icon.svg" alt="" className="h-5 w-5 rounded-md" /> scash</div>
              <p className="mt-3 max-w-xs text-xs leading-relaxed text-dim">Solana&apos;s shielded pool and private launchpad. Open source, MIT licensed.</p>
              <Builds />
            </div>
            <Col title="Product" links={[["App", "/app"], ["Launchpad", "/launch"], ["Spec", `${GH}/blob/main/SPEC.md`]]} />
            <Col title="Security" links={[["Policy", `${GH}/blob/main/SECURITY.md`], ["Ceremony", `${GH}/blob/main/ceremony/README.md`], ["Audit package", `${GH}/tree/main/audit`]]} />
            <Col title="Code" links={[["GitHub", GH], ["Vault program", `${GH}/tree/main/programs/scash_vault`], ["Launch program", `${GH}/tree/main/programs/scash_launch`]]} />
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
