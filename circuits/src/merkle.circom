pragma circom 2.1.6;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/mux1.circom";

// Computes the Poseidon Merkle root of `leaf` at the position described by
// `pathIndices` (LSB first) using the sibling nodes in `pathElements`.
template MerkleRoot(levels) {
    signal input leaf;
    signal input pathElements[levels];
    signal input pathIndices[levels];
    signal output root;

    component hashers[levels];
    component mux[levels];

    signal levelHashes[levels + 1];
    levelHashes[0] <== leaf;

    for (var i = 0; i < levels; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;

        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== levelHashes[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== levelHashes[i];
        mux[i].s <== pathIndices[i];

        hashers[i] = Poseidon(2);
        hashers[i].inputs[0] <== mux[i].out[0];
        hashers[i].inputs[1] <== mux[i].out[1];
        levelHashes[i + 1] <== hashers[i].out;
    }

    root <== levelHashes[levels];
}

// Same as MerkleRoot but the check against `expectedRoot` is only enforced
// when `enabled` is 1. Used for dummy (zero-value) spends and for the
// optional association-set proof.
template MerkleCheck(levels) {
    signal input enabled;
    signal input leaf;
    signal input expectedRoot;
    signal input pathElements[levels];
    signal input pathIndices[levels];

    component tree = MerkleRoot(levels);
    tree.leaf <== leaf;
    for (var i = 0; i < levels; i++) {
        tree.pathElements[i] <== pathElements[i];
        tree.pathIndices[i] <== pathIndices[i];
    }

    enabled * (1 - enabled) === 0;
    (tree.root - expectedRoot) * enabled === 0;
}
