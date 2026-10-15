/**
 * Thin adapters over the HTTP APIs of several model providers. No SDKs: a vote is
 * one request, and the service must keep running when any one provider changes
 * its client library. `spec` is "provider:model", e.g. "openai:gpt-4o-mini".
 */
export type Provider = "orbio" | "openai" | "anthropic" | "google" | "xai" | "deepseek" | "mistral" | "groq" | "openrouter";

export interface ModelSpec {
  provider: Provider;
  model: string;
}

export function parseModelSpec(spec: string): ModelSpec {
  const i = spec.indexOf(":");
  if (i <= 0) throw new Error(`model spec must be provider:model, got ${JSON.stringify(spec)}`);
  const provider = spec.slice(0, i) as Provider;
  if (!(provider in ENDPOINTS) && provider !== "anthropic" && provider !== "google") throw new Error(`unknown provider ${provider}`);
  return { provider, model: spec.slice(i + 1) };
}

/** OpenAI-compatible chat-completions hosts, and the env var that holds each key. */
const ENDPOINTS: Record<Exclude<Provider, "anthropic" | "google">, { url: string; key: string }> = {
  // Orbio is a gateway over many vendors ("orbio:anthropic/claude-haiku-5.5"); its key is an API key or
  // the access token of the service's Sign-in-with-Orbio connection (orbio.ts), resolved by the caller.
  orbio: { url: "https://api.orbio.so/api/v1/chat/completions", key: "ORBIO_API_KEY" },
  openai: { url: "https://api.openai.com/v1/chat/completions", key: "OPENAI_API_KEY" },
  xai: { url: "https://api.x.ai/v1/chat/completions", key: "XAI_API_KEY" },
  deepseek: { url: "https://api.deepseek.com/chat/completions", key: "DEEPSEEK_API_KEY" },
  mistral: { url: "https://api.mistral.ai/v1/chat/completions", key: "MISTRAL_API_KEY" },
  groq: { url: "https://api.groq.com/openai/v1/chat/completions", key: "GROQ_API_KEY" },
  openrouter: { url: "https://openrouter.ai/api/v1/chat/completions", key: "OPENROUTER_API_KEY" },
};

export function keyEnvFor(p: Provider): string {
  if (p === "anthropic") return "ANTHROPIC_API_KEY";
  if (p === "google") return "GOOGLE_API_KEY";
  return ENDPOINTS[p].key;
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/** Ask the model; returns its text. Throws on transport or provider errors; the caller treats that as "no vote this epoch". */
export async function complete(spec: ModelSpec, prompt: string, apiKey: string, timeoutMs = 60_000): Promise<string> {
  if (spec.provider === "anthropic") {
    const j = (await post(
      "https://api.anthropic.com/v1/messages",
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      { model: spec.model, max_tokens: 1200, temperature: 0.2, messages: [{ role: "user", content: prompt }] },
      timeoutMs
    )) as { content?: { type: string; text?: string }[] };
    return (j.content ?? []).map((c) => c.text ?? "").join("");
  }
  if (spec.provider === "google") {
    const j = (await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(spec.model)}:generateContent`,
      { "x-goog-api-key": apiKey },
      { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 1200, responseMimeType: "application/json" } },
      timeoutMs
    )) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
  }
  const e = ENDPOINTS[spec.provider];
  const j = (await post(
    e.url,
    { authorization: `Bearer ${apiKey}` },
    { model: spec.model, temperature: 0.2, max_tokens: 1200, messages: [{ role: "user", content: prompt }] },
    timeoutMs
  )) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? "";
}
