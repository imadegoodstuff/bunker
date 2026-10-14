// Dynamic SPL assets: any mint a user holds can be shielded (pools are
// permissionless), so the relayer must be able to price its fee in that token
// and fit the transaction in a packet without an operator editing FEE_POLICY.
//
//  * Price: Jupiter's price API gives a USD price for the token and for SOL;
//    the SOL cost floor converts to token base units with a margin on top.
//    Tokens Jupiter does not price (no liquidity) are shield-only: the relayer
//    cannot take a fee it cannot value, so it refuses relayed sends/withdrawals.
//  * Lookup table: a transact over an SPL pool only fits in 1232 bytes when the
//    pool's statics (mint, pool PDA, vault ATA, relayer ATA) are in a table.
//    The relayer creates one frozen table per mint on first use and finds its
//    own tables again after a restart by authority, so nothing is stored.
//  * Fee destination: the relayer's associated token account for the mint,
//    created idempotently alongside the table.
import {
  AddressLookupTableAccount, AddressLookupTableProgram, Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ataFor, poolPda, staticAddresses } from "@scash/sdk";

export interface AssetQuote {
  mint: string;
  decimals: number;
  tokenProgram: string;
  /** the vault pool exists (someone paid its rent) */
  pool: boolean;
  /** the relayer will relay sends/withdrawals of this asset and take its fee in it */
  supported: boolean;
  reason?: string;
  /** fee in base units of the token; present when `supported` */
  fee?: { min: string; bps: number; dest: string };
  /** per-mint lookup table the relayer compiles with; present when `supported` */
  lookupTable?: string;
  /** USD prices the quote used, for display */
  priceUsd?: number;
  solUsd?: number;
}

interface Priced { usd: number; at: number }

const SOL_MINT = "So11111111111111111111111111111111111111112";

export class DynamicAssets {
  private prices = new Map<string, Priced>();
  private tables = new Map<string, AddressLookupTableAccount>();
  private pending = new Map<string, Promise<AssetQuote>>();
  private myTables?: AddressLookupTableAccount[];

  constructor(
    readonly conn: Connection,
    readonly signer: Keypair,
    readonly program: PublicKey,
    readonly opts: {
      priceUrl: string;
      /** margin over the SOL cost floor, in bps, to absorb price moves between quote and submission */
      marginBps: number;
      bps: number;
      priceTtlMs: number;
      enabled: boolean;
    }
  ) {}

  /** Quote for one mint; creates the relayer's ATA and lookup table on first successful pricing. */
  quote(mint: PublicKey, costFloorLamports: bigint): Promise<AssetQuote> {
    const k = mint.toBase58();
    const live = this.pending.get(k);
    if (live) return live;
    const p = this.doQuote(mint, costFloorLamports).finally(() => this.pending.delete(k));
    this.pending.set(k, p);
    return p;
  }

  private async doQuote(mint: PublicKey, costFloorLamports: bigint): Promise<AssetQuote> {
    const k = mint.toBase58();
    const info = await this.conn.getAccountInfo(mint);
    if (!info || info.data.length < 82) throw new Error("not a token mint");
    const tokenProgram = info.owner;
    if (!tokenProgram.equals(TOKEN_PROGRAM_ID) && !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) throw new Error("not a token mint");
    const decimals = info.data[44];
    const pool = !!(await this.conn.getAccountInfo(poolPda(mint, this.program)));
    const base: AssetQuote = { mint: k, decimals, tokenProgram: tokenProgram.toBase58(), pool, supported: false };
    if (!this.opts.enabled) return { ...base, reason: "this relayer only relays configured assets" };

    const [tok, sol] = await Promise.all([this.price(k), this.price(SOL_MINT)]);
    if (!sol) return { ...base, reason: "SOL price unavailable; try again shortly" };
    if (!tok) return { ...base, reason: "no market price for this token; it can be shielded but the relayer cannot take a fee in it" };
    base.priceUsd = tok; base.solUsd = sol;

    // cost in lamports → USD → token base units, with margin, rounded up
    const floor = costFloorLamports + (costFloorLamports * BigInt(this.opts.marginBps)) / 10_000n;
    const usd = (Number(floor) / 1e9) * sol;
    const min = BigInt(Math.ceil((usd / tok) * 10 ** decimals));
    if (min <= 0n) return { ...base, reason: "token price too high to express a fee in it" };

    if (!pool) return { ...base, reason: "pool not open yet", fee: { min: min.toString(), bps: this.opts.bps, dest: ataFor(this.signer.publicKey, mint, tokenProgram).toBase58() } };

    const dest = await this.ensureAta(mint, tokenProgram);
    const table = await this.ensureTable(mint, tokenProgram);
    return { ...base, supported: true, fee: { min: min.toString(), bps: this.opts.bps, dest: dest.toBase58() }, lookupTable: table.key.toBase58() };
  }

  /** Current fee policy for a mint, or undefined if unsupported. For /relay. */
  async policyFor(mint: PublicKey, costFloorLamports: bigint): Promise<{ min: bigint; bps: number; dest: PublicKey; table: AddressLookupTableAccount } | undefined> {
    const q = await this.quote(mint, costFloorLamports).catch(() => undefined);
    if (!q?.supported || !q.fee || !q.lookupTable) return undefined;
    return { min: BigInt(q.fee.min), bps: q.fee.bps, dest: new PublicKey(q.fee.dest), table: this.tables.get(mint.toBase58())! };
  }

  private async price(mint: string): Promise<number | undefined> {
    const c = this.prices.get(mint);
    if (c && Date.now() - c.at < this.opts.priceTtlMs) return c.usd;
    try {
      const r = await fetch(`${this.opts.priceUrl}?ids=${mint}`);
      if (!r.ok) throw new Error(`price ${r.status}`);
      const j = (await r.json()) as Record<string, { usdPrice?: number } | null>;
      const usd = j[mint]?.usdPrice;
      if (typeof usd !== "number" || !(usd > 0)) return undefined;
      this.prices.set(mint, { usd, at: Date.now() });
      return usd;
    } catch {
      return c?.usd;
    }
  }

  private async ensureAta(mint: PublicKey, tokenProgram: PublicKey): Promise<PublicKey> {
    const ata = ataFor(this.signer.publicKey, mint, tokenProgram);
    if (await this.conn.getAccountInfo(ata)) return ata;
    const ix = new TransactionInstruction({
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: this.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: this.signer.publicKey, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]), // CreateIdempotent
    });
    await this.send([ix]);
    return ata;
  }

  private required(mint: PublicKey, tokenProgram: PublicKey): PublicKey[] {
    return staticAddresses([{ mint, tokenProgram }], this.program, this.signer.publicKey);
  }

  private async ensureTable(mint: PublicKey, tokenProgram: PublicKey): Promise<AddressLookupTableAccount> {
    const k = mint.toBase58();
    const cached = this.tables.get(k);
    if (cached) return cached;
    const need = this.required(mint, tokenProgram);
    const covers = (t: AddressLookupTableAccount) => {
      const have = new Set(t.state.addresses.map((a) => a.toBase58()));
      return need.every((a) => have.has(a.toBase58()));
    };
    for (const t of await this.ownTables()) {
      if (covers(t)) { this.tables.set(k, t); return t; }
    }
    // create + extend in one tx; the relayer stays authority so it can add
    // addresses later (nothing in it is trusted — the relayer compiles with it)
    const slot = await this.conn.getSlot("finalized");
    const [createIx, key] = AddressLookupTableProgram.createLookupTable({ authority: this.signer.publicKey, payer: this.signer.publicKey, recentSlot: slot });
    const extendIx = AddressLookupTableProgram.extendLookupTable({ lookupTable: key, authority: this.signer.publicKey, payer: this.signer.publicKey, addresses: need });
    await this.send([createIx, extendIx]);
    // the table is usable one slot after its last extension
    let table: AddressLookupTableAccount | null = null;
    for (let i = 0; i < 20 && !table; i++) {
      await new Promise((r) => setTimeout(r, 500));
      table = (await this.conn.getAddressLookupTable(key)).value;
    }
    if (!table) throw new Error("lookup table did not appear");
    this.tables.set(k, table);
    this.myTables?.push(table);
    return table;
  }

  /** Every lookup table whose authority is the relayer — the ones it made for mints before a restart. */
  private async ownTables(): Promise<AddressLookupTableAccount[]> {
    if (this.myTables) return this.myTables;
    try {
      // AddressLookupTable layout: u32 type, u64 deactivation_slot, u64 last_extended_slot, u8 start_index, Option<Pubkey> authority → pubkey at 22
      const accs = await this.conn.getProgramAccounts(AddressLookupTableProgram.programId, {
        filters: [{ memcmp: { offset: 22, bytes: this.signer.publicKey.toBase58() } }],
      });
      this.myTables = accs.map((a) => new AddressLookupTableAccount({ key: a.pubkey, state: AddressLookupTableAccount.deserialize(a.account.data) }));
    } catch (e) {
      console.warn("[relayer] could not list own lookup tables:", (e as Error).message);
      this.myTables = [];
    }
    return this.myTables;
  }

  private async send(ixs: TransactionInstruction[]) {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash();
    const msg = new TransactionMessage({ payerKey: this.signer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.signer]);
    const sig = await this.conn.sendTransaction(tx);
    const res = await this.conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    if (res.value.err) throw new Error(`setup tx failed: ${JSON.stringify(res.value.err)}`);
  }
}
