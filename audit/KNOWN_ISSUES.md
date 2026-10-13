# Known issues and accepted risks

Listed so that an auditor does not spend budget rediscovering them. Each
entry says whether it is accepted, planned, or blocked on something external.

## Blocked on external parties

| item | status | what is needed |
|---|---|---|
| Phase-2 ceremony | open; coordinator contribution #1 for both circuits; tooling and CI verification in place | contributions from parties unrelated to the coordinator, then the beacon (`ceremony/README.md`) |
| Independent audit | not started; this package is the input | an external team; report goes to `audit/reports/` |
| **Mainnet deployment with development keys** | **owner's decision**: the hosted app/relayer/indexer point at mainnet-beta and the manual `deploy-mainnet` CI job deploys the four programs under the ids in the README once the `mainnet` environment secrets are set; until that job has run the footer reports "not deployed on this cluster". The verifying keys are the development keys (toxic waste public), the SOL pool cap is the loss bound and can only be lowered, and the deployer keeps the upgrade authority so the ceremony keys can replace them. `SECURITY.md` §16. | the two items above; then a release that burns in the ceremony keys and revokes the upgrade authority |
## Accepted for the current release

| item | reasoning |
|---|---|
| Stale root surfaces as `InvalidProof`, not `UnknownRoot` | The proof names its root by ring index; passing the root itself would cost 32 bytes of the 1,232-byte packet. Clients treat both errors as "re-sync and re-prove". |
| Root expiry costs a second proof | The app re-syncs and re-proves once when the relayer's simulation reports `UnknownRoot`/`InvalidProof`, then gives up. ≈3–5 s extra on a laptop; the window itself (128 transactions) is unchanged. `SECURITY.md` §10. |
| Single global tree ⇒ one write lock | Measured 36 transacts/slot on a test validator. Sharding costs anonymity; deferred until there is load. |
| 128-root ring | With arrivals ≤ 2 tx/s and a relayer delay ≤ 30 s, expiry probability is negligible; above that the ring or the app must change. Numbers in `SECURITY.md` §7. |
| Output `pk_d` is not proven to be the recipient's | Impossible without the recipient's `ivk` (Sapling has the same limit). The receiver recomputes and refuses; a wrong `pk_d` burns the sender's funds only. |
| USDC-style freeze authority on the base mint is not refused | Freezing the vault's token account would block unshields of that asset, but refusing it would exclude USDC. The app reads `freeze_authority` and names it per asset; guardian cannot do anything about it either. |
| Yield only on the SCASH pool | Creator fees are SCASH; other pools have rate 1. Stated in README, FAQ, SPEC §9 and the app's per-transaction fee summary. |
| Passphrase entropy is the user's | scrypt N=2¹⁵ caps an attacker near 10⁵ guesses/s; the app refuses passphrases scoring under 50 bits (≈178 years expected if random) and labels the score a heuristic, but cannot stop a targeted dictionary against a memorable phrase. No reset; seed backup is the only recovery. `SECURITY.md` §1, §10. |
| No reproducible-build attestation for the Fly images | Footer shows app, relayer and indexer commits live plus the on-chain ELF sha256; `sbf` CI prints `SHA256SUMS`; `scripts/verify-program.mjs` compares chain to file. Signed, reproducible service images are not provided. `SECURITY.md` §11. |
| Transaction unreadable on every configured endpoint needs an operator | Deferred signatures are retried forever against every `RPC_URLS` fallback and never dropped; after 10 min `/health` goes 503 `degraded` and names them. The hosted indexer currently lists one endpoint, so redundancy there is a deployment choice not yet made. `SECURITY.md` §11, §14. |
| Relayer SPL fee pricing is manual | SOL fees are checked against rent + signature + cap-priced priority fee + 20 %; SPL fees come from `FEE_POLICY` with no market conversion. `/health` reports runway in worst-case transactions. `SECURITY.md` §14. |
| Note key agreement reviewed, not audited | Cofactor clearing on both sides with adversarial tests; outside readers have confirmed it from source; no independent audit yet. `SECURITY.md` §3, §14. |
| Mobile proving is unmeasured | ~3 s desktop, p50 4.8 s in Node; the app warns on mobile/low-memory devices and reports the measured time after the first proof. `SECURITY.md` §6. |
| Client builds `v0` transactions (1,232 bytes) although `v1` (4,096) is live | Memo ceiling and 2-input default follow from this. Moving to `v1` inlines ~20 accounts and needs wallet/RPC opt-in; not scheduled. SPEC §15. |
| Swap exit adapter not deployed | README marks it "in review"; each adapter needs its own review before the vault is ever pointed at it. `SECURITY.md` §6. |
| Launchpad is new, unaudited code behind `exit_target` | A failing or malicious exit program can lose only what the user just unshielded, never pool funds; the vault pays `recipient` first and the nullifiers are spent only if the whole transaction succeeds. The launchpad refuses top-level calls and verifies the outer instruction is the vault's. `SECURITY.md` §15, SPEC §16. |
| A private trade's proceeds rest one transaction at a throwaway key | An unshield and a shield do not fit one packet (same shape as the migrator). The key is derived from the spending seed, funded with exactly its claim cost, never reused, and recoverable by nonce. What a watcher sees is "vault paid a fresh key; the fresh key shielded into a pool". `SECURITY.md` §15. |
| Curve trades are public; only the trader is not | Reserves, side, size and time of every trade are on-chain and indexed at `/launches`. A curve with few trades has a small anonymity set; the app shows the count. Fixed trade sizes and the relayer's random delay blunt timing correlation, not remove it. `SECURITY.md` §15. |
| Shields and unshields send an empty dummy ciphertext; unshields also no outgoing record | The program requires two ciphertexts, not their lengths; the omitted fields encrypt nothing anyone decrypts (the dummy is zero-value to the sender, an unshield's change is the sender's). Saves 99 / 179 bytes; needed for a relayed trade and its claim to fit. Private sends are unchanged. SPEC §7. |
| Migration depends on Raydium CP-Swap's account layout and rent | `migrate` reproduces the `initialize` account list and keeps a 0.1 SOL rent reserve; a Raydium upgrade that changes either would make `migrate` fail until this program is upgraded, with the curve's SOL waiting on the curve (nobody can take it). A front-run config-0 pool is handled by accepting another enabled config. SPEC §16, `SECURITY.md` §15. |
| Launch images are hosted by the indexer | Content-addressed, immutable and rate-limited, but a single host; a mint's URI points at it. Launches made outside the app may carry any URI and show no image. `SECURITY.md` §15. |
| Anonymity set is per asset (and per amount distribution) | `asset` is public; sharing one tree is an engineering choice. SPEC §8. |
| Migration is two transactions, not one | Two proofs do not fit one packet. Between them funds sit in a PDA whose only destination is the staged shield; Execute is permissionless. |
| Migrator does not hide that X left pool A and X entered pool B | Same information as any public shield; old notes spent and new note owner remain hidden. |
| Dev keys in the deployed programs (mainnet included) | Deterministic by design so CI can detect VK drift; toxic waste is public, so proofs are forgeable and the turnstile plus the pool cap bound the loss to the pool's own TVL. Users are told to shield only what they can afford to lose until the ceremony keys ship. `SECURITY.md` §16. |
| Upgrade authority held until the ceremony keys ship | Needed to replace the development verifying keys; revoked in the release that burns the ceremony keys in. Until then the deployer key is a trust assumption, visible via `solana program show`. `SECURITY.md` §16. |
| Fee policy is four agent keys with no brake | Owner's decision. Each token's fee (0.5–3 %) and holders' share (50–100 %) move one step per ~6-minute epoch toward the median of the four agents' fresh votes (quorum two); nobody can veto, pause, replace a key or add one, and the keys cannot touch anything but those two numbers. Four captured keys reach the bounds, one step at a time, and nothing else. Agents are model-driven processes whose every decision is logged at `/log` and memo'd on-chain. `SECURITY.md` §17, SPEC §16. |
| Agent silence freezes the fee rather than resetting it | Fewer than two fresh votes (24-minute TTL) leaves the fee where it is, indefinitely; there is no fallback value and no key to set one. Accepted as the price of "no brake". `SECURITY.md` §17. |
| Relayer learns recipient of unshields | Inherent in relaying a public unshield; the relayer learns nothing about which notes were spent. Users can self-relay. |
| Indexer is a trusted-for-availability component | Every leaf, ciphertext and root it returns is re-verified by the client. |

## Fixed, kept here for history

| item | fix | commit |
|---|---|---|
| Token-2022 transfer-fee mints credited `amount` while the vault received less | extension refusal at `create_pool` + `move_in` delta check | see `SECURITY.md` §6 |
| `ivk` was 251 bits and could exceed the subgroup order | 250-bit `SCALAR_MASK` in SDK and circuit | `SECURITY.md` §1, SPEC §2 |
| Output `g_d`/`pk_d` were not checked on-curve | `ValidSubgroupPoint`, `BabyCheck` in `transact.circom`; adversarial suite | `SECURITY.md` §6 |
| First-depositor share inflation | virtual offset 10⁶ in share math; fuzz test | `SECURITY.md` §7 |
| Root ring advanced per leaf (window was 64 transactions for 2-output transacts) | `tree::record_root` once per `transact`; bench asserts exact eviction at 128 | `SECURITY.md` §7 |
| Fixed-message signature as sole key material | scrypt seed with optional passphrase, single derivation path, `scashseed1` backup | `SECURITY.md` §1 |
| Indexer fetched with `maxSupportedTransactionVersion: 0`; one `v1` transaction to the program would stall the scanner forever | request version 1, per-signature fallback, deferred signatures retried every tick, `/commitments` serves only the contiguous prefix; `indexer/src/scanner.test.ts` | `SECURITY.md` §9–10 |
| SECURITY.md said 40 bits ≈ 10 000 years at 10⁵ guesses/s | 64 days expected; table and pinned test; floor raised to 50 bits; phrases scored as phrases | `SECURITY.md` §10 |
| Scanner dropped `null` RPC results (not indexed, not queued) and evicted queued signatures on `null` | `null` and thrown errors both defer; attempts/age tracked; tests for both paths | `SECURITY.md` §11 |
| App detected stale roots by regex over RPC error JSON | SDK `VAULT_ERRORS` mirrored from `error.rs` (test-pinned); relayer returns `vaultError`; app uses the field | `SECURITY.md` §11 |
| `ShieldedWallet.release` keyed by nullifier while `consumed` held commitments: notes stayed reserved after any failure | `consumed` = commitments, `consumedNullifiers` added, `reserve/release/isPending/isSpent` tested | `SECURITY.md` §12 |
| Client could re-prove the same notes after a lost relayer response | notes stay reserved after acceptance, chain re-sync before release; relayer idempotent on nullifiers (`queue.test.ts`) | `SECURITY.md` §12 |
| SECURITY.md §7 still described manual resubmit after §10 added auto re-prove | text fixed; `scripts/doc-drift-check.mjs` in CI fails on superseded phrases and on code facts missing from docs | `SECURITY.md` §13 |
| Empty passphrase derivable by default argument | `seedFromSignature` requires `{ allowEmpty: true }`; app requires typed "signature only" | `SECURITY.md` §13 |
| Indexer had one RPC; a deferred transaction waited for a human to switch endpoints | `RPC_URLS` fallbacks tried per signature and on every retry; `degraded` now means "no endpoint"; three failover tests | `SECURITY.md` §14 |
| Relayer priority fee was a static `CU_PRICE`; cost floor ignored fee movement between accept and submit | p75 of recent fees clamped to `[CU_PRICE, CU_PRICE_MAX]`, floor priced at the cap, `/health` runway | `SECURITY.md` §14 |
| SPEC §11 described exits through a transient token account and a `scash_swap` adapter that does not exist; §13 said harvester fees fund a relayer gas pool, which `Distribute` does not do | §11 rewritten to the code (`recipient` paid first, exit program invoked with the trailing accounts and `to_recipient ‖ exit_data`); §13 states the vault/team split only | SPEC §11, §13 |
