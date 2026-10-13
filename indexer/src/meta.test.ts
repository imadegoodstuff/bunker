import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMeta, decodeImage, MetaError, MetaStore, RateLimit, MAX_IMAGE_BYTES, FILE_RE } from "./meta.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const dataUrl = (bytes: Uint8Array, mime = "image/png") => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;

test("meta: images are sniffed, bounded and content-addressed; the JSON points at the image", () => {
  const m = buildMeta({ name: " Shielded Test ", symbol: "SHT", description: "a\u0000 test", image: dataUrl(PNG, "image/jpeg") }, "https://idx.example/");
  assert.equal(m.mime, "image/png", "the declared type is ignored; the bytes say PNG");
  assert.match(m.imageName, /^[0-9a-f]{64}\.png$/);
  assert.match(m.jsonName, /^[0-9a-f]{64}\.json$/);
  assert.equal(m.uri, `https://idx.example/meta/${m.jsonName}`);
  assert.ok(m.uri.length <= 200, "fits the mint's 200-byte URI");
  const j = JSON.parse(m.json);
  assert.equal(j.name, "Shielded Test");
  assert.equal(j.description, "a test");
  assert.equal(j.image, `https://idx.example/meta/${m.imageName}`);
  // same content, same names
  assert.equal(buildMeta({ name: "Shielded Test", symbol: "SHT", description: "a test", image: dataUrl(PNG) }, "https://idx.example").jsonName, m.jsonName);
  // different description, different JSON, same image
  const m2 = buildMeta({ name: "Shielded Test", symbol: "SHT", description: "other", image: dataUrl(PNG) }, "https://idx.example");
  assert.equal(m2.imageName, m.imageName);
  assert.notEqual(m2.jsonName, m.jsonName);
});

test("meta: rejections", () => {
  const ok = { name: "n", symbol: "S", image: dataUrl(PNG) };
  assert.throws(() => buildMeta({ ...ok, image: "https://x/y.png" }, "u"), MetaError);
  assert.throws(() => buildMeta({ ...ok, image: dataUrl(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])) }, "u"), /PNG, JPEG, GIF or WebP/);
  assert.throws(() => buildMeta({ ...ok, image: dataUrl(new Uint8Array(0)) }, "u"), MetaError);
  assert.throws(() => decodeImage(dataUrl(new Uint8Array(MAX_IMAGE_BYTES + 1).fill(0x89))), /larger/);
  assert.throws(() => buildMeta({ ...ok, name: "" }, "u"), /name is required/);
  assert.throws(() => buildMeta({ ...ok, name: "x".repeat(33) }, "u"), /longer/);
  assert.throws(() => buildMeta({ ...ok, symbol: "A B" }, "u"), /symbol may only/);
  assert.throws(() => buildMeta({ ...ok, symbol: "ABCDEFGHIJK" }, "u"), /longer/);
  assert.throws(() => buildMeta({ ...ok, description: "d".repeat(501) }, "u"), /longer/);
  // a <script> in the name is just text in JSON, but the symbol charset keeps it out of the ticker
  assert.throws(() => buildMeta({ ...ok, symbol: "<s>" }, "u"), MetaError);
  // webp is detected at offset 8
  const webp = new Uint8Array(20); webp.set([0x52, 0x49, 0x46, 0x46], 0); webp.set([0x57, 0x45, 0x42, 0x50], 8);
  assert.equal(decodeImage(dataUrl(webp)).ext, "webp");
});

test("meta: the store writes content-addressed files once and only serves well-formed names", () => {
  const dir = mkdtempSync(join(tmpdir(), "scash-meta-"));
  try {
    const store = new MetaStore(dir);
    const m = buildMeta({ name: "n", symbol: "S", image: dataUrl(PNG) }, "https://idx.example");
    store.put(m);
    store.put(m);
    assert.deepEqual([...store.get(m.imageName)!.bytes], [...PNG]);
    assert.equal(store.get(m.imageName)!.mime, "image/png");
    assert.equal(store.get(m.jsonName)!.mime, "application/json");
    assert.equal(store.get("../etc/passwd"), undefined);
    assert.equal(store.get("x".repeat(64) + ".png"), undefined);
    assert.equal(store.get(`${"0".repeat(64)}.png`), undefined);
    assert.ok(FILE_RE.test(m.jsonName) && !FILE_RE.test(m.jsonName + "/"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("meta: rate limit is a fixed window per key", () => {
  const rl = new RateLimit(2, 1000);
  assert.ok(rl.allow("a", 0) && rl.allow("a", 1) && !rl.allow("a", 2));
  assert.ok(rl.allow("b", 2));
  assert.ok(rl.allow("a", 1000), "window rolled");
});
