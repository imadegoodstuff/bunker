# Test matrix

What each suite covers, how to run it, and what nothing covers yet.

| suite | command | runs in CI | covers |
|---|---|---|---|
| Rust unit tests | `cargo test --workspace` | `rust` job | field encoding, share math fuzz (64 seeds × 400 ops), Token-2022 TLV parsing, migrator layout/PDA, Groth16 verification of the committed fixture incl. tamper, launchpad curve (k monotone, round trip never profits, exact-out tight, fee math) and state layouts |
| clippy | `cargo clippy --workspace --all-targets -- -D warnings` | `rust` job | lint-level issues; `unexpected_cfgs`/`deprecated` allowed |
| SBF build | `cargo build-sbf` for vault, harvester, migrator, launch | `sbf` job | the programs compile for the target; `.so` artifacts feed e2e and the manual mainnet deploy |
| SDK tests | `npm run -w sdk test` | `ts` job | key derivation and scalar bounds, address round-trip, note encryption, Merkle paths, ext data, public amount encoding, nullifier position, seed/backup, packet size |
| circuit build | `npm run -w circuits build` | `ts`, `audit`, `e2e`, `ceremony` jobs | circuits compile; constraint counts |
| circuit adversarial suite | `npm run -w circuits test` | `e2e` job | 14 tampered witnesses of a valid unshield, each must be unsatisfiable (`audit/INVARIANTS.md` C1–C13) |
| circomspect | `node circuits/scripts/lint.mjs` | `audit` job | under-constrained signal patterns; allow-list in `circuits/circomspect-allow.json` |
| cargo-audit / npm audit | `cargo audit`, `node scripts/audit.mjs` | `audit` job | known-vulnerable dependencies; allow-list with reasons in `npm-audit-allow.json` |
| VK drift | `setup-dev` + `export-vk` + `git diff --exit-code` | `e2e` job | compiled verifying key equals the one derived from source |
| end-to-end | `node scripts/e2e.mjs` | `e2e` job | init, pool, lookup table, shield, relayed send with memo, receiver scan, unshield to fresh key, donate and yield accrual, replay rejection, turnstile |
| bench | `node scripts/bench.mjs --n 140` | `e2e` job, artifact `bench-report` | proving latency, 139 concurrent transacts, per-slot landing, CU, root-ring eviction at exactly 128 |
| migration e2e | `node scripts/migrate-e2e.mjs --new-vault <id>` | `e2e` job (fresh validator) | stage → old-vault unshield to PDA → permissionless Execute → new-vault note; PDA emptied; staging closed; refund |
| launchpad e2e | `node scripts/launch-e2e.mjs` | `e2e` job (fresh validator) | launch (mint without authorities, metadata, pool, frozen table) → three agent votes recorded, stranger and out-of-bounds votes refused, fee unchanged within the epoch → retired public-trade tag and premature migrate refused → relayed private buy (claim key holds exactly the quote and the reserve; books match) → claim shield signed by the claim key only → harvest (treasury half, pool rate rises, second harvest refused) → relayed private sell with tip → SOL claim → direct exit call refused → epoch boundary: program's rolled fee equals the SDK's `rolled` → buy past the end of the curve (capped, refund at the claim key, graduated at ≈20 SOL) → vote, harvest and a late private buy refused → `migrate` into Raydium CP-Swap cloned from mainnet-beta (pool owned by CP-Swap, vault balances to the lamport, LP supply 0, migrate PDA gone, treasury receipts, second migrate refused) → buyer key absent from every launchpad transaction |
| indexer tests | `npm test -w indexer` | `ts` job | RPC failover and deferral, launch/trade/harvest/graduate/migrate ingestion with idempotent replays, fee vote/roll events from the launch program's own history, metadata upload validation/store/rate limit |
| agents tests | `npm test -w agents` | `ts` job | model output parsing, snapping to the policy grid, when a vote is re-sent; Orbio OAuth: PKCE/state, single-use state, one refresh under concurrency, new refresh token persisted before use, refusal marks the connection disconnected, pair survives a restart |
| relayer tests | `npm test -w relayer` | `ts` job | priority-fee oracle, nullifier idempotency |
| ceremony check | `node circuits/scripts/ceremony.mjs check --fetch` | `ceremony` job | r1cs hashes, transcript chain, hosted zkey verification with contribution hashes |
| invariants list | `node scripts/audit-package-check.mjs` | `audit` job | every test reference in `INVARIANTS.md` resolves |

## Not covered by any automated test

- **Token-2022 fee mint end-to-end.** The `ShortDelivery` path is unit-tested
  only through the extension refusal; a real transfer-fee mint on a validator
  with the Token-2022 program would exercise the delta check directly.
- **Guardian paths.** `SetShieldPaused`, `LowerTvlCap`, `UpdateAspRoot` are
  not exercised by e2e (they are short and read like their names, but an
  auditor should confirm the authority checks).
- **Exit adapters other than the launchpad.** The exit CPI (`exit_target`,
  `exit_data` forwarding, trailing accounts with flags preserved) is exercised
  end-to-end by the launchpad e2e; no swap adapter exists yet.
- **Migration fallback config.** The e2e migrates through Raydium's config 0;
  the path that accepts another config when the config-0 pool was front-run
  is checked by the program's derivation code but not exercised end-to-end.
- **Metadata upload over HTTP.** `indexer/src/meta.ts` (sniffing, bounds,
  content addressing, store, rate limit) is unit-tested; the Fastify route
  itself is not.
- **Relayer `/relay` policy for launchpad exits.** The e2e signs with a
  relayer key directly; the HTTP checks (exit target allow-list, tip floor,
  per-token table) are not covered by an automated test.
- **Multi-input spends in e2e.** `transact4x2` is covered by the fixture and
  the circuit build; the e2e script spends at most two inputs.
- **Browser proving on low-memory devices.** No mobile budget measured.
- **Relayer HTTP service.** Fee floor, policy and simulate-before-queue are not covered by an automated test; e2e signs with a relayer key directly.
- **Relayer under adversarial load.** Rate limiting and queue behaviour are
  not load-tested; the relayer simulates each transaction before accepting.
- **Indexer correctness under reorgs.** The indexer follows `confirmed`
  commitment; the client re-verifies, so the risk is availability, not
  integrity, but it is untested.
- **Ceremony contributions from outside parties.** The tooling is tested; a
  second contributor has not run it.

## How an auditor should add tests

- Circuit: add a `test(...)` to `circuits/test/adversarial.test.mjs` using
  the `rejects(mutate, label)` helper; the honest witness is built once.
- Program: Rust unit tests at the end of the relevant module (clippy
  requires the test module to be last) or a new integration test in
  `programs/scash_vault/tests/`.
- Protocol flows: extend `scripts/e2e.mjs`; it runs against a fresh
  `solana-test-validator` with the three programs loaded.
- Then add the row to `audit/INVARIANTS.md` so the reference is checked.
