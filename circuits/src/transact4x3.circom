pragma circom 2.1.6;

include "transact.circom";

// v2: 4 spends (consolidation), 3 outputs (payment, change, private relayer-fee note).
component main {public [root, publicAmount, asset, extDataHash, aspRoot, nullifiers, outCommitments]} = Transact(4, 3, 26);

