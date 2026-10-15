import type { Metadata } from "next";
import Image from "next/image";

export const metadata: Metadata = {
  title: "Android",
  description: "BUNKER for Android: a private BNB wallet. The vault is created on your phone, proofs are generated on it, and the key never leaves it.",
};

const STEPS: [string, React.ReactNode][] = [
  ["Install", <>Download the APK below and open it. Android asks once to allow installs from your browser.</>],
  ["Create the vault", <>The app generates a spending key on the phone and shows a backup string (<code>bunkerseed1…</code>). Write it down: it is the only way to open the vault anywhere else.</>],
  ["Fund the built-in account", <>A public BNB account is derived from the same key. Send BNB (or any token) to it; that is what you shield from. Sends, trades and swaps after that are relayed and need no gas from you.</>],
  ["Shield, send, trade", <>Everything after that is private: sends to <code>bunker1…</code> addresses, withdrawals to any address, launchpad buys and sells, all proven on the phone and handed to the relayer as a finished proof.</>],
];

const FACTS: [string, string][] = [
  ["package", "com.bunkeronbnb.wallet"],
  ["size", "≈ 6 MB"],
  ["android", "6.0+ (API 23)"],
  ["key storage", "app sandbox · allowBackup=false"],
  ["proving", "Groth16 / BN254 on-device (WASM)"],
  ["source", "github.com/imadegoodstuff/bunker · mobile/"],
];

export default function AndroidPage() {
  return (
    <div className="max-w-5xl mx-auto rise">
      <div className="grid md:grid-cols-[1fr_280px] gap-10 items-start">
        <div>
          <div className="label-signal mb-2">BUNKER for Android</div>
          <h1 className="display text-3xl md:text-5xl mb-4">A private BNB wallet that fits in a 6 MB APK.</h1>
          <p className="text-mute leading-relaxed max-w-2xl mb-8">
            No wallet app, no extension, no account. The vault is created on your phone, zero-knowledge proofs are generated on it, and the key is
            excluded from cloud backup by design. It talks to the same contracts, indexer and relayer as this site, so you share one anonymity set
            with every BUNKER user.
          </p>
          <div className="flex flex-wrap items-center gap-3 mb-3">
            <a className="btn btn-signal" href="/download/bunker-android.apk">download bunker-android.apk</a>
            <a className="btn btn-ghost btn-sm" href="/download/bunker-android.apk.sha256">sha256</a>
            <a className="btn btn-ghost btn-sm" href="/ios">on iPhone?</a>
          </div>
          <p className="font-mono text-[11px] text-dim mb-10">
            Direct download. Verify with <code>sha256sum bunker-android.apk</code> against the checksum file. iPhone users install from Safari today; the App Store build is in preparation.
          </p>

          <div className="divide-y rule border-t rule">
            {STEPS.map(([h, p], i) => (
              <section key={h} className="py-5 grid md:grid-cols-[200px_1fr] gap-3">
                <h2 className="display text-base"><span className="font-mono text-[11px] text-signal mr-3">0{i + 1}</span>{h}</h2>
                <p className="text-mute leading-relaxed text-[15px] [&_code]:font-mono [&_code]:text-fg [&_code]:text-[12px]">{p}</p>
              </section>
            ))}
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
                <dd className="text-fg text-right break-all">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-5 text-[12px] text-mute leading-relaxed">
            The app is a thin shell: an update to this site is an update to the app. The same &ldquo;This device&rdquo; flow works in any mobile browser, and the site installs as a web app from the browser menu.
          </p>
        </aside>
      </div>
    </div>
  );
}
