# Invariants

Each row names a property, where the code enforces it, and the test that
exercises it. `scripts/audit-package-check.mjs` (CI) verifies that every
`path::name` in the test column resolves to a file that contains that name, so
the table cannot silently drift from the tests. "manual" marks properties an
auditor should check by reading; those are the ones we most want challenged.

Test notation: `file::title` is a `node:test`/mocha title, a logged string
from `scripts/e2e.mjs`, or a CI step name.

## Circuit (soundness)

| id | invariant | enforced in | test |
|---|---|---|---|
| C1 | No value is created: `Σ in + public_amount = Σ out` with every value < 2^64 | `circuits/src/transact.circom` balance and range constraints | `circuits/test/adversarial.test.mjs::creating value out of nothing is rejected` |
| C2 | Output values are 64-bit | `transact.circom` `Num2Bits(64)` per output | `circuits/test/adversarial.test.mjs::output value of 2^64 or more is rejected` |
| C3 | A real (non-zero) input is a member of the tree under the public root | `transact.circom` Merkle check gated on `value != 0` | `circuits/test/adversarial.test.mjs::a real input with a wrong Merkle root is rejected` |
| C4 | A tampered Merkle path does not verify | same | `circuits/test/adversarial.test.mjs::a real input with a tampered Merkle path is rejected` |
| C5 | Dummy (zero-value) inputs skip membership and carry no value | `transact.circom` dummy gating | `circuits/test/adversarial.test.mjs::a dummy (zero-value) input cannot carry value` |
| C6 | Nullifier = Poseidon(nk, rho, position) exactly | `transact.circom` nullifier block | `circuits/test/adversarial.test.mjs::a nullifier that does not match (nk, rho, position) is rejected` |
| C7 | The same note cannot be spent twice in one transaction | `transact.circom` pairwise nullifier inequality | `circuits/test/adversarial.test.mjs::spending the same note twice in one transaction is rejected` |
| C8 | Only the holder of `ask`/`nk` for a note can spend it | `keys.circom` derives `ak`, `nk`, `ivk`, `pk_d` from the private key and binds them to the input note | `circuits/test/adversarial.test.mjs::spending a note that belongs to someone else is rejected` |
| C9 | Output commitment = Poseidon of the output note fields | `note.circom` | `circuits/test/adversarial.test.mjs::output commitment that does not match the output note is rejected` |
| C10 | Output `pk_d` is on Baby Jubjub | `transact.circom` `BabyCheck` on every output | `circuits/test/adversarial.test.mjs::output pk_d off the curve is rejected` |
| C11 | Output `g_d` is on the curve and not of small order | `keys.circom` `ValidSubgroupPoint` | `circuits/test/adversarial.test.mjs::output g_d of small order is rejected even though it is on the curve` |
| C12 | `public_amount` is bound to the proof | public input | `circuits/test/adversarial.test.mjs::changing the public amount without changing the notes is rejected` |
| C13 | With a non-zero ASP root, every real input is a member of the association set | `transact.circom` ASP Merkle check | `circuits/test/adversarial.test.mjs::with an association-set root, a real input needs a valid ASP path` |
| C14 | `ext_data_hash` is a public input, so recipient, relayer, fee, exit data and ciphertexts are bound to the proof | `transact.circom` public signals; hash computed in `sdk/src/extdata.ts` and `ShieldedPool.extDataHash` | `sdk/src/sdk.test.ts::ext data is abi.encode(tuple) and hashes like ShieldedPool.extDataHash` |
| C15 | The verifier contracts are the ones derived from the committed circuit source and pinned ptau | `circuits/scripts/setup-dev.mjs` deterministic beacon; `contracts/scripts/export-verifiers.cjs`; CI drift step | `.github/workflows/ci.yml::Solidity verifiers match the dev keys` |
| C16 | The proof is passed to the verifier in the encoding snarkjs' Solidity verifier expects (B coordinates swapped, nothing negated) | `sdk/src/pool.ts` `proofArg` | `sdk/src/sdk.test.ts::proof argument order: B coordinates swapped as snarkjs' exportSolidityCallData does, nothing negated` |

## Pool contract

| id | invariant | enforced in | test |
|---|---|---|---|
| P1 | A nullifier can be recorded once; a second spend reverts `NullifierSpent` | `ShieldedPool.transact` nullifier loop (also within one call) | `scripts/e2e.mjs::replay rejected as expected` |
| P2 | `totalOut ≤ totalIn` per pool (turnstile) | `ShieldedPool.transact` on every negative `publicAmount` | `scripts/e2e.mjs::turnstile:` |
| P3 | Share math equals the SDK mirror; rounding favours the pool; donations raise the rate for existing holders | `ShieldedPool` `sharesForDeposit/amountForMint/amountForBurn/sharesForWithdraw` with `VIRTUAL_OFFSET` | `contracts/test/pool.test.cjs::share math mirrors the SDK` |
| P4 | Donations into a pool with zero shares are refused (nothing to credit) | `ShieldedPool.donate` | `contracts/test/pool.test.cjs::refuses a donation nobody can receive and malformed transacts` |
| P5 | A BNB shield's `msg.value` equals the credited amount; an ERC-20 shield credits exactly what arrived (`ShortDelivery`) | `ShieldedPool._moveIn` | manual (fee-on-transfer mock not yet in the test suite; e2e covers the exact-value BNB and LaunchToken paths) |
| P6 | ERC-20 pools are permissionless and `unitExp` is bounded to `[decimals−9, decimals]`; BNB uses gwei units | `ShieldedPool.createPool` | `contracts/test/pool.test.cjs::native pool exists with gwei units; ERC-20 pools are permissionless and bounded` |
| P7 | Root ring records one root per transaction; a proof is valid for 128 later transactions and refused after | `ShieldedPool._insertPair`, `isKnownRoot` | manual (ring arithmetic is `ROOT_HISTORY` modulo; a load test like the old `bench.mjs` is not yet ported) |
| P8 | The empty tree root equals the SDK's (`Poseidon("bunker_empty")` leaf) | constructor `emptyLeaf`; `sdk/src/merkle.ts` | `contracts/test/pool.test.cjs::starts at the SDK's empty root` |
| P9 | `PoseidonT3` at the deterministic address hashes like circomlibjs | `poseidon-solidity` bytecode | `contracts/test/pool.test.cjs::PoseidonT3 matches circomlibjs` |
| P10 | `assetId` and `extDataHash` match the SDK byte for byte | `ShieldedPool.assetId`, `extDataHash` | `contracts/test/pool.test.cjs::extDataHash is sha256(abi.encode(ext)) mod p` |
| P11 | Guardian can pause shields and lower caps, nothing else; unshields cannot be paused | `ShieldedPool.setShieldPaused`, `lowerTvlCap`, `setGuardian` | `contracts/test/pool.test.cjs::guardian can pause shields and lower caps, nothing else` |
| P12 | ASP roots are a 32-entry ring per provider and `aspRoot = 0` is never "known" | `ShieldedPool.publishAspRoot`, `isKnownAspRoot` | `contracts/test/pool.test.cjs::ASP roots are a 32-entry ring per provider` |
| P13 | The exit hook receives only funds already paid to `recipient`; the pool is non-reentrant across it | `ShieldedPool.transact` exit block, `nonReentrant` | manual |
| P14 | `publicAmount` outside `(−2^64, 2^64)` is refused before verification | `ShieldedPool.transact` | `contracts/test/pool.test.cjs::refuses a donation nobody can receive and malformed transacts` |

## Launchpad contract

| id | invariant | enforced in | test |
|---|---|---|---|
| L1 | `onExit` is callable only by the pool, only for a known curve, only for a matching token/kind | `Launchpad.onExit` | `contracts/test/launchpad.test.cjs::buys and sells through the exit hook pay the claim key and the relayer` |
| L2 | Curve math on-chain equals the JS mirror; `k` never decreases; a capped buy pays exact-out | `Launchpad.buy/sell/buyCapped/quoteBuyExactOut` | `contracts/test/launchpad.test.cjs::curve math on-chain equals the JS mirror and k never decreases` |
| L3 | Virtual BNB is sized so the curve sells out exactly at graduation | `contracts/scripts/lib.cjs` `defaultParams` | `contracts/test/launchpad.test.cjs::virtual BNB is sized so the curve sells out at graduation` |
| L4 | A launch mints the whole supply to the launchpad, opens the token's pool, and the token has no owner | `Launchpad.launch`, `LaunchToken` | `contracts/test/launchpad.test.cjs::launch mints the supply to the curve and opens a pool` |
| L5 | Only the four agents can vote, within bounds; the fee moves toward the median one step per epoch, votes count from the next epoch | `Launchpad.vote`, `_roll`, `feeTarget` | `contracts/test/launchpad.test.cjs::agents vote; the fee follows the median one step per epoch` |
| L6 | Catch-up is capped at `MAX_CATCHUP_EPOCHS` and stale votes expire | `Launchpad.rollPure` | `contracts/test/launchpad.test.cjs::rollPure: catch-up is capped and stale votes expire` |
| L7 | After graduation trades, votes and harvest revert; `migrate` adds all BNB and tokens to PancakeSwap and burns the LP | `Launchpad._graduateIfDue`, `migrate` | `contracts/test/launchpad.test.cjs::graduates when sold out and migrates to the AMM with LP burned` |
| L8 | The SDK's fee-policy mirror agrees with the contract | `sdk/src/launch.ts` `rolled`, `policyTarget` | `sdk/src/sdk.test.ts::fee policy mirror: median, quorum, one bounded step per epoch, votes count from the next epoch and expire` |
| L9 | A claim key is a deterministic secp256k1 account per (seed, nonce) | `sdk/src/launch.ts` `claimKey` | `sdk/src/sdk.test.ts::claim keys are deterministic secp256k1 accounts, distinct per nonce and seed` |
| L10 | The whole trade path works end to end with the buyer's wallet never appearing | `scripts/e2e.mjs` | `scripts/e2e.mjs::claim key holds` |

## SDK and wallet

| id | invariant | enforced in | test |
|---|---|---|---|
| S1 | `ivk` and every derived scalar are < Baby Jubjub subgroup order (250-bit truncation) | `sdk/src/keys.ts` `SCALAR_MASK` | `sdk/src/sdk.test.ts::key derivation is deterministic and ivk is a valid Baby Jubjub scalar` |
| S2 | Diversified addresses from one key are unlinkable and round-trip through bech32m | `sdk/src/keys.ts` | `sdk/src/sdk.test.ts::diversified addresses round-trip through bech32m (hrp bunker) and are unlinkable` |
| S3 | Only the receiver (`ivk`) or the sender (`ovk`) can decrypt a note; a stranger cannot | `sdk/src/encryption.ts` | `sdk/src/sdk.test.ts::note encryption: receiver decrypts with ivk, strangers cannot, sender recovers with ovk` |
| S4 | A passphrase changes the seed; the `bunkerseed1` backup round-trips | `sdk/src/keys.ts` | `sdk/src/sdk.test.ts::seed derivation: passphrase changes the seed, backup round-trips` |
| S5 | Nullifiers depend on position, so identical notes have distinct nullifiers | `sdk/src/note.ts` | `sdk/src/sdk.test.ts::nullifier depends on position` |
| S6 | The receiver recomputes `pk_d` and the commitment before crediting a note | `sdk/src/wallet.ts` scan | `scripts/e2e.mjs::bob received note` |
| S7 | A `g_d` with a torsion component is refused by the receiver; so is a `pk_d ≠ [ivk]·g_d` | `wallet.ts` scan re-derives `g_d` from `d` | `sdk/src/sdk.test.ts::a g_d with a torsion component passes the circuit's small-order check but is never credited by the receiver` |
| S8 | Key agreement clears the cofactor: a torsion component in `epk` cannot probe `ivk mod 8` | `sdk/src/encryption.ts` | `sdk/src/sdk.test.ts::a torsion component in epk cannot probe ivk mod 8 (cofactor-cleared key agreement)` |
| S9 | Notes reserved for a pending proof are hidden from the balance and released if the transaction never lands | `sdk/src/wallet.ts` `reserve/release/markSpent` | `sdk/src/sdk.test.ts::note reservation: reserve hides a note, release restores it, markSpent removes it` |
| S10 | Every custom error in the ABIs is in the SDK's error tables and decodes from revert data | `sdk/src/errors.ts` | `sdk/src/sdk.test.ts::error tables list every custom error in the ABIs and decode revert data` |
| S11 | Passphrase strength is a discounting heuristic and the time-to-crack table is `2^(b−1)/rate` | `sdk/src/keys.ts` `passphraseStrength` | `sdk/src/sdk.test.ts::passphrase strength: the time-to-crack arithmetic is 2^(b-1)/rate` |

## Relayer and indexer

| id | invariant | enforced in | test |
|---|---|---|---|
| R1 | The relayer cannot change recipient, amount, fee or ciphertexts (all under `ext_data_hash`) | `ShieldedPool.transact` ext binding | `sdk/src/sdk.test.ts::ext data is abi.encode(tuple) and hashes like ShieldedPool.extDataHash` |
| R2 | The attached gas price is clamped to `[floor, cap]` and the BNB fee floor is priced at the cap | `relayer/src/fees.ts` | `relayer/src/fees.test.ts::clampGasPrice: node price clamped to [floor, cap]; no sample means the floor` |
| R3 | A second `/relay` carrying a nullifier of a live job resolves to that job; a failed job frees its nullifiers | `relayer/src/queue.ts` | `relayer/src/queue.test.ts::a second /relay carrying a nullifier of a live job resolves to that job; a failed job frees its nullifiers` |
| R4 | The relayer simulates before queueing, so stale roots and spent notes are rejected up front with the contract error named | `relayer/src/index.ts` | manual (the HTTP service has no automated test yet; e2e submits with a relayer key directly) |
| I1 | A failing block range stops the scan at the last committed block and is retried; nothing is skipped | `indexer/src/scanner.ts` | `indexer/src/scanner.test.ts::a failing range stops the scan at the last committed block and is retried next tick; nothing is skipped` |
| I2 | A fallback endpoint supplies what the primary cannot, in the same tick | `indexer/src/scanner.ts` | `indexer/src/scanner.test.ts::a fallback endpoint supplies the range the primary cannot, in the same tick` |
| I3 | Launch, trade, harvest, graduate, migrate and fee events are folded into rows idempotently | `indexer/src/scanner.ts` `ingest` | `indexer/src/scanner.test.ts::launchpad events: a launch row is created and every trade/harvest/graduate/migrate updates it; replays are idempotent` |

## Ceremony

| id | invariant | enforced in | test |
|---|---|---|---|
| Z1 | The r1cs rebuilt from source hashes to the transcript value | `circuits/scripts/ceremony.mjs check` | `.github/workflows/ci.yml::ceremony.mjs check --fetch` |
| Z2 | The hosted zkey verifies against r1cs + ptau and its embedded contribution hashes equal the transcript, in order | `ceremony.mjs verifyAgainstTranscript` | `.github/workflows/ci.yml::ceremony.mjs check --fetch` |
