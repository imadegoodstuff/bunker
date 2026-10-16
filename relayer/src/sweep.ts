// Fee notes arrive in the relayer's shielded wallet (protocol v2 pays the
// relayer privately). The sweeper turns them back into gas money: when the EOA
// runs low it syncs the wallet from the indexer, proves an unshield of up to
// four BNB fee notes to the EOA and sends it through the submit queue (one
// nonce stream). ERC-20 fee notes stay in the wallet for the operator.
//
// Needs INDEXER_URL and ARTIFACTS_DIR (transact2x3/4x3 wasm+zkey); without
// them it idles and /health says so.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PublicClient, WalletClient, Account, Chain, Transport } from "viem";
import { BunkerClient, NATIVE_TOKEN, assetId, amountForBurn, readPool, type EvmAddress, type NetworkConfig, type TransactCall } from "@bunker/sdk";

export interface SweepOpts {
  publicClient: PublicClient;
  walletClient: WalletClient<Transport, Chain, Account>;
  pool: EvmAddress;
  /** the fee wallet's seed (the sweeper proves spends of its notes) */
  seed: Uint8Array;
  indexerUrl?: string;
  artifactsDir?: string;
  minBalanceWei: bigint;
  minSweepUnits: bigint;
  enabled: boolean;
  log: (o: object, msg: string) => void;
}

export class Sweeper {
  private client?: BunkerClient;
  private last?: { at: number; result: string };
  private busy = false;
  private submit?: (call: TransactCall, gas: bigint) => { id: string };

  constructor(readonly o: SweepOpts) {}

  get ready(): boolean {
    return this.o.enabled && !!this.o.indexerUrl && !!this.o.artifactsDir;
  }

  /** Hook the submit queue; sweeps are keeper jobs on the relayer's nonce stream. */
  use(submit: (call: TransactCall, gas: bigint) => { id: string }) {
    this.submit = submit;
  }

  status() {
    return { enabled: this.o.enabled, ready: this.ready, last: this.last ?? null };
  }

  start() {
    if (!this.ready) return;
    setInterval(() => void this.tick(), 60_000).unref?.();
    setTimeout(() => void this.tick(), 15_000).unref?.();
  }

  private async connect(): Promise<BunkerClient> {
    if (this.client) return this.client;
    const dir = this.o.artifactsDir!;
    const art = (name: "transact2x3" | "transact4x3") => {
      const wasm = [join(dir, `${name}.wasm`), join(dir, name, `${name}_js`, `${name}.wasm`)].find(existsSync);
      const zkey = [join(dir, `${name}.zkey`), join(dir, name, `${name}_dev.zkey`), join(dir, name, `${name}.zkey`)].find(existsSync);
      if (!wasm || !zkey) throw new Error(`artifacts for ${name} not found under ${dir}`);
      return { wasm, zkey };
    };
    const chainId = this.o.walletClient.chain.id;
    const network: NetworkConfig = {
      name: `relayer-${chainId}`, chainId, rpcUrl: this.o.publicClient.transport.url ?? "", protocolVersion: 2,
      pool: this.o.pool, launchpad: "0x0000000000000000000000000000000000000000", swapExit: null, wbnb: "0x0000000000000000000000000000000000000000",
      startBlock: 0, indexerUrl: this.o.indexerUrl!, relayerUrl: "", agentsUrl: "", artifactsUrl: "", explorerUrl: "",
    };
    // the same seed as the fee wallet: the client keeps its own ShieldedWallet instance and syncs it from the indexer
    this.client = await BunkerClient.connect({ seed: this.o.seed, network, artifacts: { transact2x3: art("transact2x3"), transact4x3: art("transact4x3") } });
    return this.client;
  }

  async tick(force = false): Promise<string> {
    if (this.busy) return "busy";
    if (!this.ready) return "not configured";
    this.busy = true;
    try {
      const r = await this.run(force);
      this.last = { at: Date.now(), result: r };
      return r;
    } catch (e) {
      const r = `error: ${(e as Error).message}`;
      this.last = { at: Date.now(), result: r };
      this.o.log({ err: (e as Error).message }, "sweep failed");
      return r;
    } finally {
      this.busy = false;
    }
  }

  private async run(force: boolean): Promise<string> {
    const eoa = this.o.walletClient.account.address;
    const bal = await this.o.publicClient.getBalance({ address: eoa });
    if (!force && bal >= this.o.minBalanceWei) return `eoa has ${bal} wei; no sweep needed`;
    const c = await this.connect();
    await c.sync();
    const asset = assetId(NATIVE_TOKEN);
    const pool = await readPool(this.o.publicClient, this.o.pool, NATIVE_TOKEN);
    const spendable = c.wallet.spendable(asset).slice(0, 4);
    const shares = spendable.reduce((a, n) => a + n.value, 0n);
    const units = amountForBurn(pool, shares);
    if (units < this.o.minSweepUnits) return `only ${units} units spendable (${c.wallet.queuedBalance(asset)} shares queued); below the sweep minimum`;
    const built = await c.wallet.buildTransact({
      asset, poolAddress: this.o.pool, chainId: this.o.walletClient.chain.id, token: NATIVE_TOKEN, pool, tree: c.tree, artifacts: await this.artifacts(c),
      kind: "unshield", amount: units > 1n ? units - 1n : units, recipient: eoa,
    });
    if (!this.submit) { c.wallet.release(built.consumed); return "no submit hook"; }
    const job = this.submit(built.call, 700_000n);
    this.o.log({ units: units.toString(), notes: spendable.length, job: job.id }, "sweeping fee notes to the relayer EOA");
    return `sweeping ${units} units in job ${job.id}`;
  }

  private async artifacts(c: BunkerClient) {
    return { transact2x3: await c.loadArtifacts("transact2x3"), transact4x3: await c.loadArtifacts("transact4x3") };
  }
}
