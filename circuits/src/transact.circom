pragma circom 2.1.6;

include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "merkle.circom";
include "keys.circom";
include "note.circom";

// One shielded action: spend nIns notes, create nOuts notes, and move
// `publicAmount` across the pool boundary. See SPEC.md section 6.
template Transact(nIns, nOuts, levels) {
    // ---- public ----
    signal input root;
    signal input publicAmount;
    signal input asset;
    signal input extDataHash;
    signal input aspRoot;
    signal input nullifiers[nIns];
    signal input outCommitments[nOuts];

    // ---- private: keys ----
    signal input ask;
    signal input nsk;

    // ---- private: spends ----
    signal input inValue[nIns];
    signal input inGd[nIns][2];
    signal input inPkd[nIns][2];
    signal input inRho[nIns];
    signal input inRcm[nIns];
    signal input inPathElements[nIns][levels];
    signal input inPathIndices[nIns][levels];
    signal input inAspPathElements[nIns][levels];
    signal input inAspPathIndices[nIns][levels];

    // ---- private: outputs ----
    signal input outValue[nOuts];
    signal input outGd[nOuts][2];
    signal input outPkd[nOuts][2];
    signal input outRho[nOuts];
    signal input outRcm[nOuts];

    // 1. keys
    component keys = ViewingKeys();
    keys.ask <== ask;
    keys.nsk <== nsk;

    // asp enabled flag: aspRoot != 0
    component aspIsZero = IsZero();
    aspIsZero.in <== aspRoot;
    signal aspEnabled;
    aspEnabled <== 1 - aspIsZero.out;

    // 2..5. spends
    component inCm[nIns];
    component inOwner[nIns];
    component inNf[nIns];
    component inTree[nIns];
    component inAsp[nIns];
    component inValueBits[nIns];
    component inIsDummy[nIns];
    signal inPosition[nIns];
    signal inEnabled[nIns];
    signal inAspEnabled[nIns];

    var inSum = 0;

    for (var i = 0; i < nIns; i++) {
        inOwner[i] = DiversifiedKeyCheck();
        for (var b = 0; b < 250; b++) {
            inOwner[i].ivkBits[b] <== keys.ivkBits[b];
        }
        inOwner[i].gd[0] <== inGd[i][0];
        inOwner[i].gd[1] <== inGd[i][1];
        inOwner[i].pkd[0] <== inPkd[i][0];
        inOwner[i].pkd[1] <== inPkd[i][1];

        inCm[i] = NoteCommitment();
        inCm[i].asset <== asset;
        inCm[i].value <== inValue[i];
        inCm[i].gd[0] <== inGd[i][0];
        inCm[i].gd[1] <== inGd[i][1];
        inCm[i].pkd[0] <== inPkd[i][0];
        inCm[i].pkd[1] <== inPkd[i][1];
        inCm[i].rho <== inRho[i];
        inCm[i].rcm <== inRcm[i];

        // position = sum(pathIndices[k] * 2^k)
        var pos = 0;
        for (var k = 0; k < levels; k++) {
            pos += inPathIndices[i][k] * (1 << k);
        }
        inPosition[i] <== pos;

        inNf[i] = Nullifier();
        inNf[i].nk <== keys.nk;
        inNf[i].rho <== inRho[i];
        inNf[i].position <== inPosition[i];
        inNf[i].nf === nullifiers[i];

        inValueBits[i] = Num2Bits(64);
        inValueBits[i].in <== inValue[i];

        inIsDummy[i] = IsZero();
        inIsDummy[i].in <== inValue[i];
        inEnabled[i] <== 1 - inIsDummy[i].out;

        inTree[i] = MerkleCheck(levels);
        inTree[i].enabled <== inEnabled[i];
        inTree[i].leaf <== inCm[i].cm;
        inTree[i].expectedRoot <== root;
        for (var k = 0; k < levels; k++) {
            inTree[i].pathElements[k] <== inPathElements[i][k];
            inTree[i].pathIndices[k] <== inPathIndices[i][k];
        }

        inAspEnabled[i] <== inEnabled[i] * aspEnabled;
        inAsp[i] = MerkleCheck(levels);
        inAsp[i].enabled <== inAspEnabled[i];
        inAsp[i].leaf <== inCm[i].cm;
        inAsp[i].expectedRoot <== aspRoot;
        for (var k = 0; k < levels; k++) {
            inAsp[i].pathElements[k] <== inAspPathElements[i][k];
            inAsp[i].pathIndices[k] <== inAspPathIndices[i][k];
        }

        inSum += inValue[i];
    }

    // nullifiers must be pairwise distinct (prevents spending one note twice in one tx)
    component nfDistinct[nIns * (nIns - 1) / 2];
    var d = 0;
    for (var i = 0; i < nIns; i++) {
        for (var j = i + 1; j < nIns; j++) {
            nfDistinct[d] = IsEqual();
            nfDistinct[d].in[0] <== nullifiers[i];
            nfDistinct[d].in[1] <== nullifiers[j];
            nfDistinct[d].out === 0;
            d++;
        }
    }

    // 6..7. outputs
    component outCm[nOuts];
    component outValueBits[nOuts];
    component outGdValid[nOuts];
    component outPkdOnCurve[nOuts];
    var outSum = 0;

    for (var j = 0; j < nOuts; j++) {
        outCm[j] = NoteCommitment();
        outCm[j].asset <== asset;
        outCm[j].value <== outValue[j];
        outCm[j].gd[0] <== outGd[j][0];
        outCm[j].gd[1] <== outGd[j][1];
        outCm[j].pkd[0] <== outPkd[j][0];
        outCm[j].pkd[1] <== outPkd[j][1];
        outCm[j].rho <== outRho[j];
        outCm[j].rcm <== outRcm[j];
        outCm[j].cm === outCommitments[j];

        outValueBits[j] = Num2Bits(64);
        outValueBits[j].in <== outValue[j];

        // Output address validity. The circuit cannot check that pk_d belongs
        // to the recipient (it has no access to the recipient's ivk; Sapling
        // has the same limit), and the receiver enforces that by recomputing
        // pk_d = [ivk] g_d and the commitment before accepting a note. What
        // the circuit can and does enforce: g_d is on the curve and not of
        // small order, and pk_d is on the curve, so a note that passes is
        // structurally spendable by whoever holds the matching ivk.
        outGdValid[j] = ValidSubgroupPoint();
        outGdValid[j].p[0] <== outGd[j][0];
        outGdValid[j].p[1] <== outGd[j][1];
        outPkdOnCurve[j] = BabyCheck();
        outPkdOnCurve[j].x <== outPkd[j][0];
        outPkdOnCurve[j].y <== outPkd[j][1];

        outSum += outValue[j];
    }

    // 8. balance
    inSum + publicAmount === outSum;

    // 9. bind extDataHash. A public input that appears in no constraint has a
    // zero IC point in the Groth16 verifying key and is therefore NOT checked
    // by the verifier; this quadratic constraint is what makes the verifier
    // bind ext_data_hash. circomspect flags the intermediate as used once
    // (CS0017); it is allow-listed in circuits/circomspect-allow.json.
    signal extDataSquare;
    extDataSquare <== extDataHash * extDataHash;
}
