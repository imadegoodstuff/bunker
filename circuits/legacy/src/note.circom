pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

// cm = Poseidon(asset, value, g_d.x, g_d.y, pk_d.x, pk_d.y, rho, rcm)
template NoteCommitment() {
    signal input asset;
    signal input value;
    signal input gd[2];
    signal input pkd[2];
    signal input rho;
    signal input rcm;
    signal output cm;

    component h = Poseidon(8);
    h.inputs[0] <== asset;
    h.inputs[1] <== value;
    h.inputs[2] <== gd[0];
    h.inputs[3] <== gd[1];
    h.inputs[4] <== pkd[0];
    h.inputs[5] <== pkd[1];
    h.inputs[6] <== rho;
    h.inputs[7] <== rcm;
    cm <== h.out;
}

// nf = Poseidon(nk, rho, position)
template Nullifier() {
    signal input nk;
    signal input rho;
    signal input position;
    signal output nf;

    component h = Poseidon(3);
    h.inputs[0] <== nk;
    h.inputs[1] <== rho;
    h.inputs[2] <== position;
    nf <== h.out;
}
