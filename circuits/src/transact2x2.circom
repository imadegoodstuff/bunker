pragma circom 2.1.6;

include "transact.circom";

component main {public [root, publicAmount, asset, extDataHash, aspRoot, nullifiers, outCommitments]} = Transact(2, 2, 26);
