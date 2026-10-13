import type { Metadata } from "next";
import { Inter, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const serif = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-serif", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "scash",
  description: "Shielded notes on Solana. Private by construction, verified on-chain.",
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://scash.fly.dev"),
  openGraph: { title: "scash", description: "Shielded notes on Solana.", type: "website" },
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
