// Gas price oracle: follows the node's `eth_gasPrice`, clamped to
// [floor, cap]. BSC uses legacy gas pricing (a flat gas price per tx); the
// relayer's fee floor is priced at the *cap* so a fee that clears it at quote
// time still covers submission after the random delay.

export function clampGasPrice(sample: bigint | undefined, floor: bigint, cap: bigint): bigint {
  if (cap < floor) throw new Error(`cap ${cap} below floor ${floor}`);
  if (sample === undefined || sample < 0n) return floor;
  return sample > cap ? cap : sample < floor ? floor : sample;
}

export class GasPriceOracle {
  private price: bigint;
  private source: "floor" | "node" = "floor";
  private lastError: string | null = null;
  private updatedAt = 0;
  private timer?: NodeJS.Timeout;

  constructor(
    readonly client: { getGasPrice(): Promise<bigint> },
    readonly opts: { floor: bigint; cap: bigint; refreshMs: number },
  ) {
    if (opts.cap < opts.floor) throw new Error(`cap ${opts.cap} below floor ${opts.floor}`);
    this.price = opts.floor;
  }

  /** wei per gas the relayer attaches right now */
  current(): bigint {
    return this.price;
  }

  info() {
    return { current: this.price.toString(), floor: this.opts.floor.toString(), cap: this.opts.cap.toString(), source: this.source, updatedAt: this.updatedAt, lastError: this.lastError };
  }

  async refresh(): Promise<bigint> {
    try {
      const sample = await this.client.getGasPrice();
      this.price = clampGasPrice(sample, this.opts.floor, this.opts.cap);
      this.source = "node";
      this.lastError = null;
      this.updatedAt = Date.now();
    } catch (e) {
      // keep the last good price; a failed refresh must not reset to the floor
      this.lastError = (e as Error).message;
    }
    return this.price;
  }

  start() {
    this.timer = setInterval(() => void this.refresh(), this.opts.refreshMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
