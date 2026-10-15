// High-level wallet: scans ciphertexts with ivk, tracks spendable notes,
// builds shield / send / unshield transactions (as viem contract calls).
import { BabyJub, type Point } from "./crypto.js";
import { MAX_U64 } from "./field.js";
import { encryptNote, encryptOutgoing, tryDecryptNote, NOTE_CIPHERTEXT_LEN_NO_MEMO } from "./encryption.js";
import { extDataHash, NO_EXIT, ZERO_ADDRESS, type EvmAddress, type ExtData } from "./extdata.js";
import { fullViewingKey, groupHash, newAddress, spendingKeyFromSeed, type Address, type FullViewingKey, type SpendingKey } from "./keys.js";
import { MerkleTree } from "./merkle.js";
import { noteCommitment, nullifier, freshRandomness, type Note, type SpendableNote } from "./note.js";
import { prove, type CircuitArtifacts, type CircuitName, type SpendInput, type TransactProof } from "./prover.js";
import { transactCall, sharesForDeposit, sharesForWithdraw, amountForMint, type PoolState, type TransactCall } from "./pool.js";

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
  publicAmount: bigint;
  aspRoot: bigint;
  /** The contract call: `walletClient.writeContract(call)` or hand `call` to the relayer. */
  call: TransactCall;
  outputs: Note[];
  /** Commitments of the input notes, now marked pending; hand back to `release` if the transaction is never submitted. */
  consumed: bigint[];
  /** Nullifiers of the same input notes (what the chain will record); feed to `markSpent` once confirmed. */
  consumedNullifiers: bigint[];
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
    const note: Note = { asset, value: r.plaintext.value, gd, pkd, rseed: r.plaintext.rseed, rho: r.plaintext.rho, rcm: r.plaintext.rcm };
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
   * Build a transact proof + contract call. Amounts are in the pool's internal
   * units (`PoolState.unit` wei each; gwei for BNB).
   *  - shield:   amount > 0, inputs empty, outputs = [note(to self or recipient), change 0]; `value` = cost in wei
   *  - send:     amount = 0, outputs = [note(to recipient), change(to self)]
   *  - unshield: amount < 0 with recipient = public account
   */
  async buildTransact(opts: {
    asset: bigint;
    /** pool contract */
    poolAddress: EvmAddress;
    /** asset address, ZERO_ADDRESS for BNB */
    token: EvmAddress;
    pool: PoolState;
    tree: MerkleTree;
    artifacts: Record<CircuitName, CircuitArtifacts>;
    kind: "shield" | "send" | "unshield";
    amount: bigint; // internal units
    to?: Address; // shielded recipient (send / shield-to-other)
    recipient?: EvmAddress; // public recipient (unshield)
    relayer: EvmAddress;
    relayerFee: bigint; // internal units, taken from unshield amount
    memo?: Uint8Array;
    aspRoot?: bigint;
    aspProvider?: EvmAddress;
    aspPathFor?: (cm: bigint) => Promise<{ elements: bigint[]; indices: number[] } | undefined>;
    exitTarget?: EvmAddress;
    exitData?: Uint8Array;
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
        { asset, value: publicShares, gd: toGd, pkd: toAddr.pkd, ...freshRandomness() },
        { asset, value: 0n, gd: selfGd, pkd: self.pkd, ...freshRandomness() },
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
        { asset, value: sharesOut, gd: toGd, pkd: toAddr.pkd, ...freshRandomness() },
        { asset, value: inSum - sharesOut - feeShares, gd: selfGd, pkd: self.pkd, ...freshRandomness() },
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
        { asset, value: inSum - sharesOut, gd: selfGd, pkd: self.pkd, ...freshRandomness() },
        { asset, value: 0n, gd: selfGd, pkd: self.pkd, ...freshRandomness() },
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
    const recipient: EvmAddress = kind === "unshield" ? opts.recipient! : opts.relayer;
    // The second output of a shield or an unshield is a zero-value dummy to the
    // sender; an unshield's first output is the sender's own change. Their
    // ciphertexts (and an unshield's outgoing record) carry nothing anyone will
    // decrypt, so they are sent empty to save calldata. A private send keeps
    // both ciphertexts: its second output is real change.
    const dummyEmpty = kind !== "send";
    const outEmpty = kind === "unshield";
    const ext: ExtData = {
      recipient,
      relayer: opts.relayer,
      relayerFee,
      exitTarget: opts.exitTarget ?? NO_EXIT,
      exitData: opts.exitData ?? new Uint8Array(0),
      ciphertext0: c0.ciphertext,
      ciphertext1: dummyEmpty ? new Uint8Array(0) : c1.ciphertext,
      outCiphertext: outEmpty ? new Uint8Array(0) : outCipher,
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

    const value = kind === "shield" && opts.token === ZERO_ADDRESS ? amountForMint(pool, publicShares) * pool.unit : 0n;
    const call = transactCall(opts.poolAddress, opts.token, proof, root, publicShares, opts.aspRoot ?? 0n, opts.aspProvider ?? ZERO_ADDRESS, ext, value);

    const consumed = inputs.map((n) => n.commitment);
    this.reserve(consumed);
    return { proof, ext, root, publicAmount: publicShares, aspRoot: opts.aspRoot ?? 0n, call, outputs, consumed, consumedNullifiers: proof.nullifiers.slice(0, inputs.length) };
  }

  /** Mark notes (by commitment) as pending so a second build cannot pick them. */
  reserve(commitments: bigint[]) {
    for (const c of commitments) this.pending.add(c.toString(16));
  }

  /** Undo a pending mark if a built transaction was never submitted. Takes the `consumed` list from `buildTransact`. */
  release(commitments: bigint[]) {
    for (const c of commitments) this.pending.delete(c.toString(16));
  }

  isPending(commitment: bigint): boolean {
    return this.pending.has(commitment.toString(16));
  }

  /** True once `markSpent` has seen this note's nullifier on-chain (the note is gone from the wallet). */
  isSpent(commitment: bigint): boolean {
    return !this.notes.has(commitment.toString(16));
  }
}

export { NOTE_CIPHERTEXT_LEN_NO_MEMO, amountForMint };
