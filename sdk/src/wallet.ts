// High-level wallet: scans ciphertexts with ivk, tracks spendable notes,
// builds shield / send / unshield / exit transactions (as viem contract calls).
import { BabyJub, type Point } from "./crypto.js";
import { MAX_U64 } from "./field.js";
import { encryptNote, encryptOutgoing, tryDecryptNote, NOTE_CIPHERTEXT_LEN_NO_MEMO } from "./encryption.js";
import { extDataHash, NO_EXIT, NO_RESHIELD, ZERO_ADDRESS, type EvmAddress, type ExtData, type Reshield } from "./extdata.js";
import { fullViewingKey, groupHash, newAddress, spendingKeyFromSeed, type Address, type FullViewingKey, type SpendingKey } from "./keys.js";
import { MerkleTree } from "./merkle.js";
import { assetId, noteCommitment, nullifier, openNoteCommitment, ownerHash, freshRandomness, type Note, type SpendableNote } from "./note.js";
import { prove, type CircuitArtifacts, type CircuitName, type SpendInput, type TransactProof } from "./prover.js";
import { transactCall, sharesForDeposit, sharesForWithdraw, amountForMint, type PoolState, type TransactCall } from "./pool.js";

export interface IndexedOutput {
  index: number; // leaf index
  commitment: bigint;
  ciphertext: Uint8Array;
  /** where the chain recorded it, if the caller knows (feeds the ledger) */
  block?: number;
  blockTime?: number | null;
}

/** One note this wallet has ever owned: when it arrived and, once spent, when it left. Times are unix seconds. */
export interface LedgerEntry {
  commitment: bigint;
  nullifier: bigint;
  asset: bigint;
  /** shares */
  value: bigint;
  position: number;
  receivedBlock: number | null;
  receivedAt: number | null;
  spentBlock: number | null;
  spentAt: number | null;
  memo?: Uint8Array;
}

/** A nullifier seen on-chain, with where (and optionally when) it appeared. */
export interface SeenNullifier { nullifier: bigint; block: number; blockTime?: number | null }

/** An `OpenNote` event: a note the pool minted for an exit hook's proceeds. */
export interface IndexedOpenNote {
  index: number;
  commitment: bigint;
  shares: bigint;
  ownerHash: bigint;
  ciphertext: Uint8Array;
  block?: number;
  blockTime?: number | null;
}

export interface WalletState {
  notes: SpendableNote[]; // unspent, owned
  spentNullifiers: Set<string>;
}

export type TransactKind = "shield" | "send" | "unshield" | "exit";

export interface BuiltTransact {
  proof: TransactProof;
  ext: ExtData;
  root: bigint;
  publicAmount: bigint;
  aspRoot: bigint;
  /** The contract call: `walletClient.writeContract(call)` or hand `call` to the relayer. */
  call: TransactCall;
  outputs: Note[];
  /** The note the pool will mint for an exit's proceeds (amount filled in on-chain), when `kind === "exit"` with a reshield. */
  reshieldNote?: Note;
  /** Commitments of the input notes, now marked pending; hand back to `release` if the transaction is never submitted. */
  consumed: bigint[];
  /** Nullifiers of the same input notes (what the chain will record); feed to `markSpent` once confirmed. */
  consumedNullifiers: bigint[];
}

export class ShieldedWallet {
  /** Absent on a watch-only wallet made from a viewing key. */
  readonly spend?: SpendingKey;
  readonly fvk: FullViewingKey;
  readonly bjj: BabyJub;
  readonly notes = new Map<string, SpendableNote>(); // key = commitment hex
  readonly nullifierOf = new Map<string, bigint>(); // commitment -> nf
  /** Every note ever owned, in arrival order; spent ones stay with their spend time. */
  readonly ledger: LedgerEntry[] = [];
  private ledgerByNf = new Map<string, LedgerEntry>();
  private seenCm = new Set<string>();
  private pending = new Set<string>();
  /** Leaves in the on-chain tree (`ShieldedPool.insertedIndex`); notes at or past it are queued and not yet spendable. */
  private inserted = Number.POSITIVE_INFINITY;

  private constructor(spend: SpendingKey | undefined, fvk: FullViewingKey, bjj: BabyJub) {
    this.spend = spend;
    this.fvk = fvk;
    this.bjj = bjj;
  }

  static async fromSeed(seed: Uint8Array): Promise<ShieldedWallet> {
    const spend = spendingKeyFromSeed(seed);
    const fvk = await fullViewingKey(spend);
    return new ShieldedWallet(spend, fvk, await BabyJub.load());
  }

  /** A watch-only wallet: sees every incoming note, every spend and every balance, can sign nothing. */
  static async fromViewingKey(fvk: FullViewingKey): Promise<ShieldedWallet> {
    return new ShieldedWallet(undefined, fvk, await BabyJub.load());
  }

  get watchOnly(): boolean {
    return !this.spend;
  }

  address(): Address {
    return newAddress(this.bjj, this.fvk.ivk);
  }

  selfPoint(): { gd: Point; pkd: Point } {
    const a = this.address();
    return { gd: groupHash(this.bjj, a.d)!, pkd: a.pkd };
  }

  /** Tell the wallet how many leaves the chain has inserted so `spendable` excludes queued notes. */
  markInserted(insertedIndex: number) {
    this.inserted = insertedIndex;
  }

  get insertedIndex(): number {
    return this.inserted;
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
    return this.remember(note, cm, out.index, r.plaintext.memo, out);
  }

  /**
   * Try to claim an open note. The ciphertext tells us the address and the
   * randomness; the amount is public; the commitment must match both.
   */
  async scanOpenNote(ev: IndexedOpenNote, asset: bigint): Promise<SpendableNote | null> {
    const r = tryDecryptNote(this.bjj, this.fvk.ivk, ev.ciphertext);
    if (!r) return null;
    const gd = groupHash(this.bjj, r.plaintext.d);
    if (!gd) return null;
    const pkd = this.bjj.mulScalar(gd, this.fvk.ivk);
    if ((await ownerHash(gd, pkd)) !== ev.ownerHash) return null;
    const cm = await openNoteCommitment(asset, ev.shares, ev.ownerHash, r.plaintext.rho, r.plaintext.rcm);
    if (cm !== ev.commitment) return null;
    const note: Note = { asset, value: ev.shares, gd, pkd, rseed: r.plaintext.rseed, rho: r.plaintext.rho, rcm: r.plaintext.rcm };
    return this.remember(note, cm, ev.index, undefined, ev);
  }

  private async remember(note: Note, cm: bigint, index: number, memo: Uint8Array | undefined, where?: { block?: number; blockTime?: number | null }): Promise<SpendableNote> {
    const sn: SpendableNote = { ...note, commitment: cm, position: index, memo };
    const key = cm.toString(16);
    if (note.value > 0n && !this.seenCm.has(key)) {
      this.seenCm.add(key);
      const nf = await nullifier(this.fvk.nk, note.rho, index);
      this.notes.set(key, sn);
      this.nullifierOf.set(key, nf);
      const entry: LedgerEntry = {
        commitment: cm, nullifier: nf, asset: note.asset, value: note.value, position: index, memo,
        receivedBlock: where?.block ?? null, receivedAt: where?.blockTime ?? null, spentBlock: null, spentAt: null,
      };
      this.ledger.push(entry);
      this.ledgerByNf.set(nf.toString(16), entry);
    }
    return sn;
  }

  /** Drop notes whose nullifier has appeared on-chain; with `SeenNullifier`s the ledger also learns when. */
  markSpent(nullifiers: Iterable<bigint | SeenNullifier>) {
    const spent = new Map<string, SeenNullifier | null>();
    for (const n of nullifiers) {
      if (typeof n === "bigint") spent.set(n.toString(16), null);
      else spent.set(n.nullifier.toString(16), n);
    }
    for (const [key, nf] of this.nullifierOf) {
      const hex = nf.toString(16);
      if (spent.has(hex)) {
        this.notes.delete(key);
        this.nullifierOf.delete(key);
        this.pending.delete(key);
        const e = this.ledgerByNf.get(hex);
        const seen = spent.get(hex);
        if (e && e.spentBlock == null) { e.spentBlock = seen?.block ?? -1; e.spentAt = seen?.blockTime ?? null; }
      }
    }
  }

  /** Ledger entries for one asset (or all), oldest first. */
  history(asset?: bigint): LedgerEntry[] {
    return asset === undefined ? [...this.ledger] : this.ledger.filter((e) => e.asset === asset);
  }

  /** Spendable shares: owned, not reserved, already in the tree. `queuedBalance` has the rest. */
  balance(asset: bigint): bigint {
    let b = 0n;
    for (const n of this.spendable(asset)) b += n.value;
    return b;
  }

  /** Everything owned and not reserved, queued notes included. */
  totalBalance(asset: bigint): bigint {
    return this.balance(asset) + this.queuedBalance(asset);
  }

  /** Owned notes still waiting for a drain. */
  queuedBalance(asset: bigint): bigint {
    let b = 0n;
    for (const n of this.notes.values()) if (n.asset === asset && n.position >= this.inserted && !this.pending.has(n.commitment.toString(16))) b += n.value;
    return b;
  }

  spendable(asset: bigint): SpendableNote[] {
    return [...this.notes.values()]
      .filter((n) => n.asset === asset && n.position < this.inserted && !this.pending.has(n.commitment.toString(16)))
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
    if (sum < target) {
      const queued = this.queuedBalance(asset);
      throw new Error(`insufficient shielded balance: have ${sum}, need ${target}` + (queued > 0n ? ` (${queued} more is queued and spendable after the next drain)` : ""));
    }
    return chosen;
  }

  /**
   * Build a transact proof + contract call. Amounts are in the pool's internal
   * units (`PoolState.unit` wei each; gwei for BNB). Every transact has three
   * outputs: payment, change, relayer fee (a private note to `relayerAddress`;
   * a zero dummy when self-submitting).
   *  - shield:   amount > 0, inputs empty, outputs = [note(to self or recipient), 0, 0]; `value` = cost in wei
   *  - send:     amount = 0 publicly; outputs = [note(to recipient), change, fee]
   *  - unshield: amount < 0 with recipient = public account; outputs = [change, 0, fee]
   *  - exit:     unshield into `exitTarget` and, with `reshield`, take the proceeds back as a fresh note
   */
  async buildTransact(opts: {
    asset: bigint;
    /** pool contract */
    poolAddress: EvmAddress;
    /** asset address, ZERO_ADDRESS for BNB */
    token: EvmAddress;
    pool: PoolState;
    /** the tree of *inserted* leaves (see `markInserted`); its root must be known on-chain */
    tree: MerkleTree;
    artifacts: Record<CircuitName, CircuitArtifacts>;
    kind: TransactKind;
    amount: bigint; // internal units
    to?: Address; // shielded recipient (send / shield-to-other)
    recipient?: EvmAddress; // public recipient (unshield)
    /** the relayer's shielded address: where the fee note goes */
    relayerAddress?: Address;
    /** fee in internal units of this asset; 0 when self-submitting */
    relayerFee?: bigint;
    memo?: Uint8Array;
    aspRoot?: bigint;
    aspProvider?: EvmAddress;
    aspPathFor?: (cm: bigint) => Promise<{ elements: bigint[]; indices: number[] } | undefined>;
    exitTarget?: EvmAddress;
    exitData?: Uint8Array;
    /** take the exit hook's proceeds in `token` back as a note to ourselves */
    reshield?: { token: EvmAddress };
  }): Promise<BuiltTransact> {
    if (!this.spend) throw new Error("watch-only wallet cannot spend");
    const { asset, pool, tree, kind } = opts;
    const self = this.address();
    const selfGd = groupHash(this.bjj, self.d)!;
    const relayerFee = opts.relayerFee ?? 0n;
    if (relayerFee > 0n && !opts.relayerAddress) throw new Error("relayerAddress required when relayerFee > 0");
    if (kind === "shield" && relayerFee > 0n) throw new Error("a shield is signed by the depositor and pays no relayer");

    let publicShares = 0n;
    let inputs: SpendableNote[] = [];
    let toAddr: Address = self;
    let toGd: Point = selfGd;
    let payment: Note;
    let change: Note;
    const feeShares = relayerFee > 0n ? sharesForWithdraw(pool, relayerFee) : 0n;
    const dummy = (): Note => ({ asset, value: 0n, gd: selfGd, pkd: self.pkd, ...freshRandomness() });
    const feeNote: Note = feeShares > 0n ? { asset, value: feeShares, gd: groupHash(this.bjj, opts.relayerAddress!.d)!, pkd: opts.relayerAddress!.pkd, ...freshRandomness() } : dummy();

    if (kind === "shield") {
      publicShares = sharesForDeposit(pool, opts.amount);
      if (publicShares <= 0n) throw new Error("amount too small");
      toAddr = opts.to ?? self;
      toGd = groupHash(this.bjj, toAddr.d)!;
      payment = { asset, value: publicShares, gd: toGd, pkd: toAddr.pkd, ...freshRandomness() };
      change = dummy();
    } else if (kind === "send") {
      if (!opts.to) throw new Error("recipient address required");
      const sharesOut = sharesForWithdraw(pool, opts.amount);
      inputs = this.selectInputs(asset, sharesOut + feeShares);
      const inSum = inputs.reduce((a, n) => a + n.value, 0n);
      toAddr = opts.to;
      toGd = groupHash(this.bjj, toAddr.d)!;
      payment = { asset, value: sharesOut, gd: toGd, pkd: toAddr.pkd, ...freshRandomness() };
      change = { asset, value: inSum - sharesOut - feeShares, gd: selfGd, pkd: self.pkd, ...freshRandomness() };
    } else {
      if (kind === "unshield" && !opts.recipient) throw new Error("public recipient required");
      if (kind === "exit" && !opts.exitTarget) throw new Error("exitTarget required");
      const sharesOut = sharesForWithdraw(pool, opts.amount);
      inputs = this.selectInputs(asset, sharesOut + feeShares);
      const inSum = inputs.reduce((a, n) => a + n.value, 0n);
      publicShares = -sharesOut;
      payment = { asset, value: inSum - sharesOut - feeShares, gd: selfGd, pkd: self.pkd, ...freshRandomness() };
      change = dummy();
    }
    const outputs: Note[] = [payment, change, feeNote];
    if (outputs.some((o) => o.value < 0n || o.value > MAX_U64)) throw new Error("output value out of range");

    // encrypt outputs. Zero-value dummies carry nothing anyone will decrypt and are sent empty to save calldata.
    const includeMemo = !!opts.memo;
    const c0 = encryptNote(this.bjj, kind === "send" || kind === "shield" ? toAddr : self, payment, opts.memo, includeMemo);
    const c1 = change.value > 0n ? encryptNote(this.bjj, self, change, undefined, false).ciphertext : new Uint8Array(0);
    const c2 = feeShares > 0n ? encryptNote(this.bjj, opts.relayerAddress!, feeNote, undefined, false).ciphertext : new Uint8Array(0);
    const cm0 = await noteCommitment(payment);
    // the outgoing record lets the sender's ovk recover what was paid to someone else
    const outCipher = kind === "send" || (kind === "shield" && opts.to) ? encryptOutgoing(this.bjj, this.spend.ovk, cm0, payment.pkd, c0.esk) : new Uint8Array(0);

    // reshield: a fresh diversified address of our own, so the public ownerHash never repeats
    let reshield: Reshield = NO_RESHIELD;
    let reshieldNote: Note | undefined;
    if (kind === "exit" && opts.reshield) {
      const addr = newAddress(this.bjj, this.fvk.ivk);
      const gd = groupHash(this.bjj, addr.d)!;
      const rnd = freshRandomness();
      reshieldNote = { asset: assetId(opts.reshield.token), value: 0n, gd, pkd: addr.pkd, ...rnd };
      reshield = {
        token: opts.reshield.token,
        ownerHash: await ownerHash(gd, addr.pkd),
        rho: rnd.rho,
        rcm: rnd.rcm,
        ciphertext: encryptNote(this.bjj, addr, reshieldNote, undefined, false).ciphertext,
      };
    }

    const recipient: EvmAddress = kind === "unshield" ? opts.recipient! : kind === "exit" ? opts.exitTarget! : ZERO_ADDRESS;
    const ext: ExtData = {
      recipient,
      exitTarget: kind === "exit" ? opts.exitTarget! : NO_EXIT,
      exitData: kind === "exit" ? (opts.exitData ?? new Uint8Array(0)) : new Uint8Array(0),
      ciphertext0: c0.ciphertext,
      ciphertext1: c1,
      ciphertext2: c2,
      outCiphertext: outCipher,
      reshield,
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
    return { proof, ext, root, publicAmount: publicShares, aspRoot: opts.aspRoot ?? 0n, call, outputs, reshieldNote, consumed, consumedNullifiers: proof.nullifiers.slice(0, inputs.length) };
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
