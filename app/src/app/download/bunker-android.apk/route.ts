// bunkeronbnb.com/download/bunker-android.apk → the APK CI published, streamed
// through the site so the download link is ours. The source is the rolling
// `android-latest` release; override with APK_SOURCE_URL to pin a build.
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

const SOURCE = process.env.APK_SOURCE_URL ?? "https://github.com/imadegoodstuff/bunker/releases/download/android-latest/bunker-android.apk";

export async function GET(req: NextRequest) {
  const upstream = await fetch(SOURCE, { redirect: "follow", headers: { "user-agent": "bunker-app" }, cache: "no-store" });
  if (!upstream.ok || !upstream.body) return new Response("APK temporarily unavailable", { status: 503 });
  const headers = new Headers({
    "content-type": "application/vnd.android.package-archive",
    "content-disposition": 'attachment; filename="bunker-android.apk"',
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  });
  const len = upstream.headers.get("content-length");
  if (len) headers.set("content-length", len);
  return new Response(req.method === "HEAD" ? null : upstream.body, { status: 200, headers });
}

export const HEAD = GET;
