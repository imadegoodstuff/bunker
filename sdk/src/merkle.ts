// Append-only Poseidon Merkle tree mirroring the on-chain structure. Used by
// clients and the indexer to compute membership paths.
import { poseidon } from "./crypto.js";
import { TREE_DEPTH, mod, bytesToBigIntBE } from "./field.js";

export interface MerklePath {
  elements: bigint[];
  indices: number[]; // bits, LSB first
}

export const EMPTY_LEAF_PREIMAGE = mod(bytesToBigIntBE(new TextEncoder().encode("scash_empty")));

export class MerkleTree {
  readonly depth: number;
  private zeros: bigint[] = [];
  private layers: bigint[][] = [];
  private ready: Promise<void>;

  constructor(depth = TREE_DEPTH, leaves: bigint[] = []) {
    this.depth = depth;
    this.ready = this.init(leaves);
  }

  private async init(leaves: bigint[]) {
    let z = await poseidon([EMPTY_LEAF_PREIMAGE]);
    this.zeros = [z];
    for (let i = 1; i <= this.depth; i++) {
      z = await poseidon([z, z]);
      this.zeros.push(z);
    }
    this.layers = [];
    for (let i = 0; i <= this.depth; i++) this.layers.push([]);
    for (const l of leaves) await this.insertInternal(l);
  }

  async whenReady() {
    await this.ready;
  }

  get emptyLeaf(): bigint {
    return this.zeros[0];
  }

  zeroAt(level: number): bigint {
    return this.zeros[level];
  }

  get size(): number {
    return this.layers[0].length;
  }

  private async insertInternal(leaf: bigint) {
    let idx = this.layers[0].length;
    if (idx >= 2 ** this.depth) throw new Error("tree full");
    this.layers[0].push(leaf);
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const layer = this.layers[lvl];
      const parentIdx = idx >> 1;
      const left = layer[parentIdx * 2];
      const right = parentIdx * 2 + 1 < layer.length ? layer[parentIdx * 2 + 1] : this.zeros[lvl];
      const h = await poseidon([left, right]);
      this.layers[lvl + 1][parentIdx] = h;
      idx = parentIdx;
    }
  }

  async insert(leaf: bigint): Promise<number> {
    await this.ready;
    const pos = this.layers[0].length;
    await this.insertInternal(leaf);
    return pos;
  }

  async insertMany(leaves: bigint[]): Promise<void> {
    for (const l of leaves) await this.insert(l);
  }

  async root(): Promise<bigint> {
    await this.ready;
    if (this.layers[0].length === 0) return this.zeros[this.depth];
    return this.layers[this.depth][0];
  }

  async path(index: number): Promise<MerklePath> {
    await this.ready;
    if (index < 0 || index >= this.layers[0].length) throw new Error("leaf index out of range");
    const elements: bigint[] = [];
    const indices: number[] = [];
    let idx = index;
    for (let lvl = 0; lvl < this.depth; lvl++) {
      const sibling = idx ^ 1;
      const layer = this.layers[lvl];
      elements.push(sibling < layer.length ? layer[sibling] : this.zeros[lvl]);
      indices.push(idx & 1);
      idx >>= 1;
    }
    return { elements, indices };
  }

  /** Zero path for dummy spends (any valid-shaped path is accepted when value == 0). */
  dummyPath(): MerklePath {
    return { elements: this.zeros.slice(0, this.depth), indices: new Array(this.depth).fill(0) };
  }

  leaves(): readonly bigint[] {
    return this.layers[0];
  }
}

export async function verifyPath(leaf: bigint, path: MerklePath, root: bigint): Promise<boolean> {
  let h = leaf;
  for (let i = 0; i < path.elements.length; i++) {
    h = path.indices[i] === 0 ? await poseidon([h, path.elements[i]]) : await poseidon([path.elements[i], h]);
  }
  return h === root;
}
