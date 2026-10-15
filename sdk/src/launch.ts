// Client for contracts/contracts/Launchpad.sol: a bonding curve traded from
// inside the shielded pool. Curve math and fee policy mirror the contract.
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeAbiParameters, decodeAbiParameters, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LaunchpadAbi } from "./abi/Launchpad.js";
import { LaunchTokenAbi } from "./abi/LaunchToken.js";
import { bigIntToBytesLE, bigIntToBytesBE, bytesToBigIntBE, concatBytes, toHex, fromHex } from "./field.js";
import type { EvmAddress as Address } from "./extdata.js";

export { LaunchpadAbi, LaunchTokenAbi };

const enc = new TextEncoder();

// ---- claim keys

/** secp256k1 group order. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export interface ClaimKey {
  privateKey: Hex;
  address: Address;
}

/**
 * The claim key is a throwaway EOA the buyer derives from their shielded seed
 * and a per-trade nonce. The curve funds it (tokens plus a little BNB for gas),
 * and it then sends an ordinary pool shield. It appears on-chain twice — in the
 * trade's exit data and as the shield's sender — and nowhere else, so it links
 * the two halves of one trade and nothing more. Deterministic, so a seed
 * backup recovers unclaimed trades.
 */
export function claimKey(seed: Uint8Array, nonce: bigint): ClaimKey {
  const h = sha256(concatBytes(enc.encode("bunker-claim-v1"), seed, bigIntToBytesLE(nonce, 8)));
  let k = bytesToBigIntBE(h) % SECP256K1_N;
  if (k === 0n) k = 1n;
  const privateKey: Hex = `0x${toHex(bigIntToBytesBE(k, 32))}`;
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

// ---- parameters

export interface LaunchpadParams {
  treasury: Address;
  tradeFeeBps: number;
  virtualBnb: bigint;
  virtualToken: bigint;
  curveSupply: bigint;
  totalSupply: bigint;
  graduationWei: bigint;
  decimals: number;
  /** the four agent keys whose votes set every curve's fee (see `policy`) */
  agents: readonly Address[];
  /** PancakeSwap V2 router */
  router: Address;
}

// ---- curve state

export interface Vote {
  feeBps: number;
  /** 0 = never voted */
  blockNumber: bigint;
}

/** Mirror of the contract's `Curve` struct. */
export interface CurveState {
  token: Address;
  creator: Address;
  createdBlock: bigint;
  virtualBnb: bigint;
  virtualToken: bigint;
  realBnb: bigint;
  realToken: bigint;
  feesAccrued: bigint;
  graduated: boolean;
  tradeFeeBps: number;
  /** fee epoch `tradeFeeBps` was last settled for; see `rolled` */
  settledEpoch: bigint;
  /** latest vote per agent, indexed like `LaunchpadParams.agents` */
  votes: Vote[];
  /** the PancakeSwap pair the curve migrated to, or null while it has not */
  ammPair: Address | null;
  buys: bigint;
  sells: bigint;
  bnbVolume: bigint;
}

// ---- fee policy (mirror of Launchpad.sol)

/**
 * Hard limits of the agent-driven fee policy. They are constants in the
 * contract; nobody, agents included, can change them. Four keys vote per
 * curve, the curve moves toward the median of the fresh votes by at most one
 * step per epoch (80 blocks ≈ 1 minute on BSC), and only votes cast before an
 * epoch began count for it, so the fee of the epoch a trade lands in is known
 * when its proof is made. The fee runs from 0 to 5 %; all of it goes to the
 * treasury.
 */
export const policy = {
  AGENTS: 4,
  EPOCH_BLOCKS: 80n,
  VOTE_TTL_BLOCKS: 320n,
  QUORUM: 2,
  MAX_CATCHUP_EPOCHS: 4n,
  FEE_MIN_BPS: 0,
  FEE_MAX_BPS: 500,
  FEE_STEP_BPS: 100,
} as const;

export function epochOf(block: bigint): bigint {
  return block / policy.EPOCH_BLOCKS;
}
export function voteInBounds(feeBps: number): boolean {
  return Number.isInteger(feeBps) && feeBps >= policy.FEE_MIN_BPS && feeBps <= policy.FEE_MAX_BPS;
}
const stepTowards = (cur: number, target: number, step: number) => (target > cur ? Math.min(cur + step, target) : Math.max(cur - step, target));
const median = (v: number[]) => {
  const s = [...v].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : Math.floor((s[n / 2 - 1] + s[n / 2]) / 2);
};
const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

/** Fresh votes for the epoch starting at `start`: cast before it and not expired. */
export function freshVotes(votes: Vote[], start: bigint): Vote[] {
  return votes.filter((v) => v.blockNumber !== 0n && v.blockNumber < start && v.blockNumber + policy.VOTE_TTL_BLOCKS > start);
}

/** The fee the curve is moving toward at the epoch starting at `start`. */
export function policyTarget(votes: Vote[], start: bigint, curFee: number): number {
  const f = freshVotes(votes, start);
  if (f.length < policy.QUORUM) return curFee;
  return clamp(median(f.map((v) => v.feeBps)), policy.FEE_MIN_BPS, policy.FEE_MAX_BPS);
}

/** The curve as the contract will see it at `block`: fee policy advanced to that block's epoch. Pure. */
export function rolled(c: CurveState, block: bigint): CurveState {
  const epoch = epochOf(block);
  if (epoch <= c.settledEpoch) return c;
  const elapsed = epoch - c.settledEpoch < policy.MAX_CATCHUP_EPOCHS ? epoch - c.settledEpoch : policy.MAX_CATCHUP_EPOCHS;
  const t = policyTarget(c.votes, epoch * policy.EPOCH_BLOCKS, c.tradeFeeBps);
  let fee = c.tradeFeeBps;
  for (let i = 0n; i < elapsed; i++) fee = stepTowards(fee, t, policy.FEE_STEP_BPS);
  return { ...c, tradeFeeBps: fee, settledEpoch: epoch };
}

/** The fee a trade will pay if it lands anywhere in `[block, block + horizon]`: the worst case over the epochs that window touches. */
export function worstFeeBps(c: CurveState, block: bigint, horizon = 160n): number {
  let worst = rolled(c, block).tradeFeeBps;
  for (let b = (epochOf(block) + 1n) * policy.EPOCH_BLOCKS; b <= block + horizon; b += policy.EPOCH_BLOCKS) worst = Math.max(worst, rolled(c, b).tradeFeeBps);
  return worst;
}

// ---- curve math (k from current reserves, rounding for the curve)

export interface Reserves { virtualBnb: bigint; realBnb: bigint; virtualToken: bigint; realToken: bigint }

const divCeil = (a: bigint, b: bigint) => (a + b - 1n) / b;

export function curveBuy(r: Reserves, bnbIn: bigint): { out: bigint; virtualToken: bigint } {
  if (bnbIn <= 0n) throw new Error("nothing");
  const x = r.virtualBnb + r.realBnb, y = r.virtualToken, k = x * y;
  const y2 = divCeil(k, x + bnbIn);
  const out = y - y2;
  if (out <= 0n) throw new Error("nothing");
  if (out > r.realToken) throw new Error("sold out");
  return { out, virtualToken: y2 };
}
export function curveSell(r: Reserves, tokenIn: bigint): { out: bigint; virtualToken: bigint } {
  if (tokenIn <= 0n) throw new Error("nothing");
  const x = r.virtualBnb + r.realBnb, y = r.virtualToken, k = x * y;
  const y2 = y + tokenIn;
  const out = x - divCeil(k, y2);
  if (out <= 0n) throw new Error("nothing");
  if (out > r.realBnb) throw new Error("insufficient reserve");
  return { out, virtualToken: y2 };
}
export function quoteBuyExactOut(r: Reserves, tokenOut: bigint): bigint {
  if (tokenOut <= 0n || tokenOut > r.realToken) throw new Error("sold out");
  const x = r.virtualBnb + r.realBnb, y = r.virtualToken, k = x * y;
  return divCeil(k, y - tokenOut) - x;
}
/** Mirror of `buyCapped`: the buy that reaches past the last token takes every token left and only pays for those. */
export function curveBuyCapped(r: Reserves, bnbIn: bigint): { out: bigint; virtualToken: bigint; used: bigint } {
  try {
    return { ...curveBuy(r, bnbIn), used: bnbIn };
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "sold out") throw e;
    const used = quoteBuyExactOut(r, r.realToken);
    return { out: r.realToken, virtualToken: r.virtualToken - r.realToken, used: used < bnbIn ? used : bnbIn };
  }
}
export const feeOf = (amount: bigint, bps: number) => (amount * BigInt(bps)) / 10_000n;
export const feeOnNet = (net: bigint, bps: number) => (net * BigInt(bps)) / BigInt(10_000 - bps);
/** Spot price in wei per whole token (10^decimals base units). */
export function spotPrice(r: Reserves, decimals: number): number {
  return (Number(r.virtualBnb + r.realBnb) / Number(r.virtualToken)) * 10 ** decimals;
}

// ---- exit data for a private buy or sell

export const EXIT_BUY = 1;
export const EXIT_SELL = 2;

const EXIT_ABI = [
  { name: "kind", type: "uint8" },
  { name: "token", type: "address" },
  { name: "claimKey", type: "address" },
  { name: "minOut", type: "uint256" },
  { name: "claimBudget", type: "uint256" },
  { name: "relayerTip", type: "uint256" },
] as const;

/**
 * `claimBudget`: wei parked at the claim key for the gas of its shield.
 * `relayerTip`: wei paid from the BNB leg to the exit call's sender — the relayer. A relayed *sell*
 * has to pay its relayer this way, since the pool's own fee would be denominated in the token being sold.
 */
export function exitData(kind: 1 | 2, token: Address, claimKey: Address, minOut: bigint, claimBudget: bigint, relayerTip = 0n): Uint8Array {
  return fromHex(encodeAbiParameters(EXIT_ABI, [kind, token, claimKey, minOut, claimBudget, relayerTip]));
}
export function decodeExitData(d: Uint8Array): { kind: number; token: Address; claimKey: Address; minOut: bigint; claimBudget: bigint; relayerTip: bigint } {
  const [kind, token, claimKey, minOut, claimBudget, relayerTip] = decodeAbiParameters(EXIT_ABI, `0x${toHex(d)}`);
  return { kind, token, claimKey, minOut, claimBudget, relayerTip };
}

/**
 * Tokens a private buy of `amountIn` wei (what the pool delivers after the
 * relayer fee) will park at the claim key. `refund` is what comes back to the
 * claim key when the buy empties the curve (the last buy before graduation).
 */
export function quotePrivateBuy(curve: Reserves & { tradeFeeBps: number }, amountIn: bigint, claimBudget: bigint, relayerTip = 0n): { out: bigint; net: bigint; fee: bigint; reserve: bigint; refund: bigint } {
  const reserve = claimBudget + relayerTip;
  if (amountIn <= reserve) throw new Error("amount too small to cover the claim budget and tip");
  const gross = amountIn - reserve;
  let fee = feeOf(gross, curve.tradeFeeBps);
  const { out, used: net } = curveBuyCapped(curve, gross - fee);
  let refund = 0n;
  if (net < gross - fee) {
    fee = feeOnNet(net, curve.tradeFeeBps);
    refund = gross - net - fee;
  }
  return { out, net, fee, reserve, refund };
}
/** Wei a private sell of `tokenIn` parks at the claim key, after the curve fee and the relayer tip. Must exceed `claimBudget`. */
export function quotePrivateSell(curve: Reserves & { tradeFeeBps: number }, tokenIn: bigint, relayerTip = 0n): { out: bigint; gross: bigint; fee: bigint } {
  const { out: gross } = curveSell(curve, tokenIn);
  const fee = feeOf(gross, curve.tradeFeeBps);
  if (gross - fee <= relayerTip) throw new Error("sale does not cover the relayer tip");
  return { out: gross - fee - relayerTip, gross, fee };
}

// ---- reads

type RawCurve = {
  creator: Address; createdBlock: bigint; virtualBnb: bigint; virtualToken: bigint; realBnb: bigint; realToken: bigint; feesAccrued: bigint;
  graduated: boolean; tradeFeeBps: number; settledEpoch: bigint; votes: readonly { feeBps: number; blockNumber: bigint }[]; ammPair: Address; buys: bigint; sells: bigint; bnbVolume: bigint;
};

export function curveFromRaw(token: Address, c: RawCurve): CurveState {
  return {
    token,
    creator: c.creator,
    createdBlock: BigInt(c.createdBlock),
    virtualBnb: c.virtualBnb,
    virtualToken: c.virtualToken,
    realBnb: c.realBnb,
    realToken: c.realToken,
    feesAccrued: c.feesAccrued,
    graduated: c.graduated,
    tradeFeeBps: Number(c.tradeFeeBps),
    settledEpoch: BigInt(c.settledEpoch),
    votes: c.votes.map((v) => ({ feeBps: Number(v.feeBps), blockNumber: BigInt(v.blockNumber) })),
    ammPair: /^0x0{40}$/i.test(c.ammPair) ? null : c.ammPair,
    buys: BigInt(c.buys),
    sells: BigInt(c.sells),
    bnbVolume: c.bnbVolume,
  };
}

export async function readCurve(client: PublicClient, launchpad: Address, token: Address): Promise<CurveState | null> {
  const c = await client.readContract({ address: launchpad, abi: LaunchpadAbi, functionName: "curves", args: [token] });
  if (c.createdBlock === 0n) return null;
  return curveFromRaw(token, c as unknown as RawCurve);
}

export async function readParams(client: PublicClient, launchpad: Address): Promise<LaunchpadParams> {
  const p = await client.readContract({ address: launchpad, abi: LaunchpadAbi, functionName: "getParams" });
  return {
    treasury: p.treasury,
    tradeFeeBps: Number(p.tradeFeeBps),
    virtualBnb: p.virtualBnb,
    virtualToken: p.virtualToken,
    curveSupply: p.curveSupply,
    totalSupply: p.totalSupply,
    graduationWei: p.graduationWei,
    decimals: Number(p.decimals),
    agents: [...p.agents],
    router: p.router,
  };
}

export async function readTokens(client: PublicClient, launchpad: Address): Promise<Address[]> {
  const n = await client.readContract({ address: launchpad, abi: LaunchpadAbi, functionName: "tokenCount" });
  const out: Address[] = [];
  for (let i = 0n; i < n; i++) out.push(await client.readContract({ address: launchpad, abi: LaunchpadAbi, functionName: "tokens", args: [i] }));
  return out;
}

export async function readTokenMeta(client: PublicClient, token: Address): Promise<{ name: string; symbol: string; uri: string; decimals: number }> {
  const [name, symbol, uri, decimals] = await Promise.all([
    client.readContract({ address: token, abi: LaunchTokenAbi, functionName: "name" }),
    client.readContract({ address: token, abi: LaunchTokenAbi, functionName: "symbol" }),
    client.readContract({ address: token, abi: LaunchTokenAbi, functionName: "uri" }),
    client.readContract({ address: token, abi: LaunchTokenAbi, functionName: "decimals" }),
  ]);
  return { name, symbol, uri, decimals: Number(decimals) };
}

// ---- calls

export const launchCall = (launchpad: Address, name: string, symbol: string, uri: string) =>
  ({ address: launchpad, abi: LaunchpadAbi, functionName: "launch", args: [name, symbol, uri] }) as const;
export const voteCall = (launchpad: Address, token: Address, feeBps: number) => {
  if (!voteInBounds(feeBps)) throw new Error("vote outside the policy bounds");
  return { address: launchpad, abi: LaunchpadAbi, functionName: "vote", args: [token, feeBps] } as const;
};
export const harvestCall = (launchpad: Address, token: Address) => ({ address: launchpad, abi: LaunchpadAbi, functionName: "harvest", args: [token] }) as const;
export const graduateCall = (launchpad: Address, token: Address) => ({ address: launchpad, abi: LaunchpadAbi, functionName: "graduate", args: [token] }) as const;
export const migrateCall = (launchpad: Address, token: Address) => ({ address: launchpad, abi: LaunchpadAbi, functionName: "migrate", args: [token] }) as const;
export const rollPolicyCall = (launchpad: Address, token: Address) => ({ address: launchpad, abi: LaunchpadAbi, functionName: "rollPolicy", args: [token] }) as const;

/** Where the token trades after migration. */
export function pancakeSwapUrl(token: Address): string {
  return `https://pancakeswap.finance/swap?outputCurrency=${token}&inputCurrency=BNB`;
}
