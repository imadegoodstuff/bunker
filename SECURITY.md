# Security

scash is pre-release software. The programs are **not audited** and the current
proving keys come from a **development setup** (single contributor). Do not use
with real value until the public phase-2 ceremony (see `ceremony/README.md`)
has concluded and the mainnet verifying keys are pinned in a tagged release.

## Reporting

Report vulnerabilities privately to the maintainers via GitHub Security
Advisories on this repository. Please do not open public issues for exploitable
bugs. We aim to acknowledge reports within 72 hours.

## Scope

- `programs/scash_vault` — shielded pool program (Groth16 verification, note
  tree, nullifiers, turnstile accounting, exits)
- `programs/scash_harvester` — SCASH creator-fee harvester
- `circuits/` — circom circuits `transact2x2`, `transact4x2`
- `sdk/` — key derivation, note encryption, proving, transaction building
- `relayer/`, `indexer/` — off-chain infrastructure (privacy-relevant, not
  funds-custodial)

## Design-level guarantees

- **Immutability**: the vault program is deployed without an upgrade authority
  on mainnet. Bug fixes ship as a new program plus an opt-in migrator.
- **Turnstile**: per asset, `total_out <= total_in` is enforced on-chain, so a
  soundness bug in the circuit cannot drain other pools or print beyond what
  entered a pool.
- **Guardian limits**: the guardian can only pause *shielding* and *lower* the
  TVL cap. It can never pause withdrawals, change verifying keys, or move funds.
- **Verifying key hygiene**: VK export refuses `delta == gamma` (a key with no
  phase-2 contribution is trivially forgeable).
- **Nullifier derivation** includes the leaf position, preventing faerie-gold
  style double-spends across identical commitments.

## Tooling we run (free)

- `circomspect` on all circuits
- `cargo audit`, `cargo clippy -D warnings`
- snarkjs `zkey verify` against the published ptau
- Fixture-based cross-checks: proofs produced by the SDK are verified by the
  exact on-chain verifier code (`programs/scash_vault/tests`)
