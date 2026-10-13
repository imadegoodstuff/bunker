//! Where a graduated curve goes: a Raydium CP-Swap (constant product) pool on
//! mainnet-beta, created by the curve itself with all of its SOL and all of its
//! remaining tokens, the LP tokens burned in the same transaction. Nobody holds
//! the liquidity afterwards; the AMM's own fee applies and the launchpad's fee
//! policy (and its agents) no longer have anything to set.
//!
//! Only the account layout of `initialize` is reproduced here (raydium-cp-swap,
//! `instructions/initialize.rs`); nothing else of Raydium is trusted or depended on.

use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    pubkey::Pubkey,
};

/// Raydium CP-Swap program, mainnet-beta.
pub const CP_SWAP_PROGRAM_ID: Pubkey = solana_program::pubkey!("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
/// Config index 0: 0.25 % trade fee; carries `create_pool_fee` (0.15 SOL at the time of writing, read at run time).
pub const AMM_CONFIG: Pubkey = solana_program::pubkey!("D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
/// The WSOL account the pool creation fee is paid into (`create_pool_fee_reveiver::ID`).
pub const CREATE_POOL_FEE_RECEIVER: Pubkey = solana_program::pubkey!("DNXgeM9EiiaAbaWvwjHj9fQQLAX5ZsfHyvmYUNRAdNC8");
pub const WSOL_MINT: Pubkey = solana_program::pubkey!("So11111111111111111111111111111111111111112");
pub const SPL_TOKEN_PROGRAM_ID: Pubkey = solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

pub const AUTH_SEED: &[u8] = b"vault_and_lp_mint_auth_seed";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_LP_MINT_SEED: &[u8] = b"pool_lp_mint";
pub const POOL_VAULT_SEED: &[u8] = b"pool_vault";
pub const OBSERVATION_SEED: &[u8] = b"observation";

/// Anchor discriminator of `global:initialize`.
pub const INITIALIZE_DISCRIMINATOR: [u8; 8] = [175, 175, 109, 31, 13, 152, 155, 237];

/// Anchor discriminator of `account:AmmConfig`.
pub const AMM_CONFIG_DISCRIMINATOR: [u8; 8] = [218, 244, 33, 104, 203, 203, 43, 111];
/// Byte offset of `create_pool_fee: u64` in `AmmConfig` (8 discriminator, bump u8, disable bool, index u16, three u64 fee rates).
const CREATE_POOL_FEE_OFFSET: usize = 8 + 1 + 1 + 2 + 8 * 3;

/// `create_pool_fee` of an `AmmConfig` account, or None if the data is not one
/// (wrong discriminator, too short) or pool creation is disabled on it.
pub fn create_pool_fee(amm_config_data: &[u8]) -> Option<u64> {
    if amm_config_data.get(..8)? != AMM_CONFIG_DISCRIMINATOR || amm_config_data[9] != 0 {
        return None;
    }
    let b = amm_config_data.get(CREATE_POOL_FEE_OFFSET..CREATE_POOL_FEE_OFFSET + 8)?;
    Some(u64::from_le_bytes(b.try_into().ok()?))
}

/// CP-Swap orders the pair by mint key: `token_0 < token_1`.
pub fn ordered(mint: &Pubkey) -> (Pubkey, Pubkey, bool) {
    if WSOL_MINT < *mint { (WSOL_MINT, *mint, true) } else { (*mint, WSOL_MINT, false) }
}

pub struct PoolKeys {
    pub authority: Pubkey,
    pub pool_state: Pubkey,
    pub lp_mint: Pubkey,
    pub token_0_vault: Pubkey,
    pub token_1_vault: Pubkey,
    pub observation: Pubkey,
}

pub fn pool_state(amm_config: &Pubkey, token_0: &Pubkey, token_1: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[POOL_SEED, amm_config.as_ref(), token_0.as_ref(), token_1.as_ref()], &CP_SWAP_PROGRAM_ID).0
}

pub fn pool_keys(amm_config: &Pubkey, token_0: &Pubkey, token_1: &Pubkey) -> PoolKeys {
    let pid = &CP_SWAP_PROGRAM_ID;
    let (authority, _) = Pubkey::find_program_address(&[AUTH_SEED], pid);
    let pool_state = pool_state(amm_config, token_0, token_1);
    let (lp_mint, _) = Pubkey::find_program_address(&[POOL_LP_MINT_SEED, pool_state.as_ref()], pid);
    let (token_0_vault, _) = Pubkey::find_program_address(&[POOL_VAULT_SEED, pool_state.as_ref(), token_0.as_ref()], pid);
    let (token_1_vault, _) = Pubkey::find_program_address(&[POOL_VAULT_SEED, pool_state.as_ref(), token_1.as_ref()], pid);
    let (observation, _) = Pubkey::find_program_address(&[OBSERVATION_SEED, pool_state.as_ref()], pid);
    PoolKeys { authority, pool_state, lp_mint, token_0_vault, token_1_vault, observation }
}

/// Accounts of `initialize`, in Raydium's order.
#[allow(clippy::too_many_arguments)]
pub struct InitializeAccounts<'a, 'b> {
    pub cp_swap: &'b AccountInfo<'a>,
    pub creator: &'b AccountInfo<'a>,
    pub amm_config: &'b AccountInfo<'a>,
    pub authority: &'b AccountInfo<'a>,
    pub pool_state: &'b AccountInfo<'a>,
    pub token_0_mint: &'b AccountInfo<'a>,
    pub token_1_mint: &'b AccountInfo<'a>,
    pub lp_mint: &'b AccountInfo<'a>,
    pub creator_token_0: &'b AccountInfo<'a>,
    pub creator_token_1: &'b AccountInfo<'a>,
    pub creator_lp_token: &'b AccountInfo<'a>,
    pub token_0_vault: &'b AccountInfo<'a>,
    pub token_1_vault: &'b AccountInfo<'a>,
    pub create_pool_fee: &'b AccountInfo<'a>,
    pub observation_state: &'b AccountInfo<'a>,
    pub token_program: &'b AccountInfo<'a>,
    pub token_0_program: &'b AccountInfo<'a>,
    pub token_1_program: &'b AccountInfo<'a>,
    pub associated_token_program: &'b AccountInfo<'a>,
    pub system_program: &'b AccountInfo<'a>,
    pub rent: &'b AccountInfo<'a>,
}

pub fn initialize(a: &InitializeAccounts, init_amount_0: u64, init_amount_1: u64, open_time: u64, creator_seeds: &[&[u8]]) -> solana_program::entrypoint::ProgramResult {
    let mut data = Vec::with_capacity(32);
    data.extend_from_slice(&INITIALIZE_DISCRIMINATOR);
    data.extend_from_slice(&init_amount_0.to_le_bytes());
    data.extend_from_slice(&init_amount_1.to_le_bytes());
    data.extend_from_slice(&open_time.to_le_bytes());
    let ix = Instruction {
        program_id: *a.cp_swap.key,
        accounts: vec![
            AccountMeta::new(*a.creator.key, true),
            AccountMeta::new_readonly(*a.amm_config.key, false),
            AccountMeta::new_readonly(*a.authority.key, false),
            AccountMeta::new(*a.pool_state.key, false),
            AccountMeta::new_readonly(*a.token_0_mint.key, false),
            AccountMeta::new_readonly(*a.token_1_mint.key, false),
            AccountMeta::new(*a.lp_mint.key, false),
            AccountMeta::new(*a.creator_token_0.key, false),
            AccountMeta::new(*a.creator_token_1.key, false),
            AccountMeta::new(*a.creator_lp_token.key, false),
            AccountMeta::new(*a.token_0_vault.key, false),
            AccountMeta::new(*a.token_1_vault.key, false),
            AccountMeta::new(*a.create_pool_fee.key, false),
            AccountMeta::new(*a.observation_state.key, false),
            AccountMeta::new_readonly(*a.token_program.key, false),
            AccountMeta::new_readonly(*a.token_0_program.key, false),
            AccountMeta::new_readonly(*a.token_1_program.key, false),
            AccountMeta::new_readonly(*a.associated_token_program.key, false),
            AccountMeta::new_readonly(*a.system_program.key, false),
            AccountMeta::new_readonly(*a.rent.key, false),
        ],
        data,
    };
    invoke_signed(
        &ix,
        &[
            a.creator.clone(), a.amm_config.clone(), a.authority.clone(), a.pool_state.clone(), a.token_0_mint.clone(), a.token_1_mint.clone(),
            a.lp_mint.clone(), a.creator_token_0.clone(), a.creator_token_1.clone(), a.creator_lp_token.clone(), a.token_0_vault.clone(),
            a.token_1_vault.clone(), a.create_pool_fee.clone(), a.observation_state.clone(), a.token_program.clone(), a.token_0_program.clone(),
            a.token_1_program.clone(), a.associated_token_program.clone(), a.system_program.clone(), a.rent.clone(), a.cp_swap.clone(),
        ],
        &[creator_seeds],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discriminator_is_sha256_of_global_initialize() {
        let h = solana_program::hash::hash(b"global:initialize");
        assert_eq!(&h.to_bytes()[..8], &INITIALIZE_DISCRIMINATOR);
    }

    #[test]
    fn discriminators_match_anchor() {
        let h = solana_program::hash::hash(b"account:AmmConfig");
        assert_eq!(&h.to_bytes()[..8], &AMM_CONFIG_DISCRIMINATOR);
    }

    #[test]
    fn create_pool_fee_is_read_from_the_mainnet_config_layout() {
        // amm_config D4FPEru… as fetched from mainnet-beta: index 0, 2500 / 120000 / 40000, fee 0.15 SOL
        let mut d = vec![0u8; 236];
        d[..8].copy_from_slice(&AMM_CONFIG_DISCRIMINATOR);
        d[8] = 255;
        d[10..12].copy_from_slice(&0u16.to_le_bytes());
        d[12..20].copy_from_slice(&2500u64.to_le_bytes());
        d[20..28].copy_from_slice(&120000u64.to_le_bytes());
        d[28..36].copy_from_slice(&40000u64.to_le_bytes());
        d[36..44].copy_from_slice(&150_000_000u64.to_le_bytes());
        assert_eq!(create_pool_fee(&d), Some(150_000_000));
        assert_eq!(create_pool_fee(&d[..40]), None);
        d[9] = 1; // disable_create_pool
        assert_eq!(create_pool_fee(&d), None);
        d[9] = 0;
        d[0] ^= 1;
        assert_eq!(create_pool_fee(&d), None);
    }

    #[test]
    fn pair_is_ordered_by_key() {
        let lo = Pubkey::new_from_array([0u8; 32]);
        let hi = Pubkey::new_from_array([255u8; 32]);
        assert_eq!(ordered(&lo), (lo, WSOL_MINT, false));
        assert_eq!(ordered(&hi), (WSOL_MINT, hi, true));
    }
}
