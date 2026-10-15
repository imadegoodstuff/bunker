// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface ITransact2x2Verifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[9] calldata input) external view returns (bool);
}

interface ITransact4x2Verifier {
    function verifyProof(uint256[2] calldata a, uint256[2][2] calldata b, uint256[2] calldata c, uint256[11] calldata input) external view returns (bool);
}

/// @notice A contract the pool hands unshielded funds to inside the same transaction (SPEC §11).
interface IBunkerExit {
    /// @param token   asset of the pool that paid (address(0) = BNB)
    /// @param amount  what was just delivered to the exit target, in the asset's base units (wei)
    /// @param relayer `msg.sender` of the `transact` call (the relayer, or the user)
    /// @param data    `ext.exitData`, bound by the proof through `extDataHash`
    function onExit(address token, uint256 amount, address relayer, bytes calldata data) external;
}

interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address a) external view returns (uint256);
    function transfer(address to, uint256 v) external returns (bool);
    function transferFrom(address from, address to, uint256 v) external returns (bool);
    function approve(address spender, uint256 v) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
}

interface IERC20Metadata is IERC20 {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

/// PancakeSwap V2 (Uniswap V2 ABI).
interface IPancakeRouter02 {
    function factory() external view returns (address);
    function WETH() external view returns (address);
    function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256 deadline)
        external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external payable;
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
}

interface IPancakeFactory {
    function getPair(address a, address b) external view returns (address);
}

interface IPancakePair {
    function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts);
    function token0() external view returns (address);
}
