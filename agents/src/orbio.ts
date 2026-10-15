/**
 * One "Sign in with Orbio" connection for the whole agents service.
 *
 * Orbio (orbio.so) is an OpenAI-compatible gateway in front of many model
 * vendors, so a single connection lets the four agents each use a different
 * vendor's model. The service is registered there as a *server app*: the owner
 * signs in once (OAuth 2.1, PKCE S256, client secret on this backend), the
 * token pair is kept on disk, and the access token is refreshed here, from one
 * place, before it expires. Refresh tokens are single use, so the new one is
 * written before the new access token is ever used. Nothing about Orbio is
 * shown to the app's users; the agents simply think through it.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ORBIO_ISSUER = "https://www.orbio.so";
export const ORBIO_GATEWAY = "https://api.orbio.so/api/v1";
const AUTHORIZE = `${ORBIO_ISSUER}/oauth/authorize`;
const TOKEN = `${ORBIO_ISSUER}/api/oauth/token`;
/** what the agents need: model calls, and reading the balance for /health */
const SCOPE = "inference balance";
const STATE_TTL_MS = 10 * 60 * 1000;
/** refresh this long before expiry so a vote never starts with a token about to die */
const REFRESH_AHEAD_MS = 2 * 60 * 1000;

export interface OrbioOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** where the token pair lives; a volume in production */
  tokenPath: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Stored {
  access_token: string;
  refresh_token: string;
  /** epoch ms */
  expires_at: number;
  scope?: string;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class Orbio {
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private pending = new Map<string, { verifier: string; at: number }>();
  private stored: Stored | null = null;
  private refreshing: Promise<string> | null = null;
  /** set when Orbio refused the refresh token: the owner has to sign in again */
  disconnectedReason: string | null = null;

  constructor(readonly o: OrbioOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    try {
      this.stored = JSON.parse(readFileSync(o.tokenPath, "utf8")) as Stored;
    } catch {
      this.stored = null;
    }
  }

  get connected(): boolean {
    return this.stored !== null && this.disconnectedReason === null;
  }
  get expiresAt(): number | null {
    return this.stored?.expires_at ?? null;
  }

  /** Step 1: the URL to send the owner's browser to. The PKCE verifier waits here, keyed by `state`. */
  startUrl(): string {
    for (const [k, v] of this.pending) if (this.now() - v.at > STATE_TTL_MS) this.pending.delete(k);
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    this.pending.set(state, { verifier, at: this.now() });
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.o.clientId,
      redirect_uri: this.o.redirectUri,
      scope: SCOPE,
      state,
      code_challenge: b64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      prompt: "consent",
    });
    return `${AUTHORIZE}?${q}`;
  }

  /** Steps 2–3: check `state` and `iss`, exchange the code once, persist the pair. Returns a message for the browser. */
  async handleCallback(query: Record<string, string | undefined>): Promise<{ ok: boolean; message: string }> {
    if (query.error) return { ok: false, message: query.error === "access_denied" ? "Sign-in cancelled; nothing changed." : `Orbio returned ${query.error}` };
    const { code, state, iss } = query;
    if (!code || !state) return { ok: false, message: "missing code or state" };
    if (iss && iss !== ORBIO_ISSUER) return { ok: false, message: "unexpected issuer" };
    const p = this.pending.get(state);
    this.pending.delete(state);
    if (!p || this.now() - p.at > STATE_TTL_MS) return { ok: false, message: "unknown or expired state; start again" };
    const t = await this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: this.o.redirectUri, code_verifier: p.verifier });
    this.save(t);
    this.disconnectedReason = null;
    return { ok: true, message: "Orbio connected. The agents will use it from the next epoch." };
  }

  /** A valid access token, refreshed if it is about to expire. Throws if the owner has to sign in (again). */
  async token(): Promise<string> {
    if (!this.stored) throw new Error("Orbio is not connected: open /auth/orbio/start");
    if (this.disconnectedReason) throw new Error(`Orbio disconnected (${this.disconnectedReason}): open /auth/orbio/start`);
    if (this.stored.expires_at - this.now() > REFRESH_AHEAD_MS) return this.stored.access_token;
    // one refresh at a time: a refresh token presented twice revokes the connection
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    const rt = this.stored!.refresh_token;
    let t: Stored;
    try {
      t = await this.tokenRequest({ grant_type: "refresh_token", refresh_token: rt });
    } catch (e) {
      const msg = (e as Error).message;
      if (/invalid_grant|invalid_client|401|400/.test(msg)) this.disconnectedReason = msg.slice(0, 120);
      throw e;
    }
    this.save(t); // the new refresh token is on disk before the new access token is used
    return t.access_token;
  }

  private async tokenRequest(body: Record<string, string>): Promise<Stored> {
    const r = await this.f(TOKEN, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams(body).toString(),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`orbio token endpoint ${r.status}: ${text.slice(0, 200)}`);
    const j = JSON.parse(text) as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
    if (!j.access_token || !j.refresh_token) throw new Error("orbio token response lacks a token pair");
    return { access_token: j.access_token, refresh_token: j.refresh_token, expires_at: this.now() + j.expires_in * 1000, scope: j.scope };
  }

  private save(t: Stored) {
    this.stored = t;
    mkdirSync(dirname(this.o.tokenPath), { recursive: true });
    const tmp = `${this.o.tokenPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
    renameSync(tmp, this.o.tokenPath);
  }
}
