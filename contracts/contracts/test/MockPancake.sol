// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "../interfaces.sol";

/// Minimal stand-in for PancakeSwap V2 on local networks: one pair per token,
/// constant-product `addLiquidityETH` against existing reserves, LP minted to `to`.
contract MockWBNB {
    string public constant name = "Wrapped BNB";
    string public constant symbol = "WBNB";
    uint8 public constant decimals = 18;
}

contract MockPair {
    address public token0;
    address public token1;
    uint112 private r0;
    uint112 private r1;
    mapping(address => uint256) public balanceOf;
    uint256 public totalSupply;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (r0, r1, 0);
    }

    function mint(address to, uint256 amountA, uint256 amountB, address tokenA) external returns (uint256 liq) {
        (uint256 a0, uint256 a1) = tokenA == token0 ? (amountA, amountB) : (amountB, amountA);
        liq = totalSupply == 0 ? _sqrt(a0 * a1) : _min((a0 * totalSupply) / r0, (a1 * totalSupply) / r1);
        r0 += uint112(a0);
        r1 += uint112(a1);
        totalSupply += liq;
        balanceOf[to] += liq;
    }

    /// @dev Move reserves for a swap of `amountIn` of `tokenIn` against `amountOut` of the other side.
    function swapReserves(address tokenIn, uint256 amountIn, uint256 amountOut) external {
        if (tokenIn == token0) {
            r0 += uint112(amountIn);
            r1 -= uint112(amountOut);
        } else {
            r1 += uint112(amountIn);
            r0 -= uint112(amountOut);
        }
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }
}

contract MockPancakeFactory {
    mapping(address => mapping(address => address)) public getPair;

    function createPair(address a, address b) external returns (address p) {
        p = address(new MockPair(a, b));
        getPair[a][b] = p;
        getPair[b][a] = p;
    }
}

contract MockPancakeRouter {
    MockPancakeFactory public immutable factoryC;
    address public immutable WETH;

    constructor() {
        factoryC = new MockPancakeFactory();
        WETH = address(new MockWBNB());
    }

    function factory() external view returns (address) {
        return address(factoryC);
    }

    receive() external payable {}

    function addLiquidityETH(address token, uint256 amountTokenDesired, uint256 amountTokenMin, uint256 amountETHMin, address to, uint256)
        external
        payable
        returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)
    {
        address pairAddr = factoryC.getPair(token, WETH);
        if (pairAddr == address(0)) pairAddr = factoryC.createPair(token, WETH);
        MockPair pair = MockPair(pairAddr);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rT, uint256 rE) = pair.token0() == token ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        if (rT == 0 && rE == 0) {
            (amountToken, amountETH) = (amountTokenDesired, msg.value);
        } else {
            uint256 ethOptimal = (amountTokenDesired * rE) / rT;
            if (ethOptimal <= msg.value) {
                require(ethOptimal >= amountETHMin, "INSUFFICIENT_ETH");
                (amountToken, amountETH) = (amountTokenDesired, ethOptimal);
            } else {
                uint256 tokOptimal = (msg.value * rT) / rE;
                require(tokOptimal >= amountTokenMin, "INSUFFICIENT_TOKEN");
                (amountToken, amountETH) = (tokOptimal, msg.value);
            }
        }
        // the router keeps both sides of the liquidity (the pair only tracks reserves), so swaps can pay out
        require(IERC20(token).transferFrom(msg.sender, address(this), amountToken), "TRANSFER_FROM");
        liquidity = pair.mint(to, amountToken, amountETH, token);
        if (msg.value > amountETH) {
            (bool ok,) = msg.sender.call{value: msg.value - amountETH}("");
            require(ok, "REFUND");
        }
    }

    function getAmountsOut(uint256 amountIn, address[] memory path) public view returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        for (uint256 i = 0; i + 1 < path.length; i++) {
            MockPair pair = MockPair(factoryC.getPair(path[i], path[i + 1]));
            (uint112 r0, uint112 r1,) = pair.getReserves();
            (uint256 rIn, uint256 rOut) = pair.token0() == path[i] ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
            uint256 inFee = amounts[i] * 9975;
            amounts[i + 1] = (inFee * rOut) / (rIn * 10_000 + inFee);
        }
    }

    // ---- swaps (single hop is enough for tests; the router itself holds the token side of every pair's liquidity)

    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] calldata path, address to, uint256) external payable {
        require(path.length == 2 && path[0] == WETH, "PATH");
        uint256[] memory amounts = getAmountsOut(msg.value, path);
        require(amounts[1] >= amountOutMin, "SLIPPAGE");
        MockPair(factoryC.getPair(path[0], path[1])).swapReserves(WETH, msg.value, amounts[1]);
        require(IERC20(path[1]).transfer(to, amounts[1]), "OUT");
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256) external {
        require(path.length == 2 && path[1] == WETH, "PATH");
        uint256[] memory amounts = getAmountsOut(amountIn, path);
        require(amounts[1] >= amountOutMin, "SLIPPAGE");
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "IN");
        MockPair(factoryC.getPair(path[0], path[1])).swapReserves(path[0], amountIn, amounts[1]);
        (bool ok,) = to.call{value: amounts[1]}("");
        require(ok, "OUT");
    }

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256) external {
        require(path.length == 2, "PATH");
        uint256[] memory amounts = getAmountsOut(amountIn, path);
        require(amounts[1] >= amountOutMin, "SLIPPAGE");
        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "IN");
        MockPair(factoryC.getPair(path[0], path[1])).swapReserves(path[0], amountIn, amounts[1]);
        require(IERC20(path[1]).transfer(to, amounts[1]), "OUT");
    }

    /// @dev Test helper: seed a token/WBNB pair with reserves (tokens pulled from the caller, BNB attached).
    function seedPair(address token, uint256 tokenAmount) external payable {
        address pairAddr = factoryC.getPair(token, WETH);
        if (pairAddr == address(0)) pairAddr = factoryC.createPair(token, WETH);
        require(IERC20(token).transferFrom(msg.sender, address(this), tokenAmount), "SEED");
        MockPair(pairAddr).mint(msg.sender, tokenAmount, msg.value, token);
    }
}

interface ILaunchpadExit {
    function onExit(address token, uint256 amount, address relayer, bytes calldata data) external;
}

/// Stands in for the shielded pool in launchpad unit tests: delivers funds and calls the exit hook.
contract ExitHarness {
    event PoolCreatedStub(address token, uint8 unitExp, uint256 cap);

    /// @dev proceeds of a sell / swap come back here, as they would to the pool
    receive() external payable {}

    function createPool(address token, uint8 unitExp, uint256 tvlCap) external {
        emit PoolCreatedStub(token, unitExp, tvlCap);
    }

    function exitBnb(address launchpad, bytes calldata data) external payable {
        (bool ok,) = launchpad.call{value: msg.value}("");
        require(ok, "deliver");
        ILaunchpadExit(launchpad).onExit(address(0), msg.value, msg.sender, data);
    }

    function exitToken(address launchpad, address token, uint256 amount, bytes calldata data) external {
        require(IERC20(token).transferFrom(msg.sender, launchpad, amount), "deliver");
        ILaunchpadExit(launchpad).onExit(token, amount, msg.sender, data);
    }
}

/// Plain 18-decimals ERC-20 for pool tests.
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n, string memory s, uint8 d) {
        name = n;
        symbol = s;
        decimals = d;
    }

    function mint(address to, uint256 v) external {
        balanceOf[to] += v;
        totalSupply += v;
    }

    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v;
        return true;
    }

    function transfer(address to, uint256 v) external returns (bool) {
        balanceOf[msg.sender] -= v;
        balanceOf[to] += v;
        return true;
    }

    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        uint256 a = allowance[f][msg.sender];
        if (a != type(uint256).max) allowance[f][msg.sender] = a - v;
        balanceOf[f] -= v;
        balanceOf[to] += v;
        return true;
    }
}

/// Stand-in for the v2 pool in MigrateExit tests: takes exactly `want` wei
/// (or tokens), refunds the rest like `_moveIn`, and can be told to revert.
contract MockShieldPool {
    uint256 public want;
    bool public failNext;
    uint256 public shielded;

    receive() external payable {}

    function setWant(uint256 w) external { want = w; }
    function setFail(bool f) external { failNext = f; }

    function shield(address token) external payable {
        require(!failNext, "SHIELD_FAIL");
        if (token == address(0)) {
            require(msg.value >= want, "VALUE");
            shielded += want;
            uint256 back = msg.value - want;
            if (back > 0) {
                (bool ok,) = msg.sender.call{value: back}("");
                require(ok, "refund");
            }
        } else {
            require(msg.value == 0, "VALUE");
            require(IERC20(token).transferFrom(msg.sender, address(this), want), "pull");
            shielded += want;
        }
    }
}
