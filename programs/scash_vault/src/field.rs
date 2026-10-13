//! Minimal big-endian 256-bit helpers for the BN254 scalar field.

/// BN254 scalar field modulus, big-endian.
pub const P_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58, 0x5d,
    0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00, 0x00, 0x01,
];

pub fn cmp_be(a: &[u8; 32], b: &[u8; 32]) -> core::cmp::Ordering {
    for i in 0..32 {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    core::cmp::Ordering::Equal
}

/// a - b, assuming a >= b.
pub fn sub_be(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut borrow = 0i16;
    for i in (0..32).rev() {
        let mut v = a[i] as i16 - b[i] as i16 - borrow;
        if v < 0 {
            v += 256;
            borrow = 1;
        } else {
            borrow = 0;
        }
        out[i] = v as u8;
    }
    out
}

/// Reduce a 256-bit big-endian integer modulo p (2^256 / p < 6).
pub fn reduce_be(x: &[u8; 32]) -> [u8; 32] {
    let mut v = *x;
    while cmp_be(&v, &P_BE) != core::cmp::Ordering::Less {
        v = sub_be(&v, &P_BE);
    }
    v
}

pub fn is_zero(x: &[u8; 32]) -> bool {
    x.iter().all(|b| *b == 0)
}

/// Decode a field element that encodes a signed 64-bit amount:
/// `v` for `0 <= v < 2^64`, `p - v` for `-2^64 < -v < 0`.
/// Encode a signed amount as the field element the circuit expects:
/// `v` for v >= 0, `p - |v|` for v < 0.
pub fn encode_signed(v: i64) -> [u8; 32] {
    if v >= 0 {
        u64_to_be32(v as u64)
    } else {
        sub_be(&P_BE, &u64_to_be32(v.unsigned_abs()))
    }
}

pub fn u64_to_be32(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

pub fn decode_signed_u64(x: &[u8; 32]) -> Option<i128> {
    if cmp_be(x, &P_BE) != core::cmp::Ordering::Less {
        return None;
    }
    if x[..24].iter().all(|b| *b == 0) {
        return Some(u64::from_be_bytes(x[24..].try_into().unwrap()) as i128);
    }
    let neg = sub_be(&P_BE, x);
    if neg[..24].iter().all(|b| *b == 0) {
        return Some(-(u64::from_be_bytes(neg[24..].try_into().unwrap()) as i128));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signed_roundtrip() {
        assert_eq!(decode_signed_u64(&u64_to_be32(5)), Some(5));
        assert_eq!(decode_signed_u64(&encode_signed(-9)), Some(-9));
        assert_eq!(decode_signed_u64(&encode_signed(i64::MAX)), Some(i64::MAX as i128));
        let neg = sub_be(&P_BE, &u64_to_be32(7));
        assert_eq!(decode_signed_u64(&neg), Some(-7));
        assert_eq!(decode_signed_u64(&P_BE), None);
    }

    #[test]
    fn reduce() {
        let mut big = [0xffu8; 32];
        let r = reduce_be(&big);
        assert_eq!(cmp_be(&r, &P_BE), core::cmp::Ordering::Less);
        big = P_BE;
        assert!(is_zero(&reduce_be(&big)));
    }
}
