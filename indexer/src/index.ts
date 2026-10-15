import Fastify from "fastify";
import cors from "@fastify/cors";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, http, getAddress, defineChain } from "viem";
import { bsc, bscTestnet, hardhat } from "viem/chains";
import { readParams, PROTOCOL_VERSION } from "@bunker/sdk";
import { Db } from "./db.js";
import { Scanner } from "./scanner.js";
import { contiguousPrefix } from "./paging.js";
import { inspectContract, type ContractInfo } from "./contracts.js";
import { buildMeta, MAX_IMAGE_BYTES, MetaError, MetaStore, RateLimit } from "./meta.js";

const RPC = process.env.RPC_URL ?? "https://bsc-dataseed.bnbchain.org";
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 56);
const deployments = loadDeployments(CHAIN_ID);
if (deployments && (deployments.protocolVersion ?? 1) !== PROTOCOL_VERSION) throw new Error(`deployments file is protocol v${deployments.protocolVersion ?? 1}; this indexer speaks v${PROTOCOL_VERSION}`);
const POOL = getAddress(process.env.POOL_ADDRESS ?? deployments?.pool ?? fail("POOL_ADDRESS"));
// The launchpad; its own logs carry launches, trades and the agents' fee votes. "" disables.
const LAUNCHPAD = process.env.LAUNCHPAD_ADDRESS === "" ? undefined : getAddress(process.env.LAUNCHPAD_ADDRESS ?? deployments?.launchpad ?? fail("LAUNCHPAD_ADDRESS"));
const START_BLOCK = Number(process.env.START_BLOCK ?? deployments?.startBlock ?? 0);
const DB_PATH = process.env.DB_PATH ?? "./bunker-indexer.sqlite";
const PORT = Number(process.env.PORT ?? 8788);
// Launch metadata (token image + JSON) lives next to the database and is served from PUBLIC_URL/meta/…
const META_DIR = process.env.META_DIR ?? join(dirname(DB_PATH), "meta");
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;
const META_UPLOADS_PER_HOUR = Number(process.env.META_UPLOADS_PER_HOUR ?? 20);

function fail(name: string): never {
  throw new Error(`${name} not set and no deployments file for chain ${CHAIN_ID}`);
}
function loadDeployments(chainId: number): { protocolVersion?: number; pool?: string; launchpad?: string; startBlock?: number } | undefined {
  const p = process.env.DEPLOYMENTS ?? `contracts/deployments/${chainId}.json`;
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
}

// RPC_URLS: comma-separated fallbacks tried in order after RPC_URL whenever the primary throws.
const RPC_LIST = [RPC, ...(process.env.RPC_URLS ?? "").split(",").map((s) => s.trim()).filter((s) => s && s !== RPC)];
/** Keyed endpoints carry the key in the path or the query; /health shows the host only. */
const redact = (u: string) => {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host}${x.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "…";
  }
};

const chain = CHAIN_ID === 56 ? bsc : CHAIN_ID === 97 ? bscTestnet : CHAIN_ID === 31337 ? hardhat : defineChain({ id: CHAIN_ID, name: `chain-${CHAIN_ID}`, nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const clients = RPC_LIST.map((u) => createPublicClient({ chain, transport: http(u, { batch: true }) }));
const client = clients[0];
const db = new Db(DB_PATH);
const launchDecimals = LAUNCHPAD ? Number((await readParams(client, LAUNCHPAD)).decimals) : 6;
const scanner = new Scanner(clients, db, {
  pool: POOL,
  launchpad: LAUNCHPAD,
  startBlock: START_BLOCK,
  chunk: Number(process.env.SCAN_CHUNK ?? 2000),
  confirmations: Number(process.env.CONFIRMATIONS ?? 3),
  launchDecimals,
  intervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 3000),
});
console.log(`[indexer] chain ${CHAIN_ID}, pool ${POOL}, launchpad ${LAUNCHPAD ?? "-"}, from block ${START_BLOCK}; rpc endpoints: ${RPC_LIST.map(redact).join(", ")}`);
void scanner.start();

let onChain: { pool: ContractInfo; launchpad: ContractInfo | null } = await inspect();
setInterval(() => void inspect().then((p) => (onChain = p)), 10 * 60 * 1000).unref();
async function inspect() {
  return { pool: await inspectContract(client, POOL), launchpad: LAUNCHPAD ? await inspectContract(client, LAUNCHPAD) : null };
}

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" }, trustProxy: true });
await app.register(cors, { origin: true });
const meta = new MetaStore(META_DIR);
const metaLimit = new RateLimit(META_UPLOADS_PER_HOUR, 60 * 60 * 1000);

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

/** Process liveness only, for the platform's restart check. Data integrity is `/health`. */
app.get("/live", async () => ({ ok: true }));

app.get("/health", async (_req, reply) => {
  const degraded = scanner.degraded();
  const head = await client.getBlockNumber().catch(() => null);
  // 503 once the scan has been stuck for >10 min: wallets behind this indexer may be missing leaves.
  return reply.code(degraded ? 503 : 200).send({
    ok: !degraded,
    degraded,
    commit: process.env.GIT_SHA ?? "unknown",
    chainId: CHAIN_ID,
    pool: POOL,
    launchpad: LAUNCHPAD ?? null,
    onChain,
    protocolVersion: PROTOCOL_VERSION,
    commitments: db.count(),
    insertedIndex: db.insertedIndex(),
    scan: { ...scanner.status(), head: head === null ? null : Number(head) },
    rpc: redact(RPC),
    rpcs: RPC_LIST.map((u, i) => ({ url: redact(u), recovered: scanner.recoveredVia[i] })),
  });
});

/** Leaves and their note ciphertexts, paginated by leaf index. Wallets trial-decrypt these. */
app.get<{ Querystring: { from?: string; limit?: string } }>("/commitments", async (req) => {
  const from = Number(req.query.from ?? 0);
  const limit = Math.min(Number(req.query.limit ?? 500), 2000);
  // Serve only the contiguous prefix: a wallet that saw leaves past a hole would build the wrong tree.
  const rows = contiguousPrefix(db.commitments(from, limit), from);
  return {
    from,
    next: rows.length ? rows[rows.length - 1].idx + 1 : from,
    total: db.count(),
    items: rows.map((r) => ({
      index: r.idx, commitment: r.commitment, token: r.token, ciphertext: b64(r.ciphertext), txHash: r.tx_hash, block: r.block, blockTime: r.block_time,
      kind: r.kind, shares: r.shares, ownerHash: r.owner_hash,
    })),
  };
});

/** The shielded address an EOA registered on-chain (`ShieldedPool.register`), as the raw 43 bytes in hex; null if cleared or unknown. */
app.get<{ Params: { owner: string } }>("/registry/:owner", async (req, reply) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(req.params.owner)) return reply.code(400).send({ error: "bad address" });
  const r = db.registry(req.params.owner.toLowerCase());
  return { owner: req.params.owner.toLowerCase(), shieldedAddress: r?.shielded_address ?? null, block: r?.block ?? null };
});

/** Outgoing ciphertexts (sender-side recovery with ovk). */
app.get<{ Querystring: { from?: string; limit?: string } }>("/outgoing", async (req) => {
  const from = Number(req.query.from ?? 0);
  const limit = Math.min(Number(req.query.limit ?? 500), 2000);
  return db.outCiphertexts(from, limit).map((r) => ({ firstIndex: r.first_idx, txHash: r.tx_hash, ciphertext: b64(r.ciphertext) }));
});

app.get<{ Params: { nf: string } }>("/nullifiers/:nf", async (req) => ({ nullifier: req.params.nf, spent: db.hasNullifier(req.params.nf.toLowerCase().replace(/^0x/, "").padStart(64, "0")) }));
app.get<{ Querystring: { sinceBlock?: string; limit?: string } }>("/nullifiers", async (req) =>
  db.nullifiersSince(Number(req.query.sinceBlock ?? 0), Math.min(Number(req.query.limit ?? 1000), 5000))
);
app.get<{ Querystring: { n?: string } }>("/roots", async (req) => db.latestRoots(Math.min(Number(req.query.n ?? 32), 128)));

/** Anonymity-set statistics for the UI (per asset, recent window). */
app.get<{ Querystring: { sinceBlock?: string; days?: string } }>("/stats", async (req) => {
  const since = Number(req.query.sinceBlock ?? 0);
  const perToken: Record<string, { shields: number; unshields: number; donated: string; shielded: string; unshielded: string }> = {};
  for (const r of db.stats(since)) {
    const m = (perToken[r.token] ??= { shields: 0, unshields: 0, donated: "0", shielded: "0", unshielded: "0" });
    if (r.kind === "shield") { m.shields = r.n; m.shielded = String(r.total ?? 0); }
    if (r.kind === "unshield") { m.unshields = r.n; m.unshielded = String(r.total ?? 0); }
    if (r.kind === "donate") m.donated = String(r.total ?? 0);
  }
  return { leaves: db.count(), perToken, daily: db.dailyActivity(Number(req.query.days ?? 30)) };
});

/**
 * Launchpad: tokens launched through the shielded curve. Everything here is
 * public on-chain already (curve reserves, trade sizes, fee flows); what is
 * absent is who traded: a private trade's proceeds come back into the pool as
 * an open note whose owner is a hash.
 */
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
app.get<{ Params: { token: string }; Querystring: { limit?: string; beforeBlock?: string } }>("/launches/:token", async (req, reply) => {
  const token = req.params.token.toLowerCase();
  const l = db.launch(token);
  if (!l) return reply.code(404).send({ error: "unknown launch" });
  const trades = db.trades(token, Math.min(Number(req.query.limit ?? 50), 500), req.query.beforeBlock ? Number(req.query.beforeBlock) : undefined);
  const feeEvents = db.feeEvents(token, 100);
  return { ...withImage(l), trades, feeEvents };
});

/**
 * Launch metadata. The app uploads the token's icon (required) and an optional
 * 3:1 header with its name/symbol/description before the launch transaction;
 * the token's URI then points at the JSON written here. Content-addressed and
 * immutable; the only writable endpoint of the indexer, so it is bounded
 * (4.5 MB per image, sniffed image types, per-IP rate limit) and holds nothing
 * that identifies the uploader.
 */
const META_BODY_LIMIT = Math.ceil((2 * MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;
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
