import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Sans } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Shell } from "@/components/Shell";
import { SITE_URL } from "@/lib/config";

// Geist for display and numbers (sharp, tight), Geist Mono for labels, Instrument Sans for body copy
const display = Geist({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });
const sans = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-sans", display: "swap" });

const TITLE = "BUNKER — shielded pool and private launchpad on BNB Chain";
const DESC = "A Zcash-Sapling shielded pool on BNB Smart Chain with a launchpad that runs inside it. Shield once; send, trade and launch with no trace back to your wallet. Zero-knowledge proofs made in your browser, open source.";

export const metadata: Metadata = {
  title: { default: TITLE, template: "%s — BUNKER" },
  description: DESC,
  metadataBase: new URL(SITE_URL),
  openGraph: { title: TITLE, description: DESC, type: "website", url: SITE_URL, siteName: "BUNKER" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
  icons: { icon: "/icon.png", apple: "/apple-icon.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "BUNKER", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = { themeColor: "#0b0b0c", width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable} ${sans.variable}`}>
      <body className="min-h-screen">
        <Providers>
          <Shell>{children}</Shell>
        </Providers>
      </body>
    </html>
  );
}
