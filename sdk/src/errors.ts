/**
 * Custom errors of `ShieldedPool` and `Launchpad`, by name. The relayer turns a
 * failed simulation into one of these names so clients classify by name, not by
 * parsing RPC error payloads; `sdk.test.ts` checks the lists against the ABIs.
 */
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";
import { ShieldedPoolAbi } from "./abi/ShieldedPool.js";
import { LaunchpadAbi } from "./abi/Launchpad.js";
import { SwapExitAbi } from "./abi/SwapExit.js";

export const POOL_ERRORS = [
  "UnknownRoot",
  "UnknownAspRoot",
  "InvalidProof",
  "MalformedProof",
  "NullifierSpent",
  "PublicAmountOutOfRange",
  "ShieldPausedError",
  "TvlCapExceeded",
  "Turnstile",
  "Unauthorized",
  "TreeFull",
  "Overflow",
  "CapNotLower",
  "AlreadyInitialized",
  "NotInitialized",
  "ShortDelivery",
  "BadUnit",
  "TransferFailed",
  "Reentrancy",
  "ValueMismatch",
  "NotInTransact",
  "BadAddress",
  "AmountTooSmall",
  "NothingQueued",
  "Expired",
  "ComplianceRejected",
  "BatchShield",
  "EmptyBatch",
] as const;
export type PoolErrorName = (typeof POOL_ERRORS)[number];

export const SWAP_EXIT_ERRORS = ["NotFromPool", "BadPath", "TransferFailed"] as const;
export type SwapExitErrorName = (typeof SWAP_EXIT_ERRORS)[number];

export const LAUNCH_ERRORS = [
  "BadParams",
  "NotFromPool",
  "UnknownCurve",
  "Migrated",
  "NotGraduated",
  "NotMigratable",
  "AmountTooSmall",
  "Slippage",
  "SoldOut",
  "InsufficientReserve",
  "Nothing",
  "NotAgent",
  "BadExit",
  "Reentrancy",
  "TransferFailed",
] as const;
export type LaunchErrorName = (typeof LAUNCH_ERRORS)[number];

export type ContractErrorName = PoolErrorName | LaunchErrorName | SwapExitErrorName;

/** Errors that mean "the tree moved under you" (or the proof aged out): a fresh sync and a new proof against the current root are the right response. */
export const STALE_ROOT_ERRORS: readonly ContractErrorName[] = ["UnknownRoot", "InvalidProof", "Expired"];

const ABIS = [...ShieldedPoolAbi, ...LaunchpadAbi, ...SwapExitAbi];
const KNOWN: readonly string[] = [...POOL_ERRORS, ...LAUNCH_ERRORS, ...SWAP_EXIT_ERRORS];

/** Decode a revert's raw data into a known custom error name (undefined for anything else: out of gas, plain `require`, …). */
export function contractErrorFromData(data: Hex | undefined): ContractErrorName | undefined {
  if (!data || data === "0x") return undefined;
  try {
    const d = decodeErrorResult({ abi: ABIS, data });
    const name = d.errorName as ContractErrorName;
    if (KNOWN.includes(name)) return name;
  } catch {
    /* not ours */
  }
  return undefined;
}

/** Pull the custom error name out of a viem error (from `simulateContract`, `estimateGas`, `writeContract`). */
export function contractErrorName(err: unknown): ContractErrorName | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
  if (reverted?.data?.errorName) {
    const name = reverted.data.errorName as ContractErrorName;
    if (KNOWN.includes(name)) return name;
  }
  if (reverted?.raw) return contractErrorFromData(reverted.raw);
  // raw RPC error payloads
  const walked = err.walk((e) => typeof (e as { data?: unknown }).data === "string") as { data?: Hex } | null;
  return contractErrorFromData(walked?.data);
}

/** Body of a relayer 422. `contractError` is the structured field; `details` is the raw error for debugging only. */
export interface RelayRejection {
  error: string;
  contractError?: ContractErrorName;
  details?: unknown;
}

export function isStaleRootRejection(body: unknown): boolean {
  const name = (body as RelayRejection | undefined)?.contractError;
  return !!name && STALE_ROOT_ERRORS.includes(name);
}
