/**
 * Mirror of `programs/scash_vault/src/error.rs` (`VaultError`, `#[repr(u32)]`
 * by declaration order). The relayer turns a simulation failure into a named
 * error with this table so clients classify by name, not by parsing RPC error
 * JSON; `sdk.test.ts` checks the table against the Rust source so the two
 * cannot drift.
 */
export const VAULT_ERRORS = [
  "InvalidInstruction",
  "AlreadyInitialized",
  "NotInitialized",
  "WrongDiscriminator",
  "InvalidPda",
  "UnknownRoot",
  "UnknownAspRoot",
  "InvalidProof",
  "MalformedProof",
  "NullifierSpent",
  "PublicAmountOutOfRange",
  "ShieldPaused",
  "TvlCapExceeded",
  "Turnstile",
  "FeeExceedsAmount",
  "DepositorNotSigner",
  "Unauthorized",
  "TreeFull",
  "Overflow",
  "WrongAsset",
  "AccountMismatch",
  "CapNotLower",
  "ExtDataTooLarge",
  "UnsupportedMintExtension",
  "ShortDelivery",
] as const;
export type VaultErrorName = (typeof VAULT_ERRORS)[number];

/** Errors that mean "the tree moved under you": a fresh sync and a new proof against the current root are the right response. */
export const STALE_ROOT_ERRORS: readonly VaultErrorName[] = ["UnknownRoot", "InvalidProof"];

/**
 * Extract the vault error name from a `TransactionError` as returned by
 * `simulateTransaction` / `sendTransaction`:
 *   { InstructionError: [ixIndex, { Custom: n }] }
 * Returns undefined for anything that is not a custom error of this program
 * (compute budget, system program, token program, insufficient funds, ...).
 */
export function vaultErrorName(txError: unknown): VaultErrorName | undefined {
  if (!txError || typeof txError !== "object") return undefined;
  const ie = (txError as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2) return undefined;
  const inner = ie[1];
  if (!inner || typeof inner !== "object") return undefined;
  const custom = (inner as { Custom?: unknown }).Custom;
  if (typeof custom !== "number" || !Number.isInteger(custom) || custom < 0 || custom >= VAULT_ERRORS.length) return undefined;
  return VAULT_ERRORS[custom];
}

/** Body of a relayer 422. `vaultError` is the structured field; `details` is the raw RPC error for debugging only. */
export interface RelayRejection {
  error: string;
  vaultError?: VaultErrorName;
  details?: unknown;
  logs?: string[];
}

export function isStaleRootRejection(body: unknown): boolean {
  const name = (body as RelayRejection | undefined)?.vaultError;
  return !!name && STALE_ROOT_ERRORS.includes(name);
}
