// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {ITransact2x2Verifier, ITransact4x2Verifier, IBunkerExit, IERC20, IERC20Metadata} from "./interfaces.sol";

/**
 * @title BUNKER shielded pool
 * @notice One Poseidon commitment tree (depth 26, 128-root ring) shared by every
 * asset; one `Pool` per asset holding its balance, share rate and turnstile
 * counters; Groth16 `transact` proofs (SPEC §6) verified on-chain. Everything
 * below the shield/unshield boundary (sender, receiver, amount, which notes were
 * spent) is private; the boundary itself is public, as in Zcash.
 *
 * Not upgradeable. The guardian can pause shields and lower (never raise) a
 * pool's TVL cap; nothing can stop `transact` with `publicAmount <= 0`.
 */
contract ShieldedPool {
    // ---- constants (mirrored in sdk/src/field.ts and sdk/src/pool.ts)

    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint32 public constant LEVELS = 26;
    uint32 public constant ROOT_HISTORY = 128;
    /// @dev `V` virtual shares backed by `V` units from creation (SPEC §9).
    uint256 public constant VIRTUAL_OFFSET = 1_000_000;
    uint256 public constant MAX_VALUE = type(uint64).max;
    /// @dev BNB is accounted in gwei inside the pool: 1 unit = 1e9 wei, so a note holds < 2^64 units.
    uint256 public constant NATIVE_UNIT = 1e9;

    // ---- types

    struct Pool {
        bool exists;
        uint8 decimals;
        /// @dev base units (wei) per internal unit; all amounts below are in internal units
        uint256 unit;
        uint256 totalShares;
        uint256 totalAssets;
        uint256 totalIn;
        uint256 totalOut;
        uint256 tvlCap;
    }

    struct ExtData {
        address recipient;
        address relayer;
        uint256 relayerFee; // internal units, taken from a negative publicAmount
        address exitTarget; // address(0) = plain unshield
        bytes exitData;
        bytes ciphertext0;
        bytes ciphertext1;
        bytes outCiphertext;
    }

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    struct AspRoots {
        uint256[32] roots;
        uint8 next;
        bool exists;
    }

    // ---- state

    ITransact2x2Verifier public immutable verifier2x2;
    ITransact4x2Verifier public immutable verifier4x2;
    address public guardian;
    bool public shieldPaused;

    uint256[LEVELS] public zeros;
    uint256[LEVELS] public filledSubtrees;
    uint256[ROOT_HISTORY] public roots;
    uint32 public currentRootIndex;
    uint32 public nextIndex;

    mapping(uint256 => bool) public nullifierSpent;
    mapping(address => Pool) internal _pools;
    mapping(address => AspRoots) internal _asp;

    uint256 private _lock = 1;

    // ---- events (the indexer reads these; SPEC §7)

    event PoolCreated(address indexed token, uint8 decimals, uint256 unit, uint256 tvlCap);
    event Transact(uint32 indexed firstIndex, uint256 commitment0, uint256 commitment1, bytes ciphertext0, bytes ciphertext1, bytes outCiphertext, uint256 newRoot);
    event Nullified(uint256 indexed nullifier);
    event Shield(address indexed token, uint256 amount);
    event Unshield(address indexed token, uint256 amount);
    event Donate(address indexed token, uint256 amount);
    event AspRootPublished(address indexed provider, uint256 root);
    event ShieldPausedSet(bool paused);
    event TvlCapLowered(address indexed token, uint256 cap);
    event GuardianSet(address guardian);

    // ---- errors (sdk/src/errors.ts mirrors these by name)

    error UnknownRoot();
    error UnknownAspRoot();
    error InvalidProof();
    error MalformedProof();
    error NullifierSpent();
    error PublicAmountOutOfRange();
    error ShieldPausedError();
    error TvlCapExceeded();
    error Turnstile();
    error FeeExceedsAmount();
    error Unauthorized();
    error TreeFull();
    error Overflow();
    error AccountMismatch();
    error CapNotLower();
    error AlreadyInitialized();
    error NotInitialized();
    error ShortDelivery();
    error BadUnit();
    error TransferFailed();
    error Reentrancy();
    error ValueMismatch();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param emptyLeaf Poseidon(reduce("bunker_empty")), the tree's empty leaf (sdk/src/merkle.ts EMPTY_LEAF_PREIMAGE)
    constructor(address v2x2, address v4x2, address guardian_, uint256 emptyLeaf, uint256 nativeTvlCap) {
        verifier2x2 = ITransact2x2Verifier(v2x2);
        verifier4x2 = ITransact4x2Verifier(v4x2);
        guardian = guardian_;
        uint256 z = emptyLeaf;
        for (uint32 i = 0; i < LEVELS; i++) {
            zeros[i] = z;
            filledSubtrees[i] = z;
            z = PoseidonT3.hash([z, z]);
        }
        roots[0] = z; // root of the empty tree
        // the BNB pool exists from the start
        _pools[address(0)] = Pool({exists: true, decimals: 18, unit: NATIVE_UNIT, totalShares: 0, totalAssets: 0, totalIn: 0, totalOut: 0, tvlCap: nativeTvlCap});
        emit PoolCreated(address(0), 18, NATIVE_UNIT, nativeTvlCap);
    }

    // ---- pools

    /**
     * @notice Permissionless: open the pool of an ERC-20. `unitExp` fixes the
     * internal unit (10^unitExp wei); it must leave the token's whole supply
     * representable in notes, so it is bounded to [decimals-9, decimals] (min 0).
     * Fee-on-transfer and rebasing tokens are refused at transfer time
     * (`ShortDelivery`), not here: the pool checks every inbound transfer
     * delivered exactly what it credited.
     */
    function createPool(address token, uint8 unitExp, uint256 tvlCap) external nonReentrant {
        if (token == address(0)) revert AlreadyInitialized();
        if (_pools[token].exists) revert AlreadyInitialized();
        uint8 decimals = 18;
        try IERC20Metadata(token).decimals() returns (uint8 d) {
            decimals = d;
        } catch {}
        uint8 minExp = decimals > 9 ? decimals - 9 : 0;
        if (unitExp < minExp || unitExp > decimals) revert BadUnit();
        uint256 unit = 10 ** uint256(unitExp);
        _pools[token] = Pool({exists: true, decimals: decimals, unit: unit, totalShares: 0, totalAssets: 0, totalIn: 0, totalOut: 0, tvlCap: tvlCap});
        emit PoolCreated(token, decimals, unit, tvlCap);
    }

    function pools(address token) external view returns (Pool memory) {
        return _pools[token];
    }

    /// @notice `asset = SHA-256("bunker_asset" || token as 32 bytes) mod p`; BNB is 32 zero bytes (SPEC §8).
    function assetId(address token) public pure returns (uint256) {
        return uint256(sha256(abi.encodePacked("bunker_asset", bytes32(uint256(uint160(token)))))) % FIELD;
    }

    // ---- share math (SPEC §9; mirrored in sdk/src/pool.ts)

    function sharesForDeposit(Pool memory p, uint256 amount) public pure returns (uint256) {
        return (amount * (p.totalShares + VIRTUAL_OFFSET)) / (p.totalAssets + VIRTUAL_OFFSET);
    }

    function amountForMint(Pool memory p, uint256 shares) public pure returns (uint256) {
        uint256 ts = p.totalShares + VIRTUAL_OFFSET;
        return (shares * (p.totalAssets + VIRTUAL_OFFSET) + ts - 1) / ts;
    }

    function amountForBurn(Pool memory p, uint256 shares) public pure returns (uint256) {
        return (shares * (p.totalAssets + VIRTUAL_OFFSET)) / (p.totalShares + VIRTUAL_OFFSET);
    }

    function sharesForWithdraw(Pool memory p, uint256 amount) public pure returns (uint256) {
        uint256 ta = p.totalAssets + VIRTUAL_OFFSET;
        return (amount * (p.totalShares + VIRTUAL_OFFSET) + ta - 1) / ta;
    }

    // ---- tree

    function isKnownRoot(uint256 root) public view returns (bool) {
        if (root == 0) return false;
        uint32 i = currentRootIndex;
        for (uint32 n = 0; n < ROOT_HISTORY; n++) {
            if (roots[i] == root) return true;
            i = i == 0 ? ROOT_HISTORY - 1 : i - 1;
        }
        return false;
    }

    function getLastRoot() external view returns (uint256) {
        return roots[currentRootIndex];
    }

    /// @dev Appends exactly two leaves (every transact has two outputs), hashing the pair directly at level 0.
    function _insertPair(uint256 left, uint256 right) internal returns (uint32 firstIndex, uint256 newRoot) {
        uint32 idx = nextIndex;
        if (idx >= uint32(1 << LEVELS) - 1) revert TreeFull();
        uint256 current = PoseidonT3.hash([left, right]);
        uint32 cur = idx >> 1;
        for (uint32 level = 1; level < LEVELS; level++) {
            uint256 l;
            uint256 r;
            if (cur & 1 == 0) {
                filledSubtrees[level] = current;
                l = current;
                r = zeros[level];
            } else {
                l = filledSubtrees[level];
                r = current;
            }
            current = PoseidonT3.hash([l, r]);
            cur >>= 1;
        }
        uint32 ri = (currentRootIndex + 1) % ROOT_HISTORY;
        currentRootIndex = ri;
        roots[ri] = current;
        nextIndex = idx + 2;
        return (idx, current);
    }

    // ---- association sets (SPEC §10)

    function publishAspRoot(uint256 root) external {
        AspRoots storage a = _asp[msg.sender];
        a.roots[a.next] = root;
        a.next = uint8((a.next + 1) % 32);
        a.exists = true;
        emit AspRootPublished(msg.sender, root);
    }

    function isKnownAspRoot(address provider, uint256 root) public view returns (bool) {
        AspRoots storage a = _asp[provider];
        if (!a.exists || root == 0) return false;
        for (uint256 i = 0; i < 32; i++) {
            if (a.roots[i] == root) return true;
        }
        return false;
    }

    // ---- transact (SPEC §6, §7, §11)

    function extDataHash(ExtData calldata ext) public pure returns (uint256) {
        return uint256(sha256(abi.encode(ext))) % FIELD;
    }

    /**
     * @param token         pool asset (address(0) = BNB)
     * @param root          commitment-tree root the proof was made against (must be in the ring)
     * @param publicAmount  signed shares: > 0 shield (msg.sender deposits), < 0 unshield, 0 private send
     * @param aspRoot       association-set root or 0
     * @param aspProvider   whose ring `aspRoot` must be in (ignored when aspRoot == 0)
     * @param nullifiers    2 or 4 nullifiers
     * @param outCommitments the two new leaves
     * @param ext           recipient / relayer / fee / exit / ciphertexts, bound by the proof
     */
    function transact(
        Proof calldata proof,
        address token,
        uint256 root,
        int256 publicAmount,
        uint256 aspRoot,
        address aspProvider,
        uint256[] calldata nullifiers,
        uint256[2] calldata outCommitments,
        ExtData calldata ext
    ) external payable nonReentrant {
        Pool storage pool = _pools[token];
        if (!pool.exists) revert NotInitialized();
        if (nullifiers.length != 2 && nullifiers.length != 4) revert MalformedProof();
        if (!isKnownRoot(root)) revert UnknownRoot();
        if (aspRoot != 0 && !isKnownAspRoot(aspProvider, aspRoot)) revert UnknownAspRoot();
        if (publicAmount >= int256(uint256(1) << 64) || publicAmount <= -int256(uint256(1) << 64)) revert PublicAmountOutOfRange();

        // ---- proof
        {
            uint256 pa = publicAmount >= 0 ? uint256(publicAmount) : FIELD - uint256(-publicAmount);
            uint256 asset = assetId(token);
            uint256 extHash = extDataHash(ext);
            bool ok;
            if (nullifiers.length == 2) {
                uint256[9] memory input = [root, pa, asset, extHash, aspRoot, nullifiers[0], nullifiers[1], outCommitments[0], outCommitments[1]];
                ok = verifier2x2.verifyProof(proof.a, proof.b, proof.c, input);
            } else {
                uint256[11] memory input =
                    [root, pa, asset, extHash, aspRoot, nullifiers[0], nullifiers[1], nullifiers[2], nullifiers[3], outCommitments[0], outCommitments[1]];
                ok = verifier4x2.verifyProof(proof.a, proof.b, proof.c, input);
            }
            if (!ok) revert InvalidProof();
        }

        // ---- nullifiers
        for (uint256 i = 0; i < nullifiers.length; i++) {
            if (nullifierSpent[nullifiers[i]]) revert NullifierSpent();
            for (uint256 j = i + 1; j < nullifiers.length; j++) {
                if (nullifiers[i] == nullifiers[j]) revert NullifierSpent();
            }
            nullifierSpent[nullifiers[i]] = true;
            emit Nullified(nullifiers[i]);
        }

        // ---- value flow
        if (publicAmount > 0) {
            if (shieldPaused) revert ShieldPausedError();
            if (ext.relayerFee != 0) revert FeeExceedsAmount();
            uint256 shares = uint256(publicAmount);
            uint256 amount = amountForMint(pool, shares);
            if (pool.totalAssets + amount > pool.tvlCap) revert TvlCapExceeded();
            pool.totalAssets += amount;
            pool.totalShares += shares;
            pool.totalIn += amount;
            _moveIn(token, pool.unit, amount);
            emit Shield(token, amount);
        } else if (publicAmount < 0) {
            if (msg.value != 0) revert ValueMismatch();
            uint256 shares = uint256(-publicAmount);
            uint256 amount = amountForBurn(pool, shares);
            if (ext.relayerFee > amount) revert FeeExceedsAmount();
            if (pool.totalOut + amount > pool.totalIn) revert Turnstile();
            if (shares > pool.totalShares || amount > pool.totalAssets) revert Overflow();
            pool.totalOut += amount;
            pool.totalAssets -= amount;
            pool.totalShares -= shares;
            uint256 toRecipient = amount - ext.relayerFee;
            if (ext.relayerFee > 0) _moveOut(token, ext.relayer, ext.relayerFee * pool.unit);
            if (toRecipient > 0) _moveOut(token, ext.recipient, toRecipient * pool.unit);
            if (ext.exitTarget != address(0)) {
                // the funds already sit at `recipient` (normally the exit target itself); let it act on them now
                IBunkerExit(ext.exitTarget).onExit(token, toRecipient * pool.unit, msg.sender, ext.exitData);
            }
            emit Unshield(token, amount);
        } else {
            if (ext.relayerFee != 0) revert FeeExceedsAmount();
            if (msg.value != 0) revert ValueMismatch();
        }

        // ---- append outputs
        (uint32 first, uint256 newRoot) = _insertPair(outCommitments[0], outCommitments[1]);
        emit Transact(first, outCommitments[0], outCommitments[1], ext.ciphertext0, ext.ciphertext1, ext.outCiphertext, newRoot);
    }

    /// @notice Add `amount` units to a pool without minting shares: every existing note is worth more (SPEC §9).
    function donate(address token, uint256 amount) external payable nonReentrant {
        Pool storage pool = _pools[token];
        if (!pool.exists) revert NotInitialized();
        if (pool.totalShares == 0) revert NotInitialized(); // nothing to accrue to; never strand a donation
        pool.totalAssets += amount;
        pool.totalIn += amount;
        _moveIn(token, pool.unit, amount);
        emit Donate(token, amount);
    }

    // ---- guardian

    function setShieldPaused(bool paused) external {
        if (msg.sender != guardian) revert Unauthorized();
        shieldPaused = paused;
        emit ShieldPausedSet(paused);
    }

    function lowerTvlCap(address token, uint256 cap) external {
        if (msg.sender != guardian) revert Unauthorized();
        Pool storage pool = _pools[token];
        if (!pool.exists) revert NotInitialized();
        if (cap >= pool.tvlCap) revert CapNotLower();
        pool.tvlCap = cap;
        emit TvlCapLowered(token, cap);
    }

    /// @notice Hand the guardian role on, or to address(0) to burn it.
    function setGuardian(address g) external {
        if (msg.sender != guardian) revert Unauthorized();
        guardian = g;
        emit GuardianSet(g);
    }

    // ---- transfers

    function _moveIn(address token, uint256 unit, uint256 amount) internal {
        uint256 wei_ = amount * unit;
        if (token == address(0)) {
            if (msg.value < wei_) revert ValueMismatch();
            uint256 back = msg.value - wei_;
            if (back > 0) _sendValue(msg.sender, back);
        } else {
            if (msg.value != 0) revert ValueMismatch();
            if (wei_ == 0) return;
            uint256 before = IERC20(token).balanceOf(address(this));
            _call(token, abi.encodeCall(IERC20.transferFrom, (msg.sender, address(this), wei_)));
            if (IERC20(token).balanceOf(address(this)) - before != wei_) revert ShortDelivery();
        }
    }

    function _moveOut(address token, address to, uint256 wei_) internal {
        if (wei_ == 0) return;
        if (token == address(0)) _sendValue(to, wei_);
        else _call(token, abi.encodeCall(IERC20.transfer, (to, wei_)));
    }

    function _sendValue(address to, uint256 wei_) internal {
        (bool ok,) = payable(to).call{value: wei_}("");
        if (!ok) revert TransferFailed();
    }

    /// @dev ERC-20 call tolerant of missing return values (USDT-style).
    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
