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

/// Token-2022 mint extensions that would break the pool's accounting or let a
/// third party move or freeze pooled funds. `create_pool` refuses these mints.
///
/// * TransferFeeConfig (1): the vault receives less than the credited amount.
/// * DefaultAccountState (6): the vault ATA would be created frozen.
/// * NonTransferable (9): unshield could never move tokens out.
/// * PermanentDelegate (12): the mint authority can pull tokens out of the vault.
/// * TransferHook (14): transfers need extra accounts and run foreign code.
/// * Pausable (26): the mint authority can halt every unshield.
///
/// Everything else (metadata, confidential transfer, interest-bearing display,
/// close authority, memo-required, CPI guard, scaled UI amount) is harmless to
/// the pool. Note that a plain *freeze authority* on the base mint is not an
/// extension and is not rejected: USDC has one, and it is a documented risk.
const REJECTED_MINT_EXTENSIONS: [u16; 6] = [1, 6, 9, 12, 14, 26];

/// Walks the Token-2022 TLV extension list on a mint. Returns `None` if the
/// layout is malformed, `Some(true)` if an extension from
/// `REJECTED_MINT_EXTENSIONS` is present.
pub fn mint_has_rejected_extension(mint: &AccountInfo) -> Option<bool> {
    let d = mint.try_borrow_data().ok()?;
    mint_bytes_have_rejected_extension(&d)
}

pub fn mint_bytes_have_rejected_extension(d: &[u8]) -> Option<bool> {
    if d.len() <= 165 {
        // Base mint (82) or padded without extensions: nothing to reject.
        return Some(false);
    }
    // 165 bytes of base + padding, then the account type byte (1 = Mint).
    if d[165] != 1 {
        return None;
    }
    let mut off = 166;
    while off + 4 <= d.len() {
        let ty = u16::from_le_bytes([d[off], d[off + 1]]);
        let len = u16::from_le_bytes([d[off + 2], d[off + 3]]) as usize;
        if ty == 0 {
            break;
        }
        if REJECTED_MINT_EXTENSIONS.contains(&ty) {
            return Some(true);
        }
        off = off.checked_add(4 + len)?;
    }
    Some(false)
}

/// Token account balance at offset 64 (same for both token programs).
pub fn token_account_amount(acc: &AccountInfo) -> Option<u64> {
    let d = acc.try_borrow_data().ok()?;
    if d.len() < 165 {
        return None;
    }
    Some(u64::from_le_bytes(d[64..72].try_into().ok()?))
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
            // The authority signs either way: a user by its transaction
            // signature, a PDA through `invoke_signed`.
            AccountMeta::new_readonly(*authority.key, true),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn mint_with(exts: &[(u16, usize)]) -> Vec<u8> {
        let mut d = vec![0u8; 165];
        d.push(1); // account type: Mint
        for &(ty, len) in exts {
            d.extend_from_slice(&ty.to_le_bytes());
            d.extend_from_slice(&(len as u16).to_le_bytes());
            d.extend(std::iter::repeat_n(0xAA, len));
        }
        d
    }

    #[test]
    fn base_mints_and_harmless_extensions_pass() {
        assert_eq!(mint_bytes_have_rejected_extension(&[0u8; 82]), Some(false));
        // MetadataPointer(18) + TokenMetadata(19) + ConfidentialTransferMint(4)
        let d = mint_with(&[(18, 64), (19, 120), (4, 65)]);
        assert_eq!(mint_bytes_have_rejected_extension(&d), Some(false));
    }

    #[test]
    fn fee_hook_delegate_are_rejected_anywhere_in_the_list() {
        for ty in [1u16, 6, 9, 12, 14, 26] {
            let d = mint_with(&[(18, 64), (ty, 8), (19, 32)]);
            assert_eq!(mint_bytes_have_rejected_extension(&d), Some(true), "type {ty}");
        }
    }

    #[test]
    fn malformed_layouts_are_not_silently_accepted() {
        let mut d = mint_with(&[(18, 64)]);
        d[165] = 2; // account type: Account, not Mint
        assert_eq!(mint_bytes_have_rejected_extension(&d), None);
    }
}
