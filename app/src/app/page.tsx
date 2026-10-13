import Link from "next/link";
import { Nav } from "@/components/Nav";

const points = [
  ["01", "Unlinkable by default", "Every address you hand out is different. One viewing key decrypts them all; no one else can tell they belong together."],
  ["02", "Proven in your browser", "A Groth16 proof is generated locally and verified by the vault program on-chain. Nothing about your notes ever leaves the device."],
  ["03", "Immutable and bounded", "No upgrade key. A per-asset turnstile guarantees the pool can never pay out more than was put in, even if everything else failed."],
];

export default function Landing() {
  return (
    <>
      <Nav />
      <main className="mx-auto max-w-5xl px-6">
        <section className="pb-28 pt-28 md:pt-40">
          <h1 className="max-w-3xl text-5xl leading-[1.02] tracking-[-0.03em] md:text-7xl">
            Money on Solana,
            <br />
            <span className="serif italic">without an audience.</span>
          </h1>
          <p className="mt-8 max-w-md text-[17px] leading-relaxed text-mute">
            scash is a shielded pool built on the Zcash Sapling design. Deposit, pay and withdraw privately; the chain only ever sees proofs.
          </p>
          <div className="mt-10 flex items-center gap-6">
            <Link href="/app" className="btn-primary px-5">Open app</Link>
            <a href="https://github.com/imadegoodstuff/scash/blob/main/SPEC.md" target="_blank" rel="noreferrer" className="link text-sm">
              Read the spec →
            </a>
          </div>
        </section>

        <section className="border-t border-line">
          {points.map(([n, title, body]) => (
            <div key={n} className="grid gap-3 border-b border-line py-9 md:grid-cols-[6rem_16rem_1fr] md:gap-8">
              <span className="font-mono text-xs text-dim">{n}</span>
              <h2 className="text-[17px] font-medium tracking-tight">{title}</h2>
              <p className="max-w-xl text-[15px] leading-relaxed text-mute">{body}</p>
            </div>
          ))}
        </section>

        <footer className="flex flex-col gap-3 py-12 text-xs text-dim sm:flex-row sm:items-center sm:justify-between">
          <span>Pre-release. Not audited. Development proving keys.</span>
          <div className="flex gap-5">
            <a href="https://github.com/imadegoodstuff/scash/blob/main/SECURITY.md" className="link">Security</a>
            <a href="https://github.com/imadegoodstuff/scash/blob/main/ceremony/README.md" className="link">Ceremony</a>
            <a href="https://github.com/imadegoodstuff/scash" className="link">GitHub</a>
          </div>
        </footer>
      </main>
    </>
  );
}
