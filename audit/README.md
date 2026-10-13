# scash audit package

Everything an external auditor needs to scope, reproduce and start. This
directory is maintained alongside the code; CI fails if the invariants it
lists stop being tested (`scripts/audit-package-check.mjs`).

**Status: no independent audit has been performed.** This package exists so
that one can start without a discovery phase. When a report is delivered it is
linked from `SECURITY.md` and copied to `audit/reports/`.

## Scope

| component | path | size | language |
|---|---|---|---|
| vault program | `programs/scash_vault/src` | ~2,100 lines (incl. generated VK constants) | Rust, no framework |
| migrator program | `programs/scash_migrator/src/lib.rs` | ~330 lines | Rust |
| harvester program | `programs/scash_harvester/src/lib.rs` | ~150 lines | Rust |
| launchpad program | `programs/scash_launch/src` | ~1,270 lines (curve, state, Token-2022 CPIs, processor) | Rust |
| circuits | `circuits/src/*.circom` | `transact2x2` 33,515 constraints, `transact4x2` 64,860 | circom 2 |
| SDK (key derivation, note encryption, witness building) | `sdk/src` | ~2,000 lines | TypeScript |
| relayer | `relayer/src` | ~500 lines | TypeScript |

Out of scope unless agreed: the Next.js app UI (`app/`) beyond its use of
the SDK, the indexer (`indexer/`, a read-only cache; the app verifies every
note it returns), Fly.io deployment config.

## Priorities

1. **Circuits** (`circuits/src/transact.circom`, `keys.circom`, `note.circom`).
   Soundness of the balance equation, nullifier derivation, Merkle membership,
   ASP membership, output address checks. The constraint system is the only
   thing standing between a bug and a full drain up to the turnstile.
2. **`process_transact`** (`programs/scash_vault/src/processor.rs`): public
   input binding (`ext_data_hash` covers everything that moves funds), root
   lookup, nullifier PDAs, turnstile, share math, Token-2022 handling, exit
   CPI.
3. **Key derivation and note encryption** (`sdk/src/keys.ts`,
   `encryption.ts`): a wallet-signature-derived seed, scalar truncation to 250
   bits, ChaCha20-Poly1305 with an ephemeral Baby Jubjub key.
4. **Migrator** (`programs/scash_migrator`): PDA signing authority, staged
   instruction forwarding, leftover handling.
5. **Relayer**: fee logic, simulation-before-submit, no ability to redirect
   funds (it should be impossible by construction; confirm).
6. **Launchpad** (`programs/scash_launch`, SPEC §16, `SECURITY.md` §15): the
   exit handler's vault-origin check (stack height + instructions sysvar),
   intake sweep, curve arithmetic and the lamport-balance invariant, the
   claim-key reserve, harvest's donate path, graduation gating of the public
   instructions. The vault bounds the damage to what one user just
   unshielded; confirm that bound holds and that nothing in the launchpad
   can reach pool funds.

## Reproducing the build

```bash
git clone https://github.com/imadegoodstuff/scash && cd scash
npm ci
npm run -w circuits build && node circuits/scripts/setup-dev.mjs && node circuits/scripts/export-vk.mjs
git diff --exit-code programs/scash_vault/src/vk     # VK derived from source must match the committed one
cargo build-sbf --manifest-path programs/scash_vault/Cargo.toml
cargo test --workspace
npm run -w sdk test && npm run -w circuits test
node scripts/e2e.mjs            # needs solana-test-validator, see .github/workflows/ci.yml
```

Toolchain versions are pinned in `rust-toolchain.toml`, `circuits/package.json`
(circom2, snarkjs) and `.github/workflows/ci.yml` (Solana CLI). Program ids
are in `README.md`; the devnet deployment is redeployed from `main` by CI.

## Documents

- `THREAT_MODEL.md`: assets, actors, trust assumptions, what an attacker can
  and cannot do by design.
- `INVARIANTS.md`: every property the system relies on, where it is enforced,
  and which test exercises it. The list is machine-checked against the test
  files.
- `TEST_MATRIX.md`: what each test suite covers and, more importantly, what
  none of them covers.
- `KNOWN_ISSUES.md`: accepted risks and open items, with the reasoning, so an
  auditor does not spend time rediscovering them.
- `../SPEC.md`: the protocol. `../SECURITY.md`: review history and the
  current "not done" list.

## Contact

Open a private report through GitHub Security Advisories on the repository
for anything exploitable. Scoping questions and findings that are not
exploitable can go in a regular issue. Engagement terms (fixed scope, fixed
duration, report published in full in `audit/reports/` after fixes) are the
default offer.
