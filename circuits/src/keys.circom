pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/escalarmulany.circom";
include "circomlib/circuits/babyjub.circom";

// Derives (ak, nk, ivk bits) from the spending secrets.
//   ak  = Poseidon(ask)
//   nk  = Poseidon(nsk)
//   ivk = Poseidon(ak, nk) truncated to 251 bits
template ViewingKeys() {
    signal input ask;
    signal input nsk;
    signal output ak;
    signal output nk;
    signal output ivkBits[251];

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
    for (var i = 0; i < 251; i++) {
        ivkBits[i] <== bits.out[i];
    }
}

// Proves that pk_d = [ivk] g_d on Baby Jubjub and that g_d is on the curve.
template DiversifiedKeyCheck() {
    signal input ivkBits[251];
    signal input gd[2];
    signal input pkd[2];

    component onCurve = BabyCheck();
    onCurve.x <== gd[0];
    onCurve.y <== gd[1];

    component mul = EscalarMulAny(251);
    for (var i = 0; i < 251; i++) {
        mul.e[i] <== ivkBits[i];
    }
    mul.p[0] <== gd[0];
    mul.p[1] <== gd[1];

    mul.out[0] === pkd[0];
    mul.out[1] === pkd[1];
}
