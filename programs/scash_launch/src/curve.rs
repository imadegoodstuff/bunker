//! Constant-product curve with virtual reserves.
//!
//! `x = virtual_sol + real_sol` (lamports), `y = virtual_token` (base units,
//! starts above the tokens actually for sale and falls as they are sold).
//! `k = x·y` is taken from the *current* reserves on every trade, and every
//! division rounds in the curve's favour, so the product never decreases.

use crate::LaunchError;

pub struct Reserves {
    pub virtual_sol: u64,
    pub real_sol: u64,
    pub virtual_token: u64,
    pub real_token: u64,
}

/// Tokens out for `sol_in` lamports and the new virtual token reserve.
pub fn buy(r: &Reserves, sol_in: u64) -> Result<(u64, u64), LaunchError> {
    if sol_in == 0 {
        return Err(LaunchError::Nothing);
    }
    let x = (r.virtual_sol as u128).checked_add(r.real_sol as u128).ok_or(LaunchError::Overflow)?;
    let y = r.virtual_token as u128;
    let k = x.checked_mul(y).ok_or(LaunchError::Overflow)?;
    let x2 = x.checked_add(sol_in as u128).ok_or(LaunchError::Overflow)?;
    let y2 = k.div_ceil(x2);
    let out = y.checked_sub(y2).ok_or(LaunchError::Overflow)?;
    if out == 0 {
        return Err(LaunchError::Nothing);
    }
    if out > r.real_token as u128 {
        return Err(LaunchError::SoldOut);
    }
    Ok((out as u64, y2 as u64))
}

/// Lamports out for `token_in` base units and the new virtual token reserve.
pub fn sell(r: &Reserves, token_in: u64) -> Result<(u64, u64), LaunchError> {
    if token_in == 0 {
        return Err(LaunchError::Nothing);
    }
    let x = (r.virtual_sol as u128).checked_add(r.real_sol as u128).ok_or(LaunchError::Overflow)?;
    let y = r.virtual_token as u128;
    let k = x.checked_mul(y).ok_or(LaunchError::Overflow)?;
    let y2 = y.checked_add(token_in as u128).ok_or(LaunchError::Overflow)?;
    let x2 = k.div_ceil(y2);
    let out = x.checked_sub(x2).ok_or(LaunchError::Overflow)?;
    if out == 0 {
        return Err(LaunchError::Nothing);
    }
    if out > r.real_sol as u128 {
        return Err(LaunchError::InsufficientReserve);
    }
    Ok((out as u64, y2 as u64))
}

/// Lamports needed to buy exactly `token_out` (what a client quotes against).
pub fn quote_buy_exact_out(r: &Reserves, token_out: u64) -> Result<u64, LaunchError> {
    if token_out == 0 || token_out > r.real_token {
        return Err(LaunchError::SoldOut);
    }
    let x = (r.virtual_sol as u128) + (r.real_sol as u128);
    let y = r.virtual_token as u128;
    let k = x * y;
    let y2 = y - token_out as u128;
    let x2 = k.div_ceil(y2);
    Ok((x2 - x) as u64)
}

/// `buy`, except that a buy reaching past the last token takes every token
/// left and only the lamports they cost: `(out, new virtual token, lamports used)`.
/// The buyer gets the rest back. This is how the curve sells out cleanly at
/// graduation instead of refusing the trade that would cross it.
pub fn buy_capped(r: &Reserves, sol_in: u64) -> Result<(u64, u64, u64), LaunchError> {
    match buy(r, sol_in) {
        Ok((out, y2)) => Ok((out, y2, sol_in)),
        Err(LaunchError::SoldOut) => {
            let used = quote_buy_exact_out(r, r.real_token)?;
            Ok((r.real_token, r.virtual_token - r.real_token, used.min(sol_in)))
        }
        Err(e) => Err(e),
    }
}

pub fn fee(amount: u64, bps: u16) -> Result<u64, LaunchError> {
    u64::try_from((amount as u128) * (bps as u128) / 10_000).map_err(|_| LaunchError::Overflow)
}

/// The fee that goes with a net amount: `fee_on_net(net) = fee(gross)` where `gross = net + fee`, rounded down.
pub fn fee_on_net(net: u64, bps: u16) -> Result<u64, LaunchError> {
    u64::try_from((net as u128) * (bps as u128) / (10_000 - bps as u128)).map_err(|_| LaunchError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> Reserves {
        Reserves { virtual_sol: 30_000_000_000, real_sol: 0, virtual_token: 1_073_000_000_000_000, real_token: 793_100_000_000_000 }
    }

    #[test]
    fn product_never_decreases_over_a_random_walk() {
        let mut r = fresh();
        let k0 = (r.virtual_sol as u128 + r.real_sol as u128) * r.virtual_token as u128;
        let mut seed = 0x9e3779b97f4a7c15u64;
        for _ in 0..5_000 {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            let do_buy = (seed & 3) != 0;
            if do_buy || r.real_sol == 0 {
                let sol = 1 + seed % 5_000_000_000;
                if let Ok((out, y2)) = buy(&r, sol) {
                    r.real_sol += sol;
                    r.virtual_token = y2;
                    r.real_token -= out;
                }
            } else {
                let sold = fresh().real_token - r.real_token;
                if sold > 0 {
                    let tok = 1 + seed % sold;
                    if let Ok((out, y2)) = sell(&r, tok) {
                        r.real_sol -= out;
                        r.virtual_token = y2;
                        r.real_token += tok;
                    }
                }
            }
            let k = (r.virtual_sol as u128 + r.real_sol as u128) * r.virtual_token as u128;
            assert!(k >= k0, "k decreased");
        }
    }

    #[test]
    fn round_trip_never_profits() {
        let mut r = fresh();
        for sol in [1u64, 1_000, 1_000_000_000, 10_000_000_000, 80_000_000_000] {
            let (tok, y2) = buy(&r, sol).unwrap();
            r.real_sol += sol;
            r.virtual_token = y2;
            r.real_token -= tok;
            // a tiny position can round to zero on the way back; that is the curve keeping the dust
            let (back, y3) = match sell(&r, tok) {
                Ok(v) => v,
                Err(LaunchError::Nothing) => continue,
                Err(e) => panic!("{e:?}"),
            };
            assert!(back <= sol, "buy {sol} -> {tok} -> sell {back}");
            r.real_sol -= back;
            r.virtual_token = y3;
            r.real_token += tok;
        }
    }

    #[test]
    fn exact_out_quote_is_sufficient_and_tight() {
        let r = fresh();
        for tok in [1_000_000u64, 1_000_000_000_000, 500_000_000_000_000] {
            let need = quote_buy_exact_out(&r, tok).unwrap();
            let (got, _) = buy(&r, need).unwrap();
            assert!(got >= tok);
            if need > 1 {
                let (less, _) = buy(&r, need - 1).unwrap_or((0, 0));
                assert!(less < tok, "one lamport less must not reach the target");
            }
        }
    }

    #[test]
    fn sold_out_and_reserve_limits_hold() {
        let r = fresh();
        assert_eq!(buy(&r, u64::MAX / 4).unwrap_err(), LaunchError::SoldOut);
        assert_eq!(sell(&r, 1_000_000).unwrap_err(), LaunchError::InsufficientReserve);
        assert_eq!(buy(&r, 0).unwrap_err(), LaunchError::Nothing);
    }

    #[test]
    fn graduation_sized_buy_sells_most_of_the_supply() {
        let r = fresh();
        // the generic fixture (30 SOL virtual): 85 SOL takes roughly 3/4 of the curve supply
        let (out, _) = buy(&r, 85_000_000_000).unwrap();
        assert!(out > 700_000_000_000_000 && out < r.real_token, "{out}");
        // the mainnet defaults (7.05838 SOL virtual): 20 SOL takes all but a dust of the curve supply
        let m = Reserves { virtual_sol: 7_058_380_000, ..fresh() };
        let (out, _) = buy(&m, 20_000_000_000).unwrap();
        assert!(out <= m.real_token && m.real_token - out < m.real_token / 10_000, "{out}");
    }

    #[test]
    fn fee_math() {
        assert_eq!(fee(10_000, 100).unwrap(), 100);
        assert_eq!(fee(1, 100).unwrap(), 0);
        assert_eq!(fee(u64::MAX, 10_000).unwrap(), u64::MAX);
        // fee_on_net inverts fee: gross = net + fee_on_net(net) pays fee(gross) (up to rounding)
        for net in [1u64, 999, 1_000_000, 123_456_789_012] {
            let f = fee_on_net(net, 100).unwrap();
            assert!(fee(net + f, 100).unwrap().abs_diff(f) <= 1, "{net}");
        }
    }

    #[test]
    fn the_last_buy_is_capped_and_pays_only_for_what_it_gets() {
        // mainnet defaults: 7.05838 SOL virtual, graduation at 20 SOL, the curve sells out right there
        let r = Reserves { virtual_sol: 7_058_380_000, real_sol: 0, virtual_token: 1_073_000_000_000_000, real_token: 793_100_000_000_000 };
        assert_eq!(buy(&r, 25_000_000_000).unwrap_err(), LaunchError::SoldOut);
        let (out, y2, used) = buy_capped(&r, 25_000_000_000).unwrap();
        assert_eq!(out, r.real_token);
        assert_eq!(y2, r.virtual_token - r.real_token);
        assert!(used > 19_990_000_000 && used < 20_010_000_000, "sells out at ≈20 SOL: {used}");
        // the product never decreases through the capped path either, and one lamport less does not empty the curve
        let (x, y) = (r.virtual_sol as u128 + r.real_sol as u128, r.virtual_token as u128);
        assert!((x + used as u128) * y2 as u128 >= x * y);
        let (o1, _) = buy(&r, used - 1_000_000).unwrap();
        assert!(o1 < r.real_token);
        // a buy that does not cross is unchanged
        let (o, y, u) = buy_capped(&r, 1_000_000_000).unwrap();
        assert_eq!((o, y), buy(&r, 1_000_000_000).unwrap());
        assert_eq!(u, 1_000_000_000);
    }
}
