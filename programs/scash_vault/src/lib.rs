//! scash vault program.
//!
//! One shared Poseidon commitment tree, one pool account per asset, Groth16
//! proofs verified with the `alt_bn128` syscalls, nullifiers as program-owned
//! PDAs, and a turnstile that bounds every pool's outflow by its inflow.
//!
//! See `SPEC.md` at the repository root.

pub mod error;
pub mod field;
pub mod processor;
pub mod state;
pub mod token;
pub mod tree;
pub mod verifier;
pub mod vk;

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use solana_program::{
        account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey,
    };

    entrypoint!(process_instruction);

    fn process_instruction(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        instruction_data: &[u8],
    ) -> ProgramResult {
        crate::processor::process(program_id, accounts, instruction_data)
    }
}

solana_program::declare_id!("89TrDDtwYTkrvxGmfYnSz6EbA1muGStuPBFUt3Dvd8WR");
