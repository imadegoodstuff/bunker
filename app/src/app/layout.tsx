import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "scash — shielded notes on Solana",
  description:
    "Sapling-grade privacy for Solana. Diversified addresses, Groth16 proofs verified on-chain, relayer-paid fees, and an immutable, turnstile-bounded vault.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://scash.fly.dev"),
  openGraph: { title: "scash", description: "Shielded notes on Solana.", type: "website" },
  icons: { icon: "/icon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body className="noise min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
