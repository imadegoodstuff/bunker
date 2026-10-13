//! Fee policy: four agent keys vote, the curve follows the median, one bounded
//! step per epoch, with no human override anywhere.
//!
//! Every launched token has its own votes and its own effective fee. The hard
//! limits below are constants: no instruction can change them, and an agent
//! vote outside them is refused. What the agents decide inside them is theirs.
//!
//! Determinism matters more than speed here: a private trade's `min_out` is
//! fixed when the proof is made, so the fee for epoch `E` must be computable
//! before `E` starts. It is: only votes cast *before* an epoch began count for
//! it, and the step from the previous fee is bounded. `roll` is pure so the
//! SDK mirrors it byte for byte.

use crate::state::{Curve, Vote};

/// Slots per fee epoch (≈ 6 minutes at 400 ms).
pub const EPOCH_SLOTS: u64 = 900;
/// A vote older than this (counted from the start of the epoch being settled) is ignored.
pub const VOTE_TTL_SLOTS: u64 = 4 * EPOCH_SLOTS;
/// Fewer fresh votes than this and the fee stays where it is.
pub const QUORUM: usize = 2;
/// How many epochs' worth of steps a single `roll` may apply after a quiet spell.
pub const MAX_CATCHUP_EPOCHS: u64 = 4;
pub const FEE_MIN_BPS: u16 = 50;
pub const FEE_MAX_BPS: u16 = 300;
pub const FEE_STEP_BPS: u16 = 100;
pub const HOLDER_MIN_BPS: u16 = 5_000;
pub const HOLDER_MAX_BPS: u16 = 10_000;
pub const HOLDER_STEP_BPS: u16 = 1_000;
pub const AGENTS: usize = 4;

pub fn epoch_of(slot: u64) -> u64 {
    slot / EPOCH_SLOTS
}

pub fn vote_in_bounds(fee_bps: u16, holder_bps: u16) -> bool {
    (FEE_MIN_BPS..=FEE_MAX_BPS).contains(&fee_bps) && (HOLDER_MIN_BPS..=HOLDER_MAX_BPS).contains(&holder_bps)
}

fn step_towards(cur: u16, target: u16, step: u16) -> u16 {
    if target > cur {
        cur.saturating_add(step).min(target)
    } else {
        cur.saturating_sub(step).max(target)
    }
}

/// Median of up to four values; an even count averages the middle two (floor).
fn median(mut v: Vec<u16>) -> u16 {
    v.sort_unstable();
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        ((v[n / 2 - 1] as u32 + v[n / 2] as u32) / 2) as u16
    }
}

/// Fresh votes for the epoch starting at `start`: cast before it and not expired.
fn fresh(votes: &[Vote; AGENTS], start: u64) -> impl Iterator<Item = &Vote> {
    votes.iter().filter(move |v| v.slot != 0 && v.slot < start && v.slot.saturating_add(VOTE_TTL_SLOTS) > start)
}

/// The targets the curve is moving towards at the epoch starting at `start`.
pub fn targets(votes: &[Vote; AGENTS], start: u64, cur_fee: u16, cur_holder: u16) -> (u16, u16) {
    let fees: Vec<u16> = fresh(votes, start).map(|v| v.fee_bps).collect();
    if fees.len() < QUORUM {
        return (cur_fee, cur_holder);
    }
    let holders: Vec<u16> = fresh(votes, start).map(|v| v.holder_bps).collect();
    (
        median(fees).clamp(FEE_MIN_BPS, FEE_MAX_BPS),
        median(holders).clamp(HOLDER_MIN_BPS, HOLDER_MAX_BPS),
    )
}

/// Advance the curve's fee policy to the epoch of `slot`. Returns true if anything changed.
pub fn roll(c: &mut Curve, slot: u64) -> bool {
    let epoch = epoch_of(slot);
    if epoch <= c.settled_epoch {
        return false;
    }
    let elapsed = (epoch - c.settled_epoch).min(MAX_CATCHUP_EPOCHS);
    let start = epoch * EPOCH_SLOTS;
    let (tf, th) = targets(&c.votes, start, c.trade_fee_bps, c.holder_share_bps);
    let (f0, h0) = (c.trade_fee_bps, c.holder_share_bps);
    for _ in 0..elapsed {
        c.trade_fee_bps = step_towards(c.trade_fee_bps, tf, FEE_STEP_BPS);
        c.holder_share_bps = step_towards(c.holder_share_bps, th, HOLDER_STEP_BPS);
    }
    c.settled_epoch = epoch;
    c.trade_fee_bps != f0 || c.holder_share_bps != h0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::DISC_CURVE;
    use solana_program::pubkey::Pubkey;

    fn curve(fee: u16, holder: u16, settled_epoch: u64) -> Curve {
        Curve {
            disc: DISC_CURVE, bump: 0, intake_bump: 0, mint: Pubkey::new_unique(), token_vault: Pubkey::new_unique(),
            virtual_sol: 1, virtual_token: 1, real_sol: 0, real_token: 1, fees_accrued: 0, graduated: 0, created_slot: 0,
            total_supply: 1, curve_supply: 1, trade_fee_bps: fee, holder_share_bps: holder, graduation_lamports: 1,
            protocol_treasury: Pubkey::new_unique(), vault_program: Pubkey::new_unique(), buys: 0, sells: 0, sol_volume: 0,
            lookup_table: Pubkey::new_unique(), settled_epoch, votes: [Vote::default(); AGENTS],
        }
    }
    const V: fn(u16, u16, u64) -> Vote = |fee_bps, holder_bps, slot| Vote { fee_bps, holder_bps, slot };

    #[test]
    fn median_is_robust_to_one_outlier() {
        assert_eq!(median(vec![100, 110, 120, 300]), 115);
        assert_eq!(median(vec![50, 200, 210]), 200);
        assert_eq!(median(vec![100, 300]), 200);
    }

    #[test]
    fn no_quorum_means_no_change() {
        let mut c = curve(100, 5000, 0);
        c.votes[0] = V(300, 10_000, 10);
        assert!(!roll(&mut c, EPOCH_SLOTS + 1));
        assert_eq!((c.trade_fee_bps, c.holder_share_bps, c.settled_epoch), (100, 5000, 1));
    }

    #[test]
    fn one_bounded_step_per_epoch_towards_the_median() {
        let mut c = curve(100, 5000, 0);
        c.votes[0] = V(300, 10_000, 10);
        c.votes[1] = V(300, 9_000, 20);
        c.votes[2] = V(250, 8_000, 30);
        // epoch 1: +100 fee, +1000 holder
        assert!(roll(&mut c, EPOCH_SLOTS));
        assert_eq!((c.trade_fee_bps, c.holder_share_bps), (200, 6000));
        // same epoch again: nothing
        assert!(!roll(&mut c, EPOCH_SLOTS + 500));
        // epoch 2: reaches the fee median 300, holder 7000
        assert!(roll(&mut c, 2 * EPOCH_SLOTS));
        assert_eq!((c.trade_fee_bps, c.holder_share_bps), (300, 7000));
    }

    #[test]
    fn votes_count_only_from_the_next_epoch_and_expire() {
        let mut c = curve(100, 5000, 1);
        // cast inside epoch 2: must not count for epoch 2 itself
        c.votes[0] = V(300, 5000, 2 * EPOCH_SLOTS + 1);
        c.votes[1] = V(300, 5000, 2 * EPOCH_SLOTS + 2);
        assert!(!roll(&mut c, 2 * EPOCH_SLOTS + 10));
        assert_eq!(c.trade_fee_bps, 100);
        // epoch 3: they count
        assert!(roll(&mut c, 3 * EPOCH_SLOTS));
        assert_eq!(c.trade_fee_bps, 200);
        // far later: expired, so the fee freezes where it is (catch-up capped too)
        let mut d = curve(100, 5000, 1);
        d.votes[0] = V(300, 5000, 10);
        d.votes[1] = V(300, 5000, 20);
        assert!(!roll(&mut d, 100 * EPOCH_SLOTS));
        assert_eq!(d.trade_fee_bps, 100);
    }

    #[test]
    fn catch_up_is_capped() {
        let mut c = curve(50, 5000, 0);
        c.votes[0] = V(300, 5000, 10);
        c.votes[1] = V(300, 5000, 20);
        // 3 epochs elapsed, vote still fresh (ttl 4 epochs from epoch start 2700): 3 steps → 50+250 capped at 300
        assert!(roll(&mut c, 3 * EPOCH_SLOTS));
        assert_eq!(c.trade_fee_bps, 300);
    }

    #[test]
    fn bounds() {
        assert!(vote_in_bounds(FEE_MIN_BPS, HOLDER_MIN_BPS));
        assert!(vote_in_bounds(FEE_MAX_BPS, HOLDER_MAX_BPS));
        assert!(!vote_in_bounds(FEE_MAX_BPS + 1, HOLDER_MIN_BPS));
        assert!(!vote_in_bounds(FEE_MIN_BPS, HOLDER_MIN_BPS - 1));
    }
}
