// Proving artifacts (wasm + zkey) held in memory so a proof never waits on
// the network. The 2x2 key is ~21 MB, the 4x2 key ~36 MB: handed to snarkjs
// as URLs they were fetched and parsed on every proof, which is what made a
// launchpad trade (unshield + claim: two proofs) take as long as its two
// downloads. Now the 2x2 pair is fetched once in the background when the app
// mounts, the 4x2 pair as soon as 2x2 has landed, and both are cached by the
// browser (immutable headers) for the next visit.
import type { CircuitArtifacts, CircuitName } from "@scash/sdk";
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

/** Fetch 2x2 now and 4x2 once it is in; safe to call any number of times. */
export function prefetchArtifacts(): void {
  if (typeof window === "undefined") return;
  loadArtifacts("transact2x2").then(() => loadArtifacts("transact4x2")).catch(() => undefined);
}

/**
 * What to hand `buildTransact`: bytes for every circuit already in memory,
 * the URL for the rest (snarkjs streams those itself). Awaits the 2x2 pair,
 * which every shield, claim and almost every trade uses; a 4-input spend
 * falls back to the URL if its key has not landed yet.
 */
export async function artifactsForProof(report?: (p: Progress) => void): Promise<Record<CircuitName, CircuitArtifacts>> {
  const off = report ? onArtifactProgress(report) : () => undefined;
  try {
    await loadArtifacts("transact2x2");
  } finally {
    off();
  }
  return {
    transact2x2: loaded.transact2x2 ?? ARTIFACTS.transact2x2,
    transact4x2: loaded.transact4x2 ?? ARTIFACTS.transact4x2,
  };
}

export function artifactsReady(circuit: CircuitName = "transact2x2"): boolean {
  return !!loaded[circuit];
}
