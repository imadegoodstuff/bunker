# Security

BUNKER runs on BNB Smart Chain. No independent audit report is published yet,
and the current proving keys come from a **development setup** whose toxic
waste is public by construction (see `circuits/scripts/setup-dev.mjs`). Size
deposits accordingly until the public phase-2 ceremony (`ceremony/README.md`;
open, one contribution per circuit so far, chain verified in CI) has concluded,
the ceremony verifying keys are compiled into new verifier contracts and a new
pool is deployed against them, and an independent audit report is linked from
this file. §11 states the interim precisely. No audit has taken place; the
scoping package for one (threat model, invariants with their tests, test
matrix, known issues) is in `audit/`.

## Reporting

Report vulnerabilities privately via GitHub Security Advisories on this
repository. Please do not open public issues for exploitable bugs. We aim to
acknowledge reports within 72 hours.

## Known limitations, in priority order

This section is the honest list. Items move out of it when fixed and audited,
not before.

### 1. Keys are derived from a wallet signature

The spending key is derived from the wallet's EIP-191 signature over a fixed
message (`sdk/src/keys.ts`, `SPENDING_KEY_MESSAGE`). Any web page can ask a
connected wallet to sign arbitrary text, so a phishing page can request the
same signature. Mitigations in place:

- **Passphrase as a second factor.** `seed = scrypt(sig ‖ passphrase)`. A stolen
  signature without the passphrase yields nothing; with scrypt at N=2¹⁵ a guess
  costs ~100 ms on one core and 32 MiB of memory, so a GPU farm manages on the
  order of 10⁵ guesses/s, not 10⁹. That only helps if the passphrase has
  entropy. The arithmetic, for a *uniformly random* secret of b bits at
  10⁵ guesses/s, expected time 2^(b−1)/10⁵:

  | bits | expected time to find |
  |---|---|
  | 40 | 64 days (full space: 127 days) |
  | 50 | 178 years |
  | 55 | 5 700 years |
  | 64 | 2.9 million years |
  | 70 | 190 million years |

  `sdk/src/sdk.test.ts` pins this table so it cannot drift. The app scores
  every passphrase with `passphraseStrength` and refuses anything under
  **50**. The score is a **heuristic upper bound**, not a measurement of
  entropy: human text is not uniform and attackers order guesses by frequency,
  so the heuristic only ever discounts (phrases are scored per distinct word,
  famous phrases and leaked passwords score near zero). The UI shows the
  score, says it is an estimate, and tells the user why a weak one is weak.
  **Signature-only is opt-in at every layer.** `seedFromSignature` throws on
  an empty passphrase unless the caller passes `{ allowEmpty: true }`; the app
  passes it only after the user switches to signature-only mode and ticks an
  acknowledgement that states that any site which obtains the signature can
  then spend everything. No user is without a second factor by accident.
- **Seed backup is a bearer secret.** `bunkerseed1…` is the raw 32-byte seed.
  Anyone holding it can spend; it is shown behind a click, with that warning,
  and is never written to storage by the app.
- **Self-describing message.** The signed text says, in the wallet's own
  signing dialog, that it derives a key that can spend a private balance and
  must only be signed inside BUNKER at bunkeronbnb.com. This makes phishing
  visible, not impossible.
- **No reuse of the wallet's own key.** The EOA's secp256k1 key never touches
  notes; compromise of the shielded key does not expose the public wallet,
  and vice versa.
- **One derivation path.** `seedFromSignature` → `ShieldedWallet.fromSeed` is
  the only route from a signature to any key, including viewing keys and
  addresses; the backup path imports the finished seed and bypasses nothing.

What is *not* in place: origin binding. Sign-In-With-Ethereum (EIP-4361)
would let a wallet verify the requested domain, but it binds recovery to one
domain and not every wallet shows it well. The seed backup exists so that
users are never locked to a domain or a wallet.

### 2. Nothing has been independently audited

Circuits, contracts, SDK, relayer, indexer and app are new code. The circuits
are unchanged from the circom sources that the ceremony transcript covers;
the verifier contracts are generated from the same zkeys by snarkjs. The
contracts have unit tests (`contracts/test/`) and an end-to-end run against a
Hardhat node on every push (`scripts/e2e.mjs`), but tests are not an audit.
`audit/` is the scoping package. Treat the pool as experimental software.

### 3. Anonymity sets are per asset, and amounts and timing leak

`asset` is a public input of every `transact` (SPEC §8), so a withdrawal hides
among the unspent notes *of that asset*, not among every leaf. Thin pools are
thin. Beyond that, the cryptography hides which note was spent, not how much
or when: shielding 3.1415 BNB and withdrawing 3.1415 BNB an hour later links
the two for anyone watching. The app suggests round denominations, shows the
set size per asset and the recent transaction rate, and says in the
withdrawal form that withdrawing to the depositing wallet undoes the point.
None of that is enforced; it cannot be.

### 4. The relayer: a server in the path

Sends and unshields go through a relayer so the user's EOA never signs them.
What the relayer can and cannot do:

- It **cannot** alter a transaction: recipient, fee, exit target and
  ciphertexts are under `ext_data_hash`, which the proof binds. It cannot
  learn which notes were spent or who received.
- It **can** refuse service, delay, or go down. Anyone can submit a `transact`
  from their own EOA instead (the SDK builds the same call), at the cost of
  linking that EOA to the withdrawal.
- **Economics.** The relayer pays gas and is repaid from the note. Its BNB
  floor is `max(MIN_FEE_UNITS, GAS_LIMIT × GAS_PRICE_CAP × (1 + COST_MARGIN_BPS))`
  (`relayer/src/index.ts`, defaults 1,600,000 gas, 5 gwei cap, 20 % margin), so
  a gas spike up to the cap never makes it submit at a loss; the attached gas
  price follows the network between floor and cap and never exceeds the cap,
  so during a spike above it the transaction simply waits for inclusion
  (`relayer/src/fees.ts`). ERC-20 fees are quoted through PancakeSwap at
  a margin (`relayer/src/assets.ts`); an asset with no route is shield-only.
  Launchpad sells tip the relayer in BNB out of the proceeds because the
  pool's own fee would be denominated in the token being sold.
- **Idempotent on nullifiers.** A resubmitted job with the same nullifiers
  returns the existing job rather than a second submission
  (`relayer/src/queue.ts`, tested).
- **Retry safety.** If a submission's outcome is unknown (RPC timeout after
  `eth_sendRawTransaction`), the queue checks `nullifierSpent` before
  retrying, so a transaction that did land is never resent as a second one
  that reverts and burns gas; the job is reported `confirmed` with the found
  hash.
- **Stale roots.** A proof names a root in the 128-root ring (§7). If 128
  transactions land between proving and submission the relayer's simulation
  returns `UnknownRoot` and the request is rejected with a structured 422
  (`contractError`); the app re-syncs and re-proves once
  (`app/src/lib/store.ts`), then gives up with the reason shown.
- **Timing.** Each job waits a random `[MIN_DELAY_MS, MAX_DELAY_MS]` (5–90 s)
  before submission so that a relayed transaction does not land in the block
  right after the request reached the server.

### 5. The indexer: a convenience, not a trust root

The indexer rebuilds the tree from `Transact` events and serves ciphertexts
and launch rows. It holds no keys. If it lies, the client's locally rebuilt
root will not match the chain: after every sync the app compares its tree
root against `getLastRoot()` when `nextIndex` equals its leaf count and
reports a mismatch instead of proving against a wrong tree
(`app/src/lib/store.ts`). `RPC_URLS` takes a comma-separated list of fallback
endpoints tried in order for every `eth_getLogs` range the primary fails
(`indexer/src/scanner.ts`); a range that fails everywhere is retried on the
next tick rather than skipped, and `/health` reports `degraded` when the
scanner has not advanced for a while. Anyone can run an indexer against the
public RPC; nothing in the protocol depends on this one.

### 6. The guardian and what cannot be paused

The pool has a guardian address. It can set `shieldPaused` (new deposits
stop) and lower a pool's TVL cap, and can hand the role on or burn it with
`setGuardian(address(0))`. It **cannot** move funds, block `transact` with
`publicAmount ≤ 0` (sends, unshields, launchpad trades), block `donate`,
change verifiers, or touch the launchpad. The contracts have no owner and are
not upgradeable; a new circuit means a new pool contract and a public
re-shield. The guardian exists so that a discovered soundness bug can stop
new money from entering while the turnstile (SPEC §14) bounds what can leave.

### 7. Root window, share accounting, token quirks

- **128-root ring.** A proof is valid for 128 subsequent transactions. Under
  sustained load that is a window of a few minutes; the re-prove path in §4
  covers it. The ring is per contract, not per asset.
- **Shares with a virtual offset.** All rates use `(S + 10⁶, A + 10⁶)`
  (SPEC §9), which makes the first-depositor inflation attack return about
  one millionth of the donation to the attacker. `contracts/test/pool.test.cjs`
  checks it. Rounding is against the user by at most one unit per operation
  and the dust stays in the pool.
- **Delivered-amount check.** Every inbound ERC-20 transfer is measured and
  reverts with `ShortDelivery` unless the pool received exactly what it
  credited. Fee-on-transfer and rebasing tokens therefore cannot open a
  position that the turnstile would later refuse to pay.
- **Tokens with admin keys.** BSC-USDT, USDC and others can blacklist
  addresses or pause transfers. If a token's issuer blacklists the pool,
  every unshield of that token fails until it is lifted; the pool cannot
  route around it. That is a counterparty risk of holding such tokens in any
  contract and it is documented here rather than mitigated.
- **Units.** A pool's unit is a power of ten chosen at creation
  (BNB: 1 gwei). Amounts below one unit are rounded down and lost to the
  depositor; the app shows the rounding before it happens.

### 8. Memos and ciphertext sizes

Memos are padded to one 64-byte bucket (`MEMO_MAX = 64`), so a note
ciphertext is 99 bytes without a memo and 163 with one, and which of the two
a transaction carries is visible on-chain. A private send always carries a
real second ciphertext; shields and unshields send empty dummies. So the
*kind* of transaction (send vs. boundary) is inferable from calldata size,
which is also inferable from `publicAmount`. Nothing about content leaks.

### 9. The launchpad: a new trust boundary, and what it does and does not hide

The launchpad is an exit contract (SPEC §11): the pool pays it, it acts in
the same transaction, and a throwaway claim key carries the result back.

- **The claim key is the link.** One trade = one key, visible twice on-chain
  (in the exit data and as the shield's sender). It links an unshield of X BNB
  to a shield of the bought tokens, and nothing else. It is derived from the
  seed, so a closed tab loses nothing (`recover` re-derives and sweeps).
- **Claim keys hold BNB briefly.** `claimBudget` (default 0.003 BNB) sits at
  the key until the claim; sells leave the proceeds there until claimed.
  Anyone who obtains the seed obtains the claim keys too, which is already
  everything.
- **Timing and sizes.** Buys of the app's fixed sizes right after a shield of
  the same size are correlated; the app says so next to the top-up field.
- **Slippage and fee roll.** `minOut` is quoted from `worstFeeBps` over the
  next two epochs so a fee step between quote and landing cannot fail the
  trade on slippage unexpectedly; other trades landing first still can.
- **`onExit` is pool-only.** A direct call reverts (`NotFromPool`), so no
  money other than what the pool just delivered can be acted on; the pool is
  non-reentrant across the call.
- **Migration.** `migrate` is permissionless and deterministic; the LP goes to
  the dead address. If someone created the PancakeSwap pair early at a
  different price, the router uses the pair's ratio, leftover tokens are
  burned and leftover BNB goes to the treasury, so the pool opens near the
  attacker's price rather than the curve's. That is a griefing vector with a
  cost to the griefer and no profit; it is accepted.
- **Creator anonymity.** `launch` is a public transaction from the creator's
  EOA. Launching is not private; trading is.

### 10. The fee policy: four agent keys, no brake, by the owner's decision

Each curve's fee moves toward the median of the four agents' fresh votes, one
100-bps step per 80-block epoch, bounded 0–5 %, quorum 2
(`Launchpad.sol` constants, SPEC §13). There is no timelock, veto or pause.
Consequences, accepted deliberately:

- Two colluding or compromised agent keys set the fee anywhere in the bounds
  within five epochs. The bounds are the only protection: the worst case is a
  5 % fee for as long as the keys are held, never a stolen balance.
- The agents are language models with keys. A model that hallucinates votes
  badly; a provider outage casts no vote and the last vote expires after 320
  blocks. With fewer than two fresh votes the fee stays put.
- The treasury is the agents' wallet (agent 0). It pays the agents' and the
  relayer's gas and buys back and burns or airdrops the BUNKER token at random
  (`agents/src/treasury.ts`). It is a hot wallet; its balance is the only thing
  at risk and it holds only fees already paid.

### 11. BNB Smart Chain mainnet: what is deployed and under which keys

The deployed addresses are in `contracts/deployments/56.json` once the
deployment has happened and in the app's docs page. Until the ceremony closes,
the verifiers are compiled from the **development** zkeys: a party holding
the dev toxic waste (which is public) could forge proofs, bounded per asset by
the turnstile to what that asset's pool holds. The guardian is the deployer
EOA at launch and will be handed to a multisig or burned; the launchpad has
no privileged key at all. Contract sources are verified on BscScan
(`contracts/scripts/verify.cjs`) so the bytecode can be checked against this
repository.

### 12. The documentation is checked by CI

`scripts/doc-drift-check.mjs` reads constants from the Solidity and SDK
sources (fee policy, root history, passphrase floor, relayer defaults) and
fails the build if this file, `SPEC.md` or `audit/KNOWN_ISSUES.md` state
different values or still contain phrases that described earlier behaviour.
Every security-relevant change must update the check in the same commit.

## Design-level guarantees

- **Turnstile.** Per asset, `totalOut ≤ totalIn`. A proof-system break drains
  at most what was deposited into that pool.
- **No admin over funds.** No owner, no upgrade, no pause on withdrawals.
- **Relayer-proof transactions.** Everything a relayer could change is under
  the proof.
- **Local proving.** Proofs, keys and decryption never leave the browser; the
  relayer and indexer see only what the chain sees.
- **Deterministic recovery.** Wallet + passphrase, or the seed backup,
  reproduce every key, address and claim key.

## Tooling that runs in CI on every push

- Hardhat compile and unit tests for the pool and launchpad; ABI drift check
  against `sdk/src/abi`.
- SDK, relayer, indexer and agents unit tests; app type-check.
- Circuit compile, deterministic dev setup, verifier drift check against the
  committed Solidity verifiers, and the adversarial witness tests.
- End-to-end on a Hardhat node: shield → private send → unshield → donate →
  replay rejected → launch → private buy/claim → votes and fee roll → private
  sell/claim → graduation → PancakeSwap migration.
- Ceremony transcript check, circomspect, `npm audit` with a written
  allow-list, audit-package reference check, and this document's drift check.
