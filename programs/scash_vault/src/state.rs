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

#[cfg(test)]
mod share_invariants {
    //! Randomised model of the pool's share accounting, mirroring exactly the
    //! arithmetic `process_transact` and `process_donate` perform. Invariants:
    //!   1. the pool never pays out more than it holds (solvency);
    //!   2. rounding always favours the pool, by at most one base unit per
    //!      operation, and a holder never receives more than their pro-rata
    //!      share;
    //!   3. a holder who received shares can always burn them for a non-zero
    //!      amount unless the shares are worth less than one base unit;
    //!   4. `total_in - total_out` equals the real vault balance at all times.
    use super::*;

    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            // xorshift64*
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            if n == 0 { 0 } else { self.next() % n }
        }
    }

    fn pool() -> Vec<u8> {
        let mut d = vec![0u8; Pool::LEN];
        Pool::init(&mut d, 0, 9, true, &Pubkey::default(), &Pubkey::default(), &Pubkey::default(), u64::MAX);
        d
    }

    fn mint(d: &mut [u8], vault: &mut u128, shares: u64) -> Option<u64> {
        // compute everything first: on-chain a failed checked_add reverts the whole instruction
        let amount = Pool::amount_for_mint(d, shares)?;
        let ta = Pool::total_assets(d).checked_add(amount)?;
        let ts = Pool::total_shares(d).checked_add(shares)?;
        let ti = Pool::total_in(d).checked_add(amount)?;
        Pool::set_total_assets(d, ta);
        Pool::set_total_shares(d, ts);
        Pool::set_total_in(d, ti);
        *vault += amount as u128;
        Some(amount)
    }

    fn burn(d: &mut [u8], vault: &mut u128, shares: u64) -> Option<u64> {
        let amount = Pool::amount_for_burn(d, shares)?;
        let new_out = Pool::total_out(d).checked_add(amount)?;
        assert!(new_out <= Pool::total_in(d), "turnstile would fire on an honest burn");
        Pool::set_total_out(d, new_out);
        Pool::set_total_assets(d, Pool::total_assets(d).checked_sub(amount)?);
        Pool::set_total_shares(d, Pool::total_shares(d).checked_sub(shares)?);
        assert!(*vault >= amount as u128, "pool paid out more than it holds");
        *vault -= amount as u128;
        Some(amount)
    }

    fn donate(d: &mut [u8], vault: &mut u128, amount: u64) -> Option<()> {
        if Pool::total_shares(d) == 0 {
            return None; // process_donate refuses
        }
        let ta = Pool::total_assets(d).checked_add(amount)?;
        let ti = Pool::total_in(d).checked_add(amount)?;
        Pool::set_total_assets(d, ta);
        Pool::set_total_in(d, ti);
        *vault += amount as u128;
        Some(())
    }

    #[test]
    fn interleaved_mints_donations_and_burns_never_break_solvency() {
        for seed in 1..=64u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let mut d = pool();
            let mut vault: u128 = 0;
            let mut holders: Vec<u64> = Vec::new(); // shares per holder

            for _ in 0..400 {
                match rng.below(10) {
                    0..=4 => {
                        // deposit: dust to large
                        let shares = match rng.below(4) {
                            0 => 1 + rng.below(10),
                            1 => 1 + rng.below(1_000),
                            2 => 1 + rng.below(1_000_000_000),
                            _ => 1 + rng.below(1 << 40),
                        };
                        if let Some(amount) = mint(&mut d, &mut vault, shares) {
                            // rounding favours the pool: cost >= exact value, by < 1 unit
                            let ts = Pool::total_shares(&d) as u128 - shares as u128;
                            let ta = Pool::total_assets(&d) as u128 - amount as u128;
                            if ts > 0 {
                                let exact_num = shares as u128 * ta;
                                assert!(amount as u128 * ts >= exact_num);
                                assert!(amount as u128 * ts < exact_num + ts);
                            }
                            holders.push(shares);
                        }
                    }
                    5..=6 => {
                        let amount = 1 + rng.below(1 << 36);
                        let _ = donate(&mut d, &mut vault, amount);
                    }
                    _ => {
                        if holders.is_empty() {
                            continue;
                        }
                        let i = rng.below(holders.len() as u64) as usize;
                        let have = holders[i];
                        let shares = if rng.below(3) == 0 { have } else { 1 + rng.below(have) };
                        let ts = Pool::total_shares(&d) as u128;
                        let ta = Pool::total_assets(&d) as u128;
                        let amount = burn(&mut d, &mut vault, shares).unwrap();
                        // never more than pro-rata, and short by less than one unit
                        assert!(amount as u128 * ts <= shares as u128 * ta);
                        assert!((amount as u128 + 1) * ts > shares as u128 * ta);
                        // a share worth >= 1 unit always pays something
                        if shares as u128 * ta >= ts {
                            assert!(amount > 0, "non-dust burn paid zero");
                        }
                        holders[i] -= shares;
                        if holders[i] == 0 {
                            holders.swap_remove(i);
                        }
                    }
                }
                // invariant 4: books match the vault
                assert_eq!(Pool::total_in(&d) as u128 - Pool::total_out(&d) as u128, vault);
                assert_eq!(Pool::total_assets(&d) as u128, vault);
                assert_eq!(holders.iter().map(|&s| s as u128).sum::<u128>(), Pool::total_shares(&d) as u128);
            }

            // everyone exits: the pool must be able to pay every holder
            for s in holders.drain(..) {
                burn(&mut d, &mut vault, s).unwrap();
            }
            assert_eq!(Pool::total_shares(&d), 0);
            // what is left is rounding dust that stayed in the pool (never negative)
            assert_eq!(Pool::total_assets(&d) as u128, vault);
        }
    }

    #[test]
    fn first_depositor_is_one_to_one_and_donation_needs_shares() {
        let mut d = pool();
        let mut vault = 0u128;
        assert!(donate(&mut d, &mut vault, 1_000).is_none());
        assert_eq!(mint(&mut d, &mut vault, 5_000).unwrap(), 5_000);
        donate(&mut d, &mut vault, 5_000).unwrap();
        // the single holder now owns everything
        assert_eq!(burn(&mut d, &mut vault, 5_000).unwrap(), 10_000);
        assert_eq!(vault, 0);
    }

    #[test]
    fn share_granularity_can_be_inflated_but_not_stolen_from() {
        // Known limitation (SECURITY.md §7): a first depositor can mint 1 share
        // and donate a large amount, making one share expensive. Later
        // depositors then pay in multiples of that price, but every unit they
        // pay is backed by shares at the same rate, and the attacker gains
        // nothing beyond their own deposit back.
        let mut d = pool();
        let mut vault = 0u128;
        mint(&mut d, &mut vault, 1).unwrap();
        donate(&mut d, &mut vault, 1_000_000_000).unwrap();
        let price = Pool::amount_for_mint(&d, 1).unwrap();
        assert_eq!(price, 1_000_000_001);
        // victim buys 3 shares at that price and gets exactly pro-rata back
        let paid = mint(&mut d, &mut vault, 3).unwrap();
        assert_eq!(paid, 3 * price);
        assert_eq!(burn(&mut d, &mut vault, 3).unwrap(), paid);
        // attacker exits with exactly what they put in
        assert_eq!(burn(&mut d, &mut vault, 1).unwrap(), 1_000_000_001);
        assert_eq!(vault, 0);
    }
}
