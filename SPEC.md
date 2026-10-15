# BUNKER protocol specification

Version 0.2 (draft). This document is normative for the circuits in `circuits/`, the contracts in `contracts/contracts/`, and the client library in `sdk/`.

BUNKER is a shielded-note system on BNB Smart Chain. It follows the Zcash Sapling construction (notes, commitments, nullifiers, diversified addresses, incoming/outgoing viewing keys) and adapts it to what the EVM verifies cheaply: Groth16 over BN254 through the `ecAdd`/`ecMul`/`ecPairing` precompiles, Poseidon in Solidity (`poseidon-solidity`), and one contract call per private action.

Everything below the "boundary" (shield in, unshield out) is private: sender, receiver, amount, and which notes were spent. Everything at the boundary is public, as it is in Zcash. The pool additionally enforces a per-asset turnstile so that no soundness bug in the proof system can ever release more of an asset than was deposited.

## 1. Notation

- `p` is the BN254 scalar field modulus, `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- `Poseidon_t(x_1..x_n)` is the Poseidon permutation over `F_p` with the circomlib parameters for `t = n + 1`. On-chain only `t = 3` (two inputs, tree hashing) is needed; it is `PoseidonT3` from `poseidon-solidity`, deployed through the deterministic deployment proxy at `0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93` on every EVM chain. All hashes in this document are Poseidon unless stated otherwise.
- `BJJ` is the Baby Jubjub twisted Edwards curve over `F_p`, subgroup order `l = 2736030358979909402780800718157159386076813972158567259200215660948447373041`, cofactor 8.
- `H_blake(domain, ...)` is BLAKE2b-512 with a 16-byte personalization string.
- Integers are encoded big-endian when they are field elements; ABI encoding follows Solidity.

## 2. Keys

A wallet owns one spending key and derives everything else from it. Derivation is deterministic so that the same wallet reproduces the same keys on any device.

```
sk      : 32 bytes.
          sk = scrypt(password = sig || NFKC(passphrase),
                      salt     = "bunker:v1:wallet-seed",
                      N = 2^15, r = 8, p = 1, dkLen = 32)
          where sig is the wallet's EIP-191 signature over SPENDING_KEY_MESSAGE
          (sdk/src/keys.ts; a multi-line text that states what it derives)
          and passphrase is a user secret (empty only with explicit opt-in).
          sk may also be imported directly from a "bunkerseed1" + hex backup.

ask     = to_scalar(H_blake("bunkerExpandSeed", sk || 0x00))   spend authorizing key
nsk     = to_scalar(H_blake("bunkerExpandSeed", sk || 0x01))   nullifier deriving key
ovk     = H_blake("bunkerExpandSeed", sk || 0x02)[0..32]        outgoing viewing key

ak      = Poseidon(ask)                                           spend validating key
nk      = Poseidon(nsk)                                           nullifier key
ivk     = Poseidon(ak, nk) mod 2^250                              incoming viewing key
```

`to_scalar` reduces the 64-byte hash modulo `p`. `ivk` is truncated to **250** bits: the Baby Jubjub prime-subgroup order is `l ≈ 2^250.6`, so `2^250 < l < 2^251` and a 250-bit value is always a valid scalar below `l`. Ephemeral scalars `esk` (§12) use the same mask plus rejection of 0. The SDK (`SCALAR_MASK` in `sdk/src/keys.ts`) and the circuit (`ViewingKeys`/`DiversifiedKeyCheck` in `circuits/src/keys.circom`) both use 250 bits; `sdk.test.ts` asserts `ivk < l` over many seeds, and because the circuit re-derives `ivk` from `(ask, nsk)` and checks `pk_d = [ivk]·g_d` against the note, any width mismatch between SDK and circuit makes every proof fail.

| Key | Can spend | Can see incoming notes | Can see outgoing notes | Can derive addresses |
|---|---|---|---|---|
| `sk` | yes | yes | yes | yes |
| full viewing key `(ak, nk, ovk)` | no | yes | yes | yes |
| incoming viewing key `ivk` | no | yes | no | yes |
| outgoing viewing key `ovk` | no | no | yes | no |

This is the Sapling hierarchy minus the re-randomized spend-authorization signature: because a relayer (or the user's own EOA) is the only transaction signer, authorization is proven inside the circuit by knowledge of `ask`, bound to `ext_data_hash`.

**Why a passphrase.** Any web page can ask a connected wallet to sign arbitrary text, and most wallets will sign it after showing the text. A signature-only derivation therefore hands the spending key to any page that can phish one signature. The passphrase is a second factor the page never sees; scrypt makes each guess at it cost about 100 ms. The app refuses passphrases scoring under `PASSPHRASE_MIN_BITS` and requires an explicit acknowledgement to proceed without one. See `SECURITY.md` §1.

- *Single derivation path.* `seedFromSignature` is the only function that turns a signature into `sk`; every other key is derived from `sk` by `ShieldedWallet.fromSeed`. There is no viewing-key or recovery path that skips the passphrase. The passphrase is not stored anywhere, not even hashed.
- *Loss.* Wallet signature + passphrase, or the `bunkerseed1` backup, each reproduce `sk`. Losing the passphrase without a backup means the notes are unspendable; nobody can reset it.
- *Offline guessing.* An attacker holding the signature can test passphrases offline at one scrypt call each (≈100 ms on a desktop core). Without the signature the passphrase is useless, so the attacker needs both.
- *Cross-site linkage.* secp256k1 signatures made by common wallets are deterministic (RFC 6979), so the signature over `SPENDING_KEY_MESSAGE` is a fixed value per wallet. A site that obtains it learns only that it belongs to the public address it already knows; it cannot derive `ivk` or any `bunker1…` address without the passphrase.

## 3. Diversified addresses

An address is `(d, pk_d)`:

```
d     : 11 random bytes (diversifier)
g_d   = GroupHash_BJJ(d)          a point in the prime-order subgroup, or ⊥
pk_d  = [ivk] g_d
```

`GroupHash_BJJ(d)` is `H_blake("bunkerDiversify_", d)` interpreted as a candidate `y`, solved for `x` on the curve (taking the even `x`), multiplied by the cofactor 8, rejecting the identity. Roughly half of all `d` succeed; the wallet increments `d` until one does.

One `ivk` has 2^88 unlinkable addresses. Nothing is registered on-chain to receive. Addresses are encoded with bech32m, HRP `bunker` (BSC mainnet; `tbunker` for testnets and local Hardhat runs), payload `d || compress(pk_d)` (11 + 32 bytes).

## 4. Notes

```
Note = (asset, value, g_d, pk_d, rho, rcm)

asset : F_p    asset identifier, see §8
value : u64    amount in the pool's internal unit (shares, see §9)
rho   : F_p    random, unique per note; input to the nullifier
rcm   : F_p    random commitment trapdoor
```

`rho` and `rcm` are derived from a 32-byte `rseed` (as in ZIP 212): `rho = BLAKE2b-512(rseed, personal = "bunker_rho______") mod p`, `rcm = BLAKE2b-512(rseed, personal = "bunker_rcm______") mod p`, so the encrypted note transmits `rseed` only.

```
owner = Poseidon(g_d.x, g_d.y, pk_d.x, pk_d.y)                           (4 inputs)
cm    = Poseidon(asset, value, owner, rho, rcm)                          (5 inputs)
nf    = Poseidon(nk, rho, pos)                                           pos = leaf index
```

Including `pos` makes two notes with identical contents distinct in their nullifiers ("faerie gold"). The address is hashed first so that a contract can mint a note for an owner it knows only by `owner` (an *open note*, §11): the value is public there, the address is not.

## 5. Commitment tree and roots

A single append-only Poseidon Merkle tree of depth 26 (67,108,864 leaves) holds the commitments of every note of every asset. Sharing one tree is an engineering choice; it does **not** give assets a shared anonymity set, because `asset` is public in every transaction (§8).

- Leaf hash: the commitment itself. Node hash: `Poseidon(left, right)`.
- Empty leaf: `Poseidon(BE("bunker_empty") mod p) = EMPTY_LEAF`, computed by `sdk/src/merkle.ts` and passed to the pool's constructor (`contracts/scripts/lib.cjs` recomputes it with circomlibjs; the e2e asserts the on-chain empty root equals the SDK's).
- The contract keeps `filledSubtrees[26]`, `insertedIndex`, `nextIndex`, and a ring buffer of the last **128 roots** (`ROOT_HISTORY`).
- **Deferred insertion.** `transact` does not hash its outputs into the tree. It appends them to a queue (`_queue`, positions `insertedIndex … nextIndex-1`) and emits them; `drain(max)` (permissionless, `max ≤ MAX_DRAIN = 512`, reverts `NothingQueued` when there is nothing to do) hashes the next `max` queued leaves in, writing **one** ring slot for the whole batch (`Drain(fromIndex, count, newRoot, rootIndex)`). A `transact` whose root is unknown first drains up to `AUTO_DRAIN = 64` leaves itself, so a proof against a stale root still gets its own chance. Leaf positions are fixed at enqueue time, so a note's `pos` (hence its nullifier) is known the moment it is emitted; it is *spendable* once its leaf is inserted and the client holds a path. Nullifiers are never deferred: a spend is final in its block.
- A root written by a batch of *n* leaves stays valid until 128 later roots are written, i.e. far longer than before in transactions. `isKnownRoot(root)` scans the ring; `getLastRoot()` returns the newest.
- A proof names its root by value. If the root has since left the ring the contract reverts with `UnknownRoot`; clients treat it (and `InvalidProof`) as "re-sync and re-prove" (`SECURITY.md` §7). The relayer runs a keeper that drains after `DRAIN_AFTER_MS` or at `DRAIN_AT` queued leaves, and `POST /drain` hurries it; the SDK's `ensureInserted` asks for a drain and, given a signer, drains itself if nobody does.

## 6. The transact circuit

`Transact(nIns, nOuts, levels)` is instantiated as `transact2x3` (2 spends, 3 outputs) and `transact4x3` (4 spends, 3 outputs), both with `levels = 26`. Every private action — a send, an unshield, a shield with change, a launchpad trade, a swap — is one proof. The three outputs are, by convention, *payment*, *change* and the *relayer's fee note*; an output the sender has no use for carries value 0 and an empty ciphertext. The verifiers in `contracts/contracts/verifiers/` are generated by `snarkjs zkey export solidityverifier` from the zkeys in use. The current mainnet zkeys come from the deterministic development setup (`circuits/scripts/setup-dev.mjs`, powers of tau `ppot_0080_17`), not from a multi-party ceremony; a ceremony means new verifiers and a new pool.

Public inputs, in order:

```
root            : F_p     commitment tree root
public_amount   : F_p     out_total - in_total encoded as value for positive, p - value for negative
asset           : F_p
ext_data_hash   : F_p     SHA-256(abi.encode(ext_data)) mod p, see §7
asp_root        : F_p     association set root, 0 to disable (§10)
nullifiers[nIns]: F_p
out_cms[nOuts]  : F_p
```

Private inputs: `ask, nsk`; per spend `value_i, g_d_i, pk_d_i, rho_i, rcm_i, path_elements_i[levels], path_index_i, asp_path_elements_i[levels], asp_path_index_i`; per output `value_j, g_d_j, pk_d_j, rho_j, rcm_j`.

Constraints:

1. `ak = Poseidon(ask)`, `nk = Poseidon(nsk)`, `ivk = Poseidon(ak, nk)` truncated to 250 bits.
2. For every spend: `g_d_i` is on the curve and not of small order (`ValidSubgroupPoint`), and `pk_d_i == [ivk] g_d_i`. This is the ownership proof.
3. For every spend: `cm_i = Poseidon(asset, value_i, Poseidon(g_d_i, pk_d_i), rho_i, rcm_i)` and, if `value_i != 0`, `MerkleRoot(cm_i, path_i) == root`. Zero-value spends are dummies and skip the membership check.
4. For every spend: `nullifiers[i] == Poseidon(nk, rho_i, pos_i)`.
5. If `asp_root != 0`: for every non-dummy spend, `MerkleRoot(cm_i, asp_path_i) == asp_root`.
6. For every output: `out_cms[j] == Poseidon(asset, value_j, Poseidon(g_d_j, pk_d_j), rho_j, rcm_j)`, `value_j < 2^64`, `g_d_j` is on the curve and not of small order, `pk_d_j` is on the curve.
7. All `value_i < 2^64`.
8. `sum(value_i) + public_amount == sum(value_j)` in `F_p`. Because all values are 64-bit and `nIns ≤ 4, nOuts = 3`, no wraparound is possible unless `public_amount` is outside `(-2^64, 2^64)`, which the contract rejects (`PublicAmountOutOfRange`) before verification.
9. `ext_data_hash` is bound by being a public input (squared into a dummy constraint so it cannot be optimized away).

**What the circuit does and does not prove about an output address.** For a spend the prover holds `ivk`, so the circuit proves `pk_d = [ivk] g_d`. For an output the prover is the *sender*, who must not know the recipient's `ivk`, so the circuit proves only that the output is *structurally* a valid address. Whether it is *the recipient's* address is enforced at receive time: `ShieldedWallet.scan` decrypts `d`, recomputes `g_d = GroupHash(d)` and `pk_d = [ivk] g_d` from its own `ivk`, recomputes the commitment, and accepts the note only if it equals the on-chain `cm`. A note whose `pk_d` matches no `ivk` is value destroyed by the sender and cannot touch anyone else's funds. `circuits/test/adversarial.test.mjs` applies one tampering at a time to a valid witness (off-curve points, small-order `g_d`, wrong commitment, value ≥ 2^64, minting, wrong public amount, foreign note, wrong root, tampered path, wrong nullifier, double spend inside one transaction, dummy input carrying value, ASP root without membership) and asserts each is unsatisfiable.

**Why `[8]P ≠ O` and not `[l]P = O`.** `ValidSubgroupPoint` excludes points of order 1, 2, 4, 8, the same check the Sapling Spend statement makes on `g_d`. A torsion component only matters when a secret scalar multiplies an adversary-chosen point; the only such place is key agreement on `epk`, which clears the cofactor first (§12), and `scan` recomputes `g_d` from `d` rather than trusting the sender's point. A full subgroup check would cost ≈2,500 constraints per point for a leak with no path.

## 7. Transaction data

```solidity
struct Reshield {
  address token;          // asset of the note minted from an exit hook's proceeds
  uint256 ownerHash;      // Poseidon(g_d, pk_d) of its owner; 0 = no reshield
  uint256 rho; uint256 rcm;
  bytes   ciphertext;     // the owner's own record of (d, rseed) for that note
}
struct ExtData {
  address recipient;      // destination of a negative public_amount
  address exitTarget;     // address(0) = plain unshield; otherwise a contract whose onExit is called (§11)
  bytes   exitData;       // opaque, passed to exitTarget
  bytes   ciphertext0;    // note ciphertext of output 0: the payment (§12)
  bytes   ciphertext1;    // output 1: the change
  bytes   ciphertext2;    // output 2: the relayer's fee note, encrypted to the relayer's bunker1… address
  bytes   outCiphertext;  // sender-side record under ovk
  Reshield reshield;
}
ext_data_hash = SHA-256(abi.encode(ext)) mod p
```

The contract recomputes `ext_data_hash` from calldata before verifying the proof (`ShieldedPool.extDataHash`). A relayer therefore cannot alter the recipient, exit, reshield or ciphertexts. **There is no public relayer fee.** The relayer is paid with output 2, a note like any other: it publishes its shielded address at `/info`, decrypts `ciphertext2` with its own `ivk` before accepting a job, recomputes the commitment against `outCommitments[2]`, and prices the note in the asset (`relayer/src/index.ts`). On-chain nothing says what the fee was or who was paid; a withdrawal delivers exactly `|public_amount|` to `recipient`. Ciphertext lengths are not fixed: outputs the sender has no use for are value 0 and sent with an empty ciphertext (`sdk/src/wallet.ts`).

```solidity
function transact(
  Proof calldata proof,          // a: G1, b: G2, c: G1 as uint256 words (snarkjs order, B coordinates swapped per EIP-197)
  address token,                 // pool asset, address(0) = BNB
  uint256 root,                  // must be in the 128-root ring
  int256  publicAmount,          // signed shares: > 0 shield, < 0 unshield, 0 private send
  uint256 aspRoot,               // 0 = none
  address aspProvider,           // whose ring aspRoot must be in
  uint256[] calldata nullifiers, // 2 or 4
  uint256[3] calldata outCommitments,
  ExtData calldata ext
) external payable;
```

For a BNB shield `msg.value` must equal `amountForMint(shares) × unit`; for an ERC-20 shield the contract pulls exactly that amount with `transferFrom` and reverts with `ShortDelivery` unless its balance grew by it (fee-on-transfer and rebasing tokens are thereby refused). Memos inside note ciphertexts are padded to a 64-byte bucket; `MEMO_MAX = 64`. Note ciphertexts begin with a version byte, `0x02` for this protocol.

Events: `Transact(token, firstIndex, commitments[3], ciphertext0, ciphertext1, ciphertext2, outCiphertext)`, `OpenNote(token, index, cm, shares, ownerHash, ciphertext)` for a reshielded exit (§11), `Drain(fromIndex, count, newRoot, rootIndex)`, `Registered(owner, shieldedAddress)` (§16), `Nullified(nf)`, `Shield/Unshield/Donate(token, amount)`. The indexer rebuilds the tree and every wallet's view from `Transact`, `OpenNote` and `Drain`; anyone can.

## 8. Assets

An asset is an ERC-20 or native BNB (`address(0)`). `asset = SHA-256("bunker_asset" || token left-padded to 32 bytes) mod p` (`ShieldedPool.assetId`, mirrored by `assetId` in the SDK). Each asset has a `Pool` record holding its share rate, turnstile counters, TVL cap and internal `unit`; all assets share the commitment tree.

**Units.** Note values are 64-bit. A pool's `unit` is `10^unitExp` wei: BNB uses `NATIVE_UNIT = 10^9` (one gwei), so a note holds up to 1.8 × 10^10 BNB; an ERC-20 pool chooses `unitExp ∈ [decimals − 9, decimals]` at `createPool` (`BadUnit` otherwise), which keeps the whole supply representable. Launch tokens have 6 decimals and `unit = 1`. Amounts below one unit are dust the depositor loses; the app rounds down and says so.

**Pools are permissionless.** `createPool(token, unitExp, tvlCap)` opens a pool for any ERC-20 once; the first shield of a token opens it. The BNB pool exists from construction.

**Anonymity is per asset, not per tree.** `asset` is a public input of every `transact`, so each transaction reveals which asset it moves; the anonymity set of a withdrawal is the set of unspent notes of that asset. The app reports set sizes per asset for this reason.

## 9. Shares and donations

Inside a pool, `value` is denominated in shares. Each pool has `totalShares` and `totalAssets` and all rates are computed over `(totalShares + V, totalAssets + V)` with `V = VIRTUAL_OFFSET = 10^6`:

```
sharesForDeposit(a)  = floor(a · (S+V) / (A+V))
amountForMint(s)     = ceil (s · (A+V) / (S+V))      what a shield of s shares costs
amountForBurn(s)     = floor(s · (A+V) / (S+V))      what an unshield of s shares pays
sharesForWithdraw(a) = ceil (a · (S+V) / (A+V))
```

Shield mints shares; unshield burns them. Anyone may call `donate(token, amount)`, which increases `totalAssets` without minting shares, so every existing note is worth more; donations to a pool with no shares are refused (`NotInitialized`) so none is stranded. `V` behaves like a founding holder of `V` shares backed by `V` units: an empty pool is 1:1, and the first-depositor inflation attack returns ≈ `D/V` of a donation `D` to the attacker with the rest accruing to later depositors (`contracts/test/pool.test.cjs`). Rounding dust stays in the pool. In the current deployment no pool is donated to; every share rate is 1.

## 10. Association sets

An association set provider (ASP) publishes a Merkle root over commitments it has approved with `publishAspRoot(root)`; the contract keeps the last 32 roots per provider address. A spender may include `(aspRoot, aspProvider)` in a proof to show its inputs are in the set. Using an ASP is always optional for the spender; recipients and relayers decide whether to require it. A spender whose note is in no set can always exit publicly with `aspRoot = 0`.

## 11. Exits

If `exitTarget != address(0)`, the contract first pays the unshielded amount to `recipient` exactly as for a plain unshield, then calls `IBunkerExit(exitTarget).onExit(token, amount, msg.sender, exitData)` in the same transaction. `recipient`, `exitTarget`, `exitData` and `reshield` are all under `ext_data_hash`, so a relayer can neither redirect the funds nor change what the exit contract is told. The exit contract sees the funds already at `recipient` (normally itself) and acts on them; if it reverts, the whole transaction reverts and nothing was spent. The pool is `nonReentrant` across the call and accepts plain BNB (`receive()`) only while that call is in progress.

**Reshield (open notes).** If `ext.reshield.ownerHash != 0`, the pool measures its balance of `reshield.token` before and after `onExit`, and whatever the hook sent back becomes a note in that token's pool, owned by `ownerHash`, with the caller-supplied `rho, rcm`: `cm = Poseidon(asset, shares, ownerHash, rho, rcm)`, queued like any other leaf and announced by `OpenNote`. Its value (`shares`) is public, its owner is a hash the spender chose, and the spender's `ciphertext` (their own `d, rseed` record) lets any device holding the viewing key recover it. This is how a launchpad trade or a swap returns its proceeds to the shielded pool without any key, account or second transaction on the path. The launchpad (§13) and `SwapExit` (§17) are the exit contracts; both refuse any caller but the pool (`NotFromPool`).

## 12. Note encryption

For each output note the sender samples `esk` and computes

```
epk          = [esk] g_d
shared       = [8·esk] pk_d               = [8·ivk] epk on the receiver side   (cofactor-cleared, Sapling KA.Agree)
K_enc        = H_blake("bunkerNoteEncKey", compress(shared) || compress(epk))
ciphertext   = compress(epk) || ChaCha20-Poly1305(K_enc, nonce = 0, plaintext)
plaintext    = d || value (8 LE) || rseed (32) || memo
```

A ciphertext without a memo is `32 + 16 + 11 + 8 + 32 = 99` bytes; with a memo, 163. The receiver trial-decrypts every ciphertext in every `Transact` event with `ivk` and accepts a note only if the recomputed `cm` matches the leaf. The sender additionally encrypts `(pk_d, esk)` under `K_out = H_blake("bunkerOutKey____", ovk || cm)` so that holders of `ovk` can reconstruct outgoing notes. Trial decryption happens on the client; the indexer serves raw ciphertexts and never holds keys.

## 13. The launchpad

`contracts/contracts/Launchpad.sol` is a token launchpad whose primary market exists only inside the shielded pool. It is the worked example of §11: a contract that receives money from the pool and sends the result back into the pool, with no user-held key anywhere on the path.

**Launch.** `launch(name, symbol, uri)` deploys a `LaunchToken` (ERC-20, 6 decimals, fixed supply minted to the launchpad, no owner, no mint or pause function), opens its shielded pool (`createPool(token, 0, max)`), and creates the curve. The creator pays gas and receives nothing: no allocation, no authority, no fee switch. Parameters are global and fixed in the constructor (`getParams()`): total supply 10^15 base units (one billion tokens), 793.1M on the curve, virtual token reserve 1.073 × 10^9 tokens, graduation at `graduationWei` of real BNB (mainnet: 3 BNB), starting fee 1 %, the four agent addresses, and the PancakeSwap V2 router. The virtual BNB reserve is `G × (1.073 − 0.7931) / 0.7931`, so the curve sells its last token exactly as it reaches `G`; the remaining 20.69 % of the supply is reserved for the AMM pair.

**Image and metadata.** `uri` points at JSON the app uploads to the indexer's `/meta` (icon required, 3:1 header optional, each ≤ 4.5 MB, content-addressed and served immutably at `/meta/<sha256>.<ext>`). The contract stores the URI and checks nothing about it.

**Curve.** Constant product over virtual reserves, `(virtualBnb + realBnb) · virtualToken = k`, integer arithmetic rounding against the trader (`buy`, `sell`, `quoteBuyExactOut`, `buyCapped`, all `pure` and mirrored in `sdk/src/launch.ts`).

**Private buy.** The buyer unshields BNB with `recipient = exitTarget = Launchpad`, `exitData = abi.encode(EXIT_BUY, token, minOut)` and `reshield = {token, ownerHash, …}`:

```
fee    = amount · fee_bps;   net = amount − fee
tokens = buy(net), must be ≥ minOut
curve  : realBnb += net, feesAccrued += fee
pool   : receives `tokens` back from the launchpad and mints them as an open note owned by ownerHash (§11)
```

A buy may not reach past the last token: `SoldOut` is raised unless it lands within `overshootSlack(amount) = max(amount / 10000, 1 gwei)` of the exact size (which lets the final buy be quoted exactly despite gwei rounding), and in that case the curve keeps the hair. The SDK's `quoteBuy` reports `maxIn`. The relayer is paid with the transaction's fee note, not out of the trade. Nothing is claimed afterwards: the tokens are a note of the buyer's before the transaction ends.

**Private sell.** The mirror image: the seller unshields tokens with `exitData` of kind `EXIT_SELL` and `reshield = {BNB, ownerHash, …}`; the launchpad prices them, keeps the fee, and sends the BNB back to the pool, which mints it as an open note of the seller's. The relayer's fee note is denominated in the token sold; the relayer prices it on the curve itself (`relayer/src/assets.ts`).

**Harvest.** Anyone may call `harvest(token)` while the curve is live: it pays `feesAccrued` to the treasury fixed at construction. The treasury is the agents' own wallet (agent 0): it fuels the agents' and the relayer's gas and, at random moments, buys the BUNKER token back on PancakeSwap and burns it or airdrops it to holders (`agents/src/treasury.ts`). After graduation `harvest` is refused and the fees travel with `migrate`.

**Fee policy: four agents, no brake.** Every curve carries its own trading fee, set by the four agent addresses in `Params`, operated off-chain by four independent model-driven agents (`agents/`). There is no proposer, guardian, timelock, pause or veto; nobody, the deployer included, can touch the fee once the agents are set. The rules are constants in the contract and mirrored by `policy` in the SDK:

```
EPOCH_BLOCKS = 80 (~1 min)   VOTE_TTL_BLOCKS = 320 (~4 min)   QUORUM = 2   MAX_CATCHUP_EPOCHS = 4
fee_bps ∈ [0, 500],          moves at most 100 bps toward the target per epoch (never past it)
```

`vote(token, feeBps)` records the agent's `(feeBps, block)` in `votes[i]`, overwriting its previous vote; a non-agent is refused (`NotAgent`), a value outside the bounds is refused (`BadParams`). Nothing changes at the moment of voting. Every function that reads a curve first *rolls* it: if the current epoch `E = block / 80` is later than `settledEpoch`, the contract takes the votes cast before the start of `E` and younger than `VOTE_TTL_BLOCKS`, and if at least `QUORUM` of them are fresh, computes the target as their median (even count: floor of the mean of the middle two), clamped to the bounds; the fee moves one step toward the target per elapsed epoch, at most `MAX_CATCHUP_EPOCHS` steps in one roll. Rolls emit `FeeRoll`, votes `FeeVote`; the indexer serves both. Because the roll is pure in `(curve, block)` (`rollPure`), a client can compute the fee any future block will charge: the app quotes at `rolled(curve, block)` and sets `minOut` from `worstFeeBps(curve, block, 160)`.

**Graduation.** When `realBnb ≥ graduationWei` or the curve is sold out, `graduated` is set (by the trade that crossed the line or by a permissionless `graduate`) and the curve freezes: `onExit`, `harvest` and `vote` revert with `Migrated`, and the only call left is `migrate`. There is no public trading on the curve at any point.

**Migration.** `migrate(token)` (permissionless) calls the PancakeSwap V2 router's `addLiquidityETH` with all of the curve's BNB and every token the launchpad still holds for it (the unsold remainder plus the reserved 20.69 %), sends the LP tokens to `0x…dEaD`, burns leftover tokens if a pre-existing pair forced a different ratio, and pays unharvested fees plus any BNB the router returned to the treasury. `Migrate(token, pair, bnbIn, tokensIn, liquidity)` is emitted and `ammPair` recorded. Nobody holds the LP, so the liquidity is permanent. The agents service acts as keeper and calls `migrate` on the first tick that sees a graduated, unmigrated curve.

**What is public, exactly.** The curve's reserves and every trade's side, size and block (`CurveBuy`/`CurveSell`); the creator's wallet and the metadata they uploaded; the PancakeSwap pair and everything after graduation; and the size of each open note minted from a trade (`OpenNote.shares`), whose owner is a hash. What does not exist on-chain is which note paid for a buy, who holds the tokens afterwards, or any link between a buy and a later sell. Trade timing and the fixed sizes the app offers are the remaining signals (`SECURITY.md` §9).

## 14. Turnstile and immutability

For every pool, `totalOut ≤ totalIn` is checked on every negative `publicAmount` (`Turnstile`). `totalIn` counts shields and donations; `totalOut` counts unshields. Should a proof-system flaw let an attacker forge notes, it can at most drain what honest users deposited into that asset's pool, never more, and the drain is visible and measurable.

The contracts are not upgradeable and have no owner. A guardian key can pause shields (`setShieldPaused`) and lower, never raise, a pool's TVL cap (`lowerTvlCap`), and can hand the role on or burn it (`setGuardian(address(0))`). Nothing can pause `transact` with `publicAmount ≤ 0`, `donate`, or any launchpad function. A new circuit or proof system means a new pool contract; moving funds between pools is an unshield from the old and a shield into the new, as public as any shield.

## 15. Gas

| Call | Gas (Hardhat, cancun) |
|---|---|
| `transact2x3`, shield / send / unshield (outputs queued) | ≈ 430–510 k |
| `transact2x3`, exit with reshield (launchpad buy, swap) | ≈ 650–810 k |
| `drain`, 3–4 leaves | ≈ 780–845 k (≈ 26 Poseidon(2) per leaf + one root) |
| `launch` (token deploy + pool + curve) | ≈ 1.4 M |
| `migrate` | ≈ 0.35 M |

The pairing check is ≈ 180 k. Tree hashing moved out of `transact` into `drain`, where a batch of *n* leaves costs about `n × 26` Poseidon(2) hashes but only one root write, and is paid by the keeper. At BSC's ~0.1 gwei gas price a private send costs well under 0.0005 BNB; the relayer prices its BNB fee from `GAS_LIMIT × GAS_PRICE_CAP × (1 + margin)` so it is never underpaid, and quotes ERC-20 fees through PancakeSwap or the launchpad curve (`relayer/src/assets.ts`).

## 16. Registry: paying a plain address

`register(bytes shieldedAddress)` stores a 43-byte diversified address (`d || compress(pk_d)`, the payload of a `bunker1…` string) under `msg.sender`; an empty payload clears it (`Registered(owner, payload)`). A sender who is given a plain `0x…` address reads `registry(owner)` from the chain (never from an indexer), validates the point (on curve, in the prime-order subgroup, `GroupHash(d)` defined) and pays it like any `bunker1…` address. The registry is public; which notes are paid to a registered address is not, since the payment is an ordinary output ciphertext. The SDK registers the wallet's diversifier-0 address so the mapping is stable; fresh diversified addresses remain unlinkable to it.

## 17. SwapExit: private swaps

`contracts/contracts/SwapExit.sol` is the second exit contract. `exitData = abi.encode(address[] path, uint256 minOut)`; `path[0]` must be the asset withdrawn (WBNB for BNB), `path` has 2 or 3 hops, and the output token's pool must exist. `onExit` approves the PancakeSwap V2 router, swaps the exact input along `path` (the `…SupportingFeeOnTransferTokens` variants; a swap to BNB lands at SwapExit and is forwarded to the pool) with `minOut` as the floor, and returns. The pool's reshield turns the output into an open note of the spender's (§11). The relayer checks that the reshield token equals the last hop and that its pool exists before relaying; a swap into a token with no pool can be preceded by `POST /pool` on the relayer, which opens one.

## 18. Viewing keys

A full viewing key is the bech32m string `bunkerview1…` over `ak || nk || ovk` (96 bytes). It derives `ivk` and therefore every diversified address, decrypts every incoming note and every outgoing record, computes every nullifier (so it knows what is spent), and cannot produce a proof. `BunkerClient.connect({ viewingKey })` yields a watch-only client with the same `sync` and `balance` as a spending one.
