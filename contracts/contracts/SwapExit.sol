// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBunkerExit, IERC20, IPancakeRouter02} from "./interfaces.sol";

interface IPancakeRouterSwaps is IPancakeRouter02 {
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external;
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external;
}

/**
 * @title BUNKER private swap
 * @notice An exit hook that swaps whatever the pool unshields into it on
 * PancakeSwap V2 and sends the output straight back to the pool, which mints
 * the trader a note for it in the same transaction. On-chain one sees "the
 * pool swapped"; who did, and what they now hold, stays inside the pool.
 *
 * `exitData` = abi.encode(address[] path, uint256 minOut). `path[0]` must be
 * WBNB when the pool paid BNB and the unshielded token otherwise; the last
 * element is the asset of the trader's new note (WBNB = BNB). Stateless and
 * permissionless; holds nothing between transactions.
 */
contract SwapExit is IBunkerExit {
    address public immutable pool;
    IPancakeRouterSwaps public immutable router;
    address public immutable wbnb;

    error NotFromPool();
    error BadPath();
    error TransferFailed();

    constructor(address pool_, address router_) {
        pool = pool_;
        router = IPancakeRouterSwaps(router_);
        wbnb = IPancakeRouterSwaps(router_).WETH();
    }

    /// @dev BNB from the pool (what we swap) and from the router (what we swapped into).
    receive() external payable {}

    function onExit(address token, uint256 amount, address, bytes calldata data) external override {
        if (msg.sender != pool) revert NotFromPool();
        (address[] memory path, uint256 minOut) = abi.decode(data, (address[], uint256));
        if (path.length < 2) revert BadPath();
        address last = path[path.length - 1];
        if (token == address(0)) {
            if (path[0] != wbnb || last == wbnb) revert BadPath();
            router.swapExactETHForTokensSupportingFeeOnTransferTokens{value: amount}(minOut, path, pool, block.timestamp);
        } else {
            if (path[0] != token) revert BadPath();
            if (!IERC20(token).approve(address(router), amount)) revert TransferFailed();
            if (last == wbnb) {
                router.swapExactTokensForETHSupportingFeeOnTransferTokens(amount, minOut, path, address(this), block.timestamp);
                (bool ok,) = payable(pool).call{value: address(this).balance}("");
                if (!ok) revert TransferFailed();
            } else {
                router.swapExactTokensForTokensSupportingFeeOnTransferTokens(amount, minOut, path, pool, block.timestamp);
            }
        }
    }
}
