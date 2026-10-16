// Association-set provider (SPEC §10). The set is a Poseidon Merkle tree, the
// same shape as the pool's own tree, over the subset of leaves this indexer
// vouches for. A proof against its root shows "every note I spend is in this
// set" without saying which, so a withdrawal can be compliant and private at
// once. Membership is decided per transaction, from what the chain publishes:
//
//   * a shield (publicAmount > 0) is vouched for when its depositor is not on
//     the denylist (OFAC SDN digital-currency addresses by default);
//   * any other transaction is vouched for when its proof was made against a
//     root this indexer itself produced earlier: its inputs were in the set, so
//     its outputs inherit the standing. A send that proved no set membership
//     breaks the lineage (the indexer cannot see which notes it spent), and its
//     outputs are not in the set until they are re-vouched for;
//   * an open note (exit proceeds re-entering the pool) follows the transaction
//     that created it.
//
// Nothing here de-anonymises anyone: the inputs are events everybody can read,
// and the output is a root plus membership paths. A different provider can
// publish a different set from the same data; wallets pick the provider.
import { MerkleTree, TREE_DEPTH } from "@bunker/sdk";
import type { Db } from "./db.js";

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/g;
const ZERO_ROOT = "0".repeat(64);

export interface DenylistSource { url: string; addresses: number; fetchedAt: number | null; error?: string }

/** Sanctioned / flagged depositors. Fetched from text or JSON documents: every 0x-address in them counts. */
export class Denylist {
  readonly sources: DenylistSource[];
  private set = new Set<string>();
  /** Bumped whenever the set's contents change, so the tree knows to rebuild. */
  version = 0;

  private readonly inline: Set<string>;
  /** last successful fetch per source; a failed refresh keeps the previous contents rather than shrinking the list */
  private perSource = new Map<string, Set<string>>();

  constructor(urls: string[], inline: string[] = []) {
    this.sources = urls.map((url) => ({ url, addresses: 0, fetchedAt: null }));
    this.inline = new Set(inline.map((a) => a.toLowerCase()));
    this.set = new Set(this.inline);
  }
  has(address: string) { return this.set.has(address.toLowerCase()); }
  get size() { return this.set.size; }

  async refresh(fetchImpl: typeof fetch = fetch) {
    for (const s of this.sources) {
      try {
        const r = await fetchImpl(s.url, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const found = new Set(((await r.text()).match(ADDRESS_RE) ?? []).map((a) => a.toLowerCase()));
        this.perSource.set(s.url, found);
        s.addresses = found.size;
        s.fetchedAt = Date.now();
        delete s.error;
      } catch (e) {
        s.error = (e as Error).message;
      }
    }
    const next = new Set(this.inline);
    for (const found of this.perSource.values()) for (const a of found) next.add(a);
    if (next.size !== this.set.size || [...next].some((a) => !this.set.has(a))) {
      this.set = next;
      this.version++;
    }
  }
}

export interface AspSnapshot {
  root: string; // 0x-prefixed 32-byte hex
  leaves: number;
  excluded: number;
  updatedAt: number | null;
  /** leaf index in the pool tree → position in the association set */
  positions: Map<number, number>;
}

export class AssociationSet {
  private tree = new MerkleTree(TREE_DEPTH);
  private snapshot: AspSnapshot = { root: "0x" + ZERO_ROOT, leaves: 0, excluded: 0, updatedAt: null, positions: new Map() };
  /** every root this instance has produced; a transaction proved against one of these passes its standing on */
  private ownRoots = new Set<string>();
  private builtTransacts = 0;
  private builtDenylist = -1;
  private building: Promise<void> | null = null;

  constructor(readonly db: Db, readonly denylist: Denylist, readonly log: (s: string) => void = () => {}) {
    for (const r of (db.getMeta("asp_roots") ?? "").split(",").filter(Boolean)) this.ownRoots.add(r);
  }

  current(): AspSnapshot { return this.snapshot; }
  /** True if this provider ever published `root` (hex, no prefix). */
  produced(root: string) { return this.ownRoots.has(root.toLowerCase().replace(/^0x/, "").padStart(64, "0")); }

  /** Bring the set up to date with the database. Appends when nothing earlier changed; rebuilds when the denylist moved. */
  async update(): Promise<void> {
    if (this.building) return this.building;
    this.building = this.rebuild().finally(() => (this.building = null));
    return this.building;
  }

  private async rebuild() {
    const txs = this.db.transacts();
    const fresh = this.builtDenylist !== this.denylist.version;
    if (!fresh && txs.length === this.builtTransacts) return;
    if (fresh) {
      this.tree = new MerkleTree(TREE_DEPTH);
      this.builtTransacts = 0;
      this.snapshot = { ...this.snapshot, positions: new Map(), excluded: 0 };
    }
    await this.tree.whenReady();
    // Leaves per Transact: its three notes (first_idx..+2) and any open note of the same tx minted after it and
    // before the tx's next Transact (a batch produces several Transacts in one tx).
    const all = this.db.allLeaves();
    const byFirst = new Map<number, { idx: number; commitment: string }[]>();
    const firstsByTx = new Map<string, number[]>();
    for (const t of txs) {
      byFirst.set(t.first_idx, []);
      firstsByTx.set(t.tx_hash, [...(firstsByTx.get(t.tx_hash) ?? []), t.first_idx]);
    }
    for (const l of all) {
      const firsts = firstsByTx.get(l.tx_hash) ?? [];
      let owner = -1;
      for (const f of firsts) if (f <= l.idx && f > owner) owner = f;
      if (owner >= 0) byFirst.get(owner)!.push({ idx: l.idx, commitment: l.commitment });
    }
    let excluded = this.snapshot.excluded;
    const positions = this.snapshot.positions;
    for (let i = this.builtTransacts; i < txs.length; i++) {
      const t = txs[i];
      const shield = BigInt(t.public_amount) > 0n;
      const ok = shield ? !this.denylist.has(t.sender) : t.asp_root !== ZERO_ROOT && this.ownRoots.has(t.asp_root);
      for (const l of byFirst.get(t.first_idx) ?? []) {
        if (!ok) { excluded++; continue; }
        if (positions.has(l.idx)) continue;
        const pos = await this.tree.insert(BigInt("0x" + l.commitment));
        positions.set(l.idx, pos);
      }
    }
    this.builtTransacts = txs.length;
    this.builtDenylist = this.denylist.version;
    const rootHex = (await this.tree.root()).toString(16).padStart(64, "0");
    if (!this.ownRoots.has(rootHex) && this.tree.size > 0) {
      this.ownRoots.add(rootHex);
      this.db.setMeta("asp_roots", [...this.ownRoots].slice(-4096).join(","));
    }
    const changed = rootHex !== this.snapshot.root.slice(2);
    this.snapshot = { root: "0x" + rootHex, leaves: this.tree.size, excluded, updatedAt: changed || this.snapshot.updatedAt === null ? Date.now() : this.snapshot.updatedAt, positions };
    if (changed) this.log(`association set: ${this.tree.size} leaves (${excluded} excluded), root 0x${rootHex.slice(0, 12)}…`);
  }

  /** Membership path for the leaf at pool index `idx`, or null if it is not in the set. */
  async path(idx: number): Promise<{ root: string; elements: string[]; indices: number[] } | null> {
    const pos = this.snapshot.positions.get(idx);
    if (pos === undefined) return null;
    const p = await this.tree.path(pos);
    return { root: this.snapshot.root, elements: p.elements.map((e) => "0x" + e.toString(16).padStart(64, "0")), indices: p.indices };
  }
}

/** The default list: OFAC's SDN digital-currency addresses, maintained as a flat file from the official XML. */
export const DEFAULT_DENYLIST_URLS = ["https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt"];
