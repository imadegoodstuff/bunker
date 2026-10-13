// Token metadata hosting for the launchpad. A launch needs an image; the app
// uploads it here together with name/symbol/description, and the mint's URI
// points at the JSON this writes. Files are content-addressed (sha256) and
// immutable, so a URI always resolves to exactly what the creator uploaded,
// and uploading the same thing twice costs nothing.
import { createHash } from "node:crypto";
import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_IMAGE_BYTES = 512 * 1024;
export const MAX_NAME = 32;
export const MAX_SYMBOL = 10;
export const MAX_DESCRIPTION = 500;

const MAGIC: { mime: string; ext: string; head: number[]; at?: number }[] = [
  { mime: "image/png", ext: "png", head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", ext: "jpg", head: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", ext: "gif", head: [0x47, 0x49, 0x46, 0x38] },
  { mime: "image/webp", ext: "webp", head: [0x57, 0x45, 0x42, 0x50], at: 8 },
];
export const EXT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", json: "application/json" };

export interface MetaInput { name: string; symbol: string; description?: string; image: string }
export interface MetaFiles { imageName: string; imageBytes: Uint8Array; jsonName: string; json: string; mime: string }

export class MetaError extends Error {}

/** Decode a `data:` URL, sniff the real type from the bytes (the declared type is not trusted) and bound the size. */
export function decodeImage(dataUrl: string): { bytes: Uint8Array; mime: string; ext: string } {
  const m = /^data:([a-z0-9./+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(dataUrl ?? "");
  if (!m) throw new MetaError("image must be a base64 data URL");
  if (m[2].length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 16) throw new MetaError(`image larger than ${MAX_IMAGE_BYTES / 1024} KiB`);
  const bytes = new Uint8Array(Buffer.from(m[2].replace(/\s/g, ""), "base64"));
  if (bytes.length === 0) throw new MetaError("empty image");
  if (bytes.length > MAX_IMAGE_BYTES) throw new MetaError(`image larger than ${MAX_IMAGE_BYTES / 1024} KiB`);
  const kind = MAGIC.find((k) => k.head.every((b, i) => bytes[(k.at ?? 0) + i] === b));
  if (!kind) throw new MetaError("image must be PNG, JPEG, GIF or WebP");
  return { bytes, mime: kind.mime, ext: kind.ext };
}

const clean = (s: unknown, max: number, what: string, required: boolean): string => {
  if (s === undefined || s === null) s = "";
  if (typeof s !== "string") throw new MetaError(`${what} must be a string`);
  const t = s.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (required && !t) throw new MetaError(`${what} is required`);
  if (t.length > max) throw new MetaError(`${what} longer than ${max} characters`);
  return t;
};

/** Validate an upload and lay out the two files it becomes. `publicUrl` is where `/meta/<file>` is served from. */
export function buildMeta(input: MetaInput, publicUrl: string): MetaFiles & { uri: string; image: string } {
  const name = clean(input.name, MAX_NAME, "name", true);
  const symbol = clean(input.symbol, MAX_SYMBOL, "symbol", true);
  if (!/^[A-Za-z0-9._-]+$/.test(symbol)) throw new MetaError("symbol may only use letters, digits, . _ -");
  const description = clean(input.description, MAX_DESCRIPTION, "description", false);
  const img = decodeImage(input.image);
  const imageName = `${sha256(img.bytes)}.${img.ext}`;
  const base = publicUrl.replace(/\/+$/, "");
  const image = `${base}/meta/${imageName}`;
  const json = JSON.stringify({ name, symbol, description, image, properties: { files: [{ uri: image, type: img.mime }], category: "image" } });
  const jsonName = `${sha256(Buffer.from(json))}.json`;
  return { imageName, imageBytes: img.bytes, jsonName, json, mime: img.mime, uri: `${base}/meta/${jsonName}`, image };
}

export function sha256(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex");
}

/** Only content-addressed names are ever read or written. */
export const FILE_RE = /^[0-9a-f]{64}\.(png|jpg|gif|webp|json)$/;

export class MetaStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }
  put(files: MetaFiles) {
    this.write(files.imageName, files.imageBytes);
    this.write(files.jsonName, Buffer.from(files.json));
  }
  private write(name: string, bytes: Uint8Array) {
    if (!FILE_RE.test(name)) throw new MetaError("bad file name");
    const path = join(this.dir, name);
    if (existsSync(path)) return; // content-addressed: same name, same bytes
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }
  get(name: string): { bytes: Buffer; mime: string } | undefined {
    if (!FILE_RE.test(name)) return undefined;
    const path = join(this.dir, name);
    if (!existsSync(path)) return undefined;
    return { bytes: readFileSync(path), mime: EXT_MIME[name.slice(name.lastIndexOf(".") + 1)] };
  }
}

/** Fixed-window per-key limiter for uploads (images are the only thing anyone can write here). */
export class RateLimit {
  private hits = new Map<string, { n: number; windowStart: number }>();
  constructor(readonly max: number, readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || now - h.windowStart >= this.windowMs) {
      this.hits.set(key, { n: 1, windowStart: now });
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now - v.windowStart >= this.windowMs) this.hits.delete(k);
      return true;
    }
    if (h.n >= this.max) return false;
    h.n++;
    return true;
  }
}
