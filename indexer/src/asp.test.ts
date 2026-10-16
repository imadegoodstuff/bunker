// The association set must (1) vouch for shields from clean depositors and
// drop those from denylisted ones, (2) pass standing on to transactions that
// proved membership against one of its own earlier roots and withhold it from
// those that proved nothing, (3) hand out paths that verify against the root it
// publishes, and (4) rebuild when the denylist changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyPath } from "@bunker/sdk";
import { Db } from "./db.js";
import { AssociationSet, Denylist } from "./asp.js";

const hex = (n: number) => n.toString(16).padStart(64, "0");
const ZERO = "0".repeat(64);
const CLEAN = "0x1111111111111111111111111111111111111111";
const DIRTY = "0x2222222222222222222222222222222222222222";

function shield(db: Db, first: number, sender: string, tx = `0xs${first}`) {
  for (let i = 0; i < 3; i++) db.insertCommitment(first + i, hex(first + i + 1), "0x00", new Uint8Array([1]), tx, 100 + first, null);
  db.insertTransact(tx, first, sender, "5", ZERO, 100 + first);
}
function send(db: Db, first: number, aspRoot: string, tx = `0xp${first}`) {
  for (let i = 0; i < 3; i++) db.insertCommitment(first + i, hex(first + i + 1), null, new Uint8Array([1]), tx, 100 + first, null);
  db.insertTransact(tx, first, CLEAN, "0", aspRoot, 100 + first);
}

test("denylist parsing takes every address in a document and survives a failing source", async () => {
  const d = new Denylist(["https://a/list.txt", "https://b/list.json"], ["0x3333333333333333333333333333333333333333"]);
  const fetchImpl = (async (url: string) => {
    if (url.startsWith("https://a")) return new Response(`# sdn\n${DIRTY}\n0xAbCdEf0000000000000000000000000000000001 # note`);
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  await d.refresh(fetchImpl);
  assert.equal(d.size, 3);
  assert.ok(d.has(DIRTY) && d.has("0xabcdef0000000000000000000000000000000001") && d.has("0x3333333333333333333333333333333333333333"));
  assert.equal(d.sources[0].addresses, 2);
  assert.match(d.sources[1].error ?? "", /ECONNRESET/);
  assert.equal(d.version, 1);
  // a later failure of both sources keeps the list as it was
  await d.refresh((async () => { throw new Error("down"); }) as unknown as typeof fetch);
  assert.equal(d.size, 3);
  assert.equal(d.version, 1, "nothing changed");
});

test("membership follows depositors and proven lineage; paths verify against the published root", async () => {
  const db = new Db(":memory:");
  const denylist = new Denylist([], [DIRTY]);
  const asp = new AssociationSet(db, denylist);
  shield(db, 0, CLEAN);
  shield(db, 3, DIRTY);
  await asp.update();
  let s = asp.current();
  assert.equal(s.leaves, 3, "the clean shield's three leaves");
  assert.equal(s.excluded, 3, "the sanctioned depositor's three leaves");
  const root1 = s.root;
  assert.ok(asp.produced(root1));
  const p0 = await asp.path(0);
  assert.ok(p0 && (await verifyPath(BigInt("0x" + hex(1)), { elements: p0.elements.map(BigInt), indices: p0.indices }, BigInt(root1))));
  assert.equal(await asp.path(4), null, "a leaf from the dirty shield has no path");

  // a send that proved nothing breaks lineage; one that proved against root1 inherits it
  send(db, 6, ZERO);
  send(db, 9, root1.slice(2));
  send(db, 12, hex(424242), "0xforeign");
  await asp.update();
  s = asp.current();
  assert.equal(s.leaves, 6, "clean shield + the send that proved membership");
  assert.equal(s.excluded, 9);
  assert.equal(await asp.path(6), null);
  assert.ok(await asp.path(10));
  assert.notEqual(s.root, root1);
  assert.ok(asp.produced(root1) && asp.produced(s.root), "every root ever produced stays acceptable for lineage");

  // the denylist grows to cover the first depositor: the set is rebuilt from scratch. The shield drops out; the
  // send that proved membership against an earlier root keeps its standing (roots are not revoked retroactively:
  // the proof was valid when it was made, and the set cannot tell which notes it spent).
  const d2 = new Denylist([], [DIRTY, CLEAN]);
  const asp2 = new AssociationSet(db, d2);
  await asp2.update();
  assert.equal(asp2.current().leaves, 3, "only the send that proved lineage against root1");
  assert.equal(await asp2.path(0), null, "the now-denylisted shield is out");

  // a fresh instance on the same database remembers the roots it produced
  const again = new AssociationSet(db, new Denylist([], [DIRTY]));
  assert.ok(again.produced(root1));
  await again.update();
  assert.equal(again.current().root, s.root, "deterministic for the same inputs");
});

test("a batch (several Transacts in one tx) attributes each open note to the Transact before it", async () => {
  const db = new Db(":memory:");
  const asp = new AssociationSet(db, new Denylist([], [DIRTY]));
  // one tx: a clean shield at 0 whose exit minted an open note at 3, then a dirty shield at 4 with an open note at 7
  shield(db, 0, CLEAN, "0xbatch");
  db.insertOpenNote(3, hex(99), "0x00", "1", hex(7), new Uint8Array([2]), "0xbatch", 100, null);
  shield(db, 4, DIRTY, "0xbatch");
  db.insertOpenNote(7, hex(98), "0x00", "1", hex(7), new Uint8Array([2]), "0xbatch", 100, null);
  await asp.update();
  assert.equal(asp.current().leaves, 4);
  assert.equal(asp.current().excluded, 4);
  assert.ok(await asp.path(3));
  assert.equal(await asp.path(7), null);
});
