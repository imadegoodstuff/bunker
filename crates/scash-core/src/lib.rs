//! Types shared by the on-chain program, the relayer and tests.
//! Layouts here are normative; the TypeScript SDK mirrors them byte for byte.

use borsh::{BorshDeserialize, BorshSerialize};

pub const TREE_DEPTH: usize = 26;
pub const ROOT_HISTORY: usize = 128;
pub const ASP_ROOT_HISTORY: usize = 32;
pub const MAX_INPUTS: usize = 4;
pub const OUTPUTS: usize = 2;
pub const PROOF_LEN: usize = 256;

/// Seeds for program-derived addresses.
pub mod seeds {
    pub const CONFIG: &[u8] = b"config";
    pub const TREE: &[u8] = b"tree";
    pub const POOL: &[u8] = b"pool";
    pub const VAULT: &[u8] = b"vault";
    pub const NULLIFIER: &[u8] = b"nf";
    pub const ASP: &[u8] = b"asp";
    pub const EXIT: &[u8] = b"exit";
}

/// Public data bound to a proof through `ext_data_hash = sha256(borsh(ExtData)) mod p`.
#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct ExtData {
    pub recipient: [u8; 32],
    pub relayer: [u8; 32],
    pub relayer_fee: u64,
    pub exit_target: [u8; 32],
    pub exit_data: Vec<u8>,
    pub ciphertexts: Vec<Vec<u8>>,
    pub out_ciphertext: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub struct TransactArgs {
    /// Groth16 proof: -A (64) || B (128) || C (64), big-endian coordinates.
    pub proof: Vec<u8>,
    /// Index into the tree's root ring; the program reads the root itself.
    pub root_index: u8,
    /// Signed shares: + shield, - unshield, 0 private send. Encoded to a field element on-chain.
    pub public_amount: i64,
    /// Association-set root, if the proof was made against one.
    pub asp_root: Option<[u8; 32]>,
    pub nullifiers: Vec<[u8; 32]>,
    pub out_commitments: Vec<[u8; 32]>,
    pub ext_data: ExtData,
}

#[derive(Clone, Debug, PartialEq, Eq, BorshSerialize, BorshDeserialize)]
pub enum VaultInstruction {
    /// Create the global config and the shared commitment tree.
    /// Accounts: [payer s, config w, tree w, system]
    Initialize { guardian: [u8; 32] },

    /// Create a pool for a mint (or the native mint, 11111111111111111111111111111111).
    /// Accounts: [payer s, config, pool w, vault w, mint, token_program, system, rent]
    CreatePool { tvl_cap: u64 },

    /// Verify a proof and apply it.
    /// Accounts: see `programs/scash_vault/src/processor.rs::process_transact`.
    Transact(TransactArgs),

    /// Add assets to a pool without minting shares.
    /// Accounts: [donor s, donor_token w, pool w, vault w, mint, token_program]
    Donate { amount: u64 },

    /// Publish an association-set root. Signer is the provider.
    /// Accounts: [provider s, asp w, system]
    UpdateAspRoot { root: [u8; 32] },

    /// Guardian: pause or resume shields (positive public amounts). Never affects spends.
    /// Accounts: [guardian s, config w]
    SetShieldPaused { paused: bool },

    /// Guardian: lower a pool's TVL cap. Raising is impossible.
    /// Accounts: [guardian s, config, pool w]
    LowerTvlCap { tvl_cap: u64 },
}

/// Number of public inputs the verifier expects for `n_ins` spends and 2 outputs.
pub const fn public_input_count(n_ins: usize) -> usize {
    5 + n_ins + OUTPUTS
}
