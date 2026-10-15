// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT6} from "poseidon-solidity/PoseidonT6.sol";
import {ITransact2x3Verifier, ITransact4x3Verifier, IBunkerExit, IERC20, IERC20Metadata} from "./interfaces.sol";

/**
 * @title BUNKER shielded pool, protocol v2
 * @notice One Poseidon commitment tree (depth 26, 128-root ring) shared by every
 * asset; one `Pool` per asset holding its balance, share rate and turnstile
 * counters; Groth16 `transact` proofs (SPEC §6) verified on-chain.
 *
 * v2 over v1:
 *  - Deferred insertion. `transact` only verifies, burns nullifiers and queues
 *    the new commitments; anyone may `drain` the queue into the tree in one
 *    batch that shares the upper Merkle path. A transact no longer pays for
 *    26 Poseidon rounds per leaf. Double-spend protection is not deferred.
 *  - Three outputs per transact. The third is a note paid to the relayer, so
 *    the relayer fee is private too and private sends can pay a relayer.
 *  - Atomic unshield → call → reshield. An exit hook can hand its proceeds
 *    straight back to the pool; the pool measures the delta and mints a note
 *    for it ("open note": amount public at creation, owner hidden, private
 *    once spent). Launchpad trades and swaps never touch a public address.
 *  - Address registry. An EOA can publish its shielded address, so anyone can
 *    pay 0x… privately without exchanging bunker1… strings out of band.
 *
 * Everything below the shield/unshield boundary (sender, receiver, amount,
 * which notes were spent, what the relayer earned) is private; the boundary
 * itself is public, as in Zcash. Not upgradeable. The guardian can pause
 * shields and lower (never raise) a pool's TVL cap; nothing can stop
 * `transact` with `publicAmount <= 0`.
 */
contract ShieldedPool {
    // ---- constants (mirrored in sdk/src/field.ts and sdk/src/pool.ts)

    uint256 public constant VERSION = 2;
    uint256 public constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint32 public constant LEVELS = 26;
    uint32 public constant ROOT_HISTORY = 128;
    /// @dev most leaves one `drain` inserts; a transact that has to drain first inserts at most AUTO_DRAIN
    uint32 public constant MAX_DRAIN = 512;
    uint32 public constant AUTO_DRAIN = 64;
    /// @dev `V` virtual shares backed by `V` units from creation (SPEC §9).
    uint256 public constant VIRTUAL_OFFSET = 1_000_000;
    uint256 public constant MAX_VALUE = type(uint64).max;
    /// @dev BNB is accounted in gwei inside the pool: 1 unit = 1e9 wei, so a note holds < 2^64 units.
    uint256 public constant NATIVE_UNIT = 1e9;
    /// @dev a shielded address on the wire: d (11 bytes) || compressed pk_d (32 bytes)
    uint256 public constant ADDRESS_BYTES = 43;

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

    /// @dev Where an exit hook's proceeds go: a note for `token` to the owner behind `ownerHash`. `ownerHash == 0` = no reshield.
    struct Reshield {
        address token;
        uint256 ownerHash;
        uint256 rho;
        uint256 rcm;
        bytes ciphertext;
    }

    struct ExtData {
        address recipient;
        address exitTarget; // address(0) = plain unshield
        bytes exitData;
        bytes ciphertext0;
        bytes ciphertext1;
        bytes ciphertext2; // the relayer's fee note
        bytes outCiphertext;
        Reshield reshield;
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

    ITransact2x3Verifier public immutable verifier2x3;
    ITransact4x3Verifier public immutable verifier4x3;
    address public guardian;
    bool public shieldPaused;

    uint256[LEVELS] public zeros;
    uint256[LEVELS] public filledSubtrees;
    uint256[ROOT_HISTORY] public roots;
    uint32 public currentRootIndex;
    /// @notice leaves in the tree; the next drained leaf lands here
    uint32 public insertedIndex;
    /// @notice leaves in the tree plus the queue; the next transact's first output lands here
    uint32 public nextIndex;
    mapping(uint32 => uint256) internal _queue;

    mapping(uint256 => bool) public nullifierSpent;
    mapping(address => Pool) internal _pools;
    mapping(address => AspRoots) internal _asp;
    /// @notice shielded address published by an EOA (empty = none)
    mapping(address => bytes) public registry;

    uint256 private _lock = 1;

    // ---- events (the indexer reads these; SPEC §7)

    event PoolCreated(address indexed token, uint8 decimals, uint256 unit, uint256 tvlCap);
    /// @dev `firstIndex` is the leaf index of commitment0; the three leaves are queued, `Drain` says when they entered the tree.
    event Transact(address indexed token, uint32 indexed firstIndex, uint256[3] commitments, bytes ciphertext0, bytes ciphertext1, bytes ciphertext2, bytes outCiphertext);
    /// @dev A note minted by the pool for an exit hook's proceeds. `shares` is public; who owns it is not.
    event OpenNote(address indexed token, uint32 indexed index, uint256 commitment, uint256 shares, uint256 ownerHash, bytes ciphertext);
    event Drain(uint32 indexed fromIndex, uint32 count, uint256 newRoot, uint32 rootIndex);
    event Registered(address indexed owner, bytes shieldedAddress);
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
    error Unauthorized();
    error TreeFull();
    error Overflow();
    error CapNotLower();
    error AlreadyInitialized();
    error NotInitialized();
    error ShortDelivery();
    error BadUnit();
    error TransferFailed();
    error Reentrancy();
    error ValueMismatch();
    error NotInTransact();
    error BadAddress();
    error AmountTooSmall();
    error NothingQueued();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param emptyLeaf Poseidon(reduce("bunker_empty")), the tree's empty leaf (sdk/src/merkle.ts EMPTY_LEAF_PREIMAGE)
    constructor(address v2x3, address v4x3, address guardian_, uint256 emptyLeaf, uint256 nativeTvlCap) {
        verifier2x3 = ITransact2x3Verifier(v2x3);
        verifier4x3 = ITransact4x3Verifier(v4x3);
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

    /// @dev BNB may only arrive while a transact is running (an exit hook handing proceeds back, see `Reshield`).
    receive() external payable {
        if (_lock != 2) revert NotInTransact();
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

    // ---- registry

    /// @notice Publish the shielded address payments to `msg.sender` should be encrypted to. Overwrites; empty bytes clears.
    function register(bytes calldata shieldedAddress) external {
        if (shieldedAddress.length != 0 && shieldedAddress.length != ADDRESS_BYTES) revert BadAddress();
        registry[msg.sender] = shieldedAddress;
        emit Registered(msg.sender, shieldedAddress);
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

    /// @notice Commitments waiting to enter the tree.
    function pendingCount() public view returns (uint32) {
        return nextIndex - insertedIndex;
    }

    /// @notice A queued commitment by leaf index (0 once drained).
    function queued(uint32 index) external view returns (uint256) {
        return _queue[index];
    }

    /// @dev Reserve the next leaf index and park the commitment there.
    function _enqueue(uint256 commitment) internal returns (uint32 index) {
        index = nextIndex;
        if (index >= uint32(1 << LEVELS) - 1) revert TreeFull();
        _queue[index] = commitment;
        nextIndex = index + 1;
    }

    /**
     * @notice Permissionless: move up to `max` queued commitments into the tree
     * and record one new root. Equivalent to appending them one by one, but
     * every level is hashed once per node instead of once per leaf. Relayers
     * run this as a keeper; a transact whose root is not yet known drains
     * AUTO_DRAIN leaves itself before checking again.
     */
    function drain(uint32 max) external nonReentrant {
        if (max == 0 || pendingCount() == 0) revert NothingQueued();
        _drain(max);
    }

    function _drain(uint32 max) internal {
        uint32 start = insertedIndex;
        uint32 n = nextIndex - start;
        if (n == 0) return;
        if (max > MAX_DRAIN) max = MAX_DRAIN;
        if (n > max) n = max;

        uint256[] memory nodes = new uint256[](n);
        for (uint32 i = 0; i < n; i++) {
            nodes[i] = _queue[start + i];
            delete _queue[start + i];
        }

        uint32 pos = start; // position of nodes[0] at the current level
        uint32 count = n;
        for (uint32 level = 0; level < LEVELS; level++) {
            uint256 leftFill = filledSubtrees[level];
            uint32 last = pos + count - 1;
            // the node at the latest even position of this level is what a later drain pairs against
            if (last & 1 == 0) filledSubtrees[level] = nodes[count - 1];
            else if (count >= 2) filledSubtrees[level] = nodes[count - 2];

            uint32 parentStart = pos >> 1;
            uint32 parentCount = (last >> 1) - parentStart + 1;
            uint256[] memory next = new uint256[](parentCount);
            for (uint32 p = 0; p < parentCount; p++) {
                uint32 lc = (parentStart + p) << 1;
                uint256 l = lc < pos ? leftFill : nodes[lc - pos];
                uint256 r = lc + 1 > last ? zeros[level] : nodes[lc + 1 - pos];
                next[p] = PoseidonT3.hash([l, r]);
            }
            nodes = next;
            count = parentCount;
            pos = parentStart;
        }

        uint32 ri = (currentRootIndex + 1) % ROOT_HISTORY;
        currentRootIndex = ri;
        roots[ri] = nodes[0];
        insertedIndex = start + n;
        emit Drain(start, n, nodes[0], ri);
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

    /// @notice Commitment of a note whose owner is given as `ownerHash = Poseidon(g_d, pk_d)` (what `OpenNote` mints).
    function openNoteCommitment(uint256 asset, uint256 shares, uint256 ownerHash, uint256 rho, uint256 rcm) public pure returns (uint256) {
        return PoseidonT6.hash([asset, shares, ownerHash, rho, rcm]);
    }

    /**
     * @param token         pool asset (address(0) = BNB)
     * @param root          commitment-tree root the proof was made against (must be in the ring, or become so after an auto-drain)
     * @param publicAmount  signed shares: > 0 shield (msg.sender deposits), < 0 unshield, 0 private send
     * @param aspRoot       association-set root or 0
     * @param aspProvider   whose ring `aspRoot` must be in (ignored when aspRoot == 0)
     * @param nullifiers    2 or 4 nullifiers
     * @param outCommitments the three new leaves: payment, change, relayer fee
     * @param ext           recipient / exit / reshield / ciphertexts, bound by the proof
     */
    function transact(
        Proof calldata proof,
        address token,
        uint256 root,
        int256 publicAmount,
        uint256 aspRoot,
        address aspProvider,
        uint256[] calldata nullifiers,
        uint256[3] calldata outCommitments,
        ExtData calldata ext
    ) external payable nonReentrant {
        Pool storage pool = _pools[token];
        if (!pool.exists) revert NotInitialized();
        if (nullifiers.length != 2 && nullifiers.length != 4) revert MalformedProof();
        if (!isKnownRoot(root)) {
            _drain(AUTO_DRAIN);
            if (!isKnownRoot(root)) revert UnknownRoot();
        }
        if (aspRoot != 0 && !isKnownAspRoot(aspProvider, aspRoot)) revert UnknownAspRoot();
        if (publicAmount >= int256(uint256(1) << 64) || publicAmount <= -int256(uint256(1) << 64)) revert PublicAmountOutOfRange();

        // ---- proof
        {
            uint256 pa = publicAmount >= 0 ? uint256(publicAmount) : FIELD - uint256(-publicAmount);
            uint256 asset = assetId(token);
            uint256 extHash = extDataHash(ext);
            bool ok;
            if (nullifiers.length == 2) {
                uint256[10] memory input = [root, pa, asset, extHash, aspRoot, nullifiers[0], nullifiers[1], outCommitments[0], outCommitments[1], outCommitments[2]];
                ok = verifier2x3.verifyProof(proof.a, proof.b, proof.c, input);
            } else {
                uint256[12] memory input = [
                    root, pa, asset, extHash, aspRoot, nullifiers[0], nullifiers[1], nullifiers[2], nullifiers[3], outCommitments[0], outCommitments[1], outCommitments[2]
                ];
                ok = verifier4x3.verifyProof(proof.a, proof.b, proof.c, input);
            }
            if (!ok) revert InvalidProof();
        }

        // ---- nullifiers (never deferred)
        for (uint256 i = 0; i < nullifiers.length; i++) {
            if (nullifierSpent[nullifiers[i]]) revert NullifierSpent();
            for (uint256 j = i + 1; j < nullifiers.length; j++) {
                if (nullifiers[i] == nullifiers[j]) revert NullifierSpent();
            }
            nullifierSpent[nullifiers[i]] = true;
            emit Nullified(nullifiers[i]);
        }

        // ---- outputs are queued before any external call
        uint32 first = _enqueue(outCommitments[0]);
        _enqueue(outCommitments[1]);
        _enqueue(outCommitments[2]);
        emit Transact(token, first, outCommitments, ext.ciphertext0, ext.ciphertext1, ext.ciphertext2, ext.outCiphertext);

        // ---- value flow
        if (publicAmount > 0) {
            if (shieldPaused) revert ShieldPausedError();
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
            if (pool.totalOut + amount > pool.totalIn) revert Turnstile();
            if (shares > pool.totalShares || amount > pool.totalAssets) revert Overflow();
            pool.totalOut += amount;
            pool.totalAssets -= amount;
            pool.totalShares -= shares;
            _moveOut(token, ext.recipient, amount * pool.unit);
            emit Unshield(token, amount);
            if (ext.exitTarget != address(0)) {
                // the funds already sit at `recipient` (normally the exit target itself); let it act on them now,
                // and take whatever it hands back as a new note
                bool reshield = ext.reshield.ownerHash != 0;
                uint256 before = reshield ? _balance(ext.reshield.token) : 0;
                IBunkerExit(ext.exitTarget).onExit(token, amount * pool.unit, msg.sender, ext.exitData);
                if (reshield) _reshield(ext.reshield, _balance(ext.reshield.token) - before);
            }
        } else {
            if (msg.value != 0) revert ValueMismatch();
        }
    }

    /// @dev Credit `receivedWei` of `rs.token` to the pool and queue a note for it owned by `rs.ownerHash`.
    function _reshield(Reshield calldata rs, uint256 receivedWei) internal {
        Pool storage pool = _pools[rs.token];
        if (!pool.exists) revert NotInitialized();
        if (shieldPaused) revert ShieldPausedError();
        uint256 amount = receivedWei / pool.unit; // dust below one unit stays with the pool
        uint256 shares = sharesForDeposit(pool, amount);
        if (shares == 0 || shares > MAX_VALUE) revert AmountTooSmall();
        if (pool.totalAssets + amount > pool.tvlCap) revert TvlCapExceeded();
        pool.totalAssets += amount;
        pool.totalShares += shares;
        pool.totalIn += amount;
        uint256 cm = openNoteCommitment(assetId(rs.token), shares, rs.ownerHash, rs.rho, rs.rcm);
        uint32 index = _enqueue(cm);
        emit Shield(rs.token, amount);
        emit OpenNote(rs.token, index, cm, shares, rs.ownerHash, rs.ciphertext);
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

    function _balance(address token) internal view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

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
