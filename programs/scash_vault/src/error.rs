use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum VaultError {
    #[error("invalid instruction data")]
    InvalidInstruction,
    #[error("account already initialized")]
    AlreadyInitialized,
    #[error("account not initialized")]
    NotInitialized,
    #[error("wrong account discriminator")]
    WrongDiscriminator,
    #[error("invalid program-derived address")]
    InvalidPda,
    #[error("unknown merkle root")]
    UnknownRoot,
    #[error("unknown association-set root")]
    UnknownAspRoot,
    #[error("proof verification failed")]
    InvalidProof,
    #[error("malformed proof or public inputs")]
    MalformedProof,
    #[error("nullifier already spent")]
    NullifierSpent,
    #[error("public amount out of range")]
    PublicAmountOutOfRange,
    #[error("shields are paused")]
    ShieldPaused,
    #[error("pool tvl cap exceeded")]
    TvlCapExceeded,
    #[error("turnstile violated: outflow would exceed inflow")]
    Turnstile,
    #[error("relayer fee exceeds amount")]
    FeeExceedsAmount,
    #[error("depositor must sign a shield")]
    DepositorNotSigner,
    #[error("unauthorized")]
    Unauthorized,
    #[error("tree is full")]
    TreeFull,
    #[error("arithmetic overflow")]
    Overflow,
    #[error("wrong asset for pool")]
    WrongAsset,
    #[error("account mismatch")]
    AccountMismatch,
    #[error("tvl cap can only be lowered")]
    CapNotLower,
    #[error("ext data too large")]
    ExtDataTooLarge,
}

impl From<VaultError> for ProgramError {
    fn from(e: VaultError) -> Self {
        ProgramError::Custom(e as u32)
    }
}
