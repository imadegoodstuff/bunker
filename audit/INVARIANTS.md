# Invariants

Every property the protocol relies on, where it is enforced and which test
exercises it. `scripts/audit-package-check.mjs` parses the tables below and
fails CI if a referenced file no longer exists or no longer contains the named
test, so this list cannot silently drift from the code.

Format of the *test* column: `path::name`, where `name` is a Rust test
function, a `node:test` title, or a string the e2e script logs when the
check passes. "manual" means no automated test yet (see `TEST_MATRIX.md`).

## Circuit (soundness)

| id | invariant | enforced in | test |
|---|---|---|---|
| C1 | Σ inputs + public_amount = Σ outputs + relayer_fee over the integers (no field wrap) | `circuits/src/transact.circom` balance + 64-bit range checks | `circuits/test/adversarial.test.mjs::creating value out of nothing is rejected` |
| C2 | Output values are < 2^64 | `transact.circom` `Num2Bits(64)` on every output | `circuits/test/adversarial.test.mjs::output value of 2^64 or more is rejected` |
| C3 | Every non-dummy input is a leaf of the tree under `root` | `transact.circom` Merkle path check gated by `value != 0` | `circuits/test/adversarial.test.mjs::a real input with a wrong Merkle root is rejected` |
| C4 | A tampered Merkle path does not verify | same | `circuits/test/adversarial.test.mjs::a real input with a tampered Merkle path is rejected` |
| C5 | Dummy (zero-value) inputs skip membership and carry no value | `transact.circom` dummy gating | `circuits/test/adversarial.test.mjs::a dummy (zero-value) input cannot carry value` |
| C6 | Nullifier = Poseidon(nk, rho, position) exactly | `transact.circom` nullifier block | `circuits/test/adversarial.test.mjs::a nullifier that does not match (nk, rho, position) is rejected` |
| C7 | The same note cannot be spent twice in one transaction | `transact.circom` pairwise nullifier inequality | `circuits/test/adversarial.test.mjs::spending the same note twice in one transaction is rejected` |
| C8 | Only the holder of `ask`/`nk` for a note can spend it | `keys.circom` derives `ak`, `nk`, `ivk`, `pk_d` from the private key and binds them to the input note | `circuits/test/adversarial.test.mjs::spending a note that belongs to someone else is rejected` |
| C9 | Output commitment = Poseidon of the output note fields | `note.circom` | `circuits/test/adversarial.test.mjs::output commitment that does not match the output note is rejected` |
| C10 | Output `pk_d` is on Baby Jubjub | `transact.circom` `BabyCheck` on every output | `circuits/test/adversarial.test.mjs::output pk_d off the curve is rejected` |
| C11 | Output `g_d` is on the curve and in the prime-order subgroup (not identity, not small order) | `keys.circom` `ValidSubgroupPoint` | `circuits/test/adversarial.test.mjs::output g_d of small order is rejected even though it is on the curve` |
| C12 | `public_amount` is bound to the proof | public input | `circuits/test/adversarial.test.mjs::changing the public amount without changing the notes is rejected` |
| C13 | With a non-zero ASP root, every real input is a member of the association set | `transact.circom` ASP Merkle check | `circuits/test/adversarial.test.mjs::with an association-set root, a real input needs a valid ASP path` |
| C14 | `ext_data_hash` is a public input, so recipient, relayer, fee, exit data and ciphertexts are bound to the proof | `transact.circom` public signals; hash computed in `sdk/src/program.ts` and `processor.rs` | `programs/scash_vault/tests/verify_fixture.rs::spend_proof_verifies_and_tampering_fails` |
| C15 | The verifying key compiled into the program is the one derived from the committed circuit source and pinned ptau | `circuits/scripts/setup-dev.mjs` deterministic beacon; CI VK drift step | `.github/workflows/ci.yml::VK drift` |

## Vault program

| id | invariant | enforced in | test |
|---|---|---|---|
| V1 | A nullifier can be recorded once; a second spend fails | `processor.rs` creates a nullifier PDA; `create_account` fails if it exists | `scripts/e2e.mjs::replay rejected as expected` |
| V2 | `total_out ≤ total_in` per pool (turnstile) | `processor.rs` on every negative `public_amount` | `scripts/e2e.mjs::turnstile:` |
| V3 | Shares are solvent: Σ shares × rate ≤ assets after any interleaving of mints, burns and donations; rounding favours the pool | `state.rs` share math with virtual offset | `programs/scash_vault/src/state.rs::interleaved_mints_donations_and_burns_never_break_solvency` |
| V4 | An inflation (first-depositor) attack is unprofitable and later depositors are made whole | `state.rs` `VIRTUAL_OFFSET` | `programs/scash_vault/src/state.rs::inflation_attack_is_unprofitable_and_victims_are_whole` |
| V5 | Donations into a pool with zero shares are refused (nothing to credit) | `state.rs` | `programs/scash_vault/src/state.rs::empty_pool_is_one_to_one_and_donation_needs_shares` |
| V6 | The offset does not change the rate of a large pool beyond rounding | `state.rs` | `programs/scash_vault/src/state.rs::large_pool_rate_is_unaffected_by_the_offset` |
| V7 | Inbound token transfers credit exactly what the vault received | `processor.rs` `move_in` balance delta check (`ShortDelivery`) | manual (Token-2022 fee mint cannot be created on the dev validator without the extension program; unit-level coverage via V8) |
| V8 | Mints with TransferFee, TransferHook, PermanentDelegate, NonTransferable, DefaultAccountState or Pausable are refused at pool creation | `token.rs` TLV walk | `programs/scash_vault/src/token.rs::fee_hook_delegate_are_rejected_anywhere_in_the_list` |
| V9 | Malformed Token-2022 TLV data is not accepted as "no extensions" | `token.rs` | `programs/scash_vault/src/token.rs::malformed_layouts_are_not_silently_accepted` |
| V10 | Root ring records one root per transaction; a proof is valid for 128 later transactions, no fewer | `tree.rs::record_root` called once per `transact` | `scripts/bench.mjs::root window` |
| V11 | A proof against an evicted root fails (as `InvalidProof`) | `processor.rs` root lookup by ring index feeds the public input | `scripts/bench.mjs::root window` |
| V12 | Field elements in instruction data are canonical (< p) | `field.rs` | `programs/scash_vault/src/field.rs::reduce` |
| V13 | Signed `public_amount` encoding round-trips | `field.rs` | `programs/scash_vault/src/field.rs::signed_roundtrip` |
| V14 | A valid proof from the committed fixture verifies on the compiled VK; one flipped byte does not | `verifier.rs` | `programs/scash_vault/tests/verify_fixture.rs::shield_proof_verifies` |
| V15 | Guardian can pause shields and lower the cap, nothing else; unshields cannot be paused | `processor.rs` `SetShieldPaused`, `LowerTvlCap` | manual |
| V16 | Exit CPI receives only funds already at `recipient`; the vault holds no authority the exit target can use | `processor.rs` exit block | manual |

## Migrator

| id | invariant | enforced in | test |
|---|---|---|---|
| M1 | Staging layout serialises and parses round-trip | `scash_migrator/src/lib.rs` | `programs/scash_migrator/src/lib.rs::staging_layout_round_trips` |
| M2 | The migrate PDA is unique per staging account | `migrate_pda` | `programs/scash_migrator/src/lib.rs::pda_is_unique_per_staging` |
| M3 | Execute only forwards the staged payload to the staged target and refunds only to the staged refund key | `process_execute` | `scripts/migrate-e2e.mjs::MIGRATION E2E PASSED` |
| M4 | After Execute the PDA holds nothing and the staging account is closed | `process_execute` | `scripts/migrate-e2e.mjs::MIGRATION E2E PASSED` |

## SDK and wallet

| id | invariant | enforced in | test |
|---|---|---|---|
| S1 | `ivk` and every derived scalar are < Baby Jubjub subgroup order (250-bit truncation) | `sdk/src/keys.ts` `SCALAR_MASK` | `sdk/src/sdk.test.ts::key derivation is deterministic and ivk is a valid Baby Jubjub scalar` |
| S2 | Diversified addresses from one key are unlinkable and round-trip through bech32m | `sdk/src/address.ts` | `sdk/src/sdk.test.ts::diversified addresses round-trip through bech32m and are unlinkable` |
| S3 | Only the receiver (`ivk`) or the sender (`ovk`) can decrypt a note; a stranger cannot | `sdk/src/encryption.ts` | `sdk/src/sdk.test.ts::note encryption: receiver decrypts with ivk, strangers cannot, sender recovers with ovk` |
| S4 | A passphrase changes the seed; the `scashseed1` backup round-trips | `sdk/src/keys.ts` | `sdk/src/sdk.test.ts::seed derivation: passphrase changes the seed, backup round-trips` |
| S5 | Nullifiers depend on position, so identical notes have distinct nullifiers | `sdk/src/note.ts` | `sdk/src/sdk.test.ts::nullifier depends on position` |
| S6 | `ext_data` hashes to a field element and round-trips | `sdk/src/program.ts` | `sdk/src/sdk.test.ts::ext data serialization round-trips and hashes into the field` |
| S7 | A relayed 2-in/2-out with the maximum memo fits one 1,232-byte packet | lookup table + v0 tx | `sdk/src/sdk.test.ts::a relayed 2-in/2-out send with the maximum memo fits in one packet` |
| S8 | The receiver recomputes `pk_d` and the commitment before crediting a note | `sdk/src/wallet.ts` scan | `scripts/e2e.mjs::bob received note` |

## Ceremony

| id | invariant | enforced in | test |
|---|---|---|---|
| Z1 | The r1cs rebuilt from source hashes to the transcript value | `circuits/scripts/ceremony.mjs check` | `.github/workflows/ci.yml::ceremony.mjs check --fetch` |
| Z2 | The hosted zkey verifies against r1cs + ptau and its embedded contribution hashes equal the transcript, in order | `ceremony.mjs verifyAgainstTranscript` | `.github/workflows/ci.yml::ceremony.mjs check --fetch` |
