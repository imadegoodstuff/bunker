# Threat model

## Assets

1. **Funds in the pool**: BNB and ERC-20 balances held by `ShieldedPool`, owed
   to note holders according to their shares, per asset.
2. **Privacy of note holders**: which notes a transaction spent, who received
   the outputs, and the balance of any address.
3. **Integrity of the share rate**: a donation to a pool must accrue to the
   existing note holders of that asset pro rata and to nobody else.
4. **Availability**: the ability to unshield. Shields may be paused by the
   guardian; unshields can never be paused.
5. **Launchpad proceeds in flight**: what a trade just unshielded, resting at
   a claim key for one transaction.

## Actors

| actor | can | cannot by design |
|---|---|---|
| anyone with a wallet | shield, unshield, send, donate, open a pool for any ERC-20, run a relayer, run an indexer, call `harvest`, `graduate`, `migrate` | spend notes they do not hold keys for; move funds other than via a valid proof |
| relayer | choose whether and when to submit a transaction; collect the fee the proof names | change recipient, amount, fee, exit data or ciphertexts (all under `extDataHash`); learn which notes were spent |
| indexer | serve stale or wrong leaves/ciphertexts/metadata | make a client accept a wrong note (client recomputes `pk_d`, commitment and Merkle root) |
| guardian key | pause shields; lower (never raise) a pool's TVL cap; burn itself | pause unshields; move funds; change any contract (no owner, no proxy) |
| ASP provider | publish roots into its own 32-entry ring | force anyone to use its set; affect spenders who pass `aspRoot = 0` |
| ceremony coordinator | order contributions; apply the beacon | produce a sound key with a trapdoor if at least one other contributor was honest |
| exit target contract | receive `onExit` with funds already at `recipient` | hold any allowance or role on the pool; re-enter `transact` (reentrancy guard; nullifiers already recorded) |
| launchpad (as exit target) | price what the pool just paid it; hand tokens or BNB to the claim key the proof named; keep its fee | touch pool funds; be called by anyone but the pool (`NotFromPool`); change who receives (claim key is under `extDataHash`) |
| agent keys (four) | vote a fee in `[0, 500]` bps for any live curve | move the fee faster than one step per epoch; touch anything but the fee; be replaced or added |
| treasury address | receive harvested fees; spend them on gas, buybacks, burns, airdrops | reach the curves or the pool |
| token creator | pay the launch gas; pick name, symbol, metadata | hold an allocation, a mint or pause function, a fee switch, or any later power over the curve or the pool |
| BSC validator / RPC | censor, reorder, delay; see ciphertexts and public inputs; see `msg.sender` of every call | decrypt notes; forge proofs |

## Trust assumptions

- Groth16 over BN254 and the Perpetual Powers of Tau phase 1 are sound.
- Poseidon (circomlib parameters, `poseidon-solidity` bytecode) is
  collision-resistant and a good PRF for nullifiers.
- Baby Jubjub DDH holds (note encryption key agreement).
- The user's wallet signs the fixed derivation message only for BUNKER and
  the wallet software itself is honest; a wallet that leaks signatures leaks
  the shielded key (mitigated by the passphrase).
- At least one phase-2 contributor was honest. **Today there is exactly one
  contribution, so the current keys are not trustworthy; see
  `ceremony/README.md` and `SECURITY.md` §11.**
- The deployed bytecode equals the verified source on BscScan.
- PancakeSwap V2's router and factory behave as documented at migration.

## What an attacker gains from each class of bug

| bug | worst case | bound |
|---|---|---|
| circuit soundness | forge notes, drain a pool | turnstile: at most `totalIn − totalOut` of that asset; TVL cap; visible on-chain |
| nullifier logic | double spend | same bound |
| share rounding | extract dust repeatedly | rounding favours the pool; mirror tests against the SDK |
| ERC-20 accounting | credit more than delivered | balance-delta check (`ShortDelivery`) |
| key derivation | spend or view another user's notes | 250-bit scalars, domain-separated scrypt seed |
| note encryption | learn amounts/recipients | ChaCha20-Poly1305 with per-note ephemeral key |
| relayer | censorship, delay | anyone can run one; the app can self-relay |
| indexer | stale view, denial | client verifies everything it is told against the chain |
| launchpad | lose one trade's proceeds; misprice a trade | bounded to what that user just unshielded (pool pays `recipient` first, nullifiers spend only on success); `minOut` checked on-chain; claim keys are seed-derived and recoverable |
| fee policy | fee pinned at 5 % or 0 | one step per epoch, bounded; no other power |

## Explicitly out of scope

- Network-level deanonymisation (IP ↔ transaction). The app and relayer do
  not add cover traffic.
- Timing correlation between a shield and an unshield of the same amount.
  Documented in SPEC §8 (anonymity is per asset and per amount distribution).
- Wallet-extension compromise.
- Front-end supply chain (CDN, npm) beyond the pinned lockfile and
  `scripts/audit.mjs`.
- Token contracts with blacklists, pausing, rebasing or fee-on-transfer
  behaviour (`SECURITY.md` §7).
