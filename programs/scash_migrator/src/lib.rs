//! scash migrator.
//!
//! The vault is immutable. When a new vault (new circuit, new proof system, or
//! a fix) is deployed, value has to move from the old one to the new one. The
//! naive route is unshield to a public wallet, then shield again, which puts
//! the funds under a user key in between and publishes that wallet. This
//! program removes the wallet from the path:
//!
//! ```text
//!   1. Stage     user writes the complete `transact` (shield) instruction for
//!                the NEW vault into a staging account: destination
//!                commitments, ciphertexts, proof. Nothing is spendable yet.
//!   2. Exit      user unshields from the OLD vault with
//!                recipient = PDA("migrate", staging). The recipient is bound
//!                inside the old proof via ext_data_hash, so the funds can
//!                only ever land at that PDA, and the PDA can only ever do
//!                what the staged instruction says.
//!   3. Execute   anyone (the relayer, the user, a stranger) calls Execute.
//!                The PDA signs the staged shield into the new vault; any
//!                leftover (rate moved, rent) goes to the staged refund key;
//!                staging is closed.
//! ```
//!
//! What this does and does not hide. The migration transaction pair reveals
//! that an unshield of amount X from the old pool funded a shield of amount X
//! into the new pool, exactly what a public shield reveals. It does not
//! reveal which old notes were spent (that is the old proof's job) nor the
//! owner of the new notes (that is the new proof's job), and no user-held
//! public key appears anywhere. Steps 2 and 3 are not atomic, but between
//! them the funds sit in a PDA whose only possible destination is the staged
//! shield, and Execute is permissionless, so nobody can strand them on
//! purpose and nobody can redirect them.
//!
//! The program does not parse the staged instruction. It forwards it to the
//! staged program id with the PDA as payer, depositor, recipient and relayer
//! destination. If the staged instruction is not a shield, the worst case is
//! that the PDA pays rent for nothing and the balance is refunded.

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction, system_program,
};
use thiserror::Error;

solana_program::declare_id!("42CGrJH6QGjHjH1CK9yQLF44UhrYjN9cQwGqVvrSYz4u");

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum MigratorError {
    #[error("invalid instruction data")]
    InvalidInstruction,
    #[error("staging account malformed or not initialised")]
    BadStaging,
    #[error("write out of bounds")]
    OutOfBounds,
    #[error("staging not fully written")]
    Incomplete,
    #[error("account does not match what was staged")]
    AccountMismatch,
    #[error("pda derivation mismatch")]
    BadPda,
}
impl From<MigratorError> for ProgramError {
    fn from(e: MigratorError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

pub mod seeds {
    pub const MIGRATE: &[u8] = b"migrate";
}

/// Staging layout:
/// `[disc u8 = 1][authority 32][target_program 32][refund 32][written u32][len u32][payload len bytes]`
pub struct Staging;
impl Staging {
    pub const DISC: u8 = 1;
    pub const OFF_AUTHORITY: usize = 1;
    pub const OFF_TARGET: usize = 33;
    pub const OFF_REFUND: usize = 65;
    pub const OFF_WRITTEN: usize = 97;
    pub const OFF_LEN: usize = 101;
    pub const HEADER: usize = 105;

    pub fn space(payload_len: usize) -> usize {
        Self::HEADER + payload_len
    }
    fn key(d: &[u8], off: usize) -> Pubkey {
        Pubkey::new_from_array(d[off..off + 32].try_into().unwrap())
    }
    fn u32_at(d: &[u8], off: usize) -> u32 {
        u32::from_le_bytes(d[off..off + 4].try_into().unwrap())
    }
    pub fn authority(d: &[u8]) -> Pubkey {
        Self::key(d, Self::OFF_AUTHORITY)
    }
    pub fn target(d: &[u8]) -> Pubkey {
        Self::key(d, Self::OFF_TARGET)
    }
    pub fn refund(d: &[u8]) -> Pubkey {
        Self::key(d, Self::OFF_REFUND)
    }
    pub fn written(d: &[u8]) -> u32 {
        Self::u32_at(d, Self::OFF_WRITTEN)
    }
    pub fn len(d: &[u8]) -> u32 {
        Self::u32_at(d, Self::OFF_LEN)
    }
    pub fn payload(d: &[u8]) -> &[u8] {
        let n = Self::len(d) as usize;
        &d[Self::HEADER..Self::HEADER + n]
    }
    pub fn check(d: &[u8]) -> Result<(), ProgramError> {
        if d.len() < Self::HEADER || d[0] != Self::DISC || d.len() < Self::HEADER + Self::len(d) as usize {
            return Err(MigratorError::BadStaging.into());
        }
        Ok(())
    }
}

/// The PDA that receives the old vault's unshield and signs the new shield.
pub fn migrate_pda(staging: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seeds::MIGRATE, staging.as_ref()], program_id)
}

pub enum MigratorInstruction {
    /// Initialise a staging account the caller created (owner = this program).
    /// Accounts: [staging w, authority s]
    /// Data: tag 0 || target_program 32 || refund 32 || payload_len u32
    Init { target: Pubkey, refund: Pubkey, len: u32 },
    /// Write a chunk of the staged instruction.
    /// Accounts: [staging w, authority s]
    /// Data: tag 1 || offset u32 || bytes
    Write { offset: u32 },
    /// Forward the staged instruction, signed by the PDA. Permissionless.
    /// Accounts:
    ///   [staging w, pda w, pda_source w, refund w, refund_source w,
    ///    target_program, system_program, token_program,
    ///    ...target accounts in the order the target expects after its first
    ///       (payer) account, with the PDA substituted wherever the target
    ///       expects depositor / recipient / relayer destination]
    /// Data: tag 2 || n_pda_slots u8 || slot indices (positions in the target
    ///       account list, excluding payer, that must be the PDA) || n_source_slots u8 || indices that must be pda_source
    Execute,
}

impl MigratorInstruction {
    fn unpack(d: &[u8]) -> Result<(Self, &[u8]), ProgramError> {
        let (&tag, rest) = d.split_first().ok_or(MigratorError::InvalidInstruction)?;
        match tag {
            0 => {
                if rest.len() != 68 {
                    return Err(MigratorError::InvalidInstruction.into());
                }
                Ok((
                    Self::Init {
                        target: Pubkey::new_from_array(rest[0..32].try_into().unwrap()),
                        refund: Pubkey::new_from_array(rest[32..64].try_into().unwrap()),
                        len: u32::from_le_bytes(rest[64..68].try_into().unwrap()),
                    },
                    &[],
                ))
            }
            1 => {
                if rest.len() < 4 {
                    return Err(MigratorError::InvalidInstruction.into());
                }
                Ok((Self::Write { offset: u32::from_le_bytes(rest[0..4].try_into().unwrap()) }, &rest[4..]))
            }
            2 => Ok((Self::Execute, rest)),
            _ => Err(MigratorError::InvalidInstruction.into()),
        }
    }
}

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (ix, rest) = MigratorInstruction::unpack(data)?;
    match ix {
        MigratorInstruction::Init { target, refund, len } => process_init(program_id, accounts, target, refund, len),
        MigratorInstruction::Write { offset } => process_write(program_id, accounts, offset, rest),
        MigratorInstruction::Execute => process_execute(program_id, accounts, rest),
    }
}

fn process_init(program_id: &Pubkey, accounts: &[AccountInfo], target: Pubkey, refund: Pubkey, len: u32) -> ProgramResult {
    let it = &mut accounts.iter();
    let staging = next_account_info(it)?;
    let authority = next_account_info(it)?;
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if staging.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut d = staging.try_borrow_mut_data()?;
    if d[0] != 0 {
        return Err(MigratorError::BadStaging.into());
    }
    if d.len() < Staging::space(len as usize) {
        return Err(MigratorError::OutOfBounds.into());
    }
    d[0] = Staging::DISC;
    d[Staging::OFF_AUTHORITY..Staging::OFF_AUTHORITY + 32].copy_from_slice(authority.key.as_ref());
    d[Staging::OFF_TARGET..Staging::OFF_TARGET + 32].copy_from_slice(target.as_ref());
    d[Staging::OFF_REFUND..Staging::OFF_REFUND + 32].copy_from_slice(refund.as_ref());
    d[Staging::OFF_WRITTEN..Staging::OFF_WRITTEN + 4].copy_from_slice(&0u32.to_le_bytes());
    d[Staging::OFF_LEN..Staging::OFF_LEN + 4].copy_from_slice(&len.to_le_bytes());
    msg!("scash-migrator: staged {} bytes for {}", len, target);
    Ok(())
}

fn process_write(program_id: &Pubkey, accounts: &[AccountInfo], offset: u32, bytes: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let staging = next_account_info(it)?;
    let authority = next_account_info(it)?;
    if !authority.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if staging.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mut d = staging.try_borrow_mut_data()?;
    Staging::check(&d)?;
    if Staging::authority(&d) != *authority.key {
        return Err(MigratorError::AccountMismatch.into());
    }
    let len = Staging::len(&d) as usize;
    let off = offset as usize;
    let end = off.checked_add(bytes.len()).ok_or(MigratorError::OutOfBounds)?;
    if end > len {
        return Err(MigratorError::OutOfBounds.into());
    }
    d[Staging::HEADER + off..Staging::HEADER + end].copy_from_slice(bytes);
    // `written` is a high-water mark; the client writes sequentially.
    let written = Staging::written(&d).max(end as u32);
    d[Staging::OFF_WRITTEN..Staging::OFF_WRITTEN + 4].copy_from_slice(&written.to_le_bytes());
    Ok(())
}

fn process_execute(program_id: &Pubkey, accounts: &[AccountInfo], slots: &[u8]) -> ProgramResult {
    let it = &mut accounts.iter();
    let staging = next_account_info(it)?;
    let pda = next_account_info(it)?;
    let pda_source = next_account_info(it)?;
    let refund = next_account_info(it)?;
    let refund_source = next_account_info(it)?;
    let target_program = next_account_info(it)?;
    let system = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let target_accounts: Vec<AccountInfo> = it.cloned().collect();

    if staging.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (expected_pda, bump) = migrate_pda(staging.key, program_id);
    if expected_pda != *pda.key {
        return Err(MigratorError::BadPda.into());
    }
    if *system.key != system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    // ---- read and validate staging
    let (target, refund_key, payload) = {
        let d = staging.try_borrow_data()?;
        Staging::check(&d)?;
        if Staging::written(&d) != Staging::len(&d) {
            return Err(MigratorError::Incomplete.into());
        }
        (Staging::target(&d), Staging::refund(&d), Staging::payload(&d).to_vec())
    };
    if target != *target_program.key || refund_key != *refund.key {
        return Err(MigratorError::AccountMismatch.into());
    }

    // ---- which target slots must be the PDA / the PDA's token account
    let (pda_slots, source_slots) = parse_slots(slots)?;
    for &s in &pda_slots {
        if target_accounts.get(s as usize).map(|a| a.key) != Some(pda.key) {
            return Err(MigratorError::AccountMismatch.into());
        }
    }
    for &s in &source_slots {
        if target_accounts.get(s as usize).map(|a| a.key) != Some(pda_source.key) {
            return Err(MigratorError::AccountMismatch.into());
        }
    }

    // ---- forward: payer = PDA (signer), then the staged account list
    let mut metas = Vec::with_capacity(1 + target_accounts.len());
    metas.push(AccountMeta::new(*pda.key, true));
    for (i, a) in target_accounts.iter().enumerate() {
        let is_pda = pda_slots.contains(&(i as u8));
        metas.push(AccountMeta { pubkey: *a.key, is_signer: is_pda, is_writable: a.is_writable });
    }
    let mut infos: Vec<AccountInfo> = Vec::with_capacity(2 + target_accounts.len());
    infos.push(pda.clone());
    infos.extend(target_accounts.iter().cloned());
    infos.push(target_program.clone());
    let pda_seeds: &[&[u8]] = &[seeds::MIGRATE, staging.key.as_ref(), &[bump]];
    invoke_signed(&Instruction { program_id: target, accounts: metas, data: payload }, &infos, &[pda_seeds])?;

    // ---- refund leftovers and close staging
    if *token_program.key != system_program::ID && pda_source.key != pda.key {
        // SPL: whatever is left in the PDA's token account goes to refund_source
        let left = token_amount(pda_source).ok_or(MigratorError::AccountMismatch)?;
        if left > 0 {
            let ix = Instruction {
                program_id: *token_program.key,
                accounts: vec![
                    AccountMeta::new(*pda_source.key, false),
                    AccountMeta::new(*refund_source.key, false),
                    AccountMeta::new_readonly(*pda.key, true),
                ],
                data: {
                    let mut d = vec![3u8]; // Transfer
                    d.extend_from_slice(&left.to_le_bytes());
                    d
                },
            };
            invoke_signed(&ix, &[pda_source.clone(), refund_source.clone(), pda.clone(), token_program.clone()], &[pda_seeds])?;
        }
    }
    let left = pda.lamports();
    if left > 0 {
        invoke_signed(&system_instruction::transfer(pda.key, refund.key, left), &[pda.clone(), refund.clone(), system.clone()], &[pda_seeds])?;
    }
    // close staging: move its rent to refund
    let staging_lamports = staging.lamports();
    **staging.try_borrow_mut_lamports()? = 0;
    **refund.try_borrow_mut_lamports()? = refund.lamports().checked_add(staging_lamports).ok_or(ProgramError::ArithmeticOverflow)?;
    staging.try_borrow_mut_data()?.fill(0);
    staging.assign(&system_program::ID);
    msg!("scash-migrator: executed");
    Ok(())
}

fn parse_slots(d: &[u8]) -> Result<(Vec<u8>, Vec<u8>), ProgramError> {
    let (&n, rest) = d.split_first().ok_or(MigratorError::InvalidInstruction)?;
    if rest.len() < n as usize {
        return Err(MigratorError::InvalidInstruction.into());
    }
    let (pda_slots, rest) = rest.split_at(n as usize);
    let (&m, rest) = rest.split_first().ok_or(MigratorError::InvalidInstruction)?;
    if rest.len() != m as usize {
        return Err(MigratorError::InvalidInstruction.into());
    }
    Ok((pda_slots.to_vec(), rest.to_vec()))
}

fn token_amount(acc: &AccountInfo) -> Option<u64> {
    let d = acc.try_borrow_data().ok()?;
    if d.len() < 165 {
        return None;
    }
    Some(u64::from_le_bytes(d[64..72].try_into().ok()?))
}

#[cfg(not(feature = "no-entrypoint"))]
mod entrypoint {
    use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, pubkey::Pubkey};
    entrypoint!(process_instruction);
    fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
        crate::process(program_id, accounts, data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_layout_round_trips() {
        let payload = vec![7u8; 300];
        let mut d = vec![0u8; Staging::space(payload.len())];
        d[0] = Staging::DISC;
        d[Staging::OFF_LEN..Staging::OFF_LEN + 4].copy_from_slice(&(payload.len() as u32).to_le_bytes());
        d[Staging::HEADER..].copy_from_slice(&payload);
        Staging::check(&d).unwrap();
        assert_eq!(Staging::payload(&d), &payload[..]);
        assert_eq!(Staging::written(&d), 0);
    }

    #[test]
    fn slots_parse() {
        let (p, s) = parse_slots(&[3, 7, 9, 10, 1, 8]).unwrap();
        assert_eq!(p, vec![7, 9, 10]);
        assert_eq!(s, vec![8]);
        assert!(parse_slots(&[2, 1]).is_err());
    }

    #[test]
    fn pda_is_unique_per_staging() {
        let a = migrate_pda(&Pubkey::new_unique(), &id()).0;
        let b = migrate_pda(&Pubkey::new_unique(), &id()).0;
        assert_ne!(a, b);
    }
}
