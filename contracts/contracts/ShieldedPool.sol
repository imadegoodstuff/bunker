// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoseidonT3} from "poseidon-solidity/PoseidonT3.sol";
import {PoseidonT6} from "poseidon-solidity/PoseidonT6.sol";
import {ITransact2x3Verifier, ITransact4x3Verifier, IBunkerExit, IComplianceHook, IERC20, IERC20Metadata} from "./interfaces.sol";

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
 * v2.1 (this revision; same note format, same tree, same share math):
 *  - Hidden asset in-pool. The asset is a private witness; the proof binds it
 *    to the public `token` only when value crosses the boundary
 *    (`publicAmount != 0`). A private send names no token, so in-pool
 *    transfers do not partition the anonymity set by asset.
 *  - Intent binding. `extDataHash` covers `block.chainid` and this pool's
 *    address, and `ext.validUntil` lets a proof expire: a transact cannot be
 *    replayed on another chain or deployment, nor hoarded.
 *  - `transactBatch`: a relayer lands several proofs in one transaction.
 *  - Compliance seam. Governance (a timelock) may attach a per-token hook
 *    consulted at the entrance only (`publicAmount > 0`); exits are never
 *    gated and the hook can see nothing inside the pool. No hook is set at
 *    deployment.
 *  - Registry accepts post-quantum addresses (shielded address + ML-KEM-768
 *    public key).
 *
 * Everything below the shield/unshield boundary (sender, receiver, amount,
 * which notes were spent, what the relayer earned, and for in-pool transfers
 * the asset) is private; the boundary itself is public, as in Zcash. Not
 * upgradeable: the verifiers are immutable and no role can move funds. The
 * guardian can pause shields and lower (never raise) a pool's TVL cap;
 * governance can set the guardian and the entrance hook; nothing can stop
 * `transact` with `publicAmount <= 0`.
 */
contract ShieldedPool {
    // ---- constants (mirrored in sdk/src/field.ts and sdk/src/pool.ts)

    uint256 public constant VERSION = 2;
    uint256 public constant REVISION = 1;
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
    /// @dev a post-quantum shielded address: ADDRESS_BYTES || ML-KEM-768 encapsulation key (1184 bytes)
    uint256 public constant PQ_ADDRESS_BYTES = 43 + 1184;

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
        /// @dev unix time after which the proof is void (0 = never). Bound by the proof like everything else here.
        uint64 validUntil;
        /// @dev opaque input for the entrance compliance hook (empty when none is set)
        bytes complianceData;
    }

    struct Proof {
        uint256[2] a;
        uint256[2][2] b;
        uint256[2] c;
    }

    /**
     * @param token         pool asset (address(0) = BNB). Ignored, and expected to be address(0), when `publicAmount == 0`.
     * @param root          commitment-tree root the proof was made against (must be in the ring, or become so after an auto-drain)
     * @param publicAmount  signed shares: > 0 shield (msg.sender deposits), < 0 unshield, 0 private send (asset stays hidden)
     * @param aspRoot       association-set root or 0
     * @param aspProvider   whose ring `aspRoot` must be in (ignored when aspRoot == 0)
     * @param nullifiers    2 or 4 nullifiers
     * @param outCommitments the three new leaves: payment, change, relayer fee
     * @param ext           recipient / exit / reshield / ciphertexts / expiry, bound by the proof
     */
    struct TransactArgs {
        Proof proof;
        address token;
        uint256 root;
        int256 publicAmount;
        uint256 aspRoot;
        address aspProvider;
        uint256[] nullifiers;
        uint256[3] outCommitments;
        ExtData ext;
    }

    struct AspRoots {
        uint256[32] roots;
        uint8 next;
        bool exists;
    }

    // ---- state

    ITransact2x3Verifier public immutable verifier2x3;
    ITransact4x3Verifier public immutable verifier4x3;
    /// @notice emergency role: pause shields, lower caps. No delay, no access to funds.
    address public guardian;
    /// @notice policy role (a timelock): sets the guardian and the per-token entrance hook, hands itself on.
    address public governance;
    bool public shieldPaused;
    /// @notice entrance compliance hook per token (address(0) = none). Consulted on shields only.
    mapping(address => address) public complianceHook;

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
    /// `publicAmount == 0` is a private send: `token` is address(0) and says nothing about the notes' asset.
    /// @dev `token` is zero and `publicAmount` is 0 for an in-pool send (the asset stays hidden). `aspRoot` and `sender`
    ///      let association-set providers track lineage: a shield's sender is its depositor, and a transaction that
    ///      proved membership against `aspRoot` hands that standing on to its outputs.
    event Transact(
        address indexed token, uint32 indexed firstIndex, int256 publicAmount, uint256 aspRoot, address sender, uint256[3] commitments, bytes ciphertext0, bytes ciphertext1, bytes ciphertext2, bytes outCiphertext
    );
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
    event GovernanceSet(address governance);
    event ComplianceHookSet(address indexed token, address hook);

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
    error Expired();
    error ComplianceRejected();
    error BatchShield();
    error EmptyBatch();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param emptyLeaf Poseidon(reduce("bunker_empty")), the tree's empty leaf (sdk/src/merkle.ts EMPTY_LEAF_PREIMAGE)
    constructor(address v2x3, address v4x3, address guardian_, address governance_, uint256 emptyLeaf, uint256 nativeTvlCap) {
        verifier2x3 = ITransact2x3Verifier(v2x3);
        verifier4x3 = ITransact4x3Verifier(v4x3);
        guardian = guardian_;
        governance = governance_;
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
    /// Either a classic address (ADDRESS_BYTES) or a post-quantum one (PQ_ADDRESS_BYTES: the same address followed by an ML-KEM-768 encapsulation key).
    function register(bytes calldata shieldedAddress) external {
        if (shieldedAddress.length != 0 && shieldedAddress.length != ADDRESS_BYTES && shieldedAddress.length != PQ_ADDRESS_BYTES) revert BadAddress();
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

    /// @notice What the proof binds: `sha256(abi.encode(block.chainid, address(this), ext)) mod p`. The chain and the
    /// pool are mixed in here rather than carried in calldata, so a proof is void anywhere but on this deployment.
    function extDataHash(ExtData calldata ext) public view returns (uint256) {
        return uint256(sha256(abi.encode(block.chainid, address(this), ext))) % FIELD;
    }

    /// @notice Commitment of a note whose owner is given as `ownerHash = Poseidon(g_d, pk_d)` (what `OpenNote` mints).
    function openNoteCommitment(uint256 asset, uint256 shares, uint256 ownerHash, uint256 rho, uint256 rcm) public pure returns (uint256) {
        return PoseidonT6.hash([asset, shares, ownerHash, rho, rcm]);
    }

    /// @notice One shielded action. See `TransactArgs`.
    function transact(TransactArgs calldata a) external payable nonReentrant {
        _transact(a, msg.value);
    }

    /**
     * @notice Several shielded actions in one transaction (a relayer landing its
     * queue at once). Shields are excluded: they carry value and a depositor,
     * which a batch has no way to attribute. One failing item reverts the batch.
     */
    function transactBatch(TransactArgs[] calldata batch) external nonReentrant {
        if (batch.length == 0) revert EmptyBatch();
        for (uint256 i = 0; i < batch.length; i++) {
            if (batch[i].publicAmount > 0) revert BatchShield();
            _transact(batch[i], 0);
        }
    }

    function _transact(TransactArgs calldata a, uint256 value) internal {
        ExtData calldata ext = a.ext;
        int256 publicAmount = a.publicAmount;
        if (a.nullifiers.length != 2 && a.nullifiers.length != 4) revert MalformedProof();
        if (ext.validUntil != 0 && block.timestamp > ext.validUntil) revert Expired();
        if (!isKnownRoot(a.root)) {
            _drain(AUTO_DRAIN);
            if (!isKnownRoot(a.root)) revert UnknownRoot();
        }
        if (a.aspRoot != 0 && !isKnownAspRoot(a.aspProvider, a.aspRoot)) revert UnknownAspRoot();
        if (publicAmount >= int256(uint256(1) << 64) || publicAmount <= -int256(uint256(1) << 64)) revert PublicAmountOutOfRange();

        // ---- proof. The asset is public only when value crosses the boundary.
        {
            uint256 pa = publicAmount >= 0 ? uint256(publicAmount) : FIELD - uint256(-publicAmount);
            uint256 assetPublic = publicAmount == 0 ? 0 : assetId(a.token);
            uint256 extHash = extDataHash(ext);
            bool ok;
            if (a.nullifiers.length == 2) {
                uint256[10] memory input = [a.root, pa, assetPublic, extHash, a.aspRoot, a.nullifiers[0], a.nullifiers[1], a.outCommitments[0], a.outCommitments[1], a.outCommitments[2]];
                ok = verifier2x3.verifyProof(a.proof.a, a.proof.b, a.proof.c, input);
            } else {
                uint256[12] memory input = [
                    a.root, pa, assetPublic, extHash, a.aspRoot, a.nullifiers[0], a.nullifiers[1], a.nullifiers[2], a.nullifiers[3], a.outCommitments[0], a.outCommitments[1], a.outCommitments[2]
                ];
                ok = verifier4x3.verifyProof(a.proof.a, a.proof.b, a.proof.c, input);
            }
            if (!ok) revert InvalidProof();
        }

        // ---- nullifiers (never deferred)
        for (uint256 i = 0; i < a.nullifiers.length; i++) {
            if (nullifierSpent[a.nullifiers[i]]) revert NullifierSpent();
            for (uint256 j = i + 1; j < a.nullifiers.length; j++) {
                if (a.nullifiers[i] == a.nullifiers[j]) revert NullifierSpent();
            }
            nullifierSpent[a.nullifiers[i]] = true;
            emit Nullified(a.nullifiers[i]);
        }

        // ---- outputs are queued before any external call
        uint32 first = _enqueue(a.outCommitments[0]);
        _enqueue(a.outCommitments[1]);
        _enqueue(a.outCommitments[2]);
        emit Transact(publicAmount == 0 ? address(0) : a.token, first, publicAmount, a.aspRoot, msg.sender, a.outCommitments, ext.ciphertext0, ext.ciphertext1, ext.ciphertext2, ext.outCiphertext);

        // ---- value flow
        if (publicAmount == 0) {
            if (value != 0) revert ValueMismatch();
            return;
        }
        address token = a.token;
        Pool storage pool = _pools[token];
        if (!pool.exists) revert NotInitialized();
        if (publicAmount > 0) {
            if (shieldPaused) revert ShieldPausedError();
            uint256 shares = uint256(publicAmount);
            uint256 amount = amountForMint(pool, shares);
            if (pool.totalAssets + amount > pool.tvlCap) revert TvlCapExceeded();
            address hook = complianceHook[token];
            if (hook != address(0) && !IComplianceHook(hook).onShield(token, msg.sender, amount * pool.unit, ext.complianceData)) revert ComplianceRejected();
            pool.totalAssets += amount;
            pool.totalShares += shares;
            pool.totalIn += amount;
            _moveIn(token, pool.unit, amount, value);
            emit Shield(token, amount);
        } else {
            if (value != 0) revert ValueMismatch();
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
        _moveIn(token, pool.unit, amount, msg.value);
        emit Donate(token, amount);
    }

    // ---- governance (a timelock): policy, never funds

    /// @notice Attach (or clear, with address(0)) the entrance hook of `token`. Only shields consult it.
    function setComplianceHook(address token, address hook) external {
        if (msg.sender != governance) revert Unauthorized();
        complianceHook[token] = hook;
        emit ComplianceHookSet(token, hook);
    }

    /// @notice Hand governance on, or to address(0) to freeze policy forever.
    function setGovernance(address g) external {
        if (msg.sender != governance) revert Unauthorized();
        governance = g;
        emit GovernanceSet(g);
    }

    // ---- guardian: emergency brake, no delay

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

    /// @notice Hand the guardian role on (the guardian itself or governance), or to address(0) to burn it.
    function setGuardian(address g) external {
        if (msg.sender != guardian && msg.sender != governance) revert Unauthorized();
        guardian = g;
        emit GuardianSet(g);
    }

    // ---- transfers

    function _balance(address token) internal view returns (uint256) {
        return token == address(0) ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function _moveIn(address token, uint256 unit, uint256 amount, uint256 value) internal {
        uint256 wei_ = amount * unit;
        if (token == address(0)) {
            if (value < wei_) revert ValueMismatch();
            uint256 back = value - wei_;
            if (back > 0) _sendValue(msg.sender, back);
        } else {
            if (value != 0) revert ValueMismatch();
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
