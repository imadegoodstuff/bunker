/**
 * Custom errors of `ShieldedPool` and `Launchpad`, by name. The relayer turns a
 * failed simulation into one of these names so clients classify by name, not by
 * parsing RPC error payloads; `sdk.test.ts` checks the lists against the ABIs.
 */
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Hex } from "viem";
import { ShieldedPoolAbi } from "./abi/ShieldedPool.js";
import { LaunchpadAbi } from "./abi/Launchpad.js";

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
  "FeeExceedsAmount",
  "Unauthorized",
  "TreeFull",
  "Overflow",
  "AccountMismatch",
  "CapNotLower",
  "AlreadyInitialized",
  "NotInitialized",
  "ShortDelivery",
  "BadUnit",
  "TransferFailed",
  "Reentrancy",
  "ValueMismatch",
] as const;
export type PoolErrorName = (typeof POOL_ERRORS)[number];

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

export type ContractErrorName = PoolErrorName | LaunchErrorName;

/** Errors that mean "the tree moved under you": a fresh sync and a new proof against the current root are the right response. */
export const STALE_ROOT_ERRORS: readonly ContractErrorName[] = ["UnknownRoot", "InvalidProof"];

const ABIS = [...ShieldedPoolAbi, ...LaunchpadAbi];

/** Decode a revert's raw data into a known custom error name (undefined for anything else: out of gas, plain `require`, …). */
export function contractErrorFromData(data: Hex | undefined): ContractErrorName | undefined {
  if (!data || data === "0x") return undefined;
  try {
    const d = decodeErrorResult({ abi: ABIS, data });
    const name = d.errorName as ContractErrorName;
    if ((POOL_ERRORS as readonly string[]).includes(name) || (LAUNCH_ERRORS as readonly string[]).includes(name)) return name;
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
    if ((POOL_ERRORS as readonly string[]).includes(name) || (LAUNCH_ERRORS as readonly string[]).includes(name)) return name;
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
