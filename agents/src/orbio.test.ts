import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orbio } from "./orbio.js";

function harness(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; body: URLSearchParams; auth: string | undefined }[] = [];
  let t = 1_000_000;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const h = init?.headers as Record<string, string>;
    calls.push({ url: String(url), body: new URLSearchParams(String(init?.body)), auth: h?.authorization });
    const r = responses.shift();
    if (!r) throw new Error("unexpected fetch");
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  const tokenPath = join(mkdtempSync(join(tmpdir(), "orbio-")), "orbio.json");
  const orbio = new Orbio({ clientId: "cid", clientSecret: "sec", redirectUri: "https://x/auth/orbio/callback", tokenPath, fetchImpl, now: () => t });
  return { orbio, calls, tokenPath, advance: (ms: number) => (t += ms) };
}

test("authorize URL carries S256 PKCE and a state the callback must echo; the code is exchanged with the client secret", async () => {
  const { orbio, calls, tokenPath } = harness([{ status: 200, body: { access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "inference balance" } }]);
  const url = new URL(orbio.startUrl());
  assert.equal(url.origin + url.pathname, "https://www.orbio.so/oauth/authorize");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("response_type"), "code");
  const state = url.searchParams.get("state")!;
  assert.equal((await orbio.handleCallback({ code: "c", state: "wrong" })).ok, false, "foreign state refused");
  assert.equal((await orbio.handleCallback({ error: "access_denied", state })).ok, false, "cancel is not an error");
  const r = await orbio.handleCallback({ code: "c", state, iss: "https://www.orbio.so" });
  assert.equal(r.ok, true);
  assert.equal(calls[0].url, "https://www.orbio.so/api/oauth/token");
  assert.equal(calls[0].auth, `Basic ${Buffer.from("cid:sec").toString("base64")}`);
  assert.equal(calls[0].body.get("grant_type"), "authorization_code");
  assert.ok(calls[0].body.get("code_verifier"));
  assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).refresh_token, "rt1", "pair persisted");
  assert.equal((await orbio.handleCallback({ code: "c", state })).ok, false, "state is single use");
  assert.equal(await orbio.token(), "at1");
});

test("the access token is refreshed before expiry, once even under concurrent callers, and the new refresh token is persisted; a refused refresh marks the connection disconnected", async () => {
  const { orbio, calls, tokenPath, advance } = harness([
    { status: 200, body: { access_token: "at1", refresh_token: "rt1", expires_in: 3600 } },
    { status: 200, body: { access_token: "at2", refresh_token: "rt2", expires_in: 3600 } },
    { status: 400, body: { error: "invalid_grant" } },
  ]);
  const state = new URL(orbio.startUrl()).searchParams.get("state")!;
  await orbio.handleCallback({ code: "c", state });
  advance(3600_000 - 60_000); // one minute before expiry
  const [a, b] = await Promise.all([orbio.token(), orbio.token()]);
  assert.deepEqual([a, b], ["at2", "at2"]);
  assert.equal(calls.length, 2, "one refresh for two callers");
  assert.equal(calls[1].body.get("refresh_token"), "rt1");
  assert.equal(JSON.parse(readFileSync(tokenPath, "utf8")).refresh_token, "rt2");
  advance(3600_000);
  await assert.rejects(() => orbio.token(), /invalid_grant/);
  assert.equal(orbio.connected, false);
  await assert.rejects(() => orbio.token(), /disconnected/);
});

test("a fresh process picks the pair up from disk", async () => {
  const { orbio, tokenPath } = harness([{ status: 200, body: { access_token: "at1", refresh_token: "rt1", expires_in: 3600 } }]);
  const state = new URL(orbio.startUrl()).searchParams.get("state")!;
  await orbio.handleCallback({ code: "c", state });
  const again = new Orbio({ clientId: "cid", clientSecret: "sec", redirectUri: "https://x/cb", tokenPath, now: () => 1_000_000 });
  assert.equal(again.connected, true);
  assert.equal(await again.token(), "at1");
});
