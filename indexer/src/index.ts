import Fastify from "fastify";
import cors from "@fastify/cors";
import { Connection, PublicKey } from "@solana/web3.js";
import { Db } from "./db.js";
import { Scanner } from "./scanner.js";
import { contiguousPrefix } from "./paging.js";
import { inspectProgram, type ProgramInfo } from "./program.js";
import { buildMeta, MAX_IMAGE_BYTES, MetaError, MetaStore, RateLimit } from "./meta.js";
import { dirname, join } from "node:path";

const RPC = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PROGRAM = new PublicKey(process.env.PROGRAM_ID ?? "89TrDDtwYTkrvxGmfYnSz6EbA1muGStuPBFUt3Dvd8WR");
// The launchpad program; its own history carries the agents' fee votes. "" disables.
const LAUNCH = process.env.LAUNCH_PROGRAM_ID === "" ? undefined : new PublicKey(process.env.LAUNCH_PROGRAM_ID ?? "861VJkPL2yUYL1DTCToeziREP4XyraihkqbTM1irFZ3k");
const DB_PATH = process.env.DB_PATH ?? "./scash-indexer.sqlite";
const PORT = Number(process.env.PORT ?? 8788);
// Launch metadata (token image + JSON) lives next to the database and is served from PUBLIC_URL/meta/…
const META_DIR = process.env.META_DIR ?? join(dirname(DB_PATH), "meta");
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const META_UPLOADS_PER_HOUR = Number(process.env.META_UPLOADS_PER_HOUR ?? 20);

// RPC_URLS: comma-separated fallbacks tried in order after RPC_URL whenever the
// primary throws or returns null for a confirmed signature.
const RPC_LIST = [RPC, ...(process.env.RPC_URLS ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== RPC)];
/** Keyed endpoints carry the key in the path (Alchemy, Helius, QuickNode…) or the query; /health shows the host only. */
const redact = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "…";
  }
};

const db = new Db(DB_PATH);
const conns = RPC_LIST.map((u) => new Connection(u, "confirmed"));
const conn = conns[0];
const scanner = new Scanner(conns, db, PROGRAM, Number(process.env.SCAN_INTERVAL_MS ?? 4000), LAUNCH);
console.log(`[indexer] rpc endpoints: ${RPC_LIST.map(redact).join(", ")}`);
void scanner.start();

let programInfo: ProgramInfo = await inspectProgram(conn, PROGRAM);
setInterval(() => void inspectProgram(conn, PROGRAM).then((p) => (programInfo = p)), 10 * 60 * 1000).unref();

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true });
await app.register(cors, { origin: true });
const meta = new MetaStore(META_DIR);
const metaLimit = new RateLimit(META_UPLOADS_PER_HOUR, 60 * 60 * 1000);

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** Process liveness only, for the platform's restart check. Data integrity is `/health`. */
app.get("/live", async () => ({ ok: true }));

app.get("/health", async (_req, reply) => {
  const deferred = scanner.deferred();
  const degraded = scanner.degraded();
  // 503 once a confirmed transaction has been unreadable for >10 min: wallets
  // behind this indexer may be missing leaves, and the operator must act.
  return reply.code(degraded ? 503 : 200).send({
    ok: !degraded,
    degraded,
    commit: process.env.GIT_SHA ?? "unknown",
    program: PROGRAM.toBase58(),
    /** What is on-chain under that id right now; `deployed: false` means the id is unfunded on this cluster. */
    onChain: programInfo,
    commitments: db.count(),
    deferred: deferred.map((d) => ({ ...d, ageSeconds: Math.round((Date.now() - d.since) / 1000) })),
    rpc: redact(RPC),
    /** Fallback order and how many transactions each fallback has supplied that the primary could not. */
    rpcs: RPC_LIST.map((u, i) => ({ url: redact(u), recovered: scanner.recoveredVia[i] })),
  });
});

/** Leaves and their note ciphertexts, paginated by leaf index. Wallets trial-decrypt these. */
app.get<{ Querystring: { from?: string; limit?: string } }>("/commitments", async (req) => {
  const from = Number(req.query.from ?? 0);
  const limit = Math.min(Number(req.query.limit ?? 500), 2000);
  // Serve only the contiguous prefix. If a transaction is deferred (scanner
  // `skipped_signatures`) there is a hole at its leaf indices; a wallet that
  // saw leaves past the hole would build the wrong tree. `next` then points at
  // the hole and the wallet simply asks again later.
  const rows = contiguousPrefix(db.commitments(from, limit), from);
  return {
    from,
    next: rows.length ? rows[rows.length - 1].idx + 1 : from,
    total: db.count(),
    items: rows.map((r) => ({ index: r.idx, commitment: r.commitment, ciphertext: b64(r.ciphertext), signature: r.signature, slot: r.slot, blockTime: r.block_time })),
  };
});

/** Outgoing ciphertexts (sender-side recovery with ovk). */
app.get<{ Querystring: { from?: string; limit?: string } }>("/outgoing", async (req) => {
  const from = Number(req.query.from ?? 0);
  const limit = Math.min(Number(req.query.limit ?? 500), 2000);
  return db.outCiphertexts(from, limit).map((r) => ({ firstIndex: r.first_idx, signature: r.signature, ciphertext: b64(r.ciphertext) }));
});

app.get<{ Params: { nf: string } }>("/nullifiers/:nf", async (req) => ({ nullifier: req.params.nf, spent: db.hasNullifier(req.params.nf.toLowerCase()) }));
app.get<{ Querystring: { sinceSlot?: string; limit?: string } }>("/nullifiers", async (req) =>
  db.nullifiersSince(Number(req.query.sinceSlot ?? 0), Math.min(Number(req.query.limit ?? 1000), 5000))
);
app.get<{ Querystring: { n?: string } }>("/roots", async (req) => db.latestRoots(Math.min(Number(req.query.n ?? 32), 128)));

/** Anonymity-set statistics for the UI (per asset, recent window). */
app.get<{ Querystring: { sinceSlot?: string; days?: string } }>("/stats", async (req) => {
  const since = Number(req.query.sinceSlot ?? 0);
  const perMint: Record<string, { shields: number; unshields: number; donated: string; shielded: string; unshielded: string }> = {};
  for (const r of db.stats(since)) {
    const m = (perMint[r.mint] ??= { shields: 0, unshields: 0, donated: "0", shielded: "0", unshielded: "0" });
    if (r.kind === "shield") { m.shields = r.n; m.shielded = String(r.total ?? 0); }
    if (r.kind === "unshield") { m.unshields = r.n; m.unshielded = String(r.total ?? 0); }
    if (r.kind === "donate") m.donated = String(r.total ?? 0);
  }
  return { leaves: db.count(), perMint, daily: db.dailyActivity(Number(req.query.days ?? 30)) };
});

/**
 * Launchpad: tokens launched through the shielded curve. Everything here is
 * public on-chain already (curve reserves, trade sizes, fee flows); what is
 * absent is who traded — a private trade's only wallet is a throwaway claim key.
 */
/** The token icon and optional header for a launch whose metadata this indexer hosts (`uri` under PUBLIC_URL/meta); nulls for foreign URIs. */
type Images = { image: string | null; header: string | null };
const imageCache = new Map<string, Images>();
function imagesOf(uri: unknown): Images {
  const none: Images = { image: null, header: null };
  if (typeof uri !== "string") return none;
  const prefix = `${PUBLIC_URL.replace(/\/+$/, "")}/meta/`;
  if (!uri.startsWith(prefix)) return none;
  const cached = imageCache.get(uri);
  if (cached) return cached;
  const out: Images = { ...none };
  try {
    const f = meta.get(uri.slice(prefix.length));
    const j = f ? (JSON.parse(f.bytes.toString("utf8")) as { image?: unknown; header?: unknown }) : undefined;
    if (typeof j?.image === "string" && j.image.startsWith(prefix)) out.image = j.image;
    if (typeof j?.header === "string" && j.header.startsWith(prefix)) out.header = j.header;
  } catch { /* not ours or malformed: no images */ }
  imageCache.set(uri, out);
  return out;
}
const withImage = (l: Record<string, unknown>) => ({ ...l, ...imagesOf(l.uri) });

app.get<{ Querystring: { limit?: string; offset?: string } }>("/launches", async (req) =>
  db.launches(Math.min(Number(req.query.limit ?? 50), 200), Number(req.query.offset ?? 0)).map(withImage)
);
app.get<{ Params: { mint: string }; Querystring: { limit?: string; beforeSlot?: string } }>("/launches/:mint", async (req, reply) => {
  const l = db.launch(req.params.mint);
  if (!l) return reply.code(404).send({ error: "unknown launch" });
  const trades = db.trades(req.params.mint, Math.min(Number(req.query.limit ?? 50), 500), req.query.beforeSlot ? Number(req.query.beforeSlot) : undefined);
  const feeEvents = db.feeEvents(req.params.mint, 100);
  return { ...withImage(l), trades, feeEvents };
});

/**
 * Launch metadata. The app uploads the token's icon (required) and an optional
 * 3:1 header with its name/symbol/description before the launch transaction;
 * the mint's URI then points at the JSON written here. Content-addressed and
 * immutable; the only writable endpoint of the indexer, so it is bounded
 * (4.5 MB per image, sniffed image types, per-IP rate limit) and holds nothing
 * that identifies the uploader.
 */
const META_BODY_LIMIT = Math.ceil((2 * MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024; // two base64 images plus text
app.post<{ Body: { name?: string; symbol?: string; description?: string; image?: string; header?: string } }>("/meta", { bodyLimit: META_BODY_LIMIT }, async (req, reply) => {
  if (!metaLimit.allow(req.ip)) return reply.code(429).send({ error: "too many uploads from this address; try again later" });
  try {
    const b = req.body ?? {};
    const files = buildMeta({ name: b.name ?? "", symbol: b.symbol ?? "", description: b.description, image: b.image ?? "", header: b.header || undefined }, PUBLIC_URL);
    meta.put(files);
    return { uri: files.uri, image: files.image, header: files.header ?? null };
  } catch (e) {
    if (e instanceof MetaError) return reply.code(400).send({ error: e.message });
    throw e;
  }
});
app.get<{ Params: { file: string } }>("/meta/:file", async (req, reply) => {
  const f = meta.get(req.params.file);
  if (!f) return reply.code(404).send({ error: "not found" });
  return reply.header("Cache-Control", "public, max-age=31536000, immutable").type(f.mime).send(f.bytes);
});

await app.listen({ port: PORT, host: "0.0.0.0" });
