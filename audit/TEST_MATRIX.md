# Test matrix

What each suite covers, how to run it, and what nothing covers yet.

| suite | command | runs in CI | covers |
|---|---|---|---|
| contract unit tests | `npm run -w contracts test` | `contracts` job | PoseidonT3 vs circomlibjs, empty root, asset ids, unit bounds and permissionless pools, share math vs the SDK, guardian powers, malformed transacts, ASP ring, `extDataHash`; launchpad curve vs the JS mirror, exit-hook buys/sells paying claim key and relayer, fee votes and roll, `rollPure` catch-up and expiry, graduation and PancakeSwap migration with LP burned (mock router) |
| ABI drift | `npm run -w contracts build && git diff --exit-code sdk/src/abi` | `contracts` job | the ABIs the SDK ships equal the compiled contracts |
| SDK tests | `npm run -w sdk test` | `ts` job | key derivation and scalar bounds, address round-trip, asset ids, note encryption, torsion/cofactor cases, Merkle paths, ext data vs `extDataHash`, share math, proof argument order, public amount encoding, nullifier position, seed/backup, note reservation, error tables vs ABIs, claim keys, exit data, fee-policy mirror, curve math, passphrase strength |
| circuit build | `npm run -w circuits build` | `ts`, `audit`, `e2e`, `ceremony` jobs | circuits compile; constraint counts |
| circuit adversarial suite | `npm run -w circuits test` | `e2e` job | 14 tampered witnesses of a valid unshield, each must be unsatisfiable (`audit/INVARIANTS.md` C1–C13) |
| verifier drift | `setup-dev` + `npm run -w contracts verifiers` + `git diff --exit-code contracts/contracts/verifiers` | `e2e` job | the Solidity verifiers equal the ones derived from source |
| circomspect | `node circuits/scripts/lint.mjs` | `audit` job | under-constrained signal patterns; allow-list in `circuits/circomspect-allow.json` |
| npm audit | `node scripts/audit.mjs` | `audit` job | known-vulnerable production dependencies; allow-list with reasons in `npm-audit-allow.json` |
| end-to-end | `npm run e2e` | `e2e` job | Hardhat node, deploy, shield (BNB), relayed private send with memo, receiver scan, unshield to a fresh key, donate and rate accrual, replay rejection, turnstile, launch, relayed private buy and claim shield, agent votes and fee roll, relayed private sell with tip and claim, capped last buy with refund, graduation, PancakeSwap migration (mock router), treasury receipts |
| indexer tests | `npm test -w indexer` | `ts` job | block-range paging, failing-range retry without skipping, RPC failover, pool/launchpad/fee-policy event ingestion with idempotent replays, metadata validation/store/rate limit |
| agents tests | `npm test -w agents` | `ts` job | model output parsing, snapping to the policy grid, when a vote is re-sent, treasury top-ups/buyback timing/holder selection/airdrop split, Orbio OAuth |
| relayer tests | `npm test -w relayer` | `ts` job | gas-price clamp and oracle, nullifier idempotency across jobs |
| ceremony check | `node circuits/scripts/ceremony.mjs check --fetch` | `ceremony` job | r1cs hashes, transcript chain, hosted zkey verification with contribution hashes |
| invariants list | `node scripts/audit-package-check.mjs` | `audit` job | every test reference in `INVARIANTS.md` resolves |
| doc drift | `node scripts/doc-drift-check.mjs` | `audit` job | SPEC/SECURITY/README/KNOWN_ISSUES state the constants the contracts and SDK have |

## Not covered by any automated test

- **Fee-on-transfer ERC-20 end-to-end.** The `ShortDelivery` path is read-only
  reviewed; a mock token that takes a fee would exercise the delta check.
- **Root-ring eviction under load.** The Solana-era `bench.mjs` (139 concurrent
  transacts, eviction at exactly 128) has not been ported to Hardhat.
- **Real PancakeSwap.** Migration runs against `contracts/contracts/test/MockPancake.sol`;
  the real router is exercised only on mainnet.
- **Relayer HTTP service.** Fee floor, token pricing, exit allow-list and
  simulate-before-queue are not covered by an automated test; e2e submits
  with a relayer key directly.
- **Relayer under adversarial load.** Rate limiting and queue behaviour are
  not load-tested.
- **Indexer correctness under reorgs.** The scanner trails the head by
  `CONFIRMATIONS` blocks; the client re-verifies, so the risk is availability,
  not integrity, but it is untested.
- **Multi-input spends in e2e.** `transact4x2` is covered by the circuit build
  and the SDK's builder; the e2e script spends at most two inputs.
- **Browser proving on low-memory devices.** No mobile budget measured.
- **Ceremony contributions from outside parties.** The tooling is tested; a
  second contributor has not run it.

## How an auditor should add tests

- Circuit: add a `test(...)` to `circuits/test/adversarial.test.mjs` using
  the `rejects(mutate, label)` helper; the honest witness is built once.
- Contracts: mocha/ethers tests in `contracts/test/*.test.cjs`; fixtures
  come from `contracts/scripts/lib.cjs`.
- Protocol flows: extend `scripts/e2e.mjs`; `--spawn` starts its own Hardhat
  node.
- Then add the row to `audit/INVARIANTS.md` so the reference is checked.
