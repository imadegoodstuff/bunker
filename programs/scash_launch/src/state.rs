//! Account layouts (borsh, fixed size). The TypeScript SDK mirrors them.

use crate::LaunchError;
use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{program_error::ProgramError, pubkey::Pubkey};

pub const DISC_LAUNCHPAD: u8 = 1;
pub const DISC_CURVE: u8 = 2;

/// One agent's latest vote on a curve's fee policy (`slot == 0` means never voted).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Vote {
    pub fee_bps: u16,
    pub holder_bps: u16,
    pub slot: u64,
}
impl Vote {
    pub const LEN: usize = 2 + 2 + 8;
}

/// Global parameters. Written once by `InitLaunchpad`; nothing can change them
/// afterwards, so the fee split a buyer sees is the fee split they get.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Launchpad {
    pub disc: u8,
    pub bump: u8,
    pub vault_program: Pubkey,
    pub protocol_treasury: Pubkey,
    /// trading fee on every buy and sell, in basis points of the SOL leg
    pub trade_fee_bps: u16,
    /// share of the fee that is bought back and donated to the token's pool
    pub holder_share_bps: u16,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    /// tokens for sale on the curve
    pub curve_supply: u64,
    /// tokens minted; the remainder stays in the curve's vault as graduation liquidity
    pub total_supply: u64,
    pub graduation_lamports: u64,
    pub decimals: u8,
    /// The four keys whose votes set every curve's fee and holder share (policy.rs).
    /// Fixed at initialisation; there is no instruction to rotate them.
    pub agents: [Pubkey; crate::policy::AGENTS],
}
impl Launchpad {
    pub const LEN: usize = 1 + 1 + 32 + 32 + 2 + 2 + 8 + 8 + 8 + 8 + 8 + 1 + 32 * crate::policy::AGENTS;

    pub fn load(d: &[u8]) -> Result<Self, ProgramError> {
        let s = Self::try_from_slice(d).map_err(|_| LaunchError::BadAccount)?;
        if s.disc != DISC_LAUNCHPAD {
            return Err(LaunchError::BadAccount.into());
        }
        Ok(s)
    }
    pub fn validate(&self) -> Result<(), ProgramError> {
        if self.trade_fee_bps > 1_000
            || self.holder_share_bps > 10_000
            || self.virtual_sol == 0
            || self.virtual_token < self.curve_supply
            || self.curve_supply == 0
            || self.total_supply < self.curve_supply
            || self.graduation_lamports == 0
            || !crate::policy::vote_in_bounds(self.trade_fee_bps, self.holder_share_bps)
        {
            return Err(LaunchError::BadParams.into());
        }
        for (i, a) in self.agents.iter().enumerate() {
            if *a == Pubkey::default() || self.agents[..i].contains(a) {
                return Err(LaunchError::BadParams.into());
            }
        }
        Ok(())
    }
}

/// One per launched mint.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct Curve {
    pub disc: u8,
    pub bump: u8,
    /// bump of PDA("intake", mint), the system-owned account the vault pays into
    pub intake_bump: u8,
    pub mint: Pubkey,
    pub token_vault: Pubkey,
    pub virtual_sol: u64,
    /// current virtual token reserve `y`
    pub virtual_token: u64,
    /// lamports held for the pool (the curve account also holds its rent and `fees_accrued`)
    pub real_sol: u64,
    /// tokens still for sale
    pub real_token: u64,
    /// lamports of trading fees not yet harvested
    pub fees_accrued: u64,
    pub graduated: u8,
    pub created_slot: u64,
    pub total_supply: u64,
    pub curve_supply: u64,
    pub trade_fee_bps: u16,
    pub holder_share_bps: u16,
    pub graduation_lamports: u64,
    pub protocol_treasury: Pubkey,
    pub vault_program: Pubkey,
    /// lifetime counters, for the public statistics the app shows
    pub buys: u64,
    pub sells: u64,
    pub sol_volume: u64,
    /// Frozen address lookup table holding this token's static accounts, created
    /// in the launch transaction so a relayed private trade fits in one packet.
    /// A hint for clients, which verify its contents; nothing on-chain trusts it.
    pub lookup_table: Pubkey,
    /// Fee epoch the policy was last advanced to (policy.rs). `trade_fee_bps` and
    /// `holder_share_bps` above are the values in force for that epoch.
    pub settled_epoch: u64,
    /// Latest vote of each agent, indexed like `Launchpad.agents`.
    pub votes: [Vote; crate::policy::AGENTS],
    /// The Raydium CP-Swap pool the curve's SOL and remaining tokens moved to at
    /// migration (`amm.rs`); all-zero until then. Once set the curve is inert:
    /// no trades, no votes, no harvest — the token trades on the AMM.
    pub amm_pool: Pubkey,
}
impl Curve {
    pub const LEN: usize = 1 + 1 + 1 + 32 + 32 + 8 * 5 + 1 + 8 * 3 + 2 + 2 + 8 + 32 + 32 + 8 * 3 + 32 + 8 + Vote::LEN * crate::policy::AGENTS + 32;

    pub fn migrated(&self) -> bool {
        self.amm_pool != Pubkey::default()
    }

    pub fn load(d: &[u8]) -> Result<Self, ProgramError> {
        let s = Self::try_from_slice(d).map_err(|_| LaunchError::BadAccount)?;
        if s.disc != DISC_CURVE {
            return Err(LaunchError::BadAccount.into());
        }
        Ok(s)
    }
    pub fn store(&self, d: &mut [u8]) -> Result<(), ProgramError> {
        let mut w = &mut d[..];
        self.serialize(&mut w).map_err(|_| ProgramError::AccountDataTooSmall)
    }
    pub fn reserves(&self) -> crate::curve::Reserves {
        crate::curve::Reserves { virtual_sol: self.virtual_sol, real_sol: self.real_sol, virtual_token: self.virtual_token, real_token: self.real_token }
    }
    pub fn should_graduate(&self) -> bool {
        self.real_sol >= self.graduation_lamports || self.real_token == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lengths_match_serialization() {
        let l = Launchpad {
            disc: DISC_LAUNCHPAD, bump: 0, vault_program: Pubkey::new_unique(), protocol_treasury: Pubkey::new_unique(),
            trade_fee_bps: 100, holder_share_bps: 5000, virtual_sol: 1, virtual_token: 2, curve_supply: 1, total_supply: 2, graduation_lamports: 1, decimals: 6,
            agents: [Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()],
        };
        assert_eq!(borsh::to_vec(&l).unwrap().len(), Launchpad::LEN);
        let c = Curve {
            disc: DISC_CURVE, bump: 0, intake_bump: 0, mint: Pubkey::new_unique(), token_vault: Pubkey::new_unique(), virtual_sol: 0, virtual_token: 0, real_sol: 0, real_token: 0,
            fees_accrued: 0, graduated: 0, created_slot: 0, total_supply: 0, curve_supply: 0, trade_fee_bps: 0, holder_share_bps: 0, graduation_lamports: 0,
            protocol_treasury: Pubkey::new_unique(), vault_program: Pubkey::new_unique(), buys: 0, sells: 0, sol_volume: 0, lookup_table: Pubkey::new_unique(),
            settled_epoch: 7, votes: [Vote { fee_bps: 100, holder_bps: 5000, slot: 1 }, Vote::default(), Vote::default(), Vote::default()], amm_pool: Pubkey::default(),
        };
        let mut buf = vec![0u8; Curve::LEN];
        c.store(&mut buf).unwrap();
        assert_eq!(Curve::load(&buf).unwrap(), c);
        assert_eq!(borsh::to_vec(&c).unwrap().len(), Curve::LEN);
    }

    #[test]
    fn params_are_validated() {
        let mut l = Launchpad {
            disc: DISC_LAUNCHPAD, bump: 0, vault_program: Pubkey::new_unique(), protocol_treasury: Pubkey::new_unique(),
            trade_fee_bps: 100, holder_share_bps: 5000, virtual_sol: 30, virtual_token: 1000, curve_supply: 800, total_supply: 1000, graduation_lamports: 85, decimals: 6,
            agents: [Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()],
        };
        l.validate().unwrap();
        let mut dup = l.clone();
        dup.agents[3] = dup.agents[0];
        assert!(dup.validate().is_err());
        let mut zero = l.clone();
        zero.agents[1] = Pubkey::default();
        assert!(zero.validate().is_err());
        l.trade_fee_bps = 1_001;
        assert!(l.validate().is_err());
        l.trade_fee_bps = 100;
        l.virtual_token = 799;
        assert!(l.validate().is_err());
    }
}
