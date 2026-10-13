use crate::{
    curve,
    seeds,
    state::{Curve, Launchpad, DISC_CURVE, DISC_LAUNCHPAD},
    token, LaunchError,
};
use borsh::{BorshDeserialize, BorshSerialize};
use scash_core::VaultInstruction;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    instruction::{get_stack_height, AccountMeta, Instruction, TRANSACTION_LEVEL_STACK_HEIGHT},
    log::sol_log_data,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::{instructions as ix_sysvar, Sysvar},
};

/// Bytes the vault prepends to `exit_data` when it calls an exit target.
const EXIT_AMOUNT_PREFIX: usize = 8;
/// `exit_data` layout: kind u8 || claim_key 32 || claim_budget u64 || min_out u64 || relayer_tip u64.
/// `relayer_tip` is paid from the SOL leg to the exit call's `payer` (the
/// relayer), which is how a relayed *sell* pays its relayer: the vault's own
/// fee would be in the token being sold, which no relayer prices.
pub const EXIT_DATA_LEN: usize = 1 + 32 + 8 + 8 + 8;
pub const ADDRESS_LOOKUP_TABLE_PROGRAM_ID: Pubkey = solana_program::pubkey!("AddressLookupTab1e1111111111111111111111111");
pub const EXIT_BUY: u8 = 0;
pub const EXIT_SELL: u8 = 1;
/// Nullifier PDAs the claim key's shield will create (dummy inputs included).
const CLAIM_NULLIFIERS: u64 = 2;
pub const MAX_NAME: usize = 32;
pub const MAX_SYMBOL: usize = 10;
pub const MAX_URI: usize = 200;

#[derive(BorshSerialize, BorshDeserialize)]
pub struct InitLaunchpadArgs {
    pub protocol_treasury: Pubkey,
    pub trade_fee_bps: u16,
    pub holder_share_bps: u16,
    pub virtual_sol: u64,
    pub virtual_token: u64,
    pub curve_supply: u64,
    pub total_supply: u64,
    pub graduation_lamports: u64,
    pub decimals: u8,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct LaunchArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct SwapArgs {
    pub amount_in: u64,
    pub min_out: u64,
}

/// Instruction tags (first byte). Exit calls from the vault carry no tag: they
/// are recognised by stack height, see `process`.
pub const IX_INIT_LAUNCHPAD: u8 = 0;
pub const IX_LAUNCH: u8 = 1;
pub const IX_HARVEST: u8 = 3;
pub const IX_GRADUATE: u8 = 4;
pub const IX_PUBLIC_BUY: u8 = 5;
pub const IX_PUBLIC_SELL: u8 = 6;

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    // The vault's exit call is the only way this program is ever invoked by
    // CPI; everything else is a top-level instruction. The vault prepends the
    // delivered amount, so the data cannot carry a tag byte.
    if get_stack_height() > TRANSACTION_LEVEL_STACK_HEIGHT {
        return process_exit(program_id, accounts, data);
    }
    let (&tag, rest) = data.split_first().ok_or(LaunchError::InvalidInstruction)?;
    match tag {
        IX_INIT_LAUNCHPAD => process_init_launchpad(program_id, accounts, InitLaunchpadArgs::try_from_slice(rest).map_err(|_| LaunchError::InvalidInstruction)?),
        IX_LAUNCH => process_launch(program_id, accounts, LaunchArgs::try_from_slice(rest).map_err(|_| LaunchError::InvalidInstruction)?),
        IX_HARVEST => process_harvest(program_id, accounts),
        IX_GRADUATE => process_graduate(program_id, accounts),
        IX_PUBLIC_BUY => process_public_buy(program_id, accounts, SwapArgs::try_from_slice(rest).map_err(|_| LaunchError::InvalidInstruction)?),
        IX_PUBLIC_SELL => process_public_sell(program_id, accounts, SwapArgs::try_from_slice(rest).map_err(|_| LaunchError::InvalidInstruction)?),
        _ => Err(LaunchError::InvalidInstruction.into()),
    }
}

// ------------------------------------------------------------------ helpers

pub fn launchpad_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seeds::LAUNCHPAD], program_id)
}
pub fn curve_pda(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seeds::CURVE, mint.as_ref()], program_id)
}
pub fn intake_pda(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seeds::INTAKE, mint.as_ref()], program_id)
}
fn expect_key(a: &AccountInfo, k: &Pubkey) -> ProgramResult {
    if a.key != k {
        return Err(LaunchError::AccountMismatch.into());
    }
    Ok(())
}
fn expect_signer(a: &AccountInfo) -> ProgramResult {
    if !a.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

fn load_curve(curve: &AccountInfo, program_id: &Pubkey) -> Result<Curve, ProgramError> {
    if curve.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    Curve::load(&curve.try_borrow_data()?)
}

/// Lamports held by a program-owned account that may be moved without the system program.
fn debit<'a>(from: &AccountInfo<'a>, to: &AccountInfo<'a>, lamports: u64) -> ProgramResult {
    let f = from.lamports().checked_sub(lamports).ok_or(LaunchError::Overflow)?;
    let t = to.lamports().checked_add(lamports).ok_or(LaunchError::Overflow)?;
    **from.try_borrow_mut_lamports()? = f;
    **to.try_borrow_mut_lamports()? = t;
    Ok(())
}

/// The curve account must always hold rent + real_sol + fees_accrued.
fn check_curve_balance(curve: &AccountInfo, c: &Curve) -> ProgramResult {
    let need = Rent::get()?
        .minimum_balance(Curve::LEN)
        .checked_add(c.real_sol)
        .and_then(|x| x.checked_add(c.fees_accrued))
        .ok_or(LaunchError::Overflow)?;
    if curve.lamports() < need {
        return Err(LaunchError::InsufficientReserve.into());
    }
    Ok(())
}

fn pool_total_shares(pool: &AccountInfo, vault_program: &Pubkey) -> Result<u64, ProgramError> {
    if pool.owner != vault_program {
        return Err(LaunchError::AccountMismatch.into());
    }
    let d = pool.try_borrow_data()?;
    if d.len() < 144 || d[0] != 3 {
        return Err(LaunchError::AccountMismatch.into());
    }
    Ok(u64::from_le_bytes(d[104..112].try_into().unwrap()))
}

fn graduate_if_due(c: &mut Curve) {
    if c.graduated == 0 && c.should_graduate() {
        c.graduated = 1;
        sol_log_data(&[b"graduate", c.mint.as_ref(), &c.real_sol.to_le_bytes(), &c.real_token.to_le_bytes()]);
    }
}

// ----------------------------------------------------------- init launchpad

fn process_init_launchpad(program_id: &Pubkey, accounts: &[AccountInfo], a: InitLaunchpadArgs) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let launchpad = next_account_info(it)?;
    let vault_program = next_account_info(it)?;
    let system = next_account_info(it)?;
    expect_signer(payer)?;
    if !launchpad.data_is_empty() {
        return Err(LaunchError::AlreadyInitialized.into());
    }
    if !vault_program.executable {
        return Err(LaunchError::AccountMismatch.into());
    }
    let (addr, bump) = launchpad_pda(program_id);
    expect_key(launchpad, &addr)?;
    let state = Launchpad {
        disc: DISC_LAUNCHPAD,
        bump,
        vault_program: *vault_program.key,
        protocol_treasury: a.protocol_treasury,
        trade_fee_bps: a.trade_fee_bps,
        holder_share_bps: a.holder_share_bps,
        virtual_sol: a.virtual_sol,
        virtual_token: a.virtual_token,
        curve_supply: a.curve_supply,
        total_supply: a.total_supply,
        graduation_lamports: a.graduation_lamports,
        decimals: a.decimals,
    };
    state.validate()?;
    let rent = Rent::get()?.minimum_balance(Launchpad::LEN);
    invoke_signed(
        &system_instruction::create_account(payer.key, launchpad.key, rent, Launchpad::LEN as u64, program_id),
        &[payer.clone(), launchpad.clone(), system.clone()],
        &[&[seeds::LAUNCHPAD, &[bump]]],
    )?;
    let mut d = launchpad.try_borrow_mut_data()?;
    let mut w = &mut d[..];
    state.serialize(&mut w).map_err(|_| ProgramError::AccountDataTooSmall)?;
    msg!("scash-launch: launchpad initialised");
    Ok(())
}

// ------------------------------------------------------------------- launch

fn process_launch(program_id: &Pubkey, accounts: &[AccountInfo], a: LaunchArgs) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let launchpad = next_account_info(it)?;
    let curve = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_vault = next_account_info(it)?;
    let intake = next_account_info(it)?;
    let intake_ata = next_account_info(it)?;
    let vault_config = next_account_info(it)?;
    let vault_pool = next_account_info(it)?;
    let vault_pool_ata = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let system = next_account_info(it)?;
    let vault_program = next_account_info(it)?;
    let lookup_table = next_account_info(it)?;

    expect_signer(payer)?;
    expect_signer(mint)?; // a fresh keypair: the mint address is unpredictable and unique
    if *lookup_table.owner != ADDRESS_LOOKUP_TABLE_PROGRAM_ID {
        return Err(LaunchError::AccountMismatch.into());
    }
    if launchpad.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let lp = Launchpad::load(&launchpad.try_borrow_data()?)?;
    expect_key(vault_program, &lp.vault_program)?;
    expect_key(token_program, &token::TOKEN_2022_PROGRAM_ID)?;
    expect_key(ata_program, &token::ASSOCIATED_TOKEN_PROGRAM_ID)?;
    expect_key(system, &system_program::ID)?;
    if a.name.len() > MAX_NAME || a.symbol.len() > MAX_SYMBOL || a.uri.len() > MAX_URI {
        return Err(LaunchError::StringTooLong.into());
    }
    if !mint.data_is_empty() || !curve.data_is_empty() {
        return Err(LaunchError::AlreadyInitialized.into());
    }
    let (curve_addr, curve_bump) = curve_pda(mint.key, program_id);
    expect_key(curve, &curve_addr)?;
    let (intake_addr, intake_bump) = intake_pda(mint.key, program_id);
    expect_key(intake, &intake_addr)?;
    expect_key(curve_vault, &token::associated_token_address(curve.key, mint.key))?;
    expect_key(intake_ata, &token::associated_token_address(intake.key, mint.key))?;
    let curve_seeds: &[&[u8]] = &[seeds::CURVE, mint.key.as_ref(), &[curve_bump]];
    let rent = Rent::get()?;

    // ---- 1. mint: metadata pointer + metadata on the mint, no freeze authority, authority = curve
    let final_len = token::MINT_SPACE_WITH_POINTER + token::metadata_tlv_len(a.name.len(), a.symbol.len(), a.uri.len());
    invoke(
        &system_instruction::create_account(payer.key, mint.key, rent.minimum_balance(final_len), token::MINT_SPACE_WITH_POINTER as u64, token_program.key),
        &[payer.clone(), mint.clone(), system.clone()],
    )?;
    token::initialize_metadata_pointer(token_program, mint, curve.key)?;
    token::initialize_mint2(token_program, mint, lp.decimals, curve.key)?;
    token::initialize_token_metadata(token_program, mint, curve, &a.name, &a.symbol, &a.uri, &[curve_seeds])?;

    // ---- 2. curve's token vault, full supply minted into it, mint authority gone
    token::create_ata_idempotent(ata_program, payer, curve_vault, curve, mint, system, token_program)?;
    token::mint_to(token_program, mint, curve_vault, curve, lp.total_supply, &[curve_seeds])?;
    token::revoke_mint_authority(token_program, mint, curve, &[curve_seeds])?;

    // ---- 3. intake: where the vault delivers SOL (the PDA itself) and tokens (its ATA)
    let intake_rent = rent.minimum_balance(0);
    if intake.lamports() < intake_rent {
        invoke(&system_instruction::transfer(payer.key, intake.key, intake_rent - intake.lamports()), &[payer.clone(), intake.clone(), system.clone()])?;
    }
    token::create_ata_idempotent(ata_program, payer, intake_ata, intake, mint, system, token_program)?;

    // ---- 4. the token's shielded pool, in the same transaction as the mint
    let create_pool = VaultInstruction::CreatePool { tvl_cap: u64::MAX };
    invoke(
        &Instruction {
            program_id: lp.vault_program,
            accounts: vec![
                AccountMeta::new(*payer.key, true),
                AccountMeta::new_readonly(*vault_config.key, false),
                AccountMeta::new(*vault_pool.key, false),
                AccountMeta::new(*vault_pool_ata.key, false),
                AccountMeta::new_readonly(*mint.key, false),
                AccountMeta::new_readonly(*token_program.key, false),
                AccountMeta::new_readonly(*system.key, false),
                AccountMeta::new_readonly(*ata_program.key, false),
            ],
            data: borsh::to_vec(&create_pool).map_err(|_| LaunchError::InvalidInstruction)?,
        },
        &[
            payer.clone(),
            vault_config.clone(),
            vault_pool.clone(),
            vault_pool_ata.clone(),
            mint.clone(),
            token_program.clone(),
            system.clone(),
            ata_program.clone(),
            vault_program.clone(),
        ],
    )?;

    // ---- 5. curve state
    invoke_signed(
        &system_instruction::create_account(payer.key, curve.key, rent.minimum_balance(Curve::LEN), Curve::LEN as u64, program_id),
        &[payer.clone(), curve.clone(), system.clone()],
        &[curve_seeds],
    )?;
    let c = Curve {
        disc: DISC_CURVE,
        bump: curve_bump,
        intake_bump,
        mint: *mint.key,
        token_vault: *curve_vault.key,
        virtual_sol: lp.virtual_sol,
        virtual_token: lp.virtual_token,
        real_sol: 0,
        real_token: lp.curve_supply,
        fees_accrued: 0,
        graduated: 0,
        created_slot: Clock::get()?.slot,
        total_supply: lp.total_supply,
        curve_supply: lp.curve_supply,
        trade_fee_bps: lp.trade_fee_bps,
        holder_share_bps: lp.holder_share_bps,
        graduation_lamports: lp.graduation_lamports,
        protocol_treasury: lp.protocol_treasury,
        vault_program: lp.vault_program,
        buys: 0,
        sells: 0,
        sol_volume: 0,
        lookup_table: *lookup_table.key,
    };
    c.store(&mut curve.try_borrow_mut_data()?)?;
    sol_log_data(&[
        b"launch",
        mint.key.as_ref(),
        a.name.as_bytes(),
        a.symbol.as_bytes(),
        a.uri.as_bytes(),
        &lp.virtual_sol.to_le_bytes(),
        &lp.virtual_token.to_le_bytes(),
        &lp.curve_supply.to_le_bytes(),
        &lp.total_supply.to_le_bytes(),
        &lp.graduation_lamports.to_le_bytes(),
        &[lp.decimals],
    ]);
    msg!("scash-launch: {} launched", a.symbol);
    Ok(())
}

// ---------------------------------------------------- exit call (from vault)

/// Called by the vault inside a `transact`, after it moved the unshielded
/// amount to `recipient`. Accounts are the ones the prover appended after the
/// nullifier PDAs:
/// `[curve w, mint, curve_vault w, intake w, intake_ata w, claim w, claim_ata w,
///   payer s w, token_2022, ata_program, system, instructions sysvar, (this program)]`
///
/// `claim` is the buyer's throwaway claim key (a system account, usually not
/// yet existing). A buy leaves the tokens in its ATA and `claim_budget` plus
/// the rents its shield will need in lamports; a sell leaves the SOL. The
/// claim key then signs an ordinary vault shield, so nothing here can hold
/// the funds hostage and no second program is on the path.
fn process_exit(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != EXIT_AMOUNT_PREFIX + EXIT_DATA_LEN {
        return Err(LaunchError::InvalidInstruction.into());
    }
    let delivered = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let kind = data[8];
    let claim_key = Pubkey::new_from_array(data[9..41].try_into().unwrap());
    let claim_budget = u64::from_le_bytes(data[41..49].try_into().unwrap());
    let min_out = u64::from_le_bytes(data[49..57].try_into().unwrap());
    let relayer_tip = u64::from_le_bytes(data[57..65].try_into().unwrap());

    let it = &mut accounts.iter();
    let curve = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_vault = next_account_info(it)?;
    let intake = next_account_info(it)?;
    let intake_ata = next_account_info(it)?;
    let claim = next_account_info(it)?;
    let claim_ata = next_account_info(it)?;
    let payer = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let system = next_account_info(it)?;
    let sysvar = next_account_info(it)?;

    let mut c = load_curve(curve, program_id)?;
    expect_key(mint, &c.mint)?;
    expect_key(curve_vault, &c.token_vault)?;
    expect_key(token_program, &token::TOKEN_2022_PROGRAM_ID)?;
    expect_key(ata_program, &token::ASSOCIATED_TOKEN_PROGRAM_ID)?;
    expect_key(system, &system_program::ID)?;
    expect_key(sysvar, &ix_sysvar::ID)?;
    let (intake_addr, _) = intake_pda(mint.key, program_id);
    expect_key(intake, &intake_addr)?;
    expect_key(intake_ata, &token::associated_token_address(intake.key, mint.key))?;
    expect_key(claim, &claim_key)?;
    // The claim key must be a plain wallet-style account (no data, system-owned),
    // otherwise a shield from it could never pay for itself.
    if !claim.data_is_empty() || (*claim.owner != system_program::ID && claim.lamports() > 0) {
        return Err(LaunchError::BadClaimAccount.into());
    }
    expect_signer(payer)?;

    // Only the vault may route trades here before graduation: the top-level
    // instruction of this transaction must be the vault program's.
    let top = ix_sysvar::load_current_index_checked(sysvar)?;
    let top_ix = ix_sysvar::load_instruction_at_checked(top as usize, sysvar)?;
    if top_ix.program_id != c.vault_program {
        return Err(LaunchError::NotFromVault.into());
    }

    let rent = Rent::get()?;
    let intake_seeds: &[&[u8]] = &[seeds::INTAKE, mint.key.as_ref(), &[c.intake_bump]];
    let curve_seeds: &[&[u8]] = &[seeds::CURVE, mint.key.as_ref(), &[c.bump]];
    let nf_rent = rent.minimum_balance(1).checked_mul(CLAIM_NULLIFIERS).ok_or(LaunchError::Overflow)?;
    let claim_rent = rent.minimum_balance(0).saturating_sub(claim.lamports());

    match kind {
        EXIT_BUY => {
            // SOL arrived at the intake PDA. Everything above its rent is this buy.
            let amount_in = intake.lamports().saturating_sub(rent.minimum_balance(0));
            if amount_in == 0 || delivered > amount_in {
                return Err(LaunchError::AmountTooSmall.into());
            }
            expect_key(claim_ata, &token::associated_token_address(claim.key, mint.key))?;
            // The claim key must be able to pay for its own shield later: its
            // own rent, the two nullifier PDAs, and a budget for fees / a relayer tip.
            let ata_rent = if claim_ata.data_is_empty() { rent.minimum_balance(token::TOKEN_ACCOUNT_LEN) } else { 0 };
            let reserve = claim_rent
                .checked_add(nf_rent)
                .and_then(|x| x.checked_add(claim_budget))
                .and_then(|x| x.checked_add(ata_rent))
                .and_then(|x| x.checked_add(relayer_tip))
                .ok_or(LaunchError::Overflow)?;
            let gross = amount_in.checked_sub(reserve).ok_or(LaunchError::AmountTooSmall)?;
            let fee = curve::fee(gross, c.trade_fee_bps)?;
            let net = gross - fee;
            let (out, y2) = curve::buy(&c.reserves(), net)?;
            if out < min_out {
                return Err(LaunchError::Slippage.into());
            }

            // money: intake → curve (net + fee), intake → claim (its reserve), intake → payer (ATA rent it fronts)
            invoke_signed(&system_instruction::transfer(intake.key, curve.key, gross), &[intake.clone(), curve.clone(), system.clone()], &[intake_seeds])?;
            invoke_signed(
                &system_instruction::transfer(intake.key, claim.key, claim_rent + nf_rent + claim_budget),
                &[intake.clone(), claim.clone(), system.clone()],
                &[intake_seeds],
            )?;
            if ata_rent > 0 {
                token::create_ata_idempotent(ata_program, payer, claim_ata, claim, mint, system, token_program)?;
            }
            if ata_rent + relayer_tip > 0 {
                invoke_signed(&system_instruction::transfer(intake.key, payer.key, ata_rent + relayer_tip), &[intake.clone(), payer.clone(), system.clone()], &[intake_seeds])?;
            }
            // tokens: curve vault → claim ATA
            let decimals = mint_decimals(mint)?;
            token::transfer_checked(token_program, curve_vault, mint, claim_ata, curve, out, decimals, &[curve_seeds])?;

            c.real_sol = c.real_sol.checked_add(net).ok_or(LaunchError::Overflow)?;
            c.fees_accrued = c.fees_accrued.checked_add(fee).ok_or(LaunchError::Overflow)?;
            c.virtual_token = y2;
            c.real_token = c.real_token.checked_sub(out).ok_or(LaunchError::Overflow)?;
            c.buys += 1;
            c.sol_volume = c.sol_volume.saturating_add(net);
            sol_log_data(&[
                b"curve_buy",
                mint.key.as_ref(),
                &net.to_le_bytes(),
                &fee.to_le_bytes(),
                &out.to_le_bytes(),
                &c.real_sol.to_le_bytes(),
                &c.real_token.to_le_bytes(),
                &c.virtual_token.to_le_bytes(),
                &[1u8],
                claim.key.as_ref(),
            ]);
        }
        EXIT_SELL => {
            // Tokens arrived at the intake's token account. Sell all of them.
            let token_in = token::token_account_amount(intake_ata).ok_or(LaunchError::AccountMismatch)?;
            if token_in == 0 || delivered > token_in {
                return Err(LaunchError::AmountTooSmall.into());
            }
            let (gross_out, y2) = curve::sell(&c.reserves(), token_in)?;
            let fee = curve::fee(gross_out, c.trade_fee_bps)?;
            let out = gross_out.checked_sub(fee).and_then(|x| x.checked_sub(relayer_tip)).ok_or(LaunchError::AmountTooSmall)?;
            if out < min_out {
                return Err(LaunchError::Slippage.into());
            }
            // The SOL claim must leave room for the claim key's rent, the nullifier rents and its budget.
            let floor = claim_rent.checked_add(nf_rent).and_then(|x| x.checked_add(claim_budget)).ok_or(LaunchError::Overflow)?;
            if out <= floor {
                return Err(LaunchError::AmountTooSmall.into());
            }
            let decimals = mint_decimals(mint)?;
            token::transfer_checked(token_program, intake_ata, mint, curve_vault, intake, token_in, decimals, &[intake_seeds])?;
            // Sells pass `claim` twice (no token account is involved).
            expect_key(claim_ata, claim.key)?;
            debit(curve, claim, out)?;
            if relayer_tip > 0 {
                debit(curve, payer, relayer_tip)?;
            }

            c.real_sol = c.real_sol.checked_sub(gross_out).ok_or(LaunchError::Overflow)?;
            c.fees_accrued = c.fees_accrued.checked_add(fee).ok_or(LaunchError::Overflow)?;
            c.virtual_token = y2;
            c.real_token = c.real_token.checked_add(token_in).ok_or(LaunchError::Overflow)?;
            c.sells += 1;
            c.sol_volume = c.sol_volume.saturating_add(gross_out);
            sol_log_data(&[
                b"curve_sell",
                mint.key.as_ref(),
                &gross_out.to_le_bytes(),
                &fee.to_le_bytes(),
                &token_in.to_le_bytes(),
                &c.real_sol.to_le_bytes(),
                &c.real_token.to_le_bytes(),
                &c.virtual_token.to_le_bytes(),
                &[1u8],
                claim.key.as_ref(),
            ]);
        }
        _ => return Err(LaunchError::InvalidInstruction.into()),
    }
    graduate_if_due(&mut c);
    check_curve_balance(curve, &c)?;
    c.store(&mut curve.try_borrow_mut_data()?)
}

fn mint_decimals(mint: &AccountInfo) -> Result<u8, ProgramError> {
    let d = mint.try_borrow_data()?;
    if d.len() < 82 {
        return Err(LaunchError::AccountMismatch.into());
    }
    Ok(d[44])
}

// ------------------------------------------------------------------ harvest

/// Permissionless. Accounts: `[curve w, mint, curve_vault w, protocol_treasury w,
///   vault_program, pool w, pool_vault w, token_2022, system]`.
fn process_harvest(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let curve = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_vault = next_account_info(it)?;
    let treasury = next_account_info(it)?;
    let vault_program = next_account_info(it)?;
    let pool = next_account_info(it)?;
    let pool_vault = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system = next_account_info(it)?;

    let mut c = load_curve(curve, program_id)?;
    expect_key(mint, &c.mint)?;
    expect_key(curve_vault, &c.token_vault)?;
    expect_key(treasury, &c.protocol_treasury)?;
    expect_key(vault_program, &c.vault_program)?;
    expect_key(token_program, &token::TOKEN_2022_PROGRAM_ID)?;
    expect_key(system, &system_program::ID)?;
    if c.fees_accrued == 0 {
        return Err(LaunchError::Nothing.into());
    }
    let fees = c.fees_accrued;
    let holder = curve::fee(fees, c.holder_share_bps)?;
    let protocol = fees - holder;
    let curve_seeds: &[&[u8]] = &[seeds::CURVE, mint.key.as_ref(), &[c.bump]];

    if protocol > 0 {
        debit(curve, treasury, protocol)?;
    }
    let mut donated = 0u64;
    let mut holder_spent = 0u64;
    // Holder share: buy on the curve (fee-free, the fee is being spent) and donate the tokens to the pool.
    // If nobody has claimed into the pool yet there is nothing to accrue to; keep it for next time.
    if holder > 0 && pool_total_shares(pool, vault_program.key)? > 0 {
        if let Ok((out, y2)) = curve::buy(&c.reserves(), holder) {
            let donate = VaultInstruction::Donate { amount: out };
            invoke_signed(
                &Instruction {
                    program_id: *vault_program.key,
                    accounts: vec![
                        AccountMeta::new(*curve.key, true),
                        AccountMeta::new(*curve_vault.key, false),
                        AccountMeta::new(*pool.key, false),
                        AccountMeta::new(*pool_vault.key, false),
                        AccountMeta::new_readonly(*mint.key, false),
                        AccountMeta::new_readonly(*token_program.key, false),
                        AccountMeta::new_readonly(*system.key, false),
                    ],
                    data: borsh::to_vec(&donate).map_err(|_| LaunchError::InvalidInstruction)?,
                },
                &[curve.clone(), curve_vault.clone(), pool.clone(), pool_vault.clone(), mint.clone(), token_program.clone(), system.clone(), vault_program.clone()],
                &[curve_seeds],
            )?;
            c.real_sol = c.real_sol.checked_add(holder).ok_or(LaunchError::Overflow)?;
            c.virtual_token = y2;
            c.real_token = c.real_token.checked_sub(out).ok_or(LaunchError::Overflow)?;
            donated = out;
            holder_spent = holder;
        }
    }
    c.fees_accrued = fees - protocol - holder_spent;
    graduate_if_due(&mut c);
    check_curve_balance(curve, &c)?;
    c.store(&mut curve.try_borrow_mut_data()?)?;
    sol_log_data(&[b"harvest", mint.key.as_ref(), &protocol.to_le_bytes(), &holder_spent.to_le_bytes(), &donated.to_le_bytes()]);
    Ok(())
}

// ----------------------------------------------------------------- graduate

fn process_graduate(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let curve = next_account_info(&mut accounts.iter())?;
    let mut c = load_curve(curve, program_id)?;
    if c.graduated != 0 || !c.should_graduate() {
        return Err(LaunchError::NotGraduated.into());
    }
    graduate_if_due(&mut c);
    c.store(&mut curve.try_borrow_mut_data()?)
}

// ------------------------------------------------------- public trading

/// After graduation anyone may trade on the curve directly.
/// Accounts: `[curve w, mint, curve_vault w, buyer s w, buyer_ata w, token_2022, ata_program, system]`.
fn process_public_buy(program_id: &Pubkey, accounts: &[AccountInfo], a: SwapArgs) -> ProgramResult {
    let it = &mut accounts.iter();
    let curve = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_vault = next_account_info(it)?;
    let buyer = next_account_info(it)?;
    let buyer_ata = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let system = next_account_info(it)?;

    let mut c = load_curve(curve, program_id)?;
    if c.graduated == 0 {
        return Err(LaunchError::NotGraduated.into());
    }
    expect_signer(buyer)?;
    expect_key(mint, &c.mint)?;
    expect_key(curve_vault, &c.token_vault)?;
    expect_key(token_program, &token::TOKEN_2022_PROGRAM_ID)?;
    expect_key(ata_program, &token::ASSOCIATED_TOKEN_PROGRAM_ID)?;
    expect_key(buyer_ata, &token::associated_token_address(buyer.key, mint.key))?;
    let fee = curve::fee(a.amount_in, c.trade_fee_bps)?;
    let net = a.amount_in.checked_sub(fee).ok_or(LaunchError::Overflow)?;
    let (out, y2) = curve::buy(&c.reserves(), net)?;
    if out < a.min_out {
        return Err(LaunchError::Slippage.into());
    }
    invoke(&system_instruction::transfer(buyer.key, curve.key, a.amount_in), &[buyer.clone(), curve.clone(), system.clone()])?;
    token::create_ata_idempotent(ata_program, buyer, buyer_ata, buyer, mint, system, token_program)?;
    let curve_seeds: &[&[u8]] = &[seeds::CURVE, mint.key.as_ref(), &[c.bump]];
    token::transfer_checked(token_program, curve_vault, mint, buyer_ata, curve, out, mint_decimals(mint)?, &[curve_seeds])?;
    c.real_sol = c.real_sol.checked_add(net).ok_or(LaunchError::Overflow)?;
    c.fees_accrued = c.fees_accrued.checked_add(fee).ok_or(LaunchError::Overflow)?;
    c.virtual_token = y2;
    c.real_token = c.real_token.checked_sub(out).ok_or(LaunchError::Overflow)?;
    c.buys += 1;
    c.sol_volume = c.sol_volume.saturating_add(net);
    check_curve_balance(curve, &c)?;
    c.store(&mut curve.try_borrow_mut_data()?)?;
    sol_log_data(&[
        b"curve_buy",
        mint.key.as_ref(),
        &net.to_le_bytes(),
        &fee.to_le_bytes(),
        &out.to_le_bytes(),
        &c.real_sol.to_le_bytes(),
        &c.real_token.to_le_bytes(),
        &c.virtual_token.to_le_bytes(),
        &[0u8],
        buyer.key.as_ref(),
    ]);
    Ok(())
}

/// Accounts: `[curve w, mint, curve_vault w, seller s w, seller_ata w, token_2022, system]`.
fn process_public_sell(program_id: &Pubkey, accounts: &[AccountInfo], a: SwapArgs) -> ProgramResult {
    let it = &mut accounts.iter();
    let curve = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_vault = next_account_info(it)?;
    let seller = next_account_info(it)?;
    let seller_ata = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let _system = next_account_info(it)?;

    let mut c = load_curve(curve, program_id)?;
    if c.graduated == 0 {
        return Err(LaunchError::NotGraduated.into());
    }
    expect_signer(seller)?;
    expect_key(mint, &c.mint)?;
    expect_key(curve_vault, &c.token_vault)?;
    expect_key(token_program, &token::TOKEN_2022_PROGRAM_ID)?;
    let (gross, y2) = curve::sell(&c.reserves(), a.amount_in)?;
    let fee = curve::fee(gross, c.trade_fee_bps)?;
    let out = gross - fee;
    if out < a.min_out {
        return Err(LaunchError::Slippage.into());
    }
    token::transfer_checked(token_program, seller_ata, mint, curve_vault, seller, a.amount_in, mint_decimals(mint)?, &[])?;
    debit(curve, seller, out)?;
    c.real_sol = c.real_sol.checked_sub(gross).ok_or(LaunchError::Overflow)?;
    c.fees_accrued = c.fees_accrued.checked_add(fee).ok_or(LaunchError::Overflow)?;
    c.virtual_token = y2;
    c.real_token = c.real_token.checked_add(a.amount_in).ok_or(LaunchError::Overflow)?;
    c.sells += 1;
    c.sol_volume = c.sol_volume.saturating_add(gross);
    check_curve_balance(curve, &c)?;
    c.store(&mut curve.try_borrow_mut_data()?)?;
    sol_log_data(&[
        b"curve_sell",
        mint.key.as_ref(),
        &gross.to_le_bytes(),
        &fee.to_le_bytes(),
        &a.amount_in.to_le_bytes(),
        &c.real_sol.to_le_bytes(),
        &c.real_token.to_le_bytes(),
        &c.virtual_token.to_le_bytes(),
        &[0u8],
        seller.key.as_ref(),
    ]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_data_layout_is_fixed() {
        assert_eq!(EXIT_DATA_LEN, 57);
        assert_eq!(EXIT_AMOUNT_PREFIX + EXIT_DATA_LEN, 65);
    }

    #[test]
    fn pdas_are_distinct_per_mint_and_claim_key() {
        let pid = crate::id();
        let m1 = Pubkey::new_unique();
        let m2 = Pubkey::new_unique();
        assert_ne!(curve_pda(&m1, &pid).0, curve_pda(&m2, &pid).0);
        assert_ne!(intake_pda(&m1, &pid).0, curve_pda(&m1, &pid).0);
        assert_ne!(launchpad_pda(&pid).0, curve_pda(&m1, &pid).0);
    }
}
