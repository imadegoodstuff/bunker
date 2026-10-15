// Checksum for /download/bunker-android.apk, from the same release.
export const dynamic = "force-dynamic";

const SOURCE = process.env.APK_SHA256_SOURCE_URL ?? "https://github.com/imadegoodstuff/bunker/releases/download/android-latest/bunker-android.apk.sha256";

export async function GET() {
  const upstream = await fetch(SOURCE, { redirect: "follow", headers: { "user-agent": "bunker-app" }, cache: "no-store" });
  if (!upstream.ok) return new Response("unavailable", { status: 503 });
  const text = (await upstream.text()).replace(/\s+\S*bunker-android\.apk\s*$/m, "  bunker-android.apk\n");
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
