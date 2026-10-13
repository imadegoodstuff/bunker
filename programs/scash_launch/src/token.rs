//! Hand-rolled Token-2022 and Associated Token Account CPIs (no spl crates).

use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    pubkey::Pubkey,
};

pub const TOKEN_2022_PROGRAM_ID: Pubkey = solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const ASSOCIATED_TOKEN_PROGRAM_ID: Pubkey = solana_program::pubkey!("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/// Mint with one MetadataPointer extension: 165 base+padding, 1 account type, TLV 4 + 64.
pub const MINT_SPACE_WITH_POINTER: usize = 234;
/// Token-2022 token account (no extensions).
pub const TOKEN_ACCOUNT_LEN: usize = 165;

/// Bytes the TokenMetadata TLV adds once initialised: header 4 + update_authority 32 + mint 32
/// + three length-prefixed strings + empty additional_metadata vec (4).
pub fn metadata_tlv_len(name: usize, symbol: usize, uri: usize) -> usize {
    4 + 32 + 32 + (4 + name) + (4 + symbol) + (4 + uri) + 4
}

pub fn associated_token_address(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[owner.as_ref(), TOKEN_2022_PROGRAM_ID.as_ref(), mint.as_ref()], &ASSOCIATED_TOKEN_PROGRAM_ID).0
}

pub fn token_account_amount(acc: &AccountInfo) -> Option<u64> {
    let d = acc.try_borrow_data().ok()?;
    if d.len() < TOKEN_ACCOUNT_LEN {
        return None;
    }
    Some(u64::from_le_bytes(d[64..72].try_into().ok()?))
}

fn run(ix: &Instruction, infos: &[AccountInfo], seeds: &[&[&[u8]]]) -> ProgramResult {
    if seeds.is_empty() {
        invoke(ix, infos)
    } else {
        invoke_signed(ix, infos, seeds)
    }
}

/// MetadataPointerExtension(39) :: Initialize(0) { authority, metadata_address }.
pub fn initialize_metadata_pointer<'a>(token_program: &AccountInfo<'a>, mint: &AccountInfo<'a>, authority: &Pubkey) -> ProgramResult {
    let mut data = vec![39u8, 0u8];
    data.extend_from_slice(authority.as_ref());
    data.extend_from_slice(mint.key.as_ref()); // metadata lives on the mint itself
    let ix = Instruction { program_id: *token_program.key, accounts: vec![AccountMeta::new(*mint.key, false)], data };
    invoke(&ix, &[mint.clone(), token_program.clone()])
}

/// InitializeMint2(20) with no freeze authority.
pub fn initialize_mint2<'a>(token_program: &AccountInfo<'a>, mint: &AccountInfo<'a>, decimals: u8, mint_authority: &Pubkey) -> ProgramResult {
    let mut data = vec![20u8, decimals];
    data.extend_from_slice(mint_authority.as_ref());
    data.push(0); // COption::None freeze authority
    let ix = Instruction { program_id: *token_program.key, accounts: vec![AccountMeta::new(*mint.key, false)], data };
    invoke(&ix, &[mint.clone(), token_program.clone()])
}

/// spl_token_metadata_interface Initialize { name, symbol, uri }; the mint is its own metadata account.
pub fn initialize_token_metadata<'a>(
    token_program: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    name: &str,
    symbol: &str,
    uri: &str,
    seeds: &[&[&[u8]]],
) -> ProgramResult {
    // sha256("spl_token_metadata_interface:initialize_account")[..8]
    let mut data = vec![0xd2, 0xe1, 0x1e, 0xa2, 0x58, 0xb8, 0x4d, 0x8d];
    for s in [name, symbol, uri] {
        data.extend_from_slice(&(s.len() as u32).to_le_bytes());
        data.extend_from_slice(s.as_bytes());
    }
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![
            AccountMeta::new(*mint.key, false),
            AccountMeta::new_readonly(*authority.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*authority.key, true),
        ],
        data,
    };
    run(&ix, &[mint.clone(), authority.clone(), token_program.clone()], seeds)
}

/// MintTo(7).
pub fn mint_to<'a>(token_program: &AccountInfo<'a>, mint: &AccountInfo<'a>, dest: &AccountInfo<'a>, authority: &AccountInfo<'a>, amount: u64, seeds: &[&[&[u8]]]) -> ProgramResult {
    let mut data = vec![7u8];
    data.extend_from_slice(&amount.to_le_bytes());
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![AccountMeta::new(*mint.key, false), AccountMeta::new(*dest.key, false), AccountMeta::new_readonly(*authority.key, true)],
        data,
    };
    run(&ix, &[mint.clone(), dest.clone(), authority.clone(), token_program.clone()], seeds)
}

/// SetAuthority(6) MintTokens(0) → None: the supply is fixed forever.
pub fn revoke_mint_authority<'a>(token_program: &AccountInfo<'a>, mint: &AccountInfo<'a>, authority: &AccountInfo<'a>, seeds: &[&[&[u8]]]) -> ProgramResult {
    let data = vec![6u8, 0u8, 0u8];
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![AccountMeta::new(*mint.key, false), AccountMeta::new_readonly(*authority.key, true)],
        data,
    };
    run(&ix, &[mint.clone(), authority.clone(), token_program.clone()], seeds)
}

/// TransferChecked(12).
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked<'a>(
    token_program: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    seeds: &[&[&[u8]]],
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
    run(&ix, &[source.clone(), mint.clone(), destination.clone(), authority.clone(), token_program.clone()], seeds)
}

/// CloseAccount(9): rent to `dest`.
pub fn close_account<'a>(token_program: &AccountInfo<'a>, account: &AccountInfo<'a>, dest: &AccountInfo<'a>, owner: &AccountInfo<'a>, seeds: &[&[&[u8]]]) -> ProgramResult {
    let ix = Instruction {
        program_id: *token_program.key,
        accounts: vec![AccountMeta::new(*account.key, false), AccountMeta::new(*dest.key, false), AccountMeta::new_readonly(*owner.key, true)],
        data: vec![9u8],
    };
    run(&ix, &[account.clone(), dest.clone(), owner.clone(), token_program.clone()], seeds)
}

/// Associated Token Account CreateIdempotent(1).
pub fn create_ata_idempotent<'a>(
    ata_program: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    ata: &AccountInfo<'a>,
    owner: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    system: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
) -> ProgramResult {
    let ix = Instruction {
        program_id: *ata_program.key,
        accounts: vec![
            AccountMeta::new(*payer.key, true),
            AccountMeta::new(*ata.key, false),
            AccountMeta::new_readonly(*owner.key, false),
            AccountMeta::new_readonly(*mint.key, false),
            AccountMeta::new_readonly(*system.key, false),
            AccountMeta::new_readonly(*token_program.key, false),
        ],
        data: vec![1u8],
    };
    invoke(&ix, &[payer.clone(), ata.clone(), owner.clone(), mint.clone(), system.clone(), token_program.clone(), ata_program.clone()])
}
