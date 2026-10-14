import type { Metadata } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "scash — Solana's shielded pool and private launchpad",
  description: "A Zcash-Sapling shielded pool on Solana mainnet with a launchpad that runs inside it. Shield once; send, trade and launch with no trace back to your wallet. No admin key, open source.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://scash.site"),
  openGraph: { title: "scash — private money and private launches on Solana", description: "Solana's shielded pool with a launchpad inside it. No admin key, no pause switch, open source.", type: "website" },
  twitter: { card: "summary_large_image", title: "scash — private money and private launches on Solana", description: "Solana's shielded pool with a launchpad inside it." },
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${serif.variable} ${mono.variable}`}>
      <body className="relative min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
