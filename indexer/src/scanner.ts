// Pulls the pool's and the launchpad's logs block range by block range
// (`eth_getLogs`), decodes them with the contract ABIs and writes them to the
// database. The scan position is a block number; a range is only committed
// once every log in it has been written, so a failed RPC call simply means the
// same range is asked again on the next tick. Only blocks at least
// `confirmations` behind the head are read, so reorgs below that depth never
// reach the database.
import { parseEventLogs, type Log, type Hex } from "viem";
import { ShieldedPoolAbi, LaunchpadAbi } from "@bunker/sdk";
import { Db } from "./db.js";

/** The subset of a viem PublicClient the scanner uses; tests pass fakes. */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: { address: `0x${string}`[]; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
  getBlock(args: { blockNumber: bigint }): Promise<{ timestamp: bigint }>;
}

/** 32-byte big-endian hex, no prefix: the wire form of field elements in this API. */
export const hex32 = (x: bigint) => x.toString(16).padStart(64, "0");
const bytesOf = (h: Hex) => Uint8Array.from(Buffer.from(h.slice(2), "hex"));

export interface ScannerOpts {
  pool: `0x${string}`;
  launchpad?: `0x${string}`;
  /** first block to scan on an empty database (the deployment block) */
  startBlock: number;
  /** blocks per eth_getLogs call; public BSC endpoints cap this around 5000 */
  chunk?: number;
  /** blocks behind the head that are treated as final */
  confirmations?: number;
  /** launch token decimals (constant per launchpad; the Launch event does not carry it) */
  launchDecimals: number;
  intervalMs?: number;
}

export class Scanner {
  private running = false;
  readonly readers: ChainReader[];
  /** How many ranges each fallback endpoint supplied after the primary failed (index 0 = primary). */
  readonly recoveredVia: number[];
  private lastError: string | null = null;
  private lastErrorAt = 0;
  private lastOkAt = Date.now();
  private times = new Map<bigint, number>();

  constructor(reader: ChainReader | ChainReader[], readonly db: Db, readonly opts: ScannerOpts) {
    this.readers = Array.isArray(reader) ? reader : [reader];
    if (this.readers.length === 0) throw new Error("scanner needs at least one RPC endpoint");
    this.recoveredVia = this.readers.map(() => 0);
  }

  private async withFailover<T>(what: string, f: (c: ChainReader, i: number) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < this.readers.length; i++) {
      try {
        const r = await f(this.readers[i], i);
        if (i > 0) this.recoveredVia[i]++;
        return r;
      } catch (e) {
        lastErr = e;
        if (i + 1 < this.readers.length) console.warn(`[scanner] ${what} failed on endpoint ${i} (${(e as Error).message}); trying endpoint ${i + 1}`);
      }
    }
    throw lastErr;
  }

  async start() {
    this.running = true;
    while (this.running) {
      try {
        await this.tick();
      } catch (e) {
        console.error("[scanner] tick failed:", (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, this.opts.intervalMs ?? 3000));
    }
  }
  stop() {
    this.running = false;
  }

  /** Last block whose logs are in the database (startBlock − 1 on an empty database). */
  lastBlock(): number {
    const v = this.db.getMeta("last_block");
    return v === undefined ? this.opts.startBlock - 1 : Number(v);
  }

  /** The scan has not advanced for a long time while the RPC keeps failing: wallets behind this indexer are stale. */
  degraded(now = Date.now()): boolean {
    return this.lastError !== null && now - this.lastOkAt > DEGRADED_AFTER_MS;
  }
  status() {
    return { lastBlock: this.lastBlock(), lastError: this.lastError, lastErrorAt: this.lastErrorAt || null, lastOkAt: this.lastOkAt };
  }

  async tick() {
    const chunk = this.opts.chunk ?? 2000;
    const conf = BigInt(this.opts.confirmations ?? 3);
    try {
      const head = await this.withFailover("getBlockNumber", (c) => c.getBlockNumber());
      const safe = head - conf;
      let from = BigInt(this.lastBlock() + 1);
      let ranges = 0;
      while (from <= safe) {
        const to = from + BigInt(chunk) - 1n < safe ? from + BigInt(chunk) - 1n : safe;
        const addresses: `0x${string}`[] = [this.opts.pool, ...(this.opts.launchpad ? [this.opts.launchpad] : [])];
        const logs = await this.withFailover("getLogs", (c) => c.getLogs({ address: addresses, fromBlock: from, toBlock: to }));
        await this.ingest(logs);
        this.db.setMeta("last_block", to.toString());
        from = to + 1n;
        ranges++;
        // a long catch-up: yield between chunks so /health keeps answering
        if (ranges % 10 === 0) await new Promise((r) => setImmediate(r));
      }
      this.lastOkAt = Date.now();
      this.lastError = null;
      if (ranges > 0) console.log(`[scanner] at block ${this.lastBlock()}, commitments=${this.db.count()}`);
    } catch (e) {
      this.lastError = (e as Error).message;
      this.lastErrorAt = Date.now();
      throw e;
    }
  }

  private async blockTime(n: bigint): Promise<number | null> {
    const c = this.times.get(n);
    if (c !== undefined) return c;
    try {
      const b = await this.withFailover("getBlock", (r) => r.getBlock({ blockNumber: n }));
      const t = Number(b.timestamp);
      if (this.times.size > 5000) this.times.clear();
      this.times.set(n, t);
      return t;
    } catch {
      return null;
    }
  }

  /** Decode and write one batch of raw logs. Idempotent: every write is keyed by (txHash, logIndex) or a unique value. */
  async ingest(raw: Log[]) {
    const events = parseEventLogs({ abi: [...ShieldedPoolAbi, ...LaunchpadAbi], logs: raw, strict: false });
    for (const ev of events) {
      const block = Number(ev.blockNumber);
      const txHash = ev.transactionHash as string;
      const logIndex = Number(ev.logIndex);
      const bt = await this.blockTime(ev.blockNumber as bigint);
      const a = ev.args as Record<string, unknown>;
      const addr = (x: unknown) => (x as string).toLowerCase();
      const big = (x: unknown) => (x as bigint).toString();
      switch (ev.eventName) {
        // --- pool
        case "Transact": {
          const first = Number(a.firstIndex);
          const token = addr(a.token);
          this.db.insertCommitment(first, hex32(a.commitment0 as bigint), token, bytesOf(a.ciphertext0 as Hex), txHash, block, bt);
          this.db.insertCommitment(first + 1, hex32(a.commitment1 as bigint), token, bytesOf(a.ciphertext1 as Hex), txHash, block, bt);
          this.db.insertOutCiphertext(txHash, first, bytesOf(a.outCiphertext as Hex));
          this.db.insertRoot(hex32(a.newRoot as bigint), first + 2, txHash, block);
          break;
        }
        case "Nullified":
          this.db.insertNullifier(hex32(a.nullifier as bigint), txHash, block);
          break;
        case "Shield":
        case "Unshield":
        case "Donate":
          this.db.insertFlow(txHash, logIndex, ev.eventName.toLowerCase(), addr(a.token), big(a.amount), block, bt);
          break;
        // --- launchpad
        case "Launch":
          this.db.insertLaunch({
            token: addr(a.token), creator: addr(a.creator), name: a.name as string, symbol: a.symbol as string, uri: a.uri as string, decimals: this.opts.launchDecimals,
            virtualBnb: big(a.virtualBnb), virtualToken: big(a.virtualToken), curveSupply: big(a.curveSupply), totalSupply: big(a.totalSupply), graduationWei: big(a.graduationWei),
            txHash, block, blockTime: bt,
          });
          break;
        case "CurveBuy":
        case "CurveSell": {
          const buy = ev.eventName === "CurveBuy";
          this.db.insertTrade({
            txHash, logIndex, token: addr(a.token), side: buy ? "buy" : "sell", bnb: big(buy ? a.bnbIn : a.bnbOut), fee: big(a.fee), tokens: big(buy ? a.tokensOut : a.tokensIn),
            claimKey: addr(a.claimKey), realBnb: big(a.realBnb), realToken: big(a.realToken), virtualToken: big(a.virtualToken), block, blockTime: bt,
          });
          break;
        }
        case "Harvest":
          this.db.insertHarvest(txHash, logIndex, addr(a.token), big(a.amount), block, bt);
          break;
        case "Graduate":
          this.db.markGraduated(addr(a.token), big(a.realBnb), big(a.realToken));
          break;
        case "Migrate":
          this.db.markMigrated(addr(a.token), addr(a.pair), big(a.bnbIn), big(a.tokensIn));
          break;
        case "FeeVote":
          this.db.insertFeeEvent({ txHash, logIndex, token: addr(a.token), kind: "vote", agent: Number(a.agent), feeBps: Number(a.feeBps), block: Number(a.blockNumber), blockTime: bt });
          break;
        case "FeeRoll":
          this.db.insertFeeEvent({ txHash, logIndex, token: addr(a.token), kind: "roll", agent: null, feeBps: Number(a.feeBps), epoch: Number(a.epoch), block, blockTime: bt });
          break;
      }
    }
  }
}

/** The scan failing for this long is an incident, not lag. */
export const DEGRADED_AFTER_MS = 10 * 60 * 1000;
