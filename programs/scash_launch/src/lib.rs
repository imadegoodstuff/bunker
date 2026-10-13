//! scash launchpad.
//!
//! Every launchpad on Solana publishes its buyers: the wallet, the amount and
//! the time of every purchase are on-chain forever, and moving the tokens into
//! a privacy pool afterwards only hides what happens next. This program puts
//! the purchase itself *inside* the shielded pool:
//!
//! ```text
//!   buy    user unshields SOL from the scash vault with
//!          exit_target = this program, recipient = PDA("intake", mint).
//!          The vault moves the SOL and calls us in the same transaction; we
//!          buy on the curve and park the tokens at a *claim key*: a fresh
//!          ed25519 key the buyer derives from their shielded seed, which
//!          also receives enough lamports to pay for its own next step.
//!   claim  the claim key signs a plain vault shield of that balance into the
//!          token's own pool, paying its own fee and nullifier rent. No
//!          relayer is needed and no program is involved beyond the vault.
//!   sell   the mirror image: unshield tokens to PDA("intake", mint)'s token
//!          account, we sell on the curve, the SOL waits at a claim key, the
//!          claim key shields it into the SOL pool.
//! ```
//!
//! What is public: that *someone inside the pool* bought or sold a given
//! amount at a given time, the curve's reserves, and one throwaway key per
//! trade that links its two halves. What is not: who, from which notes, and
//! where the tokens went. Until a curve graduates it accepts buys and sells
//! **only** through the vault, so the anonymity set of a new token is every
//! one of its holders rather than the few who opted in.
//!
//! The mint is created here with no freeze authority and only the metadata
//! extensions, so every launched token satisfies the vault's `create_pool`
//! rules by construction; the pool is created in the same instruction. The
//! creator holds no key: trading fees are split between the launchpad's
//! protocol treasury and the token's own vault pool (`harvest` buys tokens
//! with the holder share and `donate`s them, so every private holder's shares
//! appreciate), at percentages fixed when the launchpad was initialised.

pub mod curve;
pub mod policy;
pub mod processor;
pub mod state;
pub mod token;

use solana_program::program_error::ProgramError;
use thiserror::Error;

solana_program::declare_id!("861VJkPL2yUYL1DTCToeziREP4XyraihkqbTM1irFZ3k");

pub mod seeds {
    pub const LAUNCHPAD: &[u8] = b"launchpad";
    pub const CURVE: &[u8] = b"curve";
    pub const INTAKE: &[u8] = b"intake";
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum LaunchError {
    #[error("invalid instruction data")]
    InvalidInstruction,
    #[error("account malformed or not initialised")]
    BadAccount,
    #[error("already initialised")]
    AlreadyInitialized,
    #[error("pda derivation mismatch")]
    BadPda,
    #[error("account does not match what the curve expects")]
    AccountMismatch,
    #[error("arithmetic overflow")]
    Overflow,
    #[error("output below the minimum the buyer or seller asked for")]
    Slippage,
    #[error("the curve does not have that many tokens left")]
    SoldOut,
    #[error("the curve does not hold that much SOL")]
    InsufficientReserve,
    #[error("amount too small to cover the claim key's rent, nullifier rents and budget")]
    AmountTooSmall,
    #[error("public trading opens when the curve graduates; until then buy and sell through the vault")]
    NotGraduated,
    #[error("exit call did not come from the vault program")]
    NotFromVault,
    #[error("nothing to do")]
    Nothing,
    #[error("string too long")]
    StringTooLong,
    #[error("curve parameters are inconsistent")]
    BadParams,
    #[error("claim account must be a plain system account")]
    BadClaimAccount,
    #[error("signer is not one of the launchpad's agents")]
    NotAgent,
}
impl From<LaunchError> for ProgramError {
    fn from(e: LaunchError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};
    entrypoint!(process_instruction);
    fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        crate::processor::process(program_id, accounts, data)
    }
}
