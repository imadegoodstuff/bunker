// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// Test double: accepts every proof, so pool tests can exercise queueing and draining without proving.
contract AlwaysVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[10] calldata) external pure returns (bool) {
        return true;
    }

    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[12] calldata) external pure returns (bool) {
        return true;
    }
}
