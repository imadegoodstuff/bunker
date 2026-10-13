// High-level wallet: scans ciphertexts with ivk, tracks spendable notes,
// builds shield / send / unshield transactions through a relayer.
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { BabyJub, type Point } from "./crypto.js";
import { MAX_U64, randomField } from "./field.js";
import { encryptNote, encryptOutgoing, tryDecryptNote, NOTE_CIPHERTEXT_LEN_NO_MEMO } from "./encryption.js";
import { extDataHash, NO_EXIT, type ExtData } from "./extdata.js";
import { fullViewingKey, groupHash, newAddress, spendingKeyFromSeed, type Address, type FullViewingKey, type SpendingKey } from "./keys.js";
import { MerkleTree } from "./merkle.js";
import { noteCommitment, nullifier, type Note, type SpendableNote } from "./note.js";
import { prove, type CircuitArtifacts, type CircuitName, type SpendInput, type TransactProof } from "./prover.js";
import { transactIx, findRootIndex, type PoolState, type TreeState, type TransactAccounts, sharesForDeposit, sharesForWithdraw, amountForMint } from "./program.js";

export interface IndexedOutput {
  index: number; // leaf index
  commitment: bigint;
  ciphertext: Uint8Array;
}

export interface WalletState {
  notes: SpendableNote[]; // unspent, owned
  spentNullifiers: Set<string>;
}

export interface BuiltTransact {
  proof: TransactProof;
  ext: ExtData;
  root: bigint;
  rootIndex: number;
  publicAmount: bigint;
  aspRoot: bigint;
  instruction: TransactionInstruction;
  outputs: Note[];
  /** Nullifiers of the notes consumed, to mark them pending locally. */
  consumed: bigint[];
}

export class ShieldedWallet {
  readonly spend: SpendingKey;
  readonly fvk: FullViewingKey;
  readonly bjj: BabyJub;
  readonly notes = new Map<string, SpendableNote>(); // key = commitment hex
  readonly nullifierOf = new Map<string, bigint>(); // commitment -> nf
  private pending = new Set<string>();

  private constructor(spend: SpendingKey, fvk: FullViewingKey, bjj: BabyJub) {
    this.spend = spend;
    this.fvk = fvk;
    this.bjj = bjj;
  }

  static async fromSeed(seed: Uint8Array): Promise<ShieldedWallet> {
    const spend = spendingKeyFromSeed(seed);
    const fvk = await fullViewingKey(spend);
    return new ShieldedWallet(spend, fvk, await BabyJub.load());
  }

  address(): Address {
    return newAddress(this.bjj, this.fvk.ivk);
  }

  selfPoint(): { gd: Point; pkd: Point } {
    const a = this.address();
    return { gd: groupHash(this.bjj, a.d)!, pkd: a.pkd };
  }

  /** Try to decrypt an on-chain output; if it is ours, remember it. */
  async scan(out: IndexedOutput, asset: bigint): Promise<SpendableNote | null> {
    const r = tryDecryptNote(this.bjj, this.fvk.ivk, out.ciphertext);
    if (!r) return null;
    const gd = groupHash(this.bjj, r.plaintext.d);
    if (!gd) return null;
    const pkd = this.bjj.mulScalar(gd, this.fvk.ivk);
    const note: Note = { asset, value: r.plaintext.value, gd, pkd, rho: r.plaintext.rho, rcm: r.plaintext.rcm };
    const cm = await noteCommitment(note);
    if (cm !== out.commitment) return null;
    const sn: SpendableNote = { ...note, commitment: cm, position: out.index, memo: r.plaintext.memo };
    const key = cm.toString(16);
    if (note.value > 0n) {
      this.notes.set(key, sn);
      this.nullifierOf.set(key, await nullifier(this.fvk.nk, note.rho, out.index));
    }
    return sn;
  }

  /** Drop notes whose nullifier has appeared on-chain. */
  markSpent(nullifiers: Iterable<bigint>) {
    const spent = new Set(Array.from(nullifiers, (n) => n.toString(16)));
    for (const [key, nf] of this.nullifierOf) {
      if (spent.has(nf.toString(16))) {
        this.notes.delete(key);
        this.nullifierOf.delete(key);
        this.pending.delete(key);
      }
    }
  }

  balance(asset: bigint): bigint {
    let b = 0n;
    for (const n of this.notes.values()) if (n.asset === asset && !this.pending.has(n.commitment.toString(16))) b += n.value;
    return b;
  }

  spendable(asset: bigint): SpendableNote[] {
    return [...this.notes.values()]
      .filter((n) => n.asset === asset && !this.pending.has(n.commitment.toString(16)))
      .sort((a, b) => (a.value > b.value ? -1 : 1));
  }

  /** Greedy coin selection: largest first, at most 4 inputs. */
  selectInputs(asset: bigint, target: bigint): SpendableNote[] {
    const pool = this.spendable(asset);
    const chosen: SpendableNote[] = [];
    let sum = 0n;
    for (const n of pool) {
      if (sum >= target || chosen.length === 4) break;
      chosen.push(n);
      sum += n.value;
    }
    if (sum < target) throw new Error(`insufficient shielded balance: have ${sum}, need ${target}`);
    return chosen;
  }

  /**
   * Build a transact proof + instruction.
   *  - shield:   amount > 0, inputs empty, outputs = [note(to self or recipient), change 0]
   *  - send:     amount = 0, outputs = [note(to recipient), change(to self)]
   *  - unshield: amount < 0 with recipient = public account
   */
  async buildTransact(opts: {
    asset: bigint;
    mint: PublicKey;
    tokenProgram?: PublicKey;
    pool: PoolState;
    tree: MerkleTree;
    /** On-chain tree state, used to locate the root in the ring (or pass rootIndex). */
    chainTree?: TreeState;
    rootIndex?: number;
    artifacts: Record<CircuitName, CircuitArtifacts>;
    kind: "shield" | "send" | "unshield";
    amount: bigint; // asset base units
    to?: Address; // shielded recipient (send / shield-to-other)
    recipient?: PublicKey; // public recipient (unshield)
    relayer: PublicKey;
    relayerDest: PublicKey;
    relayerFee: bigint; // base units, taken from unshield amount
    payer: PublicKey;
    depositor?: PublicKey;
    depositorSource?: PublicKey;
    memo?: Uint8Array;
    aspRoot?: bigint;
    aspPathFor?: (cm: bigint) => Promise<{ elements: bigint[]; indices: number[] } | undefined>;
    exitTarget?: PublicKey;
    exitData?: Uint8Array;
    exitAccounts?: import("@solana/web3.js").AccountMeta[];
  }): Promise<BuiltTransact> {
    const { asset, pool, tree, kind } = opts;
    const self = this.address();
    const selfGd = groupHash(this.bjj, self.d)!;

    let publicShares = 0n;
    let inputs: SpendableNote[] = [];
    let outputs: Note[];
    let toAddr: Address;
    let toGd: Point;

    if (kind === "shield") {
      publicShares = sharesForDeposit(pool, opts.amount);
      if (publicShares <= 0n) throw new Error("amount too small");
      toAddr = opts.to ?? self;
      toGd = groupHash(this.bjj, toAddr.d)!;
      outputs = [
        { asset, value: publicShares, gd: toGd, pkd: toAddr.pkd, rho: randomField(), rcm: randomField() },
        { asset, value: 0n, gd: selfGd, pkd: self.pkd, rho: randomField(), rcm: randomField() },
      ];
    } else if (kind === "send") {
      if (!opts.to) throw new Error("recipient address required");
      const sharesOut = sharesForWithdraw(pool, opts.amount);
      const feeShares = opts.relayerFee > 0n ? sharesForWithdraw(pool, opts.relayerFee) : 0n;
      inputs = this.selectInputs(asset, sharesOut + feeShares);
      const inSum = inputs.reduce((a, n) => a + n.value, 0n);
      publicShares = -feeShares; // the relayer fee leaves the pool publicly
      toAddr = opts.to;
      toGd = groupHash(this.bjj, toAddr.d)!;
      outputs = [
        { asset, value: sharesOut, gd: toGd, pkd: toAddr.pkd, rho: randomField(), rcm: randomField() },
        { asset, value: inSum - sharesOut - feeShares, gd: selfGd, pkd: self.pkd, rho: randomField(), rcm: randomField() },
      ];
    } else {
      if (!opts.recipient) throw new Error("public recipient required");
      const sharesOut = sharesForWithdraw(pool, opts.amount);
      inputs = this.selectInputs(asset, sharesOut);
      const inSum = inputs.reduce((a, n) => a + n.value, 0n);
      publicShares = -sharesOut;
      toAddr = self;
      toGd = selfGd;
      outputs = [
        { asset, value: inSum - sharesOut, gd: selfGd, pkd: self.pkd, rho: randomField(), rcm: randomField() },
        { asset, value: 0n, gd: selfGd, pkd: self.pkd, rho: randomField(), rcm: randomField() },
      ];
    }
    if (outputs.some((o) => o.value < 0n || o.value > MAX_U64)) throw new Error("output value out of range");

    // encrypt outputs
    const includeMemo = !!opts.memo;
    const c0 = encryptNote(this.bjj, kind === "unshield" ? self : toAddr, outputs[0], opts.memo, includeMemo);
    const c1 = encryptNote(this.bjj, self, outputs[1], undefined, false);
    const cm0 = await noteCommitment(outputs[0]);
    const outCipher = encryptOutgoing(this.bjj, this.spend.ovk, cm0, outputs[0].pkd, c0.esk);

    const relayerFee = kind === "shield" ? 0n : opts.relayerFee;
    const recipient = kind === "unshield" ? opts.recipient! : opts.relayerDest;
    const ext: ExtData = {
      recipient,
      relayer: opts.relayer,
      relayerFee,
      exitTarget: opts.exitTarget ?? NO_EXIT,
      exitData: opts.exitData ?? new Uint8Array(0),
      ciphertexts: [c0.ciphertext, c1.ciphertext],
      outCiphertext: outCipher,
    };
    const extHash = extDataHash(ext);

    const spendInputs: SpendInput[] = [];
    for (const n of inputs) {
      spendInputs.push({ note: n, path: await tree.path(n.position), aspPath: opts.aspPathFor ? await opts.aspPathFor(n.commitment) : undefined });
    }
    const root = await tree.root();
    const proof = await prove(
      {
        spend: this.spend,
        fvk: this.fvk,
        root,
        asset,
        publicAmount: publicShares,
        extDataHash: extHash,
        aspRoot: opts.aspRoot ?? 0n,
        inputs: spendInputs,
        outputs,
        dummyPath: tree.dummyPath(),
        self: { gd: selfGd, pkd: self.pkd },
      },
      opts.artifacts
    );

    const rootIndex = opts.rootIndex ?? findRootIndex(opts.chainTree!, root);
    if (rootIndex < 0) throw new Error("local root is not in the on-chain ring; resync");
    const accounts: TransactAccounts = {
      payer: opts.payer,
      mint: opts.mint,
      tokenProgram: opts.tokenProgram,
      depositor: opts.depositor ?? opts.payer,
      depositorSource: opts.depositorSource ?? opts.depositor ?? opts.payer,
      recipient,
      relayerDest: opts.relayerDest,
      exitTarget: opts.exitTarget,
      exitAccounts: opts.exitAccounts,
    };
    const instruction = transactIx(accounts, proof, rootIndex, publicShares, opts.aspRoot ?? 0n, ext);

    for (const n of inputs) this.pending.add(n.commitment.toString(16));
    return { proof, ext, root, rootIndex, publicAmount: publicShares, aspRoot: opts.aspRoot ?? 0n, instruction, outputs, consumed: proof.nullifiers.slice(0, inputs.length) };
  }

  /** Undo a pending mark if a built transaction was never submitted. */
  release(consumedCommitments: bigint[]) {
    for (const c of consumedCommitments) this.pending.delete(c.toString(16));
  }
}

export { NOTE_CIPHERTEXT_LEN_NO_MEMO, SystemProgram, amountForMint };
