//! Incremental Poseidon Merkle tree over the `Tree` account.

use crate::{error::VaultError, state::Tree};
use scash_core::{ROOT_HISTORY, TREE_DEPTH};
use solana_poseidon::{hashv, Endianness, Parameters};
use solana_program::program_error::ProgramError;

/// Poseidon(left, right) over BN254 using the circomlib parameters.
pub fn hash2(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    let h = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[left, right])
        .map_err(|_| ProgramError::InvalidArgument)?;
    Ok(h.to_bytes())
}

/// Poseidon of one input, used for the empty-leaf constant.
pub fn hash1(x: &[u8; 32]) -> Result<[u8; 32], ProgramError> {
    let h = hashv(Parameters::Bn254X5, Endianness::BigEndian, &[x])
        .map_err(|_| ProgramError::InvalidArgument)?;
    Ok(h.to_bytes())
}

/// Empty leaf preimage: the ASCII tag "scash_empty" right-aligned in 32 bytes,
/// matching `bytesToBigIntBE("scash_empty")` on the client.
pub fn empty_leaf_preimage() -> [u8; 32] {
    let mut pre = [0u8; 32];
    let tag = b"scash_empty";
    pre[32 - tag.len()..].copy_from_slice(tag);
    pre
}

/// Initialize the tree account: zero hashes per level, subtrees = zeros,
/// root[0] = empty root. Done once, so the 27 hashes are paid once.
pub fn init(data: &mut [u8], bump: u8) -> Result<(), ProgramError> {
    data[0] = crate::state::DISC_TREE;
    data[1] = bump;
    Tree::set_next_index(data, 0);
    Tree::set_root_index(data, 0);
    let mut z = hash1(&empty_leaf_preimage())?;
    Tree::set_zero(data, 0, &z);
    for level in 0..TREE_DEPTH {
        Tree::set_subtree(data, level, &z);
        z = hash2(&z, &z)?;
        Tree::set_zero(data, level + 1, &z);
    }
    Tree::set_root_at(data, 0, &z);
    Ok(())
}

/// Append one leaf and record the new root. Returns the leaf index.
pub fn append(data: &mut [u8], leaf: &[u8; 32]) -> Result<u64, ProgramError> {
    let index = Tree::next_index(data);
    if index >= (1u64 << TREE_DEPTH) {
        return Err(VaultError::TreeFull.into());
    }
    let mut current = *leaf;
    let mut idx = index;
    for level in 0..TREE_DEPTH {
        if idx & 1 == 0 {
            Tree::set_subtree(data, level, &current);
            let zero = Tree::zero(data, level);
            current = hash2(&current, &zero)?;
        } else {
            let left = Tree::subtree(data, level);
            current = hash2(&left, &current)?;
        }
        idx >>= 1;
    }
    let ri = (Tree::root_index(data) as usize + 1) % ROOT_HISTORY;
    Tree::set_root_index(data, ri as u64);
    Tree::set_root_at(data, ri, &current);
    Tree::set_next_index(data, index + 1);
    Ok(index)
}
