pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/babyjub.circom";

// Derives (ak, nk, ivk bits) from the spending secrets.
//   ak  = Poseidon(ask)
//   nk  = Poseidon(nsk)
//   ivk = Poseidon(ak, nk) truncated to 250 bits
// 250, not 251: the Baby Jubjub subgroup order l is about 2^250.6, so a
// 251-bit value could exceed l. 250 bits guarantees ivk < l. (Sapling uses
// 251 because Jubjub's l is about 2^251.8; the number is curve-specific.)
// The SDK (sdk/src/keys.ts) applies the same mask; a mismatch would make
// every proof fail at the pk_d check in DiversifiedKeyCheck.
template ViewingKeys() {
    signal input ask;
    signal input nsk;
    signal output nk;
    signal output ivkBits[250];
    // ak is only needed to derive ivk; Transact never reads it, so it is not an output.
    signal ak;

    component hAk = Poseidon(1);
    hAk.inputs[0] <== ask;
    ak <== hAk.out;

    component hNk = Poseidon(1);
    hNk.inputs[0] <== nsk;
    nk <== hNk.out;

    component hIvk = Poseidon(2);
    hIvk.inputs[0] <== ak;
    hIvk.inputs[1] <== nk;

    component bits = Num2Bits_strict();
    bits.in <== hIvk.out;
    for (var i = 0; i < 250; i++) {
        ivkBits[i] <== bits.out[i];
    }
}

// Asserts that a point is on Baby Jubjub and not of small order (cofactor 8):
// [8]P must not be the identity (0, 1). Small-order g_d would make
// pk_d = [ivk] g_d leak ivk mod 8 and makes the Diffie-Hellman in note
// encryption degenerate; honest addresses never have one (GroupHash clears
// the cofactor), so this only ever rejects malicious or corrupted inputs.
template ValidSubgroupPoint() {
    signal input p[2];

    component onCurve = BabyCheck();
    onCurve.x <== p[0];
    onCurve.y <== p[1];

    component d1 = BabyDbl();
    d1.x <== p[0];
    d1.y <== p[1];
    component d2 = BabyDbl();
    d2.x <== d1.xout;
    d2.y <== d1.yout;
    component d3 = BabyDbl();
    d3.x <== d2.xout;
    d3.y <== d2.yout;

    // identity is (0, 1): reject iff xout == 0 AND yout == 1
    component xZero = IsZero();
    xZero.in <== d3.xout;
    component yOne = IsZero();
    yOne.in <== d3.yout - 1;
    xZero.out * yOne.out === 0;
}

// Proves that pk_d = [ivk] g_d on Baby Jubjub and that g_d is a valid
// subgroup point. pk_d is then on the curve by construction.
template DiversifiedKeyCheck() {
    signal input ivkBits[250];
    signal input gd[2];
    signal input pkd[2];

    component valid = ValidSubgroupPoint();
    valid.p[0] <== gd[0];
    valid.p[1] <== gd[1];

    component mul = EscalarMulAny(250);
    for (var i = 0; i < 250; i++) {
        mul.e[i] <== ivkBits[i];
    }
    mul.p[0] <== gd[0];
    mul.p[1] <== gd[1];

    mul.out[0] === pkd[0];
    mul.out[1] === pkd[1];
}
