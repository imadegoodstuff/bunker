use crate::{
    amm, curve, policy,
    seeds,
    state::{Curve, Launchpad, Vote, DISC_CURVE, DISC_LAUNCHPAD},
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
/// `exit_data` layout: kind u8 || claim_key 32 || min_out u64 || claim_budget u32 || relayer_tip u32.
/// `relayer_tip` is paid from the SOL leg to the exit call's `payer` (the
/// relayer), which is how a relayed *sell* pays its relayer: the vault's own
/// fee would be in the token being sold, which no relayer prices. The two
/// lamport fields are u32 (< 4.3 SOL) because every byte of a relayed buy
/// counts: the whole transaction has to fit a 1,232-byte v0 packet.
pub const EXIT_DATA_LEN: usize = 1 + 32 + 8 + 4 + 4;
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
    pub agents: [Pubkey; policy::AGENTS],
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct VoteArgs {
    pub fee_bps: u16,
    pub holder_bps: u16,
}

#[derive(BorshSerialize, BorshDeserialize)]
pub struct LaunchArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
}

/// Lamports kept back from the AMM deposit to pay for the accounts Raydium
/// creates at `initialize` (pool state, observation buffer, LP mint, two vaults,
/// LP token account) and the two transient token accounts of the migrate PDA.
/// About 0.05 SOL is needed today; whatever is left over goes to the treasury.
pub const MIGRATION_RENT_RESERVE: u64 = 100_000_000;

/// Instruction tags (first byte). Exit calls from the vault carry no tag: they
/// are recognised by stack height, see `process`. Tags 5 and 6 were the public
/// curve trades of an earlier design; a graduated curve now migrates to the AMM
/// instead, so they are unassigned.
pub const IX_INIT_LAUNCHPAD: u8 = 0;
pub const IX_LAUNCH: u8 = 1;
pub const IX_HARVEST: u8 = 3;
pub const IX_GRADUATE: u8 = 4;
pub const IX_VOTE: u8 = 7;
pub const IX_MIGRATE: u8 = 8;

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
        IX_VOTE => process_vote(program_id, accounts, VoteArgs::try_from_slice(rest).map_err(|_| LaunchError::InvalidInstruction)?),
        IX_MIGRATE => process_migrate(program_id, accounts),
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
pub fn migrate_pda(mint: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[seeds::MIGRATE, mint.as_ref()], program_id)
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

/// Load the curve and bring its fee policy up to the current epoch. Every
/// instruction that charges or splits a fee goes through here, so the fee a
/// trade pays is the one the SDK computed from the same votes and slot.
fn load_curve_rolled(curve: &AccountInfo, program_id: &Pubkey) -> Result<Curve, ProgramError> {
    let mut c = load_curve(curve, program_id)?;
    if policy::roll(&mut c, Clock::get()?.slot) {
        sol_log_data(&[b"fee_roll", c.mint.as_ref(), &c.trade_fee_bps.to_le_bytes(), &c.holder_share_bps.to_le_bytes(), &c.settled_epoch.to_le_bytes()]);
    }
    Ok(c)
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
        agents: a.agents,
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
    let slot = Clock::get()?.slot;
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
        created_slot: slot,
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
        settled_epoch: policy::epoch_of(slot),
        votes: [Vote::default(); policy::AGENTS],
        amm_pool: Pubkey::default(),
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
    let min_out = u64::from_le_bytes(data[41..49].try_into().unwrap());
    let claim_budget = u32::from_le_bytes(data[49..53].try_into().unwrap()) as u64;
    let relayer_tip = u32::from_le_bytes(data[53..57].try_into().unwrap()) as u64;

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

    let mut c = load_curve_rolled(curve, program_id)?;
    // Graduation freezes the curve: from then on the only thing that can happen
    // to it is `migrate`, and the token trades on the AMM.
    if c.graduated != 0 {
        return Err(LaunchError::Migrated.into());
    }
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
            let mut fee = curve::fee(gross, c.trade_fee_bps)?;
            let (out, y2, net) = curve::buy_capped(&c.reserves(), gross - fee)?;
            if out < min_out {
                return Err(LaunchError::Slippage.into());
            }
            // The buy that empties the curve pays only for what it got; the rest returns to the buyer's claim key.
            let mut refund = 0u64;
            if net < gross - fee {
                fee = curve::fee_on_net(net, c.trade_fee_bps)?;
                refund = gross - net - fee;
            }

            // money: intake → curve (net + fee), intake → claim (its reserve + any refund), intake → payer (ATA rent it fronts)
            invoke_signed(&system_instruction::transfer(intake.key, curve.key, net + fee), &[intake.clone(), curve.clone(), system.clone()], &[intake_seeds])?;
            invoke_signed(
                &system_instruction::transfer(intake.key, claim.key, claim_rent + nf_rent + claim_budget + refund),
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

    let mut c = load_curve_rolled(curve, program_id)?;
    // After graduation the fees still on the curve travel with it to the AMM (`process_migrate`).
    if c.graduated != 0 {
        return Err(LaunchError::Migrated.into());
    }
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

    // Order matters: the runtime syncs the caller's direct lamport edits into the
    // CPI only for the accounts the CPI names, and refuses to start a CPI while
    // those edits do not net to zero. `treasury` is not part of the donate call,
    // so the protocol share is paid after it.
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
    if protocol > 0 {
        debit(curve, treasury, protocol)?;
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

// ----------------------------------------------------------------- vote

/// One of the four agents records its vote for this curve's fee and holder
/// share. Accounts: `[launchpad, curve w, agent s]`. The vote is bounded by
/// policy.rs and takes effect from the next epoch through `roll`; nothing else
/// in the program can move the fee.
fn process_vote(program_id: &Pubkey, accounts: &[AccountInfo], a: VoteArgs) -> ProgramResult {
    let it = &mut accounts.iter();
    let launchpad = next_account_info(it)?;
    let curve = next_account_info(it)?;
    let agent = next_account_info(it)?;
    if launchpad.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    expect_key(launchpad, &launchpad_pda(program_id).0)?;
    expect_signer(agent)?;
    let lp = Launchpad::load(&launchpad.try_borrow_data()?)?;
    let idx = lp.agents.iter().position(|k| k == agent.key).ok_or(LaunchError::NotAgent)?;
    if !policy::vote_in_bounds(a.fee_bps, a.holder_bps) {
        return Err(LaunchError::BadParams.into());
    }
    let mut c = load_curve_rolled(curve, program_id)?;
    // Once the token is on the AMM there is no fee for the agents to set.
    if c.graduated != 0 {
        return Err(LaunchError::Migrated.into());
    }
    let slot = Clock::get()?.slot;
    c.votes[idx] = Vote { fee_bps: a.fee_bps, holder_bps: a.holder_bps, slot };
    c.store(&mut curve.try_borrow_mut_data()?)?;
    sol_log_data(&[b"fee_vote", c.mint.as_ref(), &[idx as u8], &a.fee_bps.to_le_bytes(), &a.holder_bps.to_le_bytes(), &slot.to_le_bytes()]);
    Ok(())
}

// ----------------------------------------------------------------- migrate

/// Permissionless. Moves a graduated curve to a Raydium CP-Swap pool: all of
/// the curve's SOL (less Raydium's creation fee and the rents of the accounts
/// it creates) and every token the curve vault still holds — the unsold
/// remainder plus the supply reserved for exactly this — become the pool's
/// initial liquidity, and the LP tokens are burned in the same instruction.
/// Fees not yet harvested are split one last time: the protocol share to the
/// treasury, the holder share into the pool (permanent liquidity is the only
/// form "to holders" can still take once nothing trades on the curve).
///
/// Raydium pays the creation fee with a system transfer from `creator`, so the
/// creator must be a plain system account: the data-less PDA("migrate", mint)
/// stands in for one transaction, funded from the curve, and is swept into the
/// treasury at the end. Nothing is left behind but the pool.
///
/// Accounts: `[curve w, mint, curve_vault w, migrate w, migrate_token w, wsol_mint,
///   migrate_wsol w, treasury w, cp_swap, amm_config, authority, pool_state w,
///   lp_mint w, migrate_lp w, token_0_vault w, token_1_vault w, create_pool_fee w,
///   observation w, spl_token, token_2022, ata_program, system, rent, default_pool]`.
///
/// `amm_config` is normally Raydium's config 0 (`amm::AMM_CONFIG`). Anyone who
/// got hold of tokens before graduation could create that pool first and strand
/// the curve, so if the config-0 pool already exists (`default_pool`, the last
/// account, is initialised) any other enabled CP-Swap config whose pool does not
/// exist yet is accepted instead.
fn process_migrate(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let curve = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let curve_vault = next_account_info(it)?;
    let mig = next_account_info(it)?;
    let mig_token = next_account_info(it)?;
    let wsol_mint = next_account_info(it)?;
    let mig_wsol = next_account_info(it)?;
    let treasury = next_account_info(it)?;
    let cp_swap = next_account_info(it)?;
    let amm_config = next_account_info(it)?;
    let authority = next_account_info(it)?;
    let pool_state = next_account_info(it)?;
    let lp_mint = next_account_info(it)?;
    let mig_lp = next_account_info(it)?;
    let token_0_vault = next_account_info(it)?;
    let token_1_vault = next_account_info(it)?;
    let fee_receiver = next_account_info(it)?;
    let observation = next_account_info(it)?;
    let spl_token = next_account_info(it)?;
    let token_2022 = next_account_info(it)?;
    let ata_program = next_account_info(it)?;
    let system = next_account_info(it)?;
    let rent_sysvar = next_account_info(it)?;
    let default_pool = next_account_info(it)?;

    let mut c = load_curve(curve, program_id)?;
    if c.migrated() {
        return Err(LaunchError::Migrated.into());
    }
    if c.graduated == 0 {
        return Err(LaunchError::NotMigratable.into());
    }
    expect_key(mint, &c.mint)?;
    expect_key(curve_vault, &c.token_vault)?;
    expect_key(treasury, &c.protocol_treasury)?;
    expect_key(wsol_mint, &amm::WSOL_MINT)?;
    expect_key(cp_swap, &amm::CP_SWAP_PROGRAM_ID)?;
    expect_key(fee_receiver, &amm::CREATE_POOL_FEE_RECEIVER)?;
    expect_key(spl_token, &amm::SPL_TOKEN_PROGRAM_ID)?;
    expect_key(token_2022, &token::TOKEN_2022_PROGRAM_ID)?;
    expect_key(ata_program, &token::ASSOCIATED_TOKEN_PROGRAM_ID)?;
    expect_key(system, &system_program::ID)?;
    expect_key(rent_sysvar, &solana_program::sysvar::rent::ID)?;
    let (mig_addr, mig_bump) = migrate_pda(mint.key, program_id);
    expect_key(mig, &mig_addr)?;
    if !mig.data_is_empty() || *mig.owner != system_program::ID {
        return Err(LaunchError::BadAccount.into());
    }
    expect_key(mig_token, &token::associated_token_address(mig.key, mint.key))?;
    expect_key(mig_wsol, &token::associated_token_address_for(mig.key, wsol_mint.key, spl_token.key))?;

    // Which Raydium config, and the pool keys that follow from it.
    let (token_0, token_1, wsol_first) = amm::ordered(mint.key);
    if amm_config.owner != cp_swap.key {
        return Err(LaunchError::AccountMismatch.into());
    }
    let create_fee = amm::create_pool_fee(&amm_config.try_borrow_data()?).ok_or(LaunchError::AccountMismatch)?;
    expect_key(default_pool, &amm::pool_state(&amm::AMM_CONFIG, &token_0, &token_1))?;
    if *amm_config.key != amm::AMM_CONFIG && (default_pool.data_is_empty() || default_pool.owner != cp_swap.key) {
        // config 0 is still free: use it
        return Err(LaunchError::AccountMismatch.into());
    }
    let keys = amm::pool_keys(amm_config.key, &token_0, &token_1);
    expect_key(authority, &keys.authority)?;
    expect_key(pool_state, &keys.pool_state)?;
    expect_key(lp_mint, &keys.lp_mint)?;
    expect_key(token_0_vault, &keys.token_0_vault)?;
    expect_key(token_1_vault, &keys.token_1_vault)?;
    expect_key(observation, &keys.observation)?;
    expect_key(mig_lp, &token::associated_token_address_for(mig.key, lp_mint.key, spl_token.key))?;

    // What goes in.
    let holder = curve::fee(c.fees_accrued, c.holder_share_bps)?;
    let protocol = c.fees_accrued - holder;
    let sol_total = c.real_sol.checked_add(holder).ok_or(LaunchError::Overflow)?;
    let sol_in = sol_total.checked_sub(create_fee).and_then(|x| x.checked_sub(MIGRATION_RENT_RESERVE)).ok_or(LaunchError::InsufficientReserve)?;
    let token_in = token::token_account_amount(curve_vault).ok_or(LaunchError::AccountMismatch)?;
    if sol_in == 0 || token_in == 0 {
        return Err(LaunchError::InsufficientReserve.into());
    }
    let (amount_0, amount_1) = if wsol_first { (sol_in, token_in) } else { (token_in, sol_in) };
    let (mint_0, mint_1, prog_0, prog_1, acc_0, acc_1) = if wsol_first {
        (wsol_mint, mint, spl_token, token_2022, mig_wsol, mig_token)
    } else {
        (mint, wsol_mint, token_2022, spl_token, mig_token, mig_wsol)
    };
    let mig_seeds: &[&[u8]] = &[seeds::MIGRATE, mint.key.as_ref(), &[mig_bump]];
    let curve_seeds: &[&[u8]] = &[seeds::CURVE, mint.key.as_ref(), &[c.bump]];

    // 1. Fund the migrate PDA from the curve. The runtime only learns about a
    //    direct lamport edit when the account is named in the next CPI, and
    //    refuses to start one while the edits it knows of do not net to zero, so
    //    the first CPI below names both sides.
    debit(curve, mig, sol_total)?;
    token::create_ata_idempotent_signed(ata_program, mig, mig_wsol, mig, wsol_mint, system, spl_token, std::slice::from_ref(curve), &[mig_seeds])?;
    // 2. Wrap the SOL leg.
    invoke_signed(&system_instruction::transfer(mig.key, mig_wsol.key, sol_in), &[mig.clone(), mig_wsol.clone(), system.clone()], &[mig_seeds])?;
    token::sync_native(spl_token, mig_wsol)?;
    // 3. Move every token the curve still holds to the migrate PDA.
    token::create_ata_idempotent_signed(ata_program, mig, mig_token, mig, mint, system, token_2022, &[], &[mig_seeds])?;
    token::transfer_checked(token_2022, curve_vault, mint, mig_token, curve, token_in, mint_decimals(mint)?, &[curve_seeds])?;
    // 4. Create the pool. Raydium creates `mig_lp` itself and mints the LP there.
    amm::initialize(
        &amm::InitializeAccounts {
            cp_swap,
            creator: mig,
            amm_config,
            authority,
            pool_state,
            token_0_mint: mint_0,
            token_1_mint: mint_1,
            lp_mint,
            creator_token_0: acc_0,
            creator_token_1: acc_1,
            creator_lp_token: mig_lp,
            token_0_vault,
            token_1_vault,
            create_pool_fee: fee_receiver,
            observation_state: observation,
            token_program: spl_token,
            token_0_program: prog_0,
            token_1_program: prog_1,
            associated_token_program: ata_program,
            system_program: system,
            rent: rent_sysvar,
        },
        amount_0,
        amount_1,
        0,
        mig_seeds,
    )?;
    // 5. Burn the LP and close the PDA's token accounts; rents return to the PDA.
    let lp_amount = token::token_account_amount(mig_lp).ok_or(LaunchError::AccountMismatch)?;
    if lp_amount == 0 {
        return Err(LaunchError::Nothing.into());
    }
    token::burn(spl_token, mig_lp, lp_mint, mig, lp_amount, &[mig_seeds])?;
    token::close_account(spl_token, mig_lp, mig, mig, &[mig_seeds])?;
    token::close_account(spl_token, mig_wsol, mig, mig, &[mig_seeds])?;
    token::close_account(token_2022, mig_token, mig, mig, &[mig_seeds])?;
    // 6. Sweep what the reserve did not need into the treasury, then the protocol
    //    share of the last fees (a direct edit, nothing CPIs after it).
    let left = mig.lamports();
    if left > 0 {
        invoke_signed(&system_instruction::transfer(mig.key, treasury.key, left), &[mig.clone(), treasury.clone(), system.clone()], &[mig_seeds])?;
    }
    if protocol > 0 {
        debit(curve, treasury, protocol)?;
    }

    c.real_sol = 0;
    c.real_token = 0;
    c.fees_accrued = 0;
    c.amm_pool = *pool_state.key;
    check_curve_balance(curve, &c)?;
    c.store(&mut curve.try_borrow_mut_data()?)?;
    sol_log_data(&[b"migrate", mint.key.as_ref(), pool_state.key.as_ref(), &sol_in.to_le_bytes(), &token_in.to_le_bytes(), &lp_amount.to_le_bytes()]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_data_layout_is_fixed() {
        assert_eq!(EXIT_DATA_LEN, 49);
        assert_eq!(EXIT_AMOUNT_PREFIX + EXIT_DATA_LEN, 57);
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
