import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "BUNKER — shielded pool and private launchpad on BNB Chain";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OG() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#0e0f0e", color: "#e8e6df", padding: 64, fontFamily: "sans-serif", position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(to right, rgba(232,230,223,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(232,230,223,0.05) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 36, height: 36, border: "3px solid #b6ff2e", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 18, height: 18, background: "#b6ff2e", display: "flex", alignItems: "center", justifyContent: "center" }}><div style={{ width: 6, height: 6, background: "#0e0f0e" }} /></div>
          </div>
          <div style={{ fontSize: 22, letterSpacing: 6, color: "#9b9a92" }}>SHIELDED POOL · PRIVATE LAUNCHPAD · BNB SMART CHAIN</div>
        </div>
        <div style={{ display: "flex", fontSize: 232, fontWeight: 700, letterSpacing: -10, lineHeight: 0.9, marginTop: 56 }}>
          BUN<span style={{ color: "#b6ff2e" }}>K</span>ER
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginTop: "auto" }}>
          <div style={{ fontSize: 30, color: "#9b9a92", maxWidth: 760, lineHeight: 1.25 }}>Shield once. Then send, trade and launch with no trace back to your wallet. Proofs made in your browser.</div>
          <div style={{ fontSize: 22, letterSpacing: 4, color: "#b6ff2e" }}>bunkeronbnb.com</div>
        </div>
      </div>
    ),
    { ...size }
  );
}
