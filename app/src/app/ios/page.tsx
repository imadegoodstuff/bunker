import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "iPhone",
  description: "BUNKER on iPhone: add it to your home screen from Safari. Same on-device vault and proving as the Android app, no App Store needed.",
};

const STEPS: [string, React.ReactNode][] = [
  ["Open in Safari", <>Go to <code>bunkeronbnb.com/app</code> in <strong className="text-fg font-medium">Safari</strong>. It has to be Safari: other iPhone browsers cannot install web apps.</>],
  ["Share → Add to Home Screen", <>Tap the Share button (the square with an arrow) at the bottom, scroll the list, tap <strong className="text-fg font-medium">Add to Home Screen</strong>, then <strong className="text-fg font-medium">Add</strong>.</>],
  ["Open from the home screen", <>A BUNKER icon appears next to your apps. Open it from there, not from Safari: it runs full-screen with its own storage, and that storage is where your vault lives.</>],
  ["Create the vault", <>Tap <em>This device</em>, create a vault, write down the backup string, fund the built-in BNB account, shield. Everything from here is identical to the Android app.</>],
];

const FACTS: [string, string][] = [
  ["requires", "iOS 16.4+ · Safari"],
  ["install", "Share → Add to Home Screen"],
  ["key storage", "the web app's own storage, on the phone"],
  ["proving", "Groth16 / BN254 on-device (WASM)"],
  ["App Store", "in preparation (TestFlight first)"],
];

export default function IosPage() {
  return (
    <div className="max-w-5xl mx-auto rise">
      <div className="grid md:grid-cols-[1fr_280px] gap-10 items-start">
        <div>
          <div className="label-signal mb-2">BUNKER on iPhone</div>
          <h1 className="display text-3xl md:text-5xl mb-4">Install it from Safari. No App Store, no waiting.</h1>
          <p className="text-mute leading-relaxed max-w-2xl mb-8">
            On iPhone, BUNKER installs as a web app: an icon on your home screen that opens full-screen, with the same on-device vault, the same
            zero-knowledge proving and the same built-in BNB account as the Android app. Nothing is downloaded from a store and nothing about it
            is different underneath: the Android and iOS shells run this very page in the same engine.
          </p>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <a className="btn btn-signal" href="/app">open bunkeronbnb.com/app in Safari</a>
            <a className="btn btn-ghost btn-sm" href="/android">Android APK</a>
          </div>
          <p className="font-mono text-[11px] text-dim mb-10">
            An App Store build is in preparation and will go through TestFlight first. The home-screen app will keep working alongside it.
          </p>

          <div className="divide-y rule border-t rule">
            {STEPS.map(([h, p], i) => (
              <section key={h} className="py-5 grid md:grid-cols-[220px_1fr] gap-3">
                <h2 className="display text-base"><span className="font-mono text-[11px] text-signal mr-3">0{i + 1}</span>{h}</h2>
                <p className="text-mute leading-relaxed text-[15px] [&_code]:font-mono [&_code]:text-fg [&_code]:text-[12px]">{p}</p>
              </section>
            ))}
          </div>

          <div className="slab p-5 mt-8">
            <div className="label mb-2">Two things worth knowing</div>
            <ul className="text-sm text-mute leading-relaxed space-y-2">
              <li><span className="text-signal font-mono text-[11px] mr-2">01</span>Always open BUNKER from the home-screen icon. The icon and a Safari tab have separate storage; a vault created in one is not visible in the other (the backup string opens it anywhere).</li>
              <li><span className="text-signal font-mono text-[11px] mr-2">02</span>The backup string is the only way to recover the vault if you delete the icon or change phones. iOS does not back this storage up to iCloud, on purpose.</li>
            </ul>
          </div>
        </div>

        <aside className="slab p-5 md:sticky md:top-24">
          <div className="flex justify-center mb-5">
            <Image src="/brand/mark-256.png" alt="" width={128} height={128} priority />
          </div>
          <dl className="font-mono text-[11px] space-y-2">
            {FACTS.map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-mute shrink-0">{k}</dt>
                <dd className="text-fg text-right">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-[12px] text-mute leading-relaxed">
            This is not an App Store listing. It is this site, pinned to your home screen by Safari, running with the same code every BUNKER user runs.
          </p>
        </aside>
      </div>
    </div>
  );
}
