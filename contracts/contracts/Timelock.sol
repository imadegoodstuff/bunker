// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title BUNKER governance timelock
 * @notice Holds the pool's `governance` role. Every policy change (an entrance
 * hook, a new guardian, a new governance) is queued, waits `delay`, and only
 * then executes: users see it coming and can leave first. The timelock owns no
 * funds and the pool gives it no way to reach any.
 *
 * `admin` queues and cancels (a multisig is the intended holder; the deployer
 * seeds it). Anyone may execute a matured call: once a change is public and
 * aged, nobody should be able to hold it hostage either.
 */
contract Timelock {
    uint256 public constant MIN_DELAY = 1 days;
    uint256 public constant MAX_DELAY = 30 days;
    /// @dev a matured call that is not executed within this window lapses
    uint256 public constant GRACE = 14 days;

    address public admin;
    address public pendingAdmin;
    uint256 public delay;
    /// @notice id => earliest execution time (0 = unknown or done)
    mapping(bytes32 => uint256) public eta;

    event Queued(bytes32 indexed id, address target, uint256 value, bytes data, uint256 eta);
    event Cancelled(bytes32 indexed id);
    event Executed(bytes32 indexed id, address target, uint256 value, bytes data);
    event DelaySet(uint256 delay);
    event AdminProposed(address admin);
    event AdminSet(address admin);

    error Unauthorized();
    error BadDelay();
    error AlreadyQueued();
    error NotQueued();
    error TooEarly();
    error Lapsed();
    error CallFailed(bytes reason);

    constructor(address admin_, uint256 delay_) {
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert BadDelay();
        admin = admin_;
        delay = delay_;
        emit AdminSet(admin_);
        emit DelaySet(delay_);
    }

    receive() external payable {}

    function id(address target, uint256 value, bytes calldata data, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(target, value, data, salt));
    }

    function queue(address target, uint256 value, bytes calldata data, bytes32 salt) external returns (bytes32 h) {
        if (msg.sender != admin) revert Unauthorized();
        h = id(target, value, data, salt);
        if (eta[h] != 0) revert AlreadyQueued();
        uint256 t = block.timestamp + delay;
        eta[h] = t;
        emit Queued(h, target, value, data, t);
    }

    function cancel(bytes32 h) external {
        if (msg.sender != admin) revert Unauthorized();
        if (eta[h] == 0) revert NotQueued();
        delete eta[h];
        emit Cancelled(h);
    }

    /// @notice Run a matured call. Permissionless.
    function execute(address target, uint256 value, bytes calldata data, bytes32 salt) external payable {
        bytes32 h = id(target, value, data, salt);
        uint256 t = eta[h];
        if (t == 0) revert NotQueued();
        if (block.timestamp < t) revert TooEarly();
        if (block.timestamp > t + GRACE) revert Lapsed();
        delete eta[h];
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(h, target, value, data);
    }

    // ---- self-administration: these too go through the queue (target = this)

    function setDelay(uint256 d) external {
        if (msg.sender != address(this)) revert Unauthorized();
        if (d < MIN_DELAY || d > MAX_DELAY) revert BadDelay();
        delay = d;
        emit DelaySet(d);
    }

    /// @dev two-step: queued by the current admin, accepted by the new one
    function proposeAdmin(address a) external {
        if (msg.sender != address(this)) revert Unauthorized();
        pendingAdmin = a;
        emit AdminProposed(a);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || pendingAdmin == address(0)) revert Unauthorized();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminSet(admin);
    }
}
