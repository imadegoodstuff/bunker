# Known issues and accepted risks

Listed so that an auditor does not spend budget rediscovering them. Each
entry says whether it is accepted, planned, or blocked on something external.
Section references (`§n`) are to `SECURITY.md`.

## Blocked on external parties

| item | status | what is needed |
|---|---|---|
| Phase-2 ceremony | open; coordinator contribution #1 for both circuits; tooling and CI verification in place | contributions from parties unrelated to the coordinator, then the beacon (`ceremony/README.md`) |
| Independent audit | not started; this package is the input | an external team; report goes to `audit/reports/` |
| **Mainnet deployment with development keys** | **owner's decision**: the contracts in `contracts/deployments/56.json` carry verifiers derived from the development zkeys (toxic waste public). Proofs are forgeable by anyone who reads the repo, so the BNB pool cap is the loss bound and can only be lowered. `SECURITY.md` §11. | the two items above; then a fresh deployment with ceremony-derived verifiers, and a public shutdown of shields on the old pool |

## Accepted for the current release

| item | reasoning |
|---|---|
| Stale root costs a second proof | A proof names a root the pool no longer holds after 128 later transactions and reverts `UnknownRoot`; the relayer's simulation catches it and the app re-syncs and re-proves once, then gives up. With arrivals ≤ 2 tx/s and a relayer delay ≤ 90 s expiry is rare; above that the ring or the app must change. `SECURITY.md` §7. |
| Single global tree, one insertion order | Every transaction inserts two leaves; a contended block serialises them by gas price like any other state. Sharding costs anonymity; deferred until there is load. |
| Output `pk_d` is not proven to be the recipient's | Impossible without the recipient's `ivk` (Sapling has the same limit). The receiver recomputes and refuses; a wrong `pk_d` burns the sender's funds only. |
| Tokens with blacklists, pausing or fee-on-transfer | A token that freezes the pool's balance blocks unshields of that asset for everyone; nothing in the pool can help. Fee-on-transfer tokens credit what arrived (`ShortDelivery` otherwise); rebasing tokens change the share rate. Opening a pool is permissionless, so the app names the risk per asset and nothing else. `SECURITY.md` §7. |
| Passphrase entropy is the user's | scrypt N=2¹⁵ caps an attacker near 10⁵ guesses/s; the app refuses passphrases scoring under 50 bits (≈178 years expected if random) and labels the score a heuristic, but cannot stop a targeted dictionary against a memorable phrase. No reset; seed backup is the only recovery. `SECURITY.md` §1. |
| Signature-only mode | A user may skip the passphrase after an explicit acknowledgement; a phished `SPENDING_KEY_MESSAGE` signature then is the spending key. `SECURITY.md` §1. |
| No reproducible-build attestation for the Fly images | The footer shows the commit each service was built from; contracts are verified on BscScan. Signed, reproducible service images are not provided. `SECURITY.md` §2, §5. |
| Indexer needs an operator when every endpoint fails | A block range that fails on every `RPC_URLS` endpoint is retried next tick and never skipped; after 10 minutes without progress `/health` returns 503 `degraded`. Redundancy is a deployment choice. `SECURITY.md` §5. |
| Relayer ERC-20 fee pricing trusts PancakeSwap spot | BNB fees are floored at `GAS_LIMIT × GAS_PRICE_CAP × (1 + margin)`; token fees convert that floor at the Pancake V2 spot price with a 50 % margin, or from `FEE_POLICY` where the operator set one. A manipulated price costs the relayer, not users; unpriced tokens are shield-only. `SECURITY.md` §4. |
| Note key agreement reviewed, not audited | Cofactor clearing on both sides with adversarial tests; no independent audit yet. `SECURITY.md` §2. |
| Mobile proving is unmeasured | ~3 s desktop; the app warns on low-memory devices and reports the measured time after the first proof. |
| Launchpad is new, unaudited code behind `exitTarget` | A failing or malicious exit hook can lose only what the user just unshielded, never pool funds; the pool pays `recipient` first, is non-reentrant across the hook, and the nullifiers are spent only if the whole transaction succeeds. `Launchpad.onExit` accepts calls from the pool only. `SECURITY.md` §9. |
| A private trade's proceeds rest one transaction at a throwaway key | An unshield and a shield cannot share one proof. The key is derived from the spending seed, funded with exactly its claim budget, never reused, and recoverable by nonce. What a watcher sees is "pool paid a fresh key; the fresh key shielded into a pool". `SECURITY.md` §9. |
| Curve trades are public; only the trader is not | Reserves, side, size and time of every trade are on-chain and indexed at `/launches`. A curve with few trades has a small anonymity set; the app shows the count. The relayer's random delay blunts timing correlation, not removes it. `SECURITY.md` §9. |
| Shields and unshields carry a dummy ciphertext | The contract requires two ciphertexts, not their contents; the omitted fields encrypt nothing anyone decrypts. Private sends are unchanged. SPEC §12. |
| Migration depends on PancakeSwap V2's router | `migrate` calls `addLiquidityETH` with the curve's whole balances and sends the LP to `0xdead`. A pair that someone created and skewed before graduation makes the router's slippage check fail; `migrate` is permissionless and retries at any price the agents accept, and the BNB waits on the curve meanwhile (nobody can take it). SPEC §13, `SECURITY.md` §9. |
| Launch images are hosted by the indexer | Content-addressed, immutable and rate-limited, but a single host. Launches made outside the app may carry any header hash and show no image. `SECURITY.md` §9. |
| Anonymity set is per asset (and per amount distribution) | `asset` is public; sharing one tree is an engineering choice. SPEC §8, `SECURITY.md` §3. |
| Dev keys in the deployed contracts (mainnet included) | Deterministic by design so CI can detect verifier drift; toxic waste is public, so proofs are forgeable and the turnstile plus the pool cap bound the loss to the pool's own TVL. The cap stays small until the ceremony keys ship. `SECURITY.md` §11. |
| Guardian is the deployer EOA at launch | It can pause new shields and lower caps, nothing else, and will be burned once the ceremony pool exists. Until then a stolen guardian key can freeze shields, not funds. `SECURITY.md` §6, §11. |
| Fee policy is four agent keys with no brake | Owner's decision. Each token's fee (0–5 %) moves one point per one-minute epoch toward the median of the four agents' fresh votes (quorum two); nobody can veto, pause, replace a key or add one, and the keys cannot touch anything but that number. Four captured keys reach 5 % or 0, one point a minute, and nothing else. The fee is paid to the treasury address, which fuels the keys and buys back the BUNKER token to burn or airdrop; a stolen treasury key loses that pot and nothing else. Every decision is logged at `/log`. `SECURITY.md` §10, SPEC §13. |
| Agent silence freezes the fee rather than resetting it | Fewer than two fresh votes (four-minute TTL) leaves the fee where it is, indefinitely; there is no fallback value and no key to set one. Accepted as the price of "no brake". `SECURITY.md` §10. |
| Relayer learns recipient of unshields | Inherent in relaying a public unshield; the relayer learns nothing about which notes were spent. Users can self-relay. `SECURITY.md` §4. |
| Indexer is a trusted-for-availability component | Every leaf, ciphertext and root it returns is re-verified by the client. `SECURITY.md` §5. |
| Documentation drift is a CI failure, not a review item | `scripts/doc-drift-check.mjs` reads the constants from the contracts and the SDK and fails when these documents stop stating them. `SECURITY.md` §12. |

## Fixed, kept here for history

| item | fix | where |
|---|---|---|
| `ivk` was 251 bits and could exceed the subgroup order | 250-bit `SCALAR_MASK` in SDK and circuit | `SECURITY.md` §1, SPEC §2 |
| Output `g_d`/`pk_d` were not checked on-curve | `ValidSubgroupPoint`, `BabyCheck` in `transact.circom`; adversarial suite | audit/INVARIANTS.md C10, C11 |
| First-depositor share inflation | virtual offset 10⁶ in share math | `SECURITY.md` §7 |
| Key agreement did not clear the cofactor on the receiver side | `agree()` multiplies by 8 on both sides; test with a torsion `epk` | `SECURITY.md` §2, INVARIANTS S8 |
| Solana-era transaction-size limits (1,232-byte packets, `v0` lookup tables, 2-input default) | the BSC port removes them: `transact4x2` is always available, exit data is ABI-encoded, memos are bounded only by `MEMO_MAX` | SPEC §7, §12 |
