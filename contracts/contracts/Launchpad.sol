// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IBunkerExit, IERC20, IPancakeRouter02, IPancakeFactory} from "./interfaces.sol";
import {LaunchToken} from "./LaunchToken.sol";

interface IShieldedPoolLite {
    function createPool(address token, uint8 unitExp, uint256 tvlCap) external;
}

/**
 * @title BUNKER privacy launchpad
 * @notice Constant-product bonding curve with virtual reserves (SPEC §13).
 * Every trade reaches the curve through the shielded pool's exit hook: the
 * trader unshields BNB (buy) or tokens (sell) straight into this contract with
 * a one-time claim key named in `exitData`; the curve pays that key, and the
 * key shields its proceeds back into the pool. The trader's wallet never
 * touches the curve.
 *
 * Fees go to the protocol treasury (the agents' wallet). The fee itself is set
 * per token by the four agent keys, one bounded step per epoch, see
 * `rollPolicy`. At graduation the curve freezes and `migrate` moves everything
 * to a PancakeSwap V2 pair whose LP tokens are burned.
 */
contract Launchpad is IBunkerExit {
    // ---- policy constants (mirrored in sdk/src/launch.ts)

    uint64 public constant EPOCH_BLOCKS = 80; // ≈ 1 minute of BSC blocks
    uint64 public constant VOTE_TTL_BLOCKS = 4 * EPOCH_BLOCKS;
    uint256 public constant QUORUM = 2;
    uint64 public constant MAX_CATCHUP_EPOCHS = 4;
    uint16 public constant FEE_MIN_BPS = 0;
    uint16 public constant FEE_MAX_BPS = 500;
    uint16 public constant FEE_STEP_BPS = 100;
    uint256 public constant AGENTS = 4;

    uint8 public constant EXIT_BUY = 1;
    uint8 public constant EXIT_SELL = 2;

    // ---- types

    struct Params {
        address treasury;
        uint16 tradeFeeBps; // starting fee of every new curve
        uint256 virtualBnb; // wei
        uint256 virtualToken; // base units; > curveSupply
        uint256 curveSupply; // base units for sale on the curve
        uint256 totalSupply; // base units minted; the rest goes to the AMM at migration
        uint256 graduationWei; // real BNB that graduates the curve
        uint8 decimals;
        address[4] agents;
        address router; // PancakeSwap V2 router
    }

    struct Vote {
        uint16 feeBps;
        uint64 blockNumber; // 0 = never voted
    }

    struct Curve {
        address creator;
        uint64 createdBlock;
        uint256 virtualBnb;
        uint256 virtualToken;
        uint256 realBnb;
        uint256 realToken;
        uint256 feesAccrued;
        bool graduated;
        uint16 tradeFeeBps;
        uint64 settledEpoch;
        Vote[4] votes;
        address ammPair;
        uint64 buys;
        uint64 sells;
        uint256 bnbVolume;
    }

    // ---- state

    address public immutable pool;
    Params public params;
    address[] public tokens;
    mapping(address => Curve) internal _curves;
    uint256 private _lock = 1;

    // ---- events

    event Launch(address indexed token, address indexed creator, string name, string symbol, string uri, uint256 virtualBnb, uint256 virtualToken, uint256 curveSupply, uint256 totalSupply, uint256 graduationWei);
    event CurveBuy(address indexed token, uint256 bnbIn, uint256 fee, uint256 tokensOut, uint256 realBnb, uint256 realToken, uint256 virtualToken, address claimKey);
    event CurveSell(address indexed token, uint256 bnbOut, uint256 fee, uint256 tokensIn, uint256 realBnb, uint256 realToken, uint256 virtualToken, address claimKey);
    event Harvest(address indexed token, uint256 amount);
    event FeeVote(address indexed token, uint8 agent, uint16 feeBps, uint64 blockNumber);
    event FeeRoll(address indexed token, uint16 feeBps, uint64 epoch);
    event Graduate(address indexed token, uint256 realBnb, uint256 realToken);
    event Migrate(address indexed token, address pair, uint256 bnbIn, uint256 tokensIn, uint256 liquidity);

    // ---- errors

    error BadParams();
    error NotFromPool();
    error UnknownCurve();
    error Migrated();
    error NotGraduated();
    error NotMigratable();
    error AmountTooSmall();
    error Slippage();
    error SoldOut();
    error InsufficientReserve();
    error Nothing();
    error NotAgent();
    error BadExit();
    error Reentrancy();
    error TransferFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address pool_, Params memory p) {
        if (
            p.treasury == address(0) || p.virtualBnb == 0 || p.curveSupply == 0 || p.virtualToken < p.curveSupply || p.totalSupply < p.curveSupply
                || p.graduationWei == 0 || p.router == address(0) || !voteInBounds(p.tradeFeeBps)
        ) revert BadParams();
        for (uint256 i = 0; i < AGENTS; i++) {
            if (p.agents[i] == address(0)) revert BadParams();
            for (uint256 j = 0; j < i; j++) {
                if (p.agents[i] == p.agents[j]) revert BadParams();
            }
        }
        pool = pool_;
        params = p;
    }

    /// @dev BNB arrives from the pool (unshield into the curve) and from the router (addLiquidityETH refund).
    receive() external payable {
        if (msg.sender != pool && msg.sender != params.router) revert NotFromPool();
    }

    // ---- views

    function curves(address token) external view returns (Curve memory) {
        return _curves[token];
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    /// @dev The auto-generated `params()` getter omits the `agents` array; this returns everything.
    function getParams() external view returns (Params memory) {
        return params;
    }

    /// @notice The curve as it will be after the policy roll for the current block (what a client should quote against).
    function curveRolled(address token) external view returns (Curve memory c) {
        c = _curves[token];
        if (c.createdBlock == 0) revert UnknownCurve();
        _roll(c, uint64(block.number));
    }

    // ---- launch

    function launch(string calldata name, string calldata symbol, string calldata uri) external nonReentrant returns (address token) {
        Params memory p = params;
        LaunchToken t = new LaunchToken(name, symbol, uri, p.decimals, p.totalSupply, pool, address(this));
        token = address(t);
        // the pool for the token: unit = 1 base unit (6 decimals < 9 → exponent 0), no TVL cap
        IShieldedPoolLite(pool).createPool(token, 0, type(uint256).max);
        Curve storage c = _curves[token];
        c.creator = msg.sender;
        c.createdBlock = uint64(block.number);
        c.virtualBnb = p.virtualBnb;
        c.virtualToken = p.virtualToken;
        c.realBnb = 0;
        c.realToken = p.curveSupply;
        c.tradeFeeBps = p.tradeFeeBps;
        c.settledEpoch = uint64(block.number) / EPOCH_BLOCKS;
        tokens.push(token);
        emit Launch(token, msg.sender, name, symbol, uri, p.virtualBnb, p.virtualToken, p.curveSupply, p.totalSupply, p.graduationWei);
    }

    // ---- exit hook: buy / sell

    /**
     * @dev Called by the pool after it delivered `amount` of `token` to this
     * contract. `data` = abi.encode(kind, curveToken, claimKey, minOut, claimBudget, relayerTip):
     * - buy  (token == BNB): `claimBudget` wei stay with the claim key for gas,
     *   `relayerTip` wei go to the relayer; the rest, less the fee, buys tokens
     *   that go to the claim key.
     * - sell (token == launched token): all delivered tokens are sold; the BNB,
     *   less fee and tip, goes to the claim key, which must end up above `claimBudget`.
     */
    struct Exit {
        uint8 kind;
        address token;
        address claimKey;
        uint256 minOut;
        uint256 claimBudget;
        uint256 relayerTip;
    }

    function decodeExit(bytes calldata data) public pure returns (Exit memory e) {
        (e.kind, e.token, e.claimKey, e.minOut, e.claimBudget, e.relayerTip) = abi.decode(data, (uint8, address, address, uint256, uint256, uint256));
    }

    function onExit(address token, uint256 amount, address relayer, bytes calldata data) external override {
        if (msg.sender != pool) revert NotFromPool();
        Exit memory e = decodeExit(data);
        Curve storage c = _curves[e.token];
        if (c.createdBlock == 0) revert UnknownCurve();
        if (e.claimKey == address(0)) revert BadExit();
        _roll(e.token, c, uint64(block.number));
        if (c.graduated) revert Migrated();

        if (e.kind == EXIT_BUY) {
            if (token != address(0)) revert BadExit();
            _buy(c, e, amount, relayer);
        } else if (e.kind == EXIT_SELL) {
            if (token != e.token) revert BadExit();
            _sell(c, e, amount, relayer);
        } else {
            revert BadExit();
        }
        _graduateIfDue(e.token, c);
    }

    function _buy(Curve storage c, Exit memory e, uint256 amount, address relayer) internal {
        uint256 reserve = e.claimBudget + e.relayerTip;
        if (amount <= reserve) revert AmountTooSmall();
        uint256 gross = amount - reserve;
        uint256 fee_ = fee(gross, c.tradeFeeBps);
        (uint256 out, uint256 y2, uint256 net) = buyCapped(c, gross - fee_);
        if (out < e.minOut) revert Slippage();
        uint256 refund = 0;
        if (net < gross - fee_) {
            // the buy that empties the curve pays only for what it got
            fee_ = feeOnNet(net, c.tradeFeeBps);
            refund = gross - net - fee_;
        }
        c.realBnb += net;
        c.feesAccrued += fee_;
        c.virtualToken = y2;
        c.realToken -= out;
        c.buys += 1;
        c.bnbVolume += net;
        _sendToken(e.token, e.claimKey, out);
        if (e.claimBudget + refund > 0) _sendValue(e.claimKey, e.claimBudget + refund);
        if (e.relayerTip > 0) _sendValue(relayer, e.relayerTip);
        emit CurveBuy(e.token, net, fee_, out, c.realBnb, c.realToken, c.virtualToken, e.claimKey);
    }

    function _sell(Curve storage c, Exit memory e, uint256 amount, address relayer) internal {
        if (amount == 0) revert AmountTooSmall();
        (uint256 grossOut, uint256 y2) = sell(c, amount);
        uint256 fee_ = fee(grossOut, c.tradeFeeBps);
        if (grossOut < fee_ + e.relayerTip) revert AmountTooSmall();
        uint256 out = grossOut - fee_ - e.relayerTip;
        if (out < e.minOut) revert Slippage();
        if (out <= e.claimBudget) revert AmountTooSmall();
        c.realBnb -= grossOut;
        c.feesAccrued += fee_;
        c.virtualToken = y2;
        c.realToken += amount;
        c.sells += 1;
        c.bnbVolume += grossOut;
        _sendValue(e.claimKey, out);
        if (e.relayerTip > 0) _sendValue(relayer, e.relayerTip);
        emit CurveSell(e.token, grossOut, fee_, amount, c.realBnb, c.realToken, c.virtualToken, e.claimKey);
    }

    // ---- keeper entry points

    /// @notice Pay the accrued fees to the treasury. After graduation they travel with the curve in `migrate`.
    function harvest(address token) external nonReentrant {
        Curve storage c = _curves[token];
        if (c.createdBlock == 0) revert UnknownCurve();
        _roll(token, c, uint64(block.number));
        if (c.graduated) revert Migrated();
        uint256 f = c.feesAccrued;
        if (f == 0) revert Nothing();
        c.feesAccrued = 0;
        _sendValue(params.treasury, f);
        emit Harvest(token, f);
        _graduateIfDue(token, c);
    }

    /// @notice One of the four agents records its fee vote; it counts from the next epoch.
    function vote(address token, uint16 feeBps) external {
        uint256 idx = AGENTS;
        for (uint256 i = 0; i < AGENTS; i++) {
            if (params.agents[i] == msg.sender) idx = i;
        }
        if (idx == AGENTS) revert NotAgent();
        if (!voteInBounds(feeBps)) revert BadParams();
        Curve storage c = _curves[token];
        if (c.createdBlock == 0) revert UnknownCurve();
        _roll(token, c, uint64(block.number));
        if (c.graduated) revert Migrated();
        c.votes[idx] = Vote({feeBps: feeBps, blockNumber: uint64(block.number)});
        emit FeeVote(token, uint8(idx), feeBps, uint64(block.number));
    }

    /// @notice Settle the fee policy up to the current block (anyone may call; trades do it implicitly).
    function rollPolicy(address token) external {
        Curve storage c = _curves[token];
        if (c.createdBlock == 0) revert UnknownCurve();
        _roll(token, c, uint64(block.number));
    }

    function graduate(address token) external {
        Curve storage c = _curves[token];
        if (c.createdBlock == 0) revert UnknownCurve();
        if (c.graduated || !_shouldGraduate(c)) revert NotGraduated();
        _graduateIfDue(token, c);
    }

    /**
     * @notice Permissionless. Moves a graduated curve to PancakeSwap V2: all of
     * the curve's BNB and every token this contract still holds for it (the
     * unsold remainder plus the supply reserved for the AMM) become the pair's
     * liquidity; the LP tokens go to the dead address. Fees not yet harvested go
     * to the treasury, as does any BNB the router returns when a pre-existing
     * pair forced a different ratio (leftover tokens are burned).
     */
    function migrate(address token) external nonReentrant {
        Curve storage c = _curves[token];
        if (c.createdBlock == 0) revert UnknownCurve();
        if (c.ammPair != address(0)) revert Migrated();
        if (!c.graduated) revert NotMigratable();
        uint256 bnbIn = c.realBnb;
        uint256 tokenIn = IERC20(token).balanceOf(address(this));
        if (bnbIn == 0 || tokenIn == 0) revert InsufficientReserve();
        uint256 fees = c.feesAccrued;
        c.realBnb = 0;
        c.realToken = 0;
        c.feesAccrued = 0;

        IPancakeRouter02 router = IPancakeRouter02(params.router);
        if (!IERC20(token).approve(address(router), tokenIn)) revert TransferFailed();
        uint256 before = address(this).balance - bnbIn;
        (uint256 usedToken,, uint256 liquidity) =
            router.addLiquidityETH{value: bnbIn}(token, tokenIn, 0, 0, address(0xdead), block.timestamp);
        address pair = IPancakeFactory(router.factory()).getPair(token, router.WETH());
        c.ammPair = pair;
        // leftovers: router refunds unused BNB to us; unused tokens are still ours
        uint256 leftoverBnb = address(this).balance - before;
        if (tokenIn > usedToken) _sendToken(token, address(0xdead), tokenIn - usedToken);
        if (fees + leftoverBnb > 0) _sendValue(params.treasury, fees + leftoverBnb);
        emit Migrate(token, pair, bnbIn - leftoverBnb, usedToken, liquidity);
    }

    // ---- curve math (mirrored in sdk/src/launch.ts)

    function buy(Curve memory r, uint256 bnbIn) public pure returns (uint256 out, uint256 y2) {
        if (bnbIn == 0) revert Nothing();
        uint256 x = r.virtualBnb + r.realBnb;
        uint256 y = r.virtualToken;
        uint256 k = x * y;
        uint256 x2 = x + bnbIn;
        y2 = _divCeil(k, x2);
        out = y - y2;
        if (out == 0) revert Nothing();
        if (out > r.realToken) revert SoldOut();
    }

    function sell(Curve memory r, uint256 tokenIn) public pure returns (uint256 out, uint256 y2) {
        if (tokenIn == 0) revert Nothing();
        uint256 x = r.virtualBnb + r.realBnb;
        uint256 y = r.virtualToken;
        uint256 k = x * y;
        y2 = y + tokenIn;
        uint256 x2 = _divCeil(k, y2);
        out = x - x2;
        if (out == 0) revert Nothing();
        if (out > r.realBnb) revert InsufficientReserve();
    }

    function quoteBuyExactOut(Curve memory r, uint256 tokenOut) public pure returns (uint256) {
        if (tokenOut == 0 || tokenOut > r.realToken) revert SoldOut();
        uint256 x = r.virtualBnb + r.realBnb;
        uint256 y = r.virtualToken;
        uint256 k = x * y;
        uint256 y2 = y - tokenOut;
        uint256 x2 = _divCeil(k, y2);
        return x2 - x;
    }

    /// @dev A buy reaching past the last token takes every token left and only the BNB they cost.
    function buyCapped(Curve memory r, uint256 bnbIn) public pure returns (uint256 out, uint256 y2, uint256 used) {
        if (bnbIn == 0) revert Nothing();
        uint256 x = r.virtualBnb + r.realBnb;
        uint256 y = r.virtualToken;
        uint256 k = x * y;
        y2 = _divCeil(k, x + bnbIn);
        out = y - y2;
        if (out == 0) revert Nothing();
        if (out <= r.realToken) return (out, y2, bnbIn);
        used = quoteBuyExactOut(r, r.realToken);
        if (used > bnbIn) used = bnbIn;
        return (r.realToken, r.virtualToken - r.realToken, used);
    }

    function fee(uint256 amount, uint16 bps) public pure returns (uint256) {
        return (amount * bps) / 10_000;
    }

    function feeOnNet(uint256 net, uint16 bps) public pure returns (uint256) {
        return (net * bps) / (10_000 - bps);
    }

    // ---- fee policy (mirrored in sdk/src/launch.ts)

    function voteInBounds(uint16 feeBps) public pure returns (bool) {
        return feeBps >= FEE_MIN_BPS && feeBps <= FEE_MAX_BPS;
    }

    function epochOf(uint64 blockNumber) public pure returns (uint64) {
        return blockNumber / EPOCH_BLOCKS;
    }

    /// @dev Median fee of the fresh votes for the epoch starting at `start`, or `cur` without quorum.
    function feeTarget(Vote[4] memory votes, uint64 start, uint16 cur) public pure returns (uint16) {
        uint16[4] memory v;
        uint256 n = 0;
        for (uint256 i = 0; i < AGENTS; i++) {
            uint64 b = votes[i].blockNumber;
            if (b != 0 && b < start && b + VOTE_TTL_BLOCKS > start) {
                v[n++] = votes[i].feeBps;
            }
        }
        if (n < QUORUM) return cur;
        // insertion sort of ≤ 4 values
        for (uint256 i = 1; i < n; i++) {
            uint16 key = v[i];
            uint256 j = i;
            while (j > 0 && v[j - 1] > key) {
                v[j] = v[j - 1];
                j--;
            }
            v[j] = key;
        }
        uint16 m = n % 2 == 1 ? v[n / 2] : uint16((uint32(v[n / 2 - 1]) + uint32(v[n / 2])) / 2);
        if (m < FEE_MIN_BPS) m = FEE_MIN_BPS;
        if (m > FEE_MAX_BPS) m = FEE_MAX_BPS;
        return m;
    }

    /// @notice Pure form of the roll for off-chain mirrors: (new fee, new settled epoch).
    function rollPure(Curve memory c, uint64 blockNumber) public pure returns (uint16 feeBps, uint64 settledEpoch) {
        _roll(c, blockNumber);
        return (c.tradeFeeBps, c.settledEpoch);
    }

    function _roll(Curve memory c, uint64 blockNumber) internal pure {
        uint64 epoch = epochOf(blockNumber);
        if (epoch <= c.settledEpoch) return;
        uint64 elapsed = epoch - c.settledEpoch;
        if (elapsed > MAX_CATCHUP_EPOCHS) elapsed = MAX_CATCHUP_EPOCHS;
        uint64 start = epoch * EPOCH_BLOCKS;
        uint16 tf = feeTarget(c.votes, start, c.tradeFeeBps);
        for (uint64 i = 0; i < elapsed; i++) {
            c.tradeFeeBps = _stepTowards(c.tradeFeeBps, tf, FEE_STEP_BPS);
        }
        c.settledEpoch = epoch;
    }

    function _roll(address token, Curve storage c, uint64 blockNumber) internal {
        uint64 epoch = epochOf(blockNumber);
        if (epoch <= c.settledEpoch) return;
        uint64 elapsed = epoch - c.settledEpoch;
        if (elapsed > MAX_CATCHUP_EPOCHS) elapsed = MAX_CATCHUP_EPOCHS;
        uint64 start = epoch * EPOCH_BLOCKS;
        uint16 f = c.tradeFeeBps;
        uint16 tf = feeTarget(c.votes, start, f);
        for (uint64 i = 0; i < elapsed; i++) {
            f = _stepTowards(f, tf, FEE_STEP_BPS);
        }
        c.settledEpoch = epoch;
        if (f != c.tradeFeeBps) {
            c.tradeFeeBps = f;
            emit FeeRoll(token, f, epoch);
        }
    }

    function _stepTowards(uint16 cur, uint16 tgt, uint16 step) internal pure returns (uint16) {
        if (tgt > cur) {
            uint32 up = uint32(cur) + step;
            return up > tgt ? tgt : uint16(up);
        }
        uint16 down = cur > step ? cur - step : 0;
        return down < tgt ? tgt : down;
    }

    // ---- internals

    function _shouldGraduate(Curve storage c) internal view returns (bool) {
        return c.realBnb >= params.graduationWei || c.realToken == 0;
    }

    function _graduateIfDue(address token, Curve storage c) internal {
        if (!c.graduated && _shouldGraduate(c)) {
            c.graduated = true;
            emit Graduate(token, c.realBnb, c.realToken);
        }
    }

    function _divCeil(uint256 a, uint256 b) internal pure returns (uint256) {
        return (a + b - 1) / b;
    }

    function _sendValue(address to, uint256 wei_) internal {
        (bool ok,) = payable(to).call{value: wei_}("");
        if (!ok) revert TransferFailed();
    }

    function _sendToken(address token, address to, uint256 amount) internal {
        if (!IERC20(token).transfer(to, amount)) revert TransferFailed();
    }
}