# Known issues and accepted risks

Listed so that an auditor does not spend budget rediscovering them. Each
entry says whether it is accepted, planned, or blocked on something external.

## Blocked on external parties

| item | status | what is needed |
|---|---|---|
| Phase-2 ceremony | open; coordinator contribution #1 for both circuits; tooling and CI verification in place | contributions from parties unrelated to the coordinator, then the beacon (`ceremony/README.md`) |
| Independent audit | not started; this package is the input | an external team; report goes to `audit/reports/` |
| Mainnet deployment | not done | the two items above |

## Accepted for the current release

| item | reasoning |
|---|---|
| Stale root surfaces as `InvalidProof`, not `UnknownRoot` | The proof names its root by ring index; passing the root itself would cost 32 bytes of the 1,232-byte packet. Clients treat both errors as "re-sync and re-prove". |
| App does not re-prove automatically on root expiry | ≈3–5 s of proving; the relayer rejects stale proofs before queueing, so the user sees the failure immediately. Planned for the app. |
| Single global tree ⇒ one write lock | Measured 36 transacts/slot on a test validator. Sharding costs anonymity; deferred until there is load. |
| 128-root ring | With arrivals ≤ 2 tx/s and a relayer delay ≤ 30 s, expiry probability is negligible; above that the ring or the app must change. Numbers in `SECURITY.md` §7. |
| Output `pk_d` is not proven to be the recipient's | Impossible without the recipient's `ivk` (Sapling has the same limit). The receiver recomputes and refuses; a wrong `pk_d` burns the sender's funds only. |
| USDC-style freeze authority on the base mint is not refused | Freezing the vault's token account would block unshields of that asset, but refusing it would exclude USDC. Documented; guardian cannot do anything about it either. |
| Yield only on the SCASH pool | Creator fees are SCASH; other pools have rate 1. Stated in README, FAQ and SPEC §9. |
| Anonymity set is per asset (and per amount distribution) | `asset` is public; sharing one tree is an engineering choice. SPEC §8. |
| Migration is two transactions, not one | Two proofs do not fit one packet. Between them funds sit in a PDA whose only destination is the staged shield; Execute is permissionless. |
| Migrator does not hide that X left pool A and X entered pool B | Same information as any public shield; old notes spent and new note owner remain hidden. |
| Dev keys in the deployed devnet programs | Deterministic by design so CI can detect VK drift; toxic waste is public; never for value. |
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
