pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";

// ownerHash = Poseidon(g_d.x, g_d.y, pk_d.x, pk_d.y)
//
// v2 splits the owner out of the commitment so the contract can mint a note
// whose amount is only known on-chain (an "open note": the output of an
// atomic unshield -> call -> reshield) with two Poseidon calls it already has
// libraries for (PoseidonT5 / PoseidonT6). A fresh diversified address per
// open note keeps ownerHash unlinkable across transactions.
template OwnerHash() {
    signal input gd[2];
    signal input pkd[2];
    signal output h;

    component p = Poseidon(4);
    p.inputs[0] <== gd[0];
    p.inputs[1] <== gd[1];
    p.inputs[2] <== pkd[0];
    p.inputs[3] <== pkd[1];
    h <== p.out;
}

// cm = Poseidon(asset, value, ownerHash, rho, rcm)
template NoteCommitment() {
    signal input asset;
    signal input value;
    signal input gd[2];
    signal input pkd[2];
    signal input rho;
    signal input rcm;
    signal output cm;

    component owner = OwnerHash();
    owner.gd[0] <== gd[0];
    owner.gd[1] <== gd[1];
    owner.pkd[0] <== pkd[0];
    owner.pkd[1] <== pkd[1];

    component h = Poseidon(5);
    h.inputs[0] <== asset;
    h.inputs[1] <== value;
    h.inputs[2] <== owner.h;
    h.inputs[3] <== rho;
    h.inputs[4] <== rcm;
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
