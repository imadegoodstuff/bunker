# Threat model

## Assets

1. **Funds in the vault**: SOL and SPL tokens held by per-asset pool PDAs,
   owed to note holders according to their shares.
2. **Privacy of note holders**: which notes a transaction spent, who received
   the outputs, and the balance of any address.
3. **Integrity of the yield**: creator fees donated to the SCASH pool must
   accrue to existing SCASH note holders pro rata and to nobody else.
4. **Availability**: the ability to unshield. Shields may be paused by the
   guardian; unshields can never be paused.

## Actors

| actor | can | cannot by design |
|---|---|---|
| anyone with a wallet | shield, unshield, send, donate, run a relayer, run an indexer, call migrator `Execute` | spend notes they do not hold keys for; move funds other than via a valid proof |
| relayer | choose whether and when to submit a transaction; collect the fee the proof names | change recipient, amount, fee, exit data or ciphertexts (all under `ext_data_hash`); learn which notes were spent |
| indexer | serve stale or wrong leaves/ciphertexts | make a client accept a wrong note (client recomputes `pk_d`, commitment and Merkle root) |
| guardian key | pause shields; lower (never raise) a pool's TVL cap; rotate ASP roots on its own ASP account | pause unshields; move funds; upgrade the program (authority is `None` after deploy) |
| pool creator | pick the mint and initial cap | pick a mint with fee/hook/delegate/pausable extensions (refused) |
| ceremony coordinator | order contributions; apply the beacon | produce a sound key with a trapdoor if at least one other contributor was honest |
| exit target program | receive a CPI with funds already at `recipient` | hold any authority over the vault; re-enter `transact` with the same nullifiers (they are already recorded) |
| Solana validator / RPC | censor, reorder, delay; see ciphertexts and public inputs | decrypt notes; forge proofs |

## Trust assumptions

- Groth16 over BN254 and the Perpetual Powers of Tau phase 1 are sound.
- Poseidon (circomlib parameters) is collision-resistant and a good PRF for
  nullifiers.
- Baby Jubjub DDH holds (note encryption key agreement).
- The user's wallet signs the fixed derivation message only for scash and
  the wallet software itself is honest; a wallet that leaks signatures leaks
  the shielded key (mitigated by the optional passphrase).
- At least one phase-2 contributor was honest. **Today there is exactly one
  contribution, so the current keys are not trustworthy; see
  `ceremony/README.md`.**
- The program binary deployed equals the one built from the tagged source
  (verifiable build; the upgrade authority is then burned).

## What an attacker gains from each class of bug

| bug | worst case | bound |
|---|---|---|
| circuit soundness | forge notes, drain a pool | turnstile: at most `total_in − total_out` of that asset; visible on-chain |
| nullifier logic | double spend | same bound |
| share rounding | extract dust repeatedly | rounding favours the pool; `share_invariants` fuzz |
| Token-2022 accounting | credit more than delivered | `move_in` delta check; extension refusal |
| key derivation | spend or view another user's notes | 250-bit scalars, domain-separated scrypt seed |
| note encryption | learn amounts/recipients | ChaCha20-Poly1305 with per-note ephemeral key |
| relayer | censorship, delay | anyone can run one; the app can self-relay |
| indexer | stale view, denial | client verifies everything it is told against the chain |
| migrator | strand funds in the PDA | Execute is permissionless; target and refund fixed at staging |

## Explicitly out of scope

- Network-level deanonymisation (IP ↔ transaction). The app and relayer do
  not add cover traffic.
- Timing correlation between a shield and an unshield of the same amount.
  Documented in SPEC §8 (anonymity is per asset and per amount distribution).
- Wallet-extension compromise.
- Front-end supply chain (CDN, npm) beyond the pinned lockfile and
  `scripts/audit.mjs`.
