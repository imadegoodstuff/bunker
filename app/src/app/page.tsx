import Link from "next/link";
import { Nav } from "@/components/Nav";
import { LiveStats } from "@/components/LiveStats";

const pillars = [
  {
    title: "Sapling-grade addresses",
    body: "Diversified addresses on Baby Jubjub: one viewing key, unlimited unlinkable addresses. Pay the same person twice and nobody can tell.",
    mono: "pk_d = [ivk]·GroupHash(d)",
  },
  {
    title: "Proofs verified on-chain",
    body: "Groth16 over BN254 checked by the vault program with Solana's alt_bn128 syscalls. ~33k constraints, proven in your browser in seconds.",
    mono: "e(A,B) = e(α,β)·e(L,γ)·e(C,δ)",
  },
  {
    title: "Nobody pays from a doxxed wallet",
    body: "A relayer signs and pays fees for sends and withdrawals. The fee is deducted inside the proof, so your public wallet never touches the pool again.",
    mono: "fee ⊂ public_amount",
  },
  {
    title: "Immutable, bounded, honest",
    body: "No upgrade authority. A per-asset turnstile guarantees the pool can never pay out more than went in — even if the circuit had a bug.",
    mono: "Σout ≤ Σin  ∀ asset",
  },
  {
    title: "Yield-bearing shielded shares",
    body: "Notes hold pool shares, not raw tokens. Creator fees from the SCASH launch are donated back, so every shielded balance quietly grows.",
    mono: "rate = total_assets / total_shares",
  },
  {
    title: "Compliance without surveillance",
    body: "Optional association-set proofs (Privacy Pools style), scoped viewing keys and payment receipts. Prove you are clean without revealing anything else.",
    mono: "asp_root ∈ public inputs",
  },
];

export default function Landing() {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-7xl px-6">
        <section className="relative pt-24 pb-20 md:pt-36">
          <div className="pointer-events-none absolute -top-24 right-0 h-[480px] w-[480px] animate-float rounded-full bg-mint-500/10 blur-3xl" />
          <p className="font-mono text-xs uppercase tracking-[0.3em] text-mint-400">shielded notes on solana</p>
          <h1 className="mt-5 max-w-4xl text-5xl font-semibold leading-[1.05] tracking-tight md:text-7xl">
            Privacy that holds up
            <span className="block bg-gradient-to-r from-mint-300 to-mint-500 bg-clip-text text-transparent">under a microscope.</span>
          </h1>
          <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink-200">
            scash brings the Zcash Sapling construction to Solana: unlinkable addresses, in-browser zero-knowledge proofs,
            relayer-paid transactions and a vault program that can never be upgraded or drained past what it holds.
          </p>
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <Link href="/app" className="btn-primary">Open the shielded wallet</Link>
            <a href="https://github.com/imadegoodstuff/scash/blob/main/SPEC.md" target="_blank" rel="noreferrer" className="btn-ghost">Read the protocol spec</a>
          </div>
          <LiveStats />
        </section>

        <section id="how" className="py-20">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">Built like a cryptosystem, not a mixer.</h2>
          <div className="mt-12 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {pillars.map((p) => (
              <div key={p.title} className="panel p-6 transition hover:border-mint-500/30">
                <div className="font-mono text-[11px] text-mint-400">{p.mono}</div>
                <h3 className="mt-3 text-lg font-semibold">{p.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-200">{p.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section id="security" className="py-20">
          <div className="panel-strong grid gap-10 p-8 md:grid-cols-2 md:p-12">
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">What the guardian can&apos;t do</h2>
              <p className="mt-4 text-ink-200">
                The only privileged key can pause <em>new deposits</em> and <em>lower</em> the TVL cap. It cannot stop withdrawals,
                change verifying keys, move funds, or upgrade the program. Those capabilities do not exist in the bytecode.
              </p>
              <ul className="mt-6 space-y-3 text-sm text-ink-200">
                <li>• Public multi-party phase-2 ceremony; keys refused if δ = γ</li>
                <li>• Nullifier bound to leaf position; no faerie-gold double spends</li>
                <li>• 128-root ring, 2²⁶ leaves, one tree shared by every asset</li>
                <li>• Proof bytes cross-verified by the exact on-chain verifier in CI</li>
              </ul>
            </div>
            <div className="rounded-2xl border border-white/10 bg-ink-900 p-6 font-mono text-xs leading-6 text-ink-200">
              <div className="text-ink-400">// public inputs, in order</div>
              <div>[ root, public_amount, asset, ext_data_hash, asp_root,</div>
              <div>&nbsp;&nbsp;nf₁ … nfₙ, cm₁, cm₂ ]</div>
              <div className="mt-4 text-ink-400">// ext data is bound by SHA-256 mod p</div>
              <div>recipient ‖ relayer ‖ fee ‖ exit_target ‖ exit_data</div>
              <div>‖ ciphertexts ‖ out_ciphertext</div>
              <div className="mt-4 text-ink-400">// turnstile, per asset</div>
              <div>assert total_out + amount ≤ total_in</div>
            </div>
          </div>
        </section>

        <section id="token" className="py-20">
          <div className="grid gap-10 md:grid-cols-[1.2fr_1fr] md:items-center">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.3em] text-mint-400">scash token</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight md:text-4xl">The token that pays the pool.</h2>
              <p className="mt-4 text-ink-200">
                SCASH launches on Meteora&apos;s Dynamic Bonding Curve. Creator trading fees are harvested by an on-chain program,
                swapped and <span className="text-ink-100">donated into the shielded pools</span>, lifting the share rate for every holder of a shielded note.
                No staking, no claiming, no linkability.
              </p>
            </div>
            <div className="panel p-6">
              <div className="flex items-baseline justify-between">
                <span className="text-sm text-ink-200">Fee route</span>
                <span className="font-mono text-xs text-mint-400">harvester → donate()</span>
              </div>
              <div className="mt-4 space-y-2 font-mono text-xs text-ink-200">
                <div className="flex justify-between"><span>DBC creator fee</span><span>claim_creator_trading_fee</span></div>
                <div className="flex justify-between"><span>DAMM v2 (post-graduation)</span><span>claim_position_fee</span></div>
                <div className="flex justify-between"><span>Pool share to holders</span><span>total_assets += donated</span></div>
              </div>
            </div>
          </div>
        </section>

        <footer className="flex flex-col items-start justify-between gap-4 border-t border-white/5 py-10 text-sm text-ink-400 md:flex-row">
          <span>scash — MIT licensed. Pre-release: not audited, dev proving keys.</span>
          <div className="flex gap-6">
            <a href="https://github.com/imadegoodstuff/scash" className="hover:text-ink-100">GitHub</a>
            <a href="https://github.com/imadegoodstuff/scash/blob/main/SECURITY.md" className="hover:text-ink-100">Security</a>
            <a href="https://github.com/imadegoodstuff/scash/blob/main/ceremony/README.md" className="hover:text-ink-100">Ceremony</a>
          </div>
        </footer>
      </main>
    </>
  );
}
