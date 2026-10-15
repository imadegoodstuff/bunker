import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "BUNKER — shielded pool and private launchpad on BNB Chain";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const SIGNAL = "#ffb02e";

/** Space Grotesk 700 from Google Fonts so the wordmark is set in the site's display face; falls back to the default font. */
async function displayFont(): Promise<ArrayBuffer | null> {
  try {
    const css = await fetch("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700", { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
    const url = css.match(/src: url\(([^)]+)\) format\('(?:truetype|opentype|woff)'\)/)?.[1];
    return url ? await fetch(url).then((r) => r.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

export default async function OG() {
  const [mark, font] = await Promise.all([
    fetch(new URL("../../public/brand/og-mark.png", import.meta.url)).then((r) => r.arrayBuffer()),
    displayFont(),
  ]);
  const markSrc = `data:image/png;base64,${Buffer.from(mark).toString("base64")}`;
  const display = font ? "Space Grotesk" : "sans-serif";
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#0b0b0b", color: "#e8e6df", fontFamily: "sans-serif", position: "relative" }}>
        <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(to right, rgba(232,230,223,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(232,230,223,0.05) 1px, transparent 1px)", backgroundSize: "48px 48px" }} />
        <div style={{ display: "flex", flexDirection: "column", padding: 64, flex: 1 }}>
          <div style={{ fontSize: 22, letterSpacing: 6, color: "#9b9a92" }}>SHIELDED POOL · PRIVATE LAUNCHPAD · BNB SMART CHAIN</div>
          <div style={{ display: "flex", fontSize: 190, fontWeight: 700, lineHeight: 0.9, marginTop: 48, fontFamily: display }}>
            {["B", "U", "N", "K", "E", "R"].map((ch) => (
              <span key={ch} style={{ color: ch === "K" ? SIGNAL : "#e8e6df" }}>{ch}</span>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginTop: "auto", gap: 18 }}>
            <div style={{ fontSize: 28, color: "#9b9a92", maxWidth: 640, lineHeight: 1.25 }}>Shield once. Then send, trade and launch with no trace back to your wallet. Proofs made in your browser.</div>
            <div style={{ fontSize: 22, letterSpacing: 4, color: SIGNAL }}>bunkeronbnb.com</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 480, position: "relative" }}>
          <div style={{ position: "absolute", width: 420, height: 420, borderRadius: 420, background: "radial-gradient(closest-side, rgba(255,176,46,0.35), transparent 70%)" }} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={markSrc} width={440} height={440} alt="" style={{ position: "relative" }} />
        </div>
      </div>
    ),
    { ...size, fonts: font ? [{ name: "Space Grotesk", data: font, weight: 700, style: "normal" }] : undefined }
  );
}
