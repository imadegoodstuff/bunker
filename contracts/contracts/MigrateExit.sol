// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBunkerExit, IERC20} from "./interfaces.sol";

/**
 * @title BUNKER v1 -> v2 migration bridge
 * @notice An exit hook for the *protocol-v1* pool. A v1 note owner unshields
 * to this contract (exitTarget = MigrateExit) and, in the same transaction,
 * the delivered funds are shielded into the v2 pool with a v2 shield proof
 * the owner prepared in advance. No EOA ever holds the money, so a v1 note
 * becomes a v2 note without a public hop in between.
 *
 * `exitData` = abi.encode(address refund, bytes v2Calldata) where `v2Calldata`
 * is a complete `ShieldedPool.transact` call for the v2 pool with
 * `publicAmount > 0` (a shield). Any wei the v2 pool hands back (unit dust,
 * or a share price that moved between proving and inclusion) goes to `refund`
 * (the relayer when `refund == address(0)`), so nothing is ever stranded here.
 *
 * Stateless, permissionless, holds nothing between transactions.
 */
contract MigrateExit is IBunkerExit {
    address public immutable v1Pool;
    address public immutable v2Pool;

    error NotFromPool();
    error ShieldFailed(bytes reason);
    error TransferFailed();

    event Migrated(address indexed token, uint256 amount);

    constructor(address v1Pool_, address v2Pool_) {
        v1Pool = v1Pool_;
        v2Pool = v2Pool_;
    }

    /// @dev BNB from the v1 pool (what we migrate) and from the v2 pool (dust it hands back).
    receive() external payable {}

    function onExit(address token, uint256 amount, address relayer, bytes calldata data) external override {
        if (msg.sender != v1Pool) revert NotFromPool();
        (address refund, bytes memory v2Calldata) = abi.decode(data, (address, bytes));
        if (refund == address(0)) refund = relayer;

        bool ok;
        bytes memory reason;
        if (token == address(0)) {
            (ok, reason) = v2Pool.call{value: amount}(v2Calldata);
        } else {
            if (!IERC20(token).approve(v2Pool, amount)) revert TransferFailed();
            (ok, reason) = v2Pool.call(v2Calldata);
            // approve exactly once per migration; never leave an allowance behind
            if (IERC20(token).allowance(address(this), v2Pool) != 0 && !IERC20(token).approve(v2Pool, 0)) revert TransferFailed();
            uint256 left = IERC20(token).balanceOf(address(this));
            if (left != 0 && !IERC20(token).transfer(refund, left)) revert TransferFailed();
        }
        if (!ok) revert ShieldFailed(reason);
        emit Migrated(token, amount);

        uint256 dust = address(this).balance;
        if (dust != 0) {
            (bool sent,) = payable(refund).call{value: dust}("");
            if (!sent) revert TransferFailed();
        }
    }
}
