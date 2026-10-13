//! scash harvester.
//!
//! The SCASH mint is launched on Meteora's Dynamic Bonding Curve (DBC) and
//! graduates to DAMM v2. Creator trading fees accrue to this program's
//! authority PDA. Anyone can call:
//!
//! 1. `Claim`   - CPI into Meteora to pull accrued creator fees (base + quote)
//!                into the harvester's token accounts.
//! 2. `Swap`    - CPI into the graduated DAMM v2 pool to sell the quote-side
//!                fees for SCASH (all-in, min-out enforced by the caller's
//!                slippage parameter checked against the pool's spot price
//!                stored by the last observation; see `swap`).
//! 3. `Distribute` - split the SCASH held by the harvester: `holder_bps` is
//!                donated to the scash vault (every private holder's shares
//!                appreciate), the remainder goes to the team treasury.
//!
//! The split is fixed at initialization and cannot be changed. The harvester
//! holds no upgrade authority over anything else.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

solana_program::declare_id!("9TorUNxbdb4vwNXNB6R487Th94616xGtvsBHpaETcqGi");

pub const SEED_CONFIG: &[u8] = b"harvester";
pub const SEED_AUTHORITY: &[u8] = b"authority";

pub const METEORA_DBC: Pubkey = solana_program::pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const METEORA_DAMM_V2: Pubkey = solana_program::pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct HarvesterConfig {
    pub bump: u8,
    pub authority_bump: u8,
    /// Basis points of harvested SCASH donated to the vault. Fixed forever.
    pub holder_bps: u16,
    pub scash_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub team_treasury: Pubkey,
    pub vault_program: Pubkey,
    pub token_program: Pubkey,
    /// Meteora pool (DBC virtual pool before graduation, DAMM v2 pool after).
    pub meteora_pool: Pubkey,
    pub graduated: bool,
    pub total_claimed_base: u64,
    pub total_claimed_quote: u64,
    pub total_donated: u64,
    pub total_team: u64,
}

impl HarvesterConfig {
    pub const LEN: usize = 1 + 1 + 2 + 32 * 6 + 1 + 8 * 4;
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub enum HarvesterInstruction {
    /// [payer s, config w, authority, system]
    Initialize {
        holder_bps: u16,
        scash_mint: Pubkey,
        quote_mint: Pubkey,
        team_treasury: Pubkey,
        vault_program: Pubkey,
        token_program: Pubkey,
        meteora_pool: Pubkey,
    },
    /// Claim creator trading fees from the Meteora pool into the authority's ATAs.
    /// [config w, authority, meteora_program, ...meteora accounts in Meteora's order]
    Claim { max_base: u64, max_quote: u64 },
    /// Swap all quote held by the authority into SCASH through the DAMM v2 pool.
    /// [config, authority, meteora_program, ...swap accounts in Meteora's order]
    Swap { amount_in: u64, min_out: u64 },
    /// Distribute SCASH: holder share -> vault donate, rest -> team.
    /// [config w, authority, harvester_scash_ata w, team_scash_ata w, scash_mint,
    ///  token_program, vault_program, pool w, vault_token w, system]
    Distribute,
    /// Mark the pool graduated and point at the DAMM v2 pool. Permissionless;
    /// verified by reading the DBC pool state's migration flag.
    /// [config w, dbc_pool, damm_pool]
    MarkGraduated,
}

fn anchor_discriminator(name: &str) -> [u8; 8] {
    let h = hashv(&[b"global:", name.as_bytes()]);
    h.to_bytes()[..8].try_into().unwrap()
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ix = HarvesterInstruction::try_from_slice(data).map_err(|_| ProgramError::InvalidInstructionData)?;
    match ix {
        HarvesterInstruction::Initialize { holder_bps, scash_mint, quote_mint, team_treasury, vault_program, token_program, meteora_pool } => {
            let it = &mut accounts.iter();
            let payer = next_account_info(it)?;
            let config = next_account_info(it)?;
            let authority = next_account_info(it)?;
            let system = next_account_info(it)?;
            if !payer.is_signer {
                return Err(ProgramError::MissingRequiredSignature);
            }
            if holder_bps > 10_000 {
                return Err(ProgramError::InvalidArgument);
            }
            let (cfg_addr, bump) = Pubkey::find_program_address(&[SEED_CONFIG], program_id);
            let (auth_addr, authority_bump) = Pubkey::find_program_address(&[SEED_AUTHORITY], program_id);
            if cfg_addr != *config.key || auth_addr != *authority.key || !config.data_is_empty() {
                return Err(ProgramError::InvalidArgument);
            }
            let lamports = Rent::get()?.minimum_balance(HarvesterConfig::LEN);
            invoke_signed(
                &system_instruction::create_account(payer.key, config.key, lamports, HarvesterConfig::LEN as u64, program_id),
                &[payer.clone(), config.clone(), system.clone()],
                &[&[SEED_CONFIG, &[bump]]],
            )?;
            let cfg = HarvesterConfig {
                bump,
                authority_bump,
                holder_bps,
                scash_mint,
                quote_mint,
                team_treasury,
                vault_program,
                token_program,
                meteora_pool,
                graduated: false,
                total_claimed_base: 0,
                total_claimed_quote: 0,
                total_donated: 0,
                total_team: 0,
            };
            cfg.serialize(&mut &mut config.try_borrow_mut_data()?[..])?;
            msg!("harvester: initialized");
            Ok(())
        }

        HarvesterInstruction::Claim { max_base, max_quote } => {
            let it = &mut accounts.iter();
            let config = next_account_info(it)?;
            let authority = next_account_info(it)?;
            let meteora = next_account_info(it)?;
            let rest: Vec<AccountInfo> = it.cloned().collect();
            let mut cfg = load(config, program_id)?;
            check_authority(authority, program_id, cfg.authority_bump)?;
            let name = if cfg.graduated { "claim_position_fee" } else { "claim_creator_trading_fee" };
            if (cfg.graduated && *meteora.key != METEORA_DAMM_V2) || (!cfg.graduated && *meteora.key != METEORA_DBC) {
                return Err(ProgramError::IncorrectProgramId);
            }
            let mut data = anchor_discriminator(name).to_vec();
            if !cfg.graduated {
                data.extend_from_slice(&max_base.to_le_bytes());
                data.extend_from_slice(&max_quote.to_le_bytes());
            }
            cpi(meteora, &rest, data, &[&[SEED_AUTHORITY, &[cfg.authority_bump]]], authority.key)?;
            cfg.total_claimed_base = cfg.total_claimed_base.saturating_add(max_base);
            cfg.total_claimed_quote = cfg.total_claimed_quote.saturating_add(max_quote);
            cfg.serialize(&mut &mut config.try_borrow_mut_data()?[..])?;
            Ok(())
        }

        HarvesterInstruction::Swap { amount_in, min_out } => {
            let it = &mut accounts.iter();
            let config = next_account_info(it)?;
            let authority = next_account_info(it)?;
            let meteora = next_account_info(it)?;
            let rest: Vec<AccountInfo> = it.cloned().collect();
            let cfg = load(config, program_id)?;
            check_authority(authority, program_id, cfg.authority_bump)?;
            let expected = if cfg.graduated { METEORA_DAMM_V2 } else { METEORA_DBC };
            if *meteora.key != expected {
                return Err(ProgramError::IncorrectProgramId);
            }
            // Both programs expose `swap { amount_in, minimum_amount_out }`.
            let mut data = anchor_discriminator("swap").to_vec();
            data.extend_from_slice(&amount_in.to_le_bytes());
            data.extend_from_slice(&min_out.to_le_bytes());
            cpi(meteora, &rest, data, &[&[SEED_AUTHORITY, &[cfg.authority_bump]]], authority.key)
        }

        HarvesterInstruction::Distribute => {
            let it = &mut accounts.iter();
            let config = next_account_info(it)?;
            let authority = next_account_info(it)?;
            let harvester_ata = next_account_info(it)?;
            let team_ata = next_account_info(it)?;
            let scash_mint = next_account_info(it)?;
            let token_program = next_account_info(it)?;
            let vault_program = next_account_info(it)?;
            let pool = next_account_info(it)?;
            let vault_token = next_account_info(it)?;
            let system = next_account_info(it)?;
            let mut cfg = load(config, program_id)?;
            check_authority(authority, program_id, cfg.authority_bump)?;
            if *vault_program.key != cfg.vault_program || *scash_mint.key != cfg.scash_mint || *token_program.key != cfg.token_program {
                return Err(ProgramError::InvalidArgument);
            }
            let balance = token_amount(harvester_ata)?;
            if balance == 0 {
                return Ok(());
            }
            let decimals = mint_decimals(scash_mint)?;
            let holder = (balance as u128 * cfg.holder_bps as u128 / 10_000) as u64;
            let team = balance - holder;
            let seeds: &[&[u8]] = &[SEED_AUTHORITY, &[cfg.authority_bump]];

            if team > 0 {
                transfer_checked(token_program, harvester_ata, scash_mint, team_ata, authority, team, decimals, seeds)?;
            }
            if holder > 0 {
                // VaultInstruction::Donate { amount } = tag 3 + u64
                let mut data = vec![3u8];
                data.extend_from_slice(&holder.to_le_bytes());
                let ix = Instruction {
                    program_id: *vault_program.key,
                    accounts: vec![
                        AccountMeta::new(*authority.key, true),
                        AccountMeta::new(*harvester_ata.key, false),
                        AccountMeta::new(*pool.key, false),
                        AccountMeta::new(*vault_token.key, false),
                        AccountMeta::new_readonly(*scash_mint.key, false),
                        AccountMeta::new_readonly(*token_program.key, false),
                        AccountMeta::new_readonly(*system.key, false),
                    ],
                    data,
                };
                invoke_signed(
                    &ix,
                    &[authority.clone(), harvester_ata.clone(), pool.clone(), vault_token.clone(), scash_mint.clone(), token_program.clone(), system.clone(), vault_program.clone()],
                    &[seeds],
                )?;
            }
            cfg.total_donated = cfg.total_donated.saturating_add(holder);
            cfg.total_team = cfg.total_team.saturating_add(team);
            cfg.serialize(&mut &mut config.try_borrow_mut_data()?[..])?;
            msg!("harvester: donated {} to holders, {} to team", holder, team);
            Ok(())
        }

        HarvesterInstruction::MarkGraduated => {
            let it = &mut accounts.iter();
            let config = next_account_info(it)?;
            let dbc_pool = next_account_info(it)?;
            let damm_pool = next_account_info(it)?;
            let mut cfg = load(config, program_id)?;
            if cfg.graduated || *dbc_pool.key != cfg.meteora_pool || dbc_pool.owner != &METEORA_DBC || damm_pool.owner != &METEORA_DAMM_V2 {
                return Err(ProgramError::InvalidArgument);
            }
            // DBC VirtualPool: `is_migrated: u8` lives after the 8-byte discriminator
            // and the fee/metrics structs; we read it at the documented offset.
            let d = dbc_pool.try_borrow_data()?;
            const IS_MIGRATED_OFFSET: usize = 8 + 72 + 32 * 5 + 1 + 1 + 1;
            if d.len() <= IS_MIGRATED_OFFSET || d[IS_MIGRATED_OFFSET] == 0 {
                return Err(ProgramError::InvalidAccountData);
            }
            cfg.graduated = true;
            cfg.meteora_pool = *damm_pool.key;
            cfg.serialize(&mut &mut config.try_borrow_mut_data()?[..])?;
            Ok(())
        }
    }
}

fn load(config: &AccountInfo, program_id: &Pubkey) -> Result<HarvesterConfig, ProgramError> {
    if config.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    HarvesterConfig::try_from_slice(&config.try_borrow_data()?).map_err(|_| ProgramError::InvalidAccountData)
}

fn check_authority(authority: &AccountInfo, program_id: &Pubkey, bump: u8) -> ProgramResult {
    let expected = Pubkey::create_program_address(&[SEED_AUTHORITY, &[bump]], program_id)?;
    if expected != *authority.key {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

fn cpi<'a>(program: &AccountInfo<'a>, accounts: &[AccountInfo<'a>], data: Vec<u8>, seeds: &[&[&[u8]]], authority: &Pubkey) -> ProgramResult {
    let metas = accounts
        .iter()
        .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer || a.key == authority, is_writable: a.is_writable })
        .collect();
    let ix = Instruction { program_id: *program.key, accounts: metas, data };
    let mut infos = accounts.to_vec();
    infos.push(program.clone());
    invoke_signed(&ix, &infos, seeds)
}

fn token_amount(acc: &AccountInfo) -> Result<u64, ProgramError> {
    let d = acc.try_borrow_data()?;
    if d.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(d[64..72].try_into().unwrap()))
}

fn mint_decimals(mint: &AccountInfo) -> Result<u8, ProgramError> {
    let d = mint.try_borrow_data()?;
    if d.len() < 82 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(d[44])
}

#[allow(clippy::too_many_arguments)]
fn transfer_checked<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    seeds: &[&[u8]],
) -> ProgramResult {
    let mut data = vec![12u8];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    invoke_signed(&ix, &[source.clone(), mint.clone(), destination.clone(), authority.clone(), token_program.clone()], &[seeds])
}