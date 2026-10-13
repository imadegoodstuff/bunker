# Security

scash is pre-release software. The circuits and programs are **not audited**
and the current proving keys come from a **development setup** whose toxic
waste is public by construction (see `circuits/scripts/setup-dev.mjs`). Do not
use with real value until the public phase-2 ceremony (`ceremony/README.md`;
open, one contribution per circuit so far, chain verified in CI) has
concluded, the mainnet verifying keys are pinned in a tagged release, and an
independent audit report is linked from this file. No audit has taken place;
the scoping package for one (threat model, invariants with their tests, test
matrix, known issues) is in `audit/`.

## Reporting

Report vulnerabilities privately via GitHub Security Advisories on this
repository. Please do not open public issues for exploitable bugs. We aim to
acknowledge reports within 72 hours.

## Known limitations, in priority order

This section is the honest list. Items move out of it when fixed and audited,
not before.

### 1. Keys are derived from a wallet signature

The spending key is derived from the wallet's signature over a fixed message
(`sdk/src/keys.ts`, `SPENDING_KEY_MESSAGE`). Any web page can ask a connected
wallet to sign arbitrary text, so a phishing page can request the same
signature. Mitigations in place:

- **Passphrase as a second factor.** `seed = scrypt(sig ‖ passphrase)`. A stolen
  signature without the passphrase yields nothing; with scrypt at N=2¹⁵ a guess
  costs ~100 ms. The app recommends a passphrase and explains that losing it
  loses the balance. A user who turns it off accepts the signature-only model.
- **Self-describing message.** The signed text says, in the wallet's own
  signing dialog, that it derives a key that can spend a private balance and
  must only be signed inside scash. This makes phishing visible, not impossible.
- **No reuse of the wallet's own key.** The Solana keypair never touches notes;
  compromise of the shielded key does not expose the public wallet, and vice
  versa.
- **One derivation path.** `seedFromSignature` → `ShieldedWallet.fromSeed` is
  the only route from a signature to any key, including viewing keys and
  addresses; the backup path imports the finished seed and bypasses nothing.
  SPEC §2 spells out loss, offline-guessing cost (≈10⁶ guesses per core-day
  with the signature in hand; an 8-character minimum is a floor, not a
  recommendation) and why a leaked signature does not link a wallet to
  shielded activity.

What is *not* in place: origin binding. Sign-In-With-Solana lets a wallet
verify that the requested domain matches the page, which would stop a phishing
site outright, but it binds recovery to one domain and not every wallet
implements it. It is planned as an optional, stronger mode; the seed backup
(`scashseed1…`) exists so that users are never locked to a domain or a wallet.

### 2. Nothing has been independently audited

Scope of the audit we need, in order of consequence:

1. `circuits/src/transact.circom` — value conservation (Σin + public = Σout),
   nullifier/ownership binding, range checks on values, root membership,
   ext_data_hash binding, and that dummy (zero-value) inputs cannot be used to
   mint.
2. `programs/scash_vault` — public-input construction (`processor.rs` must feed
   the verifier exactly what the prover committed to), signed `public_amount`
   encoding, turnstile accounting under every path, PDA/ownership checks,
   exit CPI path and its account constraints, root-ring and tree append.
3. `sdk/` — key derivation, note encryption (ChaCha20-Poly1305 with a fixed
   nonce under a per-note key), proof encoding, trial decryption.
4. `relayer/` — fee policy, simulation, queueing; privacy-relevant but not
   custodial.

The per-asset turnstile bounds the blast radius of a soundness bug to the
assets already deposited in that pool. It does not make the circuit correct,
and it does nothing for privacy bugs. It is a backstop, not a substitute.

Until an audit exists the app shows an "unaudited" notice on every page and
the SOL pool's TVL cap should stay small.

### 3. Memo length is bounded by the packet, and the spec says so

A 2-in/2-out `transact` with the lookup table is 1,140 bytes before any memo
and Solana packets are 1,232 bytes, so the maximum memo is one 64-byte bucket.
`sdk/src/sdk.test.ts` serialises the real instruction for the SOL and SPL
cases and asserts both that 64 fits and that 128 does not; SPEC §15 has the
measured numbers. An earlier draft of the spec claimed 512 bytes; that was
wrong and has been corrected.

### 4. Anonymity sets are per asset

`asset` is a public input of every transaction. Sharing one commitment tree
across assets does not merge their anonymity sets; a withdrawal of asset *A*
hides only among unspent notes of asset *A*. SPEC §8 states this and the app
reports set sizes per asset. Earlier wording ("the anonymity set is the whole
protocol") was an overstatement and has been removed.

A fuller privacy model — timing correlation through the relayer, amount
correlation, memo-length buckets, indexer query patterns — is written only in
outline. Treat the anonymity numbers in the app as upper bounds.

### 5. Recovery, migration, production readiness

- **Recovery.** Keys are reproducible from (wallet signature, passphrase) on
  any device, and the raw 32-byte seed can be exported as `scashseed1…` and
  imported without a wallet. All note ciphertexts are on-chain; any copy of
  the open-source app recovers the same notes from a public RPC plus the
  indexer, or from the chain alone (slower).
- **Migration.** The vault is immutable. A new circuit or proof system means a
  new vault; balances move through `scash_migrator` (stage the new-vault
  shield, unshield from the old vault to the migrator PDA, anyone executes),
  which never puts a user-held public key on the path. Exercised in CI by
  `scripts/migrate-e2e.mjs`; SPEC §14.
- **Not done:** ceremony contributions from parties other than the coordinator
  and the beacon, independent audit, mainnet deployment,
  formal privacy analysis, incident runbook, bug bounty. None of these are
  implied by anything in the README or the app.

### 6. Token-2022 extensions, yield scope, proving cost, exit adapters

- **Token-2022.** "Supports Token-2022" never meant every extension. A
  transfer-fee mint would have let a depositor be credited `amount` while the
  vault received `amount − fee`, leaving the last withdrawers short.
  `create_pool` now refuses mints with TransferFee, TransferHook,
  PermanentDelegate, NonTransferable, DefaultAccountState or Pausable
  extensions, and every inbound token transfer verifies that the vault balance
  grew by exactly the credited amount (`ShortDelivery` otherwise). A base-mint
  freeze authority (USDC) is not rejected; a frozen vault would block
  unshields of that asset. SPEC §9.
- **Yield.** Creator fees are donated to the SCASH pool only. SOL, USDC and
  other pools have a fixed share rate of 1. The rate is tokens per share and
  depends on trading volume; it is not a price claim and not a return on other
  assets. The landing page and FAQ say this explicitly.
- **Proving in the browser.** The ~3 s figure is a desktop measurement for
  `transact2x2` (wasm witness + snarkjs Groth16). Phones and low-memory tabs
  are slower and may fail to allocate; there is no measured mobile budget yet.
- **Exit adapters.** The swap exit is a CPI from the vault to an external
  program with the funds already at `recipient`. Each adapter widens the
  attack surface (account constraints, leftover funds, re-entrancy into the
  vault via the exit target) and must be reviewed on its own; none is
  deployed.
- **Output notes.** The circuit checks that every output `g_d` is on the curve
  and not of small order and that `pk_d` is on the curve. It cannot check that
  `pk_d` is *the recipient's* key (it would need the recipient's `ivk`; Sapling
  has the same limit). The receiver enforces that by recomputing `pk_d` and the
  commitment before accepting a note, so a wrong `pk_d` is never credited to
  anyone and is a burn by the sender, not a way to lock or take someone else's
  funds. `circuits/test/adversarial.test.mjs` tampers a valid witness fourteen
  ways and asserts each is unsatisfiable; SPEC §6 lists them.
- **Immutability vs. repair.** With no upgrade authority, a serious bug means a
  new program and a user-driven migration. A migration must not publish a
  link between old and new notes. `scash_migrator` moves value from an old
  unshield proof into a new shield proof through a PDA whose only reachable
  destination is the staged shield (the recipient is bound by `ext_data_hash`
  in the old proof, the target vault and refund key are fixed at staging,
  Execute is permissionless). What is public is that X left the old pool and
  X entered the new one, the same as any shield. The two steps are two
  transactions because two proofs do not fit one packet; between them funds
  sit in the PDA and cannot be stranded or redirected. The migrator itself is
  a ~300-line program with its own trust model in `programs/scash_migrator/
  src/lib.rs`, and like the vault it is deployed without an upgrade authority.

### 7. Throughput, root window, share accounting, indexer, passphrase default

- **One writable tree account.** Every `transact` appends to the same Tree
  PDA, so shielded transactions of all assets serialise on one write lock.
  Solana executes conflicting writes sequentially within a slot; with ~200k
  CU per transact and a 48M CU block limit the ceiling is on the order of a
  few hundred shielded transactions per slot before the tree becomes the
  bottleneck. Measured (`scripts/bench.mjs`, run in CI on every push, numbers
  in the `bench-report` artifact; the run below is a 2-vCPU GitHub runner,
  `solana-test-validator`, 139 `transact2x2` shields fired at once):
  **36 transacts landed per slot** (25 in the partial first slot), **CU per
  transact 189k–205k, mean 193k**, **39 tx/s end-to-end** including
  confirmation; proving `transact2x2` in Node on that runner took **p50 4.8 s,
  p90 5.2 s** (a desktop browser is ~3 s). Per-slot numbers are bounded by the
  validator's single-threaded write lock on the Tree account, so they are a
  floor for mainnet, not a ceiling. Sharded trees or batched appends would
  raise it at the cost of per-shard anonymity sets and cross-shard spends;
  that is a design decision for later, not an incremental fix.
- **128-root window.** A proof is made against one of the last 128 roots.
  The first bench run found the ring advancing **per leaf**, so a 2-output
  transaction consumed two slots and a proof survived only 64 later
  transactions, not 128; the vault now writes one ring slot per transaction
  (`tree::record_root`) and the bench fails if a stale proof is rejected
  before 128 landed or accepted after. A stale root is reported as
  `InvalidProof` (the ring slot named by `root_index` holds a newer root, so
  the public input no longer matches), not `UnknownRoot`; the SDK and relayer
  treat both as "re-sync and re-prove". Regenerating takes ≈3–5 s. The
  relayer's random delay is bounded so that, at the throughput the ring can
  sustain, expiry stays rare: with Poisson arrivals, P(expire) for a 30 s
  prove-plus-queue delay is negligible (<10⁻¹³) up to 2 tx/s, ≈0.01 % at
  3 tx/s and ≈97 % at 5 tx/s; at 60 s it is 24 % already at 2 tx/s
  (`expiryModel` in the report). The relayer delay must therefore stay well
  under a minute, and a sustained rate above ~2 shielded tx/s needs either a
  larger ring or automatic re-proving in the app before it is comfortable. The relayer simulates before accepting and
  rejects a stale root up front rather than queueing it, but the app does not
  yet re-prove automatically; the user must resubmit.
- **Share accounting.** Deposits round the cost *up*, withdrawals round the
  payout *down*, so rounding can only leave dust in the pool, never pay out
  more than it holds. `state.rs::share_invariants` runs 64 randomised
  sequences of deposits, donations and burns (dust to 2^40 shares) and checks
  solvency, pro-rata bounds, that books equal the vault balance, and that
  everyone can exit. Rates are computed over a virtual offset `V = 10^6`
  (SPEC §9), which makes the first-depositor inflation attack unprofitable:
  `inflation_attack_is_unprofitable_and_victims_are_whole` shows a 10⁹
  donation after a one-unit position moves the price to ≈1,001 units, the
  attacker recovers under 2,000 of it, and the next depositor loses less than
  one share to rounding. `total_in` is a cumulative `u64`; a pool whose
  lifetime inflow exceeds 2^64 base units would stop accepting deposits with
  `Overflow`.
- **Indexer.** It serves commitments and ciphertexts; it never sees keys, but
  it sees the IP, timing and query pattern of every client. A user who relies
  on one public indexer leaks when they sync and can be denied service.
  Mitigations available today: run your own (`indexer/` is one binary), or
  sync from any RPC (slower). Mitigations not built: oblivious fetching,
  Tor-friendly defaults.
- **Passphrase default.** The app enables the passphrase by default and makes
  turning it off an explicit action with the warning that a stolen signature
  then equals the key. Signature-only derivation is still permitted because
  some users will accept that trade for recoverability; the backup format
  exists so that nobody needs to.

## Design-level guarantees

- **Immutability**: the vault program is deployed without an upgrade authority
  on mainnet. Bug fixes ship as a new program plus an opt-in migrator.
- **Turnstile**: per asset, `total_out ≤ total_in` is enforced on-chain.
- **Guardian limits**: the guardian can only pause *shielding* and *lower* the
  TVL cap. It can never pause withdrawals, change verifying keys, or move funds.
- **Verifying key hygiene**: VK export refuses `delta == gamma`.
- **Nullifier derivation** includes the leaf position.
- **Deterministic dev keys**: CI regenerates the VK from a pinned ptau and a
  fixed beacon and fails if it differs from the committed one.

## Tooling that runs in CI on every push

- `cargo clippy --workspace --all-targets -D warnings`
- `cargo audit` (RustSec advisory database)
- `circomspect` on `transact2x2` and `transact4x2`
- `npm audit` on production dependencies via `scripts/audit.mjs`: fixable
  advisories are pinned with `overrides` in `package.json`; the few that
  upstream has not fixed are listed in `npm-audit-allow.json`, each with a
  written reason why the vulnerable path is not reachable from scash. Anything
  new fails the build.
- SDK unit tests including the packet-size test
- Rust tests including verification of real SDK proofs by the exact on-chain
  verifier (`programs/scash_vault/tests/verify_fixture.rs`)
- End-to-end on `solana-test-validator`: shield → private send with memo →
  unshield → donate → replay rejected → turnstile reconciled
