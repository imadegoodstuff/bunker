pragma circom 2.1.6;

include "transact.circom";

// v2: 2 spends, 3 outputs (payment, change, private relayer-fee note).
component main {public [root, publicAmount, asset, extDataHash, aspRoot, nullifiers, outCommitments]} = Transact(2, 3, 26);

