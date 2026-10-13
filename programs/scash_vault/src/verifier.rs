//! Groth16 verification using Light Protocol's `groth16-solana` over the
//! `alt_bn128` syscalls. Verifying keys are generated from the circuit
//! artifacts by `circuits/scripts/export-vk.mjs` into `src/vk/`.

use crate::{error::VaultError, vk};
use groth16_solana::groth16::Groth16Verifier;
use solana_program::program_error::ProgramError;

/// Verify a proof for `n_ins` spends. `public_inputs` must be big-endian
/// field elements in the order fixed by SPEC.md section 6.
pub fn verify(n_ins: usize, proof: &[u8], public_inputs: &[[u8; 32]]) -> Result<(), ProgramError> {
    if proof.len() != 256 {
        return Err(VaultError::MalformedProof.into());
    }
    let proof_a: &[u8; 64] = proof[0..64].try_into().unwrap();
    let proof_b: &[u8; 128] = proof[64..192].try_into().unwrap();
    let proof_c: &[u8; 64] = proof[192..256].try_into().unwrap();

    match n_ins {
        2 => {
            const N: usize = scash_core::public_input_count(2);
            let inputs: &[[u8; 32]; N] = public_inputs.try_into().map_err(|_| VaultError::MalformedProof)?;
            let mut v = Groth16Verifier::new(proof_a, proof_b, proof_c, inputs, &vk::transact2x2::VERIFYING_KEY)
                .map_err(|_| VaultError::MalformedProof)?;
            v.verify().map_err(|_| VaultError::InvalidProof)?;
        }
        4 => {
            const N: usize = scash_core::public_input_count(4);
            let inputs: &[[u8; 32]; N] = public_inputs.try_into().map_err(|_| VaultError::MalformedProof)?;
            let mut v = Groth16Verifier::new(proof_a, proof_b, proof_c, inputs, &vk::transact4x2::VERIFYING_KEY)
                .map_err(|_| VaultError::MalformedProof)?;
            v.verify().map_err(|_| VaultError::InvalidProof)?;
        }
        _ => return Err(VaultError::MalformedProof.into()),
    }
    Ok(())
}
