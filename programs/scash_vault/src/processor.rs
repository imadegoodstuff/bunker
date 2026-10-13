use crate::{
    error::VaultError,
    field,
    state::{Asp, Config, Pool, Tree},
    token, tree, verifier,
};
use borsh::{BorshDeserialize, BorshSerialize};
use scash_core::{seeds, ExtData, TransactArgs, VaultInstruction, MAX_INPUTS, OUTPUTS, PROOF_LEN};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    hash::hashv,
    instruction::{AccountMeta, Instruction},
    log::sol_log_data,
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction, system_program,
    sysvar::Sysvar,
};

pub fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let ix = VaultInstruction::try_from_slice(data).map_err(|_| VaultError::InvalidInstruction)?;
    match ix {
        VaultInstruction::Initialize { guardian } => process_initialize(program_id, accounts, guardian),
        VaultInstruction::CreatePool { tvl_cap } => process_create_pool(program_id, accounts, tvl_cap),
        VaultInstruction::Transact(args) => process_transact(program_id, accounts, args),
        VaultInstruction::Donate { amount } => process_donate(program_id, accounts, amount),
        VaultInstruction::UpdateAspRoot { root } => process_update_asp_root(program_id, accounts, root),
        VaultInstruction::SetShieldPaused { paused } => process_set_shield_paused(program_id, accounts, paused),
        VaultInstruction::LowerTvlCap { tvl_cap } => process_lower_tvl_cap(program_id, accounts, tvl_cap),
    }
}

// ------------------------------------------------------------------ helpers

fn create_pda_account<'a>(
    payer: &AccountInfo<'a>,
    account: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    owner: &Pubkey,
    space: usize,
    seeds: &[&[u8]],
) -> ProgramResult {
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    if account.lamports() > 0 {
        // Someone pre-funded the address; top up and assign instead of create.
        let needed = lamports.saturating_sub(account.lamports());
        if needed > 0 {
            invoke(&system_instruction::transfer(payer.key, account.key, needed), &[payer.clone(), account.clone(), system_program.clone()])?;
        }
        invoke_signed(&system_instruction::allocate(account.key, space as u64), &[account.clone(), system_program.clone()], &[seeds])?;
        invoke_signed(&system_instruction::assign(account.key, owner), &[account.clone(), system_program.clone()], &[seeds])?;
        return Ok(());
    }
    invoke_signed(
        &system_instruction::create_account(payer.key, account.key, lamports, space as u64, owner),
        &[payer.clone(), account.clone(), system_program.clone()],
        &[seeds],
    )
}

fn expect_pda(account: &AccountInfo, program_id: &Pubkey, seeds: &[&[u8]]) -> Result<u8, ProgramError> {
    let (addr, bump) = Pubkey::find_program_address(seeds, program_id);
    if addr != *account.key {
        return Err(VaultError::InvalidPda.into());
    }
    Ok(bump)
}

fn expect_owned(account: &AccountInfo, program_id: &Pubkey) -> ProgramResult {
    if account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

fn asset_id(mint: &Pubkey) -> [u8; 32] {
    let h = hashv(&[b"scash_asset", mint.as_ref()]);
    field::reduce_be(&h.to_bytes())
}

fn ext_data_hash(ext: &ExtData) -> Result<[u8; 32], ProgramError> {
    let mut buf = Vec::with_capacity(2048);
    ext.serialize(&mut buf).map_err(|_| VaultError::InvalidInstruction)?;
    if buf.len() > 3072 {
        return Err(VaultError::ExtDataTooLarge.into());
    }
    Ok(field::reduce_be(&hashv(&[&buf]).to_bytes()))
}

// --------------------------------------------------------------- initialize

fn process_initialize(program_id: &Pubkey, accounts: &[AccountInfo], guardian: [u8; 32]) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let config = next_account_info(it)?;
    let tree_acc = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !config.data_is_empty() || !tree_acc.data_is_empty() {
        return Err(VaultError::AlreadyInitialized.into());
    }
    let cb = expect_pda(config, program_id, &[seeds::CONFIG])?;
    let tb = expect_pda(tree_acc, program_id, &[seeds::TREE])?;

    create_pda_account(payer, config, system, program_id, Config::LEN, &[seeds::CONFIG, &[cb]])?;
    create_pda_account(payer, tree_acc, system, program_id, Tree::LEN, &[seeds::TREE, &[tb]])?;

    Config::init(&mut config.try_borrow_mut_data()?, cb, &Pubkey::new_from_array(guardian));
    tree::init(&mut tree_acc.try_borrow_mut_data()?, tb)?;
    msg!("scash: initialized");
    Ok(())
}

// -------------------------------------------------------------- create pool

fn process_create_pool(program_id: &Pubkey, accounts: &[AccountInfo], tvl_cap: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?;
    let config = next_account_info(it)?;
    let pool = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system = next_account_info(it)?;
    let ata_program = next_account_info(it).ok();

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    expect_owned(config, program_id)?;
    Config::check(&config.try_borrow_data()?)?;
    if !pool.data_is_empty() {
        return Err(VaultError::AlreadyInitialized.into());
    }

    let pb = expect_pda(pool, program_id, &[seeds::POOL, mint.key.as_ref()])?;
    let is_native = *mint.key == system_program::ID;

    let (decimals, tp) = if is_native {
        // Native vault: a system-owned PDA that just holds lamports.
        let vb = expect_pda(vault, program_id, &[seeds::VAULT, mint.key.as_ref()])?;
        if vault.lamports() == 0 {
            let rent = Rent::get()?.minimum_balance(0);
            invoke_signed(
                &system_instruction::transfer(payer.key, vault.key, rent),
                &[payer.clone(), vault.clone(), system.clone()],
                &[&[seeds::VAULT, mint.key.as_ref(), &[vb]]],
            )?;
        }
        (9u8, system_program::ID)
    } else {
        if !token::is_token_program(token_program.key) || mint.owner != token_program.key {
            return Err(VaultError::AccountMismatch.into());
        }
        let expected = token::associated_token_address(pool.key, mint.key, token_program.key);
        if expected != *vault.key {
            return Err(VaultError::AccountMismatch.into());
        }
        let decimals = token::mint_decimals(mint).ok_or(VaultError::AccountMismatch)?;
        if vault.data_is_empty() {
            let ata_program = ata_program.ok_or(ProgramError::NotEnoughAccountKeys)?;
            token::create_associated_token_account(ata_program, payer, vault, pool, mint, system, token_program)?;
        }
        (decimals, *token_program.key)
    };

    create_pda_account(payer, pool, system, program_id, Pool::LEN, &[seeds::POOL, mint.key.as_ref(), &[pb]])?;
    Pool::init(&mut pool.try_borrow_mut_data()?, pb, decimals, is_native, mint.key, &tp, vault.key, tvl_cap);
    msg!("scash: pool created");
    Ok(())
}

// ---------------------------------------------------------------- transact

pub fn process_transact(program_id: &Pubkey, accounts: &[AccountInfo], args: TransactArgs) -> ProgramResult {
    let it = &mut accounts.iter();
    let payer = next_account_info(it)?; // relayer or user; pays rent for nullifiers
    let config = next_account_info(it)?;
    let tree_acc = next_account_info(it)?;
    let pool = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system = next_account_info(it)?;
    let depositor = next_account_info(it)?;
    let depositor_source = next_account_info(it)?;
    let recipient = next_account_info(it)?;
    let relayer_dest = next_account_info(it)?;
    let asp = next_account_info(it)?;
    let exit_target = next_account_info(it)?;

    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    expect_owned(config, program_id)?;
    expect_owned(tree_acc, program_id)?;
    expect_owned(pool, program_id)?;

    // ---- shape checks
    let n_ins = args.nullifiers.len();
    if !(n_ins == 2 || n_ins == 4) || n_ins > MAX_INPUTS || args.out_commitments.len() != OUTPUTS || args.proof.len() != PROOF_LEN {
        return Err(VaultError::MalformedProof.into());
    }
    if args.ext_data.ciphertexts.len() != OUTPUTS {
        return Err(VaultError::InvalidInstruction.into());
    }
    let nullifier_accs: Vec<&AccountInfo> = (0..n_ins).map(|_| next_account_info(it)).collect::<Result<_, _>>()?;
    let remaining: Vec<AccountInfo> = it.cloned().collect();

    // ---- pool / asset binding
    let pool_data_ro = pool.try_borrow_data()?;
    Pool::check(&pool_data_ro)?;
    if Pool::mint(&pool_data_ro) != *mint.key || Pool::vault(&pool_data_ro) != *vault.key {
        return Err(VaultError::AccountMismatch.into());
    }
    let is_native = Pool::is_native(&pool_data_ro);
    let decimals = Pool::decimals(&pool_data_ro);
    if !is_native && Pool::token_program(&pool_data_ro) != *token_program.key {
        return Err(VaultError::AccountMismatch.into());
    }
    let pool_bump = Pool::bump(&pool_data_ro);
    drop(pool_data_ro);
    let asset = asset_id(mint.key);

    // ---- root: read from the ring at the index the prover used
    let root = {
        let td = tree_acc.try_borrow_data()?;
        Tree::check(&td)?;
        let r = Tree::root_at(&td, args.root_index as usize);
        if field::is_zero(&r) {
            return Err(VaultError::UnknownRoot.into());
        }
        r
    };

    // ---- association set
    let asp_root = args.asp_root.unwrap_or([0u8; 32]);
    if let Some(ar) = args.asp_root {
        expect_owned(asp, program_id)?;
        let ad = asp.try_borrow_data()?;
        Asp::check(&ad)?;
        if !Asp::has_root(&ad, &ar) {
            return Err(VaultError::UnknownAspRoot.into());
        }
    }
    let public_amount = field::encode_signed(args.public_amount);

    // ---- ext data binding
    let ext = &args.ext_data;
    if ext.recipient != recipient.key.to_bytes() || ext.exit_target != exit_target.key.to_bytes() {
        return Err(VaultError::AccountMismatch.into());
    }
    if ext.relayer_fee > 0 {
        // The fee destination must belong to the relayer named in the proof.
        let fee_owner = if is_native {
            *relayer_dest.key
        } else {
            token::token_account_owner(relayer_dest).ok_or(VaultError::AccountMismatch)?
        };
        if fee_owner.to_bytes() != ext.relayer {
            return Err(VaultError::AccountMismatch.into());
        }
    }
    let ext_hash = ext_data_hash(ext)?;

    // ---- public inputs & proof
    let mut public_inputs: Vec<[u8; 32]> = Vec::with_capacity(5 + n_ins + OUTPUTS);
    public_inputs.push(root);
    public_inputs.push(public_amount);
    public_inputs.push(asset);
    public_inputs.push(ext_hash);
    public_inputs.push(asp_root);
    public_inputs.extend_from_slice(&args.nullifiers);
    public_inputs.extend_from_slice(&args.out_commitments);
    verifier::verify(n_ins, &args.proof, &public_inputs)?;

    // ---- nullifiers: create program-owned PDAs; existing => double spend
    for (i, nf) in args.nullifiers.iter().enumerate() {
        let acc = nullifier_accs[i];
        let bump = expect_pda(acc, program_id, &[seeds::NULLIFIER, nf])?;
        if !acc.data_is_empty() || acc.owner == program_id {
            return Err(VaultError::NullifierSpent.into());
        }
        create_pda_account(payer, acc, system, program_id, 1, &[seeds::NULLIFIER, nf, &[bump]])?;
        acc.try_borrow_mut_data()?[0] = 1;
    }

    // ---- value flow
    let signed_shares = args.public_amount as i128;
    let pool_seeds: &[&[u8]] = &[seeds::POOL, mint.key.as_ref(), &[pool_bump]];

    if signed_shares > 0 {
        // ---------------- shield
        if Config::shield_paused(&config.try_borrow_data()?) {
            return Err(VaultError::ShieldPaused.into());
        }
        if !depositor.is_signer {
            return Err(VaultError::DepositorNotSigner.into());
        }
        if ext.relayer_fee != 0 {
            return Err(VaultError::FeeExceedsAmount.into());
        }
        let shares = signed_shares as u64;
        let mut pd = pool.try_borrow_mut_data()?;
        let amount = Pool::amount_for_mint(&pd, shares).ok_or(VaultError::Overflow)?;
        let new_assets = Pool::total_assets(&pd).checked_add(amount).ok_or(VaultError::Overflow)?;
        if new_assets > Pool::tvl_cap(&pd) {
            return Err(VaultError::TvlCapExceeded.into());
        }
        let new_shares = Pool::total_shares(&pd).checked_add(shares).ok_or(VaultError::Overflow)?;
        let new_in = Pool::total_in(&pd).checked_add(amount).ok_or(VaultError::Overflow)?;
        Pool::set_total_assets(&mut pd, new_assets);
        Pool::set_total_shares(&mut pd, new_shares);
        Pool::set_total_in(&mut pd, new_in);
        drop(pd);
        move_in(is_native, token_program, depositor, depositor_source, mint, vault, amount, decimals, system)?;
        sol_log_data(&[b"shield", &amount.to_le_bytes()]);
    } else if signed_shares < 0 {
        // ---------------- unshield
        let shares = (-signed_shares) as u64;
        let mut pd = pool.try_borrow_mut_data()?;
        let amount = Pool::amount_for_burn(&pd, shares).ok_or(VaultError::Overflow)?;
        if ext.relayer_fee > amount {
            return Err(VaultError::FeeExceedsAmount.into());
        }
        let new_out = Pool::total_out(&pd).checked_add(amount).ok_or(VaultError::Overflow)?;
        if new_out > Pool::total_in(&pd) {
            return Err(VaultError::Turnstile.into());
        }
        let new_assets = Pool::total_assets(&pd).checked_sub(amount).ok_or(VaultError::Overflow)?;
        let new_shares = Pool::total_shares(&pd).checked_sub(shares).ok_or(VaultError::Overflow)?;
        Pool::set_total_out(&mut pd, new_out);
        Pool::set_total_assets(&mut pd, new_assets);
        Pool::set_total_shares(&mut pd, new_shares);
        drop(pd);

        let to_recipient = amount - ext.relayer_fee;
        if ext.relayer_fee > 0 {
            move_out(is_native, token_program, pool, vault, mint, relayer_dest, ext.relayer_fee, decimals, system, pool_seeds)?;
        }
        if to_recipient > 0 {
            move_out(is_native, token_program, pool, vault, mint, recipient, to_recipient, decimals, system, pool_seeds)?;
        }
        if *exit_target.key != system_program::ID {
            // Hand control to the exit program with the funds already at `recipient`.
            let metas: Vec<AccountMeta> = remaining
                .iter()
                .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable })
                .collect();
            let mut data = Vec::with_capacity(8 + ext.exit_data.len());
            data.extend_from_slice(&to_recipient.to_le_bytes());
            data.extend_from_slice(&ext.exit_data);
            invoke(&Instruction { program_id: *exit_target.key, accounts: metas, data }, &remaining)?;
        }
        sol_log_data(&[b"unshield", &amount.to_le_bytes()]);
    } else if ext.relayer_fee != 0 {
        return Err(VaultError::FeeExceedsAmount.into());
    }

    // ---- append outputs
    let mut td = tree_acc.try_borrow_mut_data()?;
    let first_index = Tree::next_index(&td);
    for cm in &args.out_commitments {
        tree::append(&mut td, cm)?;
    }
    let new_root = Tree::current_root(&td);
    drop(td);

    // ---- event for indexers: index, commitments, ciphertexts, root
    sol_log_data(&[
        b"transact",
        &first_index.to_le_bytes(),
        &args.out_commitments[0],
        &args.out_commitments[1],
        &ext.ciphertexts[0],
        &ext.ciphertexts[1],
        &ext.out_ciphertext,
        &new_root,
    ]);
    for nf in &args.nullifiers {
        sol_log_data(&[b"nullifier", nf]);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn move_in<'a>(
    is_native: bool,
    token_program: &AccountInfo<'a>,
    from_authority: &AccountInfo<'a>,
    source: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    vault: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    system: &AccountInfo<'a>,
) -> ProgramResult {
    if amount == 0 {
        return Ok(());
    }
    if is_native {
        invoke(
            &system_instruction::transfer(from_authority.key, vault.key, amount),
            &[from_authority.clone(), vault.clone(), system.clone()],
        )
    } else {
        token::transfer_checked(token_program, source, mint, vault, from_authority, amount, decimals, &[])
    }
}

#[allow(clippy::too_many_arguments)]
fn move_out<'a>(
    is_native: bool,
    token_program: &AccountInfo<'a>,
    pool: &AccountInfo<'a>,
    vault: &AccountInfo<'a>,
    mint: &AccountInfo<'a>,
    destination: &AccountInfo<'a>,
    amount: u64,
    decimals: u8,
    system: &AccountInfo<'a>,
    pool_seeds: &[&[u8]],
) -> ProgramResult {
    if is_native {
        // vault is a system-owned PDA seeded by ["vault", mint]; derive its bump.
        let (_, vb) = Pubkey::find_program_address(&[seeds::VAULT, mint.key.as_ref()], pool.owner);
        invoke_signed(
            &system_instruction::transfer(vault.key, destination.key, amount),
            &[vault.clone(), destination.clone(), system.clone()],
            &[&[seeds::VAULT, mint.key.as_ref(), &[vb]]],
        )
    } else {
        token::transfer_checked(token_program, vault, mint, destination, pool, amount, decimals, &[pool_seeds])
    }
}

// ------------------------------------------------------------------ donate

fn process_donate(program_id: &Pubkey, accounts: &[AccountInfo], amount: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let donor = next_account_info(it)?;
    let donor_source = next_account_info(it)?;
    let pool = next_account_info(it)?;
    let vault = next_account_info(it)?;
    let mint = next_account_info(it)?;
    let token_program = next_account_info(it)?;
    let system = next_account_info(it)?;

    if !donor.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    expect_owned(pool, program_id)?;
    let mut pd = pool.try_borrow_mut_data()?;
    Pool::check(&pd)?;
    if Pool::mint(&pd) != *mint.key || Pool::vault(&pd) != *vault.key {
        return Err(VaultError::AccountMismatch.into());
    }
    if Pool::total_shares(&pd) == 0 {
        // Nothing to accrue to; refuse so donations are never stranded.
        return Err(VaultError::NotInitialized.into());
    }
    let is_native = Pool::is_native(&pd);
    let decimals = Pool::decimals(&pd);
    let new_assets = Pool::total_assets(&pd).checked_add(amount).ok_or(VaultError::Overflow)?;
    let new_in = Pool::total_in(&pd).checked_add(amount).ok_or(VaultError::Overflow)?;
    Pool::set_total_assets(&mut pd, new_assets);
    Pool::set_total_in(&mut pd, new_in);
    drop(pd);
    move_in(is_native, token_program, donor, donor_source, mint, vault, amount, decimals, system)?;
    sol_log_data(&[b"donate", &amount.to_le_bytes()]);
    Ok(())
}

// ------------------------------------------------------------- asp / admin

fn process_update_asp_root(program_id: &Pubkey, accounts: &[AccountInfo], root: [u8; 32]) -> ProgramResult {
    let it = &mut accounts.iter();
    let provider = next_account_info(it)?;
    let asp = next_account_info(it)?;
    let system = next_account_info(it)?;
    if !provider.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    let bump = expect_pda(asp, program_id, &[seeds::ASP, provider.key.as_ref()])?;
    if asp.data_is_empty() {
        create_pda_account(provider, asp, system, program_id, Asp::LEN, &[seeds::ASP, provider.key.as_ref(), &[bump]])?;
        Asp::init(&mut asp.try_borrow_mut_data()?, bump, provider.key);
    }
    expect_owned(asp, program_id)?;
    let mut ad = asp.try_borrow_mut_data()?;
    Asp::check(&ad)?;
    if Asp::provider(&ad) != *provider.key {
        return Err(VaultError::Unauthorized.into());
    }
    Asp::push_root(&mut ad, &root);
    Ok(())
}

fn guardian_only(config: &AccountInfo, guardian: &AccountInfo, program_id: &Pubkey) -> ProgramResult {
    expect_owned(config, program_id)?;
    let cd = config.try_borrow_data()?;
    Config::check(&cd)?;
    if !guardian.is_signer || Config::guardian(&cd) != *guardian.key {
        return Err(VaultError::Unauthorized.into());
    }
    Ok(())
}

fn process_set_shield_paused(program_id: &Pubkey, accounts: &[AccountInfo], paused: bool) -> ProgramResult {
    let it = &mut accounts.iter();
    let guardian = next_account_info(it)?;
    let config = next_account_info(it)?;
    guardian_only(config, guardian, program_id)?;
    Config::set_shield_paused(&mut config.try_borrow_mut_data()?, paused);
    Ok(())
}

fn process_lower_tvl_cap(program_id: &Pubkey, accounts: &[AccountInfo], tvl_cap: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let guardian = next_account_info(it)?;
    let config = next_account_info(it)?;
    let pool = next_account_info(it)?;
    guardian_only(config, guardian, program_id)?;
    expect_owned(pool, program_id)?;
    let mut pd = pool.try_borrow_mut_data()?;
    Pool::check(&pd)?;
    if tvl_cap >= Pool::tvl_cap(&pd) {
        return Err(VaultError::CapNotLower.into());
    }
    Pool::set_tvl_cap(&mut pd, tvl_cap);
    Ok(())
}
