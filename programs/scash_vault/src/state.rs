//! Account layouts. All accounts are fixed-size and read/written in place.

use crate::error::VaultError;
use scash_core::{ASP_ROOT_HISTORY, ROOT_HISTORY, TREE_DEPTH};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

pub const DISC_CONFIG: u8 = 1;
pub const DISC_TREE: u8 = 2;
pub const DISC_POOL: u8 = 3;
pub const DISC_ASP: u8 = 4;

// ---------------------------------------------------------------- Config
// [disc u8][bump u8][shield_paused u8][guardian 32]
pub struct Config;
impl Config {
    pub const LEN: usize = 1 + 1 + 1 + 32;
    pub fn init(data: &mut [u8], bump: u8, guardian: &Pubkey) {
        data[0] = DISC_CONFIG;
        data[1] = bump;
        data[2] = 0;
        data[3..35].copy_from_slice(guardian.as_ref());
    }
    pub fn check(data: &[u8]) -> Result<(), ProgramError> {
        if data.len() < Self::LEN || data[0] != DISC_CONFIG {
            return Err(VaultError::WrongDiscriminator.into());
        }
        Ok(())
    }
    pub fn bump(data: &[u8]) -> u8 {
        data[1]
    }
    pub fn shield_paused(data: &[u8]) -> bool {
        data[2] != 0
    }
    pub fn set_shield_paused(data: &mut [u8], v: bool) {
        data[2] = v as u8;
    }
    pub fn guardian(data: &[u8]) -> Pubkey {
        Pubkey::new_from_array(data[3..35].try_into().unwrap())
    }
}

// ---------------------------------------------------------------- Tree
// [disc u8][bump u8][pad 6][next_index u64][root_index u64][filled_subtrees 26*32][roots 128*32]
pub struct Tree;
impl Tree {
    pub const OFF_NEXT: usize = 8;
    pub const OFF_ROOT_INDEX: usize = 16;
    pub const OFF_SUBTREES: usize = 24;
    pub const OFF_ROOTS: usize = Self::OFF_SUBTREES + TREE_DEPTH * 32;
    pub const OFF_ZEROS: usize = Self::OFF_ROOTS + ROOT_HISTORY * 32;
    pub const LEN: usize = Self::OFF_ZEROS + (TREE_DEPTH + 1) * 32;

    pub fn zero(data: &[u8], level: usize) -> [u8; 32] {
        let o = Self::OFF_ZEROS + level * 32;
        data[o..o + 32].try_into().unwrap()
    }
    pub fn set_zero(data: &mut [u8], level: usize, v: &[u8; 32]) {
        let o = Self::OFF_ZEROS + level * 32;
        data[o..o + 32].copy_from_slice(v);
    }

    pub fn check(data: &[u8]) -> Result<(), ProgramError> {
        if data.len() < Self::LEN || data[0] != DISC_TREE {
            return Err(VaultError::WrongDiscriminator.into());
        }
        Ok(())
    }
    pub fn bump(data: &[u8]) -> u8 {
        data[1]
    }
    pub fn next_index(data: &[u8]) -> u64 {
        u64::from_le_bytes(data[Self::OFF_NEXT..Self::OFF_NEXT + 8].try_into().unwrap())
    }
    pub fn set_next_index(data: &mut [u8], v: u64) {
        data[Self::OFF_NEXT..Self::OFF_NEXT + 8].copy_from_slice(&v.to_le_bytes());
    }
    pub fn root_index(data: &[u8]) -> u64 {
        u64::from_le_bytes(data[Self::OFF_ROOT_INDEX..Self::OFF_ROOT_INDEX + 8].try_into().unwrap())
    }
    pub fn set_root_index(data: &mut [u8], v: u64) {
        data[Self::OFF_ROOT_INDEX..Self::OFF_ROOT_INDEX + 8].copy_from_slice(&v.to_le_bytes());
    }
    pub fn subtree(data: &[u8], level: usize) -> [u8; 32] {
        let o = Self::OFF_SUBTREES + level * 32;
        data[o..o + 32].try_into().unwrap()
    }
    pub fn set_subtree(data: &mut [u8], level: usize, v: &[u8; 32]) {
        let o = Self::OFF_SUBTREES + level * 32;
        data[o..o + 32].copy_from_slice(v);
    }
    pub fn root_at(data: &[u8], i: usize) -> [u8; 32] {
        let o = Self::OFF_ROOTS + (i % ROOT_HISTORY) * 32;
        data[o..o + 32].try_into().unwrap()
    }
    pub fn set_root_at(data: &mut [u8], i: usize, v: &[u8; 32]) {
        let o = Self::OFF_ROOTS + (i % ROOT_HISTORY) * 32;
        data[o..o + 32].copy_from_slice(v);
    }
    pub fn current_root(data: &[u8]) -> [u8; 32] {
        Self::root_at(data, Self::root_index(data) as usize)
    }
    pub fn is_known_root(data: &[u8], root: &[u8; 32]) -> bool {
        if root.iter().all(|b| *b == 0) {
            return false;
        }
        let o = Self::OFF_ROOTS;
        for i in 0..ROOT_HISTORY {
            if &data[o + i * 32..o + i * 32 + 32] == root {
                return true;
            }
        }
        false
    }
}

// ---------------------------------------------------------------- Pool
// [disc u8][bump u8][decimals u8][is_native u8][pad 4]
// [mint 32][token_program 32][vault 32]
// [total_shares u64][total_assets u64][total_in u64][total_out u64][tvl_cap u64]
pub struct Pool;
impl Pool {
    pub const OFF_MINT: usize = 8;
    pub const OFF_TOKEN_PROGRAM: usize = 40;
    pub const OFF_VAULT: usize = 72;
    pub const OFF_TOTAL_SHARES: usize = 104;
    pub const OFF_TOTAL_ASSETS: usize = 112;
    pub const OFF_TOTAL_IN: usize = 120;
    pub const OFF_TOTAL_OUT: usize = 128;
    pub const OFF_TVL_CAP: usize = 136;
    pub const LEN: usize = 144;

    pub fn check(data: &[u8]) -> Result<(), ProgramError> {
        if data.len() < Self::LEN || data[0] != DISC_POOL {
            return Err(VaultError::WrongDiscriminator.into());
        }
        Ok(())
    }
    pub fn bump(d: &[u8]) -> u8 {
        d[1]
    }
    pub fn decimals(d: &[u8]) -> u8 {
        d[2]
    }
    pub fn is_native(d: &[u8]) -> bool {
        d[3] != 0
    }
    pub fn mint(d: &[u8]) -> Pubkey {
        Pubkey::new_from_array(d[Self::OFF_MINT..Self::OFF_MINT + 32].try_into().unwrap())
    }
    pub fn token_program(d: &[u8]) -> Pubkey {
        Pubkey::new_from_array(d[Self::OFF_TOKEN_PROGRAM..Self::OFF_TOKEN_PROGRAM + 32].try_into().unwrap())
    }
    pub fn vault(d: &[u8]) -> Pubkey {
        Pubkey::new_from_array(d[Self::OFF_VAULT..Self::OFF_VAULT + 32].try_into().unwrap())
    }
    fn get_u64(d: &[u8], off: usize) -> u64 {
        u64::from_le_bytes(d[off..off + 8].try_into().unwrap())
    }
    fn set_u64(d: &mut [u8], off: usize, v: u64) {
        d[off..off + 8].copy_from_slice(&v.to_le_bytes());
    }
    pub fn total_shares(d: &[u8]) -> u64 {
        Self::get_u64(d, Self::OFF_TOTAL_SHARES)
    }
    pub fn total_assets(d: &[u8]) -> u64 {
        Self::get_u64(d, Self::OFF_TOTAL_ASSETS)
    }
    pub fn total_in(d: &[u8]) -> u64 {
        Self::get_u64(d, Self::OFF_TOTAL_IN)
    }
    pub fn total_out(d: &[u8]) -> u64 {
        Self::get_u64(d, Self::OFF_TOTAL_OUT)
    }
    pub fn tvl_cap(d: &[u8]) -> u64 {
        Self::get_u64(d, Self::OFF_TVL_CAP)
    }
    pub fn set_total_shares(d: &mut [u8], v: u64) {
        Self::set_u64(d, Self::OFF_TOTAL_SHARES, v)
    }
    pub fn set_total_assets(d: &mut [u8], v: u64) {
        Self::set_u64(d, Self::OFF_TOTAL_ASSETS, v)
    }
    pub fn set_total_in(d: &mut [u8], v: u64) {
        Self::set_u64(d, Self::OFF_TOTAL_IN, v)
    }
    pub fn set_total_out(d: &mut [u8], v: u64) {
        Self::set_u64(d, Self::OFF_TOTAL_OUT, v)
    }
    pub fn set_tvl_cap(d: &mut [u8], v: u64) {
        Self::set_u64(d, Self::OFF_TVL_CAP, v)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn init(
        d: &mut [u8],
        bump: u8,
        decimals: u8,
        is_native: bool,
        mint: &Pubkey,
        token_program: &Pubkey,
        vault: &Pubkey,
        tvl_cap: u64,
    ) {
        d[0] = DISC_POOL;
        d[1] = bump;
        d[2] = decimals;
        d[3] = is_native as u8;
        d[Self::OFF_MINT..Self::OFF_MINT + 32].copy_from_slice(mint.as_ref());
        d[Self::OFF_TOKEN_PROGRAM..Self::OFF_TOKEN_PROGRAM + 32].copy_from_slice(token_program.as_ref());
        d[Self::OFF_VAULT..Self::OFF_VAULT + 32].copy_from_slice(vault.as_ref());
        Self::set_total_shares(d, 0);
        Self::set_total_assets(d, 0);
        Self::set_total_in(d, 0);
        Self::set_total_out(d, 0);
        Self::set_tvl_cap(d, tvl_cap);
    }

    /// Shares minted for `amount` (rounds down; first depositor gets 1:1).
    pub fn shares_for_deposit(d: &[u8], amount: u64) -> Option<u64> {
        let ts = Self::total_shares(d) as u128;
        let ta = Self::total_assets(d) as u128;
        if ts == 0 || ta == 0 {
            return Some(amount);
        }
        u64::try_from((amount as u128).checked_mul(ts)? / ta).ok()
    }

    /// Amount that must be deposited to mint exactly `shares` (rounds up).
    pub fn amount_for_mint(d: &[u8], shares: u64) -> Option<u64> {
        let ts = Self::total_shares(d) as u128;
        let ta = Self::total_assets(d) as u128;
        if ts == 0 || ta == 0 {
            return Some(shares);
        }
        let num = (shares as u128).checked_mul(ta)?;
        u64::try_from(num.div_ceil(ts)).ok()
    }

    /// Amount released when burning `shares` (rounds down).
    pub fn amount_for_burn(d: &[u8], shares: u64) -> Option<u64> {
        let ts = Self::total_shares(d) as u128;
        let ta = Self::total_assets(d) as u128;
        if ts == 0 {
            return Some(0);
        }
        u64::try_from((shares as u128).checked_mul(ta)? / ts).ok()
    }
}

// ---------------------------------------------------------------- Asp
// [disc u8][bump u8][root_index u8][pad 5][provider 32][roots 32*32]
pub struct Asp;
impl Asp {
    pub const OFF_PROVIDER: usize = 8;
    pub const OFF_ROOTS: usize = 40;
    pub const LEN: usize = Self::OFF_ROOTS + ASP_ROOT_HISTORY * 32;

    pub fn check(d: &[u8]) -> Result<(), ProgramError> {
        if d.len() < Self::LEN || d[0] != DISC_ASP {
            return Err(VaultError::WrongDiscriminator.into());
        }
        Ok(())
    }
    pub fn init(d: &mut [u8], bump: u8, provider: &Pubkey) {
        d[0] = DISC_ASP;
        d[1] = bump;
        d[2] = 0;
        d[Self::OFF_PROVIDER..Self::OFF_PROVIDER + 32].copy_from_slice(provider.as_ref());
    }
    pub fn provider(d: &[u8]) -> Pubkey {
        Pubkey::new_from_array(d[Self::OFF_PROVIDER..Self::OFF_PROVIDER + 32].try_into().unwrap())
    }
    pub fn push_root(d: &mut [u8], root: &[u8; 32]) {
        let i = (d[2] as usize + 1) % ASP_ROOT_HISTORY;
        d[2] = i as u8;
        let o = Self::OFF_ROOTS + i * 32;
        d[o..o + 32].copy_from_slice(root);
    }
    pub fn has_root(d: &[u8], root: &[u8; 32]) -> bool {
        for i in 0..ASP_ROOT_HISTORY {
            let o = Self::OFF_ROOTS + i * 32;
            if &d[o..o + 32] == root {
                return true;
            }
        }
        false
    }
}
