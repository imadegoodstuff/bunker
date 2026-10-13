//! Hand-rolled SPL Token / Token-2022 CPIs (same instruction layouts), plus
//! the Associated Token Account program. Avoids pulling the full spl crates.

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    pubkey::Pubkey,
};

pub const TOKEN_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_2022_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

pub fn is_token_program(id: &Pubkey) -> bool {
    *id == TOKEN_PROGRAM_ID || *id == TOKEN_2022_PROGRAM_ID
}

/// Mint account: decimals at offset 44 for both token programs.
pub fn mint_decimals(mint: &AccountInfo) -> Option<u8> {
    let d = mint.try_borrow_data().ok()?;
    if d.len() < 82 {
        return None;
    }
    Some(d[44])
}

/// Token account owner at offset 32, amount at 64.
pub fn token_account_owner(acc: &AccountInfo) -> Option<Pubkey> {
    let d = acc.try_borrow_data().ok()?;
    if d.len() < 165 {
        return None;
    }
    Some(Pubkey::new_from_array(d[32..64].try_into().ok()?))
}

pub fn token_account_mint(acc: &AccountInfo) -> Option<Pubkey> {
    let d = acc.try_borrow_data().ok()?;
    if d.len() < 165 {
        return None;
    }
    Some(Pubkey::new_from_array(d[0..32].try_into().ok()?))
}

pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey, token_program: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ASSOCIATED_TOKEN_PROGRAM_ID,
    )
    .0
}

/// TransferChecked (instruction 12).
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    let mut data = Vec::with_capacity(10);
    data.push(12u8);
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(decimals);
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*source.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new(*destination.key, false),
            AccountMeta::new_readonly(*authority.key, signer_seeds.is_empty()),
        ],
        data,
    };
    let infos = [source.clone(), mint.clone(), destination.clone(), authority.clone(), token_program.clone()];
    if signer_seeds.is_empty() {
        invoke(&ix, &infos)
    } else {
        invoke_signed(&ix, &infos, signer_seeds)
    }
}

/// Associated Token Account `CreateIdempotent` (instruction 1).
pub fn create_associated_token_account<'a>(
    ata_program: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    ata: &AccountInfo<'a>,
    owner: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
) -> ProgramResult {
    let ix = Instruction {
        program_id: ASSOCIATED_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*ata.key, false),
            AccountMeta::new_readonly(*owner.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*system_program.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: vec![1u8],
    };
    invoke(
        &ix,
        &[
            payer.clone(),
            ata.clone(),
            owner.clone(),
            mint.clone(),
            system_program.clone(),
            token_program.clone(),
            ata_program.clone(),
        ],
    )
}
