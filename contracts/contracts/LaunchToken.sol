// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title Token minted by the BUNKER launchpad
 * @notice Plain ERC-20, fixed supply minted once to the launchpad, 6 decimals.
 * The shielded pool holds a standing allowance from every account so that a
 * one-time claim key can shield its tokens with a single `transact` call and
 * no prior `approve` (the pool only ever pulls from `msg.sender`, so the
 * allowance cannot be used against anyone who did not call the pool).
 */
contract LaunchToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    /// @notice off-chain metadata (image, description)
    string public uri;
    uint256 public immutable totalSupply;
    address public immutable pool;
    address public immutable launchpad;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) internal _allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(string memory name_, string memory symbol_, string memory uri_, uint8 decimals_, uint256 supply, address pool_, address launchpad_) {
        name = name_;
        symbol = symbol_;
        uri = uri_;
        decimals = decimals_;
        totalSupply = supply;
        pool = pool_;
        launchpad = launchpad_;
        balanceOf[launchpad_] = supply;
        emit Transfer(address(0), launchpad_, supply);
    }

    function allowance(address owner, address spender) public view returns (uint256) {
        if (spender == pool) return type(uint256).max;
        return _allowance[owner][spender];
    }

    function approve(address spender, uint256 value) external returns (bool) {
        _allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        if (msg.sender != pool) {
            uint256 a = _allowance[from][msg.sender];
            if (a != type(uint256).max) {
                if (a < value) revert InsufficientAllowance();
                _allowance[from][msg.sender] = a - value;
            }
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        uint256 b = balanceOf[from];
        if (b < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = b - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
