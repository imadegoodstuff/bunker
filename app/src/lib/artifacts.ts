// Proving artifacts (wasm + zkey) held in memory so a proof never waits on
// the network. The 2x3 key is ~30 MB, the 4x3 key ~50 MB: handed to snarkjs
// as URLs they were fetched and parsed on every proof. The 2x3 pair is fetched
// once in the background when the vault opens, the 4x3 pair as soon as 2x3 has
// landed, and both are cached by the browser (immutable headers) for the next
// visit. The SDK client asks this module for them through `artifactLoader`.
import type { CircuitArtifacts, CircuitName } from "@bunker/sdk";
import { ARTIFACTS } from "./config";

type Bytes = { wasm: Uint8Array; zkey: Uint8Array };
export type Progress = { circuit: CircuitName; loaded: number; total: number };

const loaded: Partial<Record<CircuitName, Bytes>> = {};
const inflight: Partial<Record<CircuitName, Promise<Bytes>>> = {};
const listeners = new Set<(p: Progress) => void>();

export function onArtifactProgress(fn: (p: Progress) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function fetchBytes(url: string, onChunk: (n: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    onChunk(n, total);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function loadArtifacts(circuit: CircuitName): Promise<Bytes> {
  const have = loaded[circuit];
  if (have) return Promise.resolve(have);
  const running = inflight[circuit];
  if (running) return running;
  const urls = ARTIFACTS[circuit];
  const p = (async () => {
    let wasmN = 0, zkeyN = 0, wasmT = 0, zkeyT = 0;
    const emit = () => { for (const fn of listeners) fn({ circuit, loaded: wasmN + zkeyN, total: wasmT + zkeyT }); };
    const [wasm, zkey] = await Promise.all([
      fetchBytes(urls.wasm, (n, t) => { wasmN = n; wasmT = t; emit(); }),
      fetchBytes(urls.zkey, (n, t) => { zkeyN = n; zkeyT = t; emit(); }),
    ]);
    const b = { wasm, zkey };
    loaded[circuit] = b;
    return b;
  })();
  inflight[circuit] = p;
  p.catch(() => { delete inflight[circuit]; });
  return p;
}

/** Fetch 2x3 now and 4x3 once it is in; safe to call any number of times. */
export function prefetchArtifacts(): void {
  if (typeof window === "undefined") return;
  loadArtifacts("transact2x3").then(() => loadArtifacts("transact4x3")).catch(() => undefined);
}

/**
 * What the SDK client gets when it needs a circuit: bytes when they are in
 * memory, otherwise the 2x3 pair is awaited (every shield and almost every
 * spend uses it) and a 4x3 proof falls back to the URL, which snarkjs streams.
 */
export async function artifactFor(circuit: CircuitName, report?: (p: Progress) => void): Promise<CircuitArtifacts> {
  if (loaded[circuit]) return loaded[circuit]!;
  if (circuit === "transact4x3" && !inflight.transact4x3) return ARTIFACTS.transact4x3;
  const off = report ? onArtifactProgress(report) : () => undefined;
  try {
    return await loadArtifacts(circuit);
  } catch {
    return ARTIFACTS[circuit];
  } finally {
    off();
  }
}

export function artifactsReady(circuit: CircuitName = "transact2x3"): boolean {
  return !!loaded[circuit];
}
