# Security

scash runs on Solana mainnet. No independent audit report is published yet,
and the current proving keys come from a **development setup** whose toxic
waste is public by construction (see `circuits/scripts/setup-dev.mjs`). Size
deposits accordingly until the public phase-2 ceremony (`ceremony/README.md`; open, one
contribution per circuit so far, chain verified in CI) has concluded, the
ceremony verifying keys are pinned in a tagged release and burned into the
programs with the upgrade authority revoked, and an independent audit report
is linked from this file. §16 states the interim precisely. No audit has taken place;
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
  costs ~100 ms on one core and 32 MiB of memory, so a GPU farm manages on the
  order of 10⁵ guesses/s, not 10⁹. That only helps if the passphrase has
  entropy: a weak one falls offline once the signature leaks. The arithmetic,
  for a *uniformly random* secret of b bits at 10⁵ guesses/s, expected time
  2^(b−1)/10⁵:

  | bits | expected time to find |
  |---|---|
  | 40 | 64 days (full space: 127 days) |
  | 50 | 178 years |
  | 55 | 5 700 years |
  | 64 | 2.9 million years |
  | 70 | 190 million years |

  (An earlier revision of this file said 40 bits was "about 10 000 years".
  That was wrong by a factor of ~60 000; `sdk/src/sdk.test.ts` now pins the
  table above so it cannot drift again.)

  The app scores every passphrase with `passphraseStrength` in
  `sdk/src/keys.ts` and refuses anything under **50**. The score is a
  **heuristic upper bound**, not a measurement of entropy: human text is not
  uniform, and attackers order guesses by frequency, so the real work can be
  far below the score. The heuristic therefore only ever discounts. Inputs
  with three or more words are scored as phrases, never by their characters
  (a 40-letter sentence of common words looks like 90 bits to a character
  model and like 30 to a phrase attacker): 11 bits per distinct word from a
  2048-word model, 4 for the ~400 most common English words and number/day
  names, 4 for a whole famous phrase ("the quick brown fox", "to the moon",
  "correct horse battery staple" …), +3 for mixed case/digits/symbols. Short
  inputs use character classes × length × 0.6 with repeats and runs ignored.
  Anything on a list of the most-used leaked passwords, with or without the
  usual trailing digits, scores 0. The UI shows the score, the expected
  guessing time *if the passphrase were random*, says in the same sentence
  that it is an estimate, and tells the user why a weak one is weak. Five
  uncommon words or 14 mixed characters is the floor; seven words or 18
  characters is "strong". None of this stops a targeted dictionary against
  a phrase that means something to the user, and the UI says that too.
  The passphrase is on by default; there is no reset, and the app says so
  next to the field and points at the seed backup as the only recovery path.
  **Signature-only is opt-in at every layer.** `seedFromSignature` throws on
  an empty or whitespace passphrase unless the caller passes
  `{ allowEmpty: true }`; the app passes it only after the user switches the
  passphrase off and types "signature only" into a confirmation field that
  states, in red, that any site which obtains the signature can then spend
  everything. Default-on is therefore not the same as mandatory, and this
  document does not claim every user has a second factor: it claims that no
  user is without one by accident.
- **Seed backup is a bearer secret.** `scashseed1…` is the raw 32-byte seed.
  Anyone holding it can spend; it is shown behind a click, with that warning,
  and is never written to storage by the app.
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

Until an audit exists the SOL pool's TVL cap should stay small; the app
links this document from its FAQ.

### 3. Memo length is bounded by the packet, and the spec says so

A 2-in/2-out `transact` with the lookup table is 1,140 bytes before any memo
and the `v0` transactions the client builds are capped at 1,232 bytes, so the
maximum memo is one 64-byte bucket. (Solana's `v1` format allows 4,096 bytes;
the client does not use it yet — §9.)
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
  unshields of that asset. The app reads the mint's `freeze_authority` and
  shows a per-asset warning naming it before any shield. SPEC §9.
- **Yield.** Creator fees are donated to the SCASH pool only. SOL, USDC and
  other pools have a fixed share rate of 1. The rate is tokens per share and
  depends on trading volume; it is not a price claim and not a return on other
  assets. The landing page, the FAQ and the fee summary of every transaction in
  the app ("Yield: none — only the SCASH pool earns") say this explicitly.
- **Proving in the browser.** The ~3 s figure is a desktop measurement for
  `transact2x2` (wasm witness + snarkjs Groth16); the Node bench in CI reports
  p50 4.8 s / p90 5.2 s. Phones and low-memory tabs are slower and may fail to
  allocate; there is no measured mobile budget yet. The app does not hide
  this: it warns up front on mobile user agents and on devices reporting under
  4 GB (`navigator.deviceMemory`), and after the first proof it shows the time
  measured on that device instead of the laptop figure.
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
  **61 transacts landed per full slot**, **CU per transact 189k–211k, mean
  194k**, **79 tx/s end-to-end** including confirmation (an earlier run with
  the per-leaf ring measured 36/slot and 39 tx/s; the lock, not the ring,
  sets the ceiling, and the two runs bracket it); proving `transact2x2` in
  Node on that runner took **p50 4.8 s, p90 5.2 s** (a desktop browser is
  ~3 s). Per-slot numbers are bounded by the
  validator's single-threaded write lock on the Tree account, so they are a
  floor for mainnet, not a ceiling. Sharded trees or batched appends would
  raise it at the cost of per-shard anonymity sets and cross-shard spends;
  that is a design decision for later, not an incremental fix.
- **128-root window.** A proof is made against one of the last 128 roots.
  The first bench run found the ring advancing **per leaf**, so a 2-output
  transaction consumed two slots and a proof survived only 64 later
  transactions, not 128; the vault now writes one ring slot per transaction
  (`tree::record_root`). The bench now computes the exact window for the
  slot its proofs reference (`128 − distance from the head`) and fails
  unless exactly that many of the 139 concurrent transacts land and the
  140th is rejected: the first run after the fix landed 125 against a root 3
  slots behind the head, as predicted. (That run also revealed that the bench
  step's exit code was masked by `| tee`; CI now sets `pipefail`.) A stale root is reported as
  `InvalidProof` (the ring slot named by `root_index` holds a newer root, so
  the public input no longer matches), not `UnknownRoot`; the SDK and relayer
  treat both as "re-sync and re-prove". Regenerating takes ≈3–5 s. The
  relayer's random delay is bounded so that, at the throughput the ring can
  sustain, expiry stays rare: with Poisson arrivals, P(expire) for a 30 s
  prove-plus-queue delay is negligible (<10⁻¹³) up to 2 tx/s, ≈0.01 % at
  3 tx/s and ≈97 % at 5 tx/s; at 60 s it is 24 % already at 2 tx/s
  (`expiryModel` in the report). The relayer delay must therefore stay well
  under a minute, and a sustained rate above ~2 shielded tx/s needs either a
  larger ring before it is comfortable. The relayer simulates before accepting and
  rejects a stale root up front rather than queueing it; since §10 the app
  re-syncs and re-proves once on `UnknownRoot`/`InvalidProof` and only then
  reports failure (`app/src/lib/store.ts`, `isStaleRootError`). That removes
  the manual resubmit, not the window: above ~2 tx/s the second proof can
  expire too.
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

### 8. Subgroup checks, key agreement, no-op transactions, relayer economics, version correspondence

A fourth review asked what `ValidSubgroupPoint` actually proves, whether
all-dummy transactions are abusable, whether the turnstile is being
oversold, and how anyone can tell which source the site is running.

- **`[8]P ≠ O` is not `[l]P = O`, and that is deliberate.** The circuit
  proves output and input `g_d` are on the curve and not of order 1, 2, 4
  or 8, which is what the Sapling Spend statement proves about `g_d`. It does
  not prove prime-subgroup membership; `g_d + T` for a torsion `T` passes.
  SPEC §6 now gives the argument why that is sufficient: torsion only matters
  where a secret scalar multiplies an attacker-chosen point, and the only such
  place in this protocol is key agreement on `epk`. `sdk.test.ts` constructs
  `g_d + T`, shows it satisfies the circuit's condition and is outside the
  subgroup, and shows the receiver refuses the note (it re-derives `g_d` from
  the diversifier). The identity, the order-2 point and off-curve points are
  rejected by the circuit itself (`adversarial.test.mjs`).
- **Key agreement did not clear the cofactor; it does now.** The review's
  question led to a real finding in the SDK, not the circuit: the receiver
  computed `[ivk]·epk` on a sender-supplied `epk`. A sender could add an
  order-8 point to `epk` and derive the key for a guessed `ivk mod 8`; the
  recipient would accept the note only when the guess was right, leaking
  three bits of `ivk` per note the recipient later spent. Key agreement is now
  `[8·sk]·P` on both sides (Sapling `KA.Agree`). `sdk.test.ts` checks that
  `epk + T` yields the same shared point for every residue of `ivk` and that
  the tampered ciphertext fails the AEAD. Ciphertexts written by earlier
  test deployments no longer decrypt; there was no value in them. This is exactly the kind of
  finding an independent audit is for.
- **All-dummy no-ops are allowed by the circuit and priced by the chain and
  the relayer.** A `transact` with zero inputs, zero outputs and
  `public_amount = 0` is a valid proof. It costs its payer two leaves, two
  rent-exempt nullifier PDAs (dummy inputs still produce unique random
  nullifiers, ≈0.0018 SOL) and the signature fee. The relayer refuses it: the
  fee policy requires at least the per-asset minimum for *every* relayed
  transaction, including private sends, and a zero-value transaction cannot
  pay a fee. Filling the tree this way would cost ≈64,000 SOL.
- **The relayer was under-pricing itself.** The relayer is `payer` and funds
  the nullifier rent, so a relayed 2-input transaction costs it ≈1.79 M
  lamports plus fees while the default minimum fee was 1.5 M. Every relayed
  SOL transaction was a small loss; a 4-input one twice that. The relayer now
  computes its cost (`rent × nullifiers + signature + priority`) per request,
  requires `cost + 20 %` for SOL regardless of policy, advertises the
  effective minimum in `/info` so the app never builds a fee it will refuse,
  and logs the cost at startup so operators can price SPL fees above it.
- **Turnstile.** It bounds the damage of a forged proof to what honest users
  deposited into that asset's pool; it does not protect the ownership of any
  particular note. It never claimed to; `audit/THREAT_MODEL.md` lists it as a
  bound, not a guarantee, and circuit soundness, nullifier uniqueness and
  share accounting are the first three items in `audit/README.md`.
- **Which source is the site running?** The app footer shows the commit it
  was built from and the program id it talks to; the relayer's `/info` and
  the indexer's `/health` return `commit`. Fly images are built with
  `--build-arg GIT_SHA=$(git rev-parse HEAD)`. `README.md`, `SPEC.md` and
  the app were already aligned on 250-bit scalars, v2 key derivation,
  per-asset anonymity sets and the seed backup when this review was written;
  the reviewer's GitHub view showed a one-commit snapshot that no longer
  exists.

### 9. Remaining product risks, and the transaction-size correction

A fifth review listed what is still risky after everything above. None of it
is new; what changed is that each item now has something in the product, not
only in this file.

- **Weak passphrase + leaked signature.** Addressed in §1: the app scores the
  passphrase, refuses under 50 estimated bits (≈178 years expected at 10⁵
  scrypt guesses/s, if the score were true entropy), shows that time with the
  caveat attached, and says plainly that there is no reset and that the seed
  backup is the only recovery path. It is still the user's entropy; the
  protocol cannot add any.
- **No backup, lost passphrase.** Still fatal, by design; the Backup card's
  copy now says so and tells the user the backup is a bearer secret.
- **Mobile proving.** Still unmeasured. The app now warns before the first
  proof on mobile and low-memory devices and reports the measured time after
  it (§6), so the number users see is their own, not the laptop one.
- **Yield only on the SCASH pool.** Already true everywhere it was stated;
  now also in the fee summary of every transaction so a SOL depositor is never
  left assuming otherwise. Shares growing in tokens says nothing about price.
- **Freeze authority on a base mint.** Still accepted (refusing it excludes
  USDC). The app now reads `freeze_authority` and shows which key could halt
  withdrawals of that asset. The swap adapter is still undeployed and
  unreviewed; README marks it "in review".
- **Transaction size — a correction.** SPEC §15 said Solana has no larger
  format than 1,232 bytes. That was wrong when written and more wrong now:
  the `v1` format (SIMD-0385) has been active on mainnet since epoch 1035,
  15 September 2026, with a 4,096-byte limit. §15 now separates the two facts
  the reviewer asked for — the network supports 4,096-byte `v1` transactions;
  scash's client builds `v0` and is bound to 1,232 — and spells out what a
  move to `v1` would buy and cost. The mistake also exposed an operational
  bug: the indexer fetched transactions with `maxSupportedTransactionVersion:
  0`, so one `v1` transaction sent to the program by anyone would have made
  the RPC error on the whole batch and stalled the scanner on it forever.
  `indexer/src/scanner.ts` now requests version 1, falls back to
  per-signature fetches when a batch fails, and logs and skips rather than
  stalls. The relayer still rejects anything over 1,232 bytes because it
  signs `v0` transactions; that is a client limit, correctly labelled.

### 10. Arithmetic correction, deferred transactions are never lost, auto re-prove, three commits in the footer

A sixth review caught a numerical error in §1 and asked for the indexer fix
to be tested rather than described.

- **40 bits is 64 days, not 10 000 years.** 2⁴⁰ ≈ 1.1·10¹² guesses at 10⁵/s
  is 127 days for the full space, 64 expected. The text in §1 was wrong; the
  code (`expectedSecondsToCrack`, 2^(b−1)/rate) was right, so the UI had been
  showing users "64 days" next to a document that said millennia. Fixed in
  §1 with a table; the floor is raised from 40 to 50 bits; the test suite pins
  40 → 63.6 days, 50 → 178 years, 55 → 5 708 years.
- **The score is a heuristic and is labelled as one.** Phrases are now scored
  as phrases (word model only, famous phrases and the most common words
  discounted, leaked passwords zeroed); the previous version let a long
  sentence of common words through on character count, which is exactly the
  failure the reviewer described. The UI sentence says "if it were random"
  and "a rough estimate, not a measurement". Details and limits in §1.
- **Deferred transactions are retried, and wallets never see past a hole.**
  "Log and skip" would have been a silent loss if the skipped transaction
  carried leaves. The scanner now records every signature it could not decode
  in `skipped_signatures`, retries all of them on every tick until they
  decode, and `/commitments` serves only the contiguous prefix from the
  requested index, so a wallet cannot insert leaf 4 before leaf 2 exists; it
  sees `next` stop at the hole and asks again. `indexer/src/scanner.test.ts`
  runs the exact scenario the reviewer asked for against a fake RPC: an
  undecodable `v1` transaction between two normal ones; the scan position advances,
  its neighbours index, the page stops at the hole, the deferred transaction
  lands (leaves, out-ciphertext, root) once the RPC decodes it, and later
  transactions flow normally. It runs in the `ts` CI job.
- **Root expiry is handled, not just explained.** `audit/KNOWN_ISSUES.md`
  listed "app does not re-prove on root expiry" as planned. The app now does:
  a relayer 422 whose simulation error is `UnknownRoot` (5) or `InvalidProof`
  (7) releases the reserved notes, re-syncs, re-proves once against the
  current root and resubmits; any other error, or a second failure, is final.
  This does not change the 128-root window or the single tree; load figures
  remain those of §7 and mobile proving remains unmeasured.
- **Which commit are the services on?** The footer no longer shows only the
  app's build. It fetches the relayer's `/info` and the indexer's `/health`
  and prints all three commits, each linked, with "all three on one commit"
  or "services differ from this build". Reproducible-build attestation of the
  Fly images is still not provided; the Dockerfiles and `--build-arg GIT_SHA`
  are the current evidence.
- **Marketing copy.** "Nothing links it to the deposit" became "Nothing
  on-chain links it to the deposit; round amounts and patience keep timing
  from doing so", and the hero caption names the per-asset anonymity set.
- **Unchanged and still open:** no independent audit; Phase-2 ceremony has
  one contribution; mainnet not deployed. These are listed first in
  `audit/KNOWN_ISSUES.md` and need external parties.

### 11. `null` is not "never", structured relayer errors, bytecode evidence — and a finding of our own

A seventh review read the §10 scanner fix line by line and found the gap in
it.

- **`null` from the RPC was dropped.** `getParsedTransactions` returns
  `null` for a signature the node has no data for; the §10 code deferred only
  `undefined` (a thrown error) and let `null` fall through — not indexed, not
  queued — then advanced `last_signature`. Every signature the scanner holds
  came from `getSignaturesForAddress` at `confirmed`, so the transaction
  exists and `null` can only mean "not yet". `retrySkipped` had the same
  hole and evicted a queued signature on `null`. Both paths now defer; each
  deferred entry records `since`, `attempts` and the last reason; nothing is
  ever dropped automatically. `scanner.test.ts` adds the two requested
  cases: a batch that succeeds with a `null` in the middle (leaves land once
  when the RPC catches up, nothing duplicated, the page stops at the hole
  until then) and a queued signature that returns `null` on retry (kept).
- **Permanent failure is an incident, and it is now visible.** A deferred
  signature older than ten minutes flips `/health` to `degraded: true` with
  HTTP 503 and lists every deferred entry with its age and reason; the log
  prints `DEGRADED` each tick. Fly's liveness check moved to `/live` so a
  data-integrity alarm does not cause restart loops. Switching RPC is the
  operator's action; the alarm is what tells them to.
- **Stale-root detection no longer parses JSON by regex.** The SDK now
  carries `VAULT_ERRORS`, a mirror of `programs/scash_vault/src/error.rs`
  that a test reads from the Rust source and compares in declaration order,
  so the table cannot drift. The relayer classifies simulation failures with
  it and returns `vaultError: "UnknownRoot" | "InvalidProof" | …` on every
  422 (`RelayRejection`); the app retries on that field, falling back to the
  same SDK classifier over `details` only for an older relayer. Tests cover
  the classifier and the stale-root predicate.
- **Bytecode evidence.** `scripts/verify-program.mjs <id> <file.so>` reads
  the ProgramData account, hashes the ELF (padding stripped and checked to
  be zero) and compares with a local build; the `sbf` CI job now prints
  `SHA256SUMS` for the artifacts of every commit, and the `deploy-mainnet`
  job runs the verifier after deploying. The indexer inspects the program id at
  startup and every ten minutes and reports `onChain` (`deployed`, deploy
  slot, upgrade authority, ELF sha256) in `/health`; the footer prints it
  next to the three commits with the sentence "same commit is not the same
  binary" and a pointer to the hashes. Reproducible attestation of the Fly
  images is still not provided.
- **What this surfaced: the program id the site talked to was not deployed
  anywhere public.** At the time the hosted app, relayer and indexer pointed
  at an id with nothing behind it on their cluster; every end-to-end run —
  e2e, adversarial suite, bench, migration — was (and is) on
  `solana-test-validator` in CI. Nothing in the deployed services pretended
  otherwise — a shield from the app would simply fail — but the footer line
  "program …" read as if it existed. The footer now checks the chain and says
  "not deployed on this cluster" in red until the program is actually there.
  The cluster is mainnet-beta only; the manual `deploy-mainnet` job (§16)
  deploys, verifies the bytecode and initialises, and this section is where
  the gap between "CI-tested" and "deployed" is stated.

### 12. Retry safety: what happens when the first submission may have succeeded

An eighth review asked whether the §10 re-prove path could double-submit if
the first attempt landed but the client saw a timeout, and asked for four
indexer tests. Looking at the question exposed a bug older than the retry.

- **`release` never released anything.** `buildTransact` returned
  `consumed` as *nullifiers* while `release` deleted pending marks keyed by
  *commitment*. Every failure path in the app therefore left the input notes
  reserved until a reload or until the chain spent them; no funds were at
  risk, but "retry" after an error silently had nothing to spend. `consumed`
  is now the input commitments (`consumedNullifiers` carries the nullifiers
  for the e2e scripts), `reserve/release/isPending/isSpent` are explicit, and
  a test reserves, releases, spends and checks the balance at every step.
- **Reserved notes stay reserved once the relayer holds the proof.** Before
  acceptance a failure releases the notes (the stale-root re-prove does this
  deliberately: nothing was submitted). After acceptance the app no longer
  treats an error as a failed payment: polling survives transient errors for
  ~2 minutes, and on any terminal error it first re-syncs the nullifier set
  from the chain and releases only notes that are still unspent. A payment
  that landed while the client was offline is therefore recognised as spent,
  not re-proved.
- **The relayer is idempotent on nullifiers.** A `/relay` carrying any
  nullifier of a job that is queued, submitting or confirmed returns that job
  (`duplicate: true`) instead of simulating and queueing a second
  transaction that would fail on-chain with `NullifierSpent` after costing
  the relayer its rent. Failed jobs free their nullifiers so an honest
  re-prove is accepted. `relayer/src/queue.test.ts` covers all three states
  and the partial-overlap case (a 4-input spend sharing one note with a
  queued 2-input one). The chain's nullifier PDA remains the only real
  double-spend guard; this layer only stops wasted work.
- **Indexer tests requested, all four present** (`indexer/src/scanner.test.ts`,
  in CI): `null` then full transaction → leaves written once; a new
  `Scanner` on the same database resumes the deferred queue after a restart;
  the same transaction returned again does not duplicate leaves, roots or
  out-ciphertexts (`INSERT OR IGNORE` on the leaf index, asserted); a
  transaction that never becomes readable accumulates `attempts`, stays
  listed, and flips `degraded` past ten minutes — which `/health` turns into
  HTTP 503 — rather than being forgotten.
- **Still only a claim:** the commit strings the services return are
  self-reported; §11 lists what evidence exists (ELF hash on-chain vs. CI
  `SHA256SUMS`) and what does not (reproducible, attested service images).

### 13. The documentation itself was drifting, so it is now checked by CI

A ninth review compared this file with the code and found this file behind:
an earlier revision of §7 still said the app "does not yet re-prove automatically; the user must resubmit"
three sections after §10 described the re-prove, and the reviewer's copy of
§1 still carried the 40-bit arithmetic error (fixed in §10 at `ed95a1c`; the
stale §7 sentence survived until this commit). For a protocol whose security
argument lives partly in prose, a stale sentence is a defect of the same
kind as a stale test.

- **Fixed text.** §7 now describes the re-prove and what it does not fix.
- **Process, made executable.** `scripts/doc-drift-check.mjs` runs in the
  `audit` CI job and fails on three things: (1) facts with one source of
  truth in code — passphrase floor and "strong" thresholds, the
  time-to-crack row for the floor computed from the constants, scrypt `N`,
  ring size, client transaction format, re-prove, relayer idempotency,
  indexer `null` handling, mainnet deployment status — must appear in the docs with the
  code's values; (2) a list of phrases that describe superseded behaviour
  (the manual-resubmit sentence, the denial of a `v1` transaction format,
  the millennia figure for 40 bits, the 40-bit floor, "skip" semantics for
  undecodable transactions, the "planned" re-prove; see the `stale` array)
  may not appear except on a line that acknowledges them as history; (3) every
  numbered fix section from §9 on must be referenced from
  `audit/KNOWN_ISSUES.md`. The rule for contributors: a security-relevant
  change adds or edits a line in that script in the same commit. The check
  is a floor, not a proof of freshness; it catches the two failures the
  reviewer found and the shape of failure they represent.
- **Signature-only is now an explicit decision** (§1): the SDK refuses an
  empty passphrase without `allowEmpty`, the app requires a typed
  confirmation. The reviewer's distinction between "default" and
  "mandatory" stands and is stated in §1 as such.
- **Privacy boundaries, in the product.** The three the reviewer listed —
  deposits are public, anonymity sets are per asset, the relayer and indexer
  see IP, timing and query pattern — were in SPEC §8 and this file; the FAQ
  now has "What can the relayer and indexer see?" and the phishing answer
  states what signature-only means. Random relayer delay weakens timing
  correlation; nothing here removes it, and the FAQ says so.

### 14. Unattended recovery and fee sustainability: the two gaps the tenth review left open

A tenth review confirmed, from source, five earlier fixes — cofactor clearing
in the note key agreement (§3), one `record_root` per `transact` (§7), the
cost-based relayer fee floor, the 50/70-bit passphrase thresholds (§1), the
indexer's deferral queue (§10–§11) — and then drew the limits precisely: the
indexer "has recovery but not unattended recovery", and "covering cost is not
the same as sustainable operation". Both are correct and both were
engineering, not policy, so both are now code.

- **Indexer RPC failover.** `RPC_URLS` takes a comma-separated list of
  fallback endpoints behind `RPC_URL`. `getSignaturesForAddress` fails over
  endpoint by endpoint; every signature the primary cannot return — thrown
  *or* `null` — is asked of each fallback in the same tick before it is
  deferred, and every retry of the deferred queue asks all of them. The
  `degraded` flag therefore now means *no configured endpoint* can return a
  confirmed transaction, which is the condition that genuinely needs a
  person. `/health` lists the endpoints (credentials redacted) with a count of
  what each fallback supplied. Three tests in `indexer/src/scanner.test.ts`
  cover: a null on the primary filled by the fallback without a deferral; a
  primary that throws on every call (history and the deferred queue both come
  from the fallback, and the recorded reason is the fallback's `null`, not the
  primary's error); and every endpoint failing (kept, reason is the last
  error). What this does not do: the hosted indexer on Fly is configured with
  one endpoint until a second provider is chosen, so the mechanism is there
  and the redundancy is an operator decision — and still documented as one in
  `audit/KNOWN_ISSUES.md`.
- **Relayer priority fee follows the market, with bounds.** `relayer/src/fees.ts`
  samples `getRecentPrioritizationFees` every 30 s and attaches the 75th
  percentile (what the busiest quarter of recent slots paid), clamped to
  `[CU_PRICE, CU_PRICE_MAX]` (defaults 0 and 20 000 µ-lamports/CU). The fee
  floor checked at `/relay` prices the priority component at the **cap**, not
  the current reading: submission happens up to `MAX_DELAY_MS` later and the
  market may move inside that window, so a fee that clears the cap is
  sufficient whatever happens. A failed sample keeps the last good price and
  reports the error on `/info`. `/health` now reports `runwayTransacts` — the
  balance divided by the worst-case (4-input, cap-priced) cost — and goes
  unhealthy below ten, which is the "stops serving because the subsidy ran
  out" condition the reviewer named, made observable before it happens.
  `relayer/src/fees.test.ts` pins the percentile, the clamp, the lone-spike
  case, and the keep-last-good-price behaviour.
- **Any token in the wallet is shieldable; the relayer prices it live.**
  Pools are permissionless, so the app lists every mint the connected wallet
  holds and the first shield of a new mint opens its pool (the depositor pays
  the rent). For the relayed leg the relayer answers `GET /asset/:mint`
  (`relayer/src/assets.ts`): it converts its 4-input SOL cost floor into the
  token at Jupiter's price with a 50 % margin (`DYNAMIC_MARGIN_BPS`), creates
  its own token account and a per-mint lookup table on first use, and finds
  those tables again after a restart by authority. Tokens Jupiter does not
  price are shield-only: the relayer refuses to take a fee it cannot value, and
  the app says so. `FEE_POLICY` still wins for any mint the operator priced by
  hand; `DYNAMIC_ASSETS=0` turns the market path off. The price feed is a
  single HTTP source and is trusted only for the relayer's own fee — a wrong
  price costs the relayer money, never a user's funds. Withdrawals of a token
  land in the recipient's associated token account, which must already exist.
- **Not changed, on purpose, and still open.** (1) The Merkle tree is one writable account; all
  assets contend for it (SPEC §8). (2) Origin binding of the signed message
  (Sign-In-With-Solana) is still declined for the recovery reason given in §1.
  (3) The cofactor-clearing fix, like everything in §3, has been reviewed from
  source by outside readers and tested against the attack it answers; it has
  not been independently audited, and this file does not claim that it has.

### 15. The launchpad: a new program, a new trust boundary, and what it does and does not hide

`programs/scash_launch` (SPEC §16) is the first exit program behind the vault's
`exit_target` (SPEC §11). It is new, unaudited code that money flows through,
so this section states its boundary rather than its marketing.

- **What the vault guarantees regardless of the launchpad.** `recipient`,
  `exit_target` and `exit_data` are under `ext_data_hash`; a relayer cannot
  point a buy at a different curve, a different claim key or a different
  minimum. The vault pays `recipient` *before* invoking the exit program and
  the exit program only ever sees accounts the client listed; a malicious or
  buggy exit program can lose the money the user just unshielded, never more,
  and never anything still inside the pool. The nullifiers are spent only if
  the whole transaction succeeds.
- **What the launchpad checks.** `process_exit` refuses to run at the top level
  (`get_stack_height`) and reads the instructions sysvar to require that the
  outer instruction belongs to the vault program recorded at initialisation.
  Without that, anyone could call the handler directly with a funded intake
  account and have the curve price their lamports as a buy without a proof —
  harmless to the pool, but a public route onto a curve that is meant to be
  shielded-only. The intake PDA is system-owned and holds nothing between
  transactions; the handler sweeps it to exactly its rent every time. Every
  PDA the handler touches is re-derived from the mint; the curve's lamport
  balance is checked against `rent + real_sol + fees_accrued` after every
  state change; every arithmetic step is checked. `scripts/launch-e2e.mjs`
  asserts the direct call is refused and that books, claim balances and
  treasury receipts match the SDK's quotes to the lamport.
- **The claim key.** A trade's proceeds rest for one transaction at an
  ed25519 key derived from the spending seed and a nonce. Anyone who learns
  the seed can of course sweep them, but the seed already spends everything,
  so nothing new is at risk. The key is funded with exactly what its claim
  costs; the claim is an ordinary shield with the claim key as payer,
  depositor, relayer and destination, so no wallet and no relayer sees it.
  Keys are never reused, and the app's `recover` re-derives them, so a closed
  tab or a failed claim loses nothing. What a watcher sees is: the vault paid
  a fresh key, the fresh key shielded into a pool. That is the same two-step
  silhouette as the migrator (SPEC §14) and it is public by construction —
  there is no way to fit the unshield and the shield into one packet.
- **The relayer sees more than it does for a plain unshield.** It sees the
  curve, the size, the claim key and (for a sell) the tip. It still cannot
  link any of it to a note or a wallet. A relayed sell pays the relayer in SOL
  out of the proceeds (`relayer_tip` in the exit data, paid by the curve to
  the exit call's `payer`); the relayer requires that tip to clear the same
  cost floor as a SOL unshield (`relayer/src/index.ts`). The relayer forwards
  to exactly one exit target, the launchpad, and refuses every other.
- **What stays public and will not be hidden.** The curve's reserves, every
  trade's side, size and time, the creator's wallet, and one throwaway key per
  trade. Timing correlation between an unshield and a claim, and between a
  claim and a later sell by the same person, is the same signal every
  unshield has (§9) and is blunted, not removed, by the relayer's random delay
  and the fixed trade sizes the app offers. A curve with three trades has an
  anonymity set of three; the app shows the trade count for that reason.
- **Token-2022 surface.** The launchpad mints with the metadata pointer and
  metadata extensions only, revokes the mint authority and sets no freeze
  authority; the vault's refusal list (transfer fee, permanent delegate,
  transfer hook, default account state, non-transferable, pausable) is what
  keeps a pool's accounting honest and the launchpad cannot create a mint the
  vault would refuse. The metadata TLV is written by Token-2022 itself, not
  by this program.
- **Economic edges, stated plainly.** The curve is a public constant-product
  curve; front-running by timing is possible as on any public curve, but the
  relayer's random release order and delay make a private trade's landing
  time unpredictable to its own sender, let alone to others. Private trades
  carry a minimum-out bound chosen by the client (1 % slippage in the app).
  Graduation at 20 SOL ends private trading on that curve; the token's
  shielded pool remains (holders keep their notes), and new entrants after
  graduation buy on the Raydium pool and shield afterwards like any other
  asset. The buy that crosses the end of the curve is capped to the tokens
  left and refunded the rest at its claim key, so nobody is refused for
  arriving last.
- **Migration to Raydium (SPEC §16).** `migrate` is permissionless and has no
  parameters: everything it does is derived from the curve and from Raydium's
  config 0, so there is nothing for a caller to choose and no key to hold. The
  pool's creator is `PDA("migrate", mint)`, a system-owned, data-less account
  that exists for one instruction and is swept to the treasury at its end; it
  is funded by a direct lamport move from the curve and the first CPI names
  both accounts, which is what the runtime requires before it will start a
  CPI after such a move. Every LP token is burned in the same instruction, so
  no account — not the program, not the treasury — can ever withdraw the
  liquidity. The program trusts Raydium only for the account layout of
  `initialize`; it verifies the config account's discriminator and that pool
  creation is enabled on it, derives every pool address itself, reads the
  creation fee from the config at run time, and asserts the LP balance it is
  about to burn is non-zero. The known griefing path — someone who unshielded
  tokens before graduation creates the config-0 pool for the pair first — is
  handled by accepting any other enabled CP-Swap config whose pool does not
  exist yet when the config-0 pool is already there; a front-run pool is a
  separate pool with its own price, not a lock on the curve. A 0.1 SOL
  reserve covers the rents of the accounts Raydium creates (about 0.05 SOL
  today); if Raydium ever grew those accounts past the reserve, `migrate`
  would fail until the program is upgraded, and the curve's SOL would wait on
  the curve meanwhile (it cannot be taken by anyone). The 0.15 SOL creation
  fee is Raydium's. The CI validator clones the real CP-Swap program and
  config from mainnet-beta, so the e2e creates a real pool through the real
  program rather than a mock.
- **Launch metadata hosting.** The indexer's `POST /meta` is the project's
  only writable public endpoint. It accepts an icon and an optional header
  (types sniffed from the bytes, ≤ 4.5 MB each) plus bounded text, stores all of it content-addressed and
  immutable, rate-limits per IP, logs nothing about the uploader, and serves
  files only by their hash names. A mint's URI is a 200-byte string the
  program does not interpret; a launch made outside the app can point
  anywhere, and the app shows an image only for URIs the indexer itself
  hosts.
- **Not done.** No independent audit of the launchpad. The harvester for the
  native token (§13 of SPEC) and the launchpad's harvest are separate code
  paths that do the same thing.

### 16. Mainnet: what is deployed, under which keys, and why the upgrade authority is still held

The project owner decided to run every path on mainnet-beta before the
phase-2 ceremony has concluded and before any audit. This section records
exactly what that means so nobody has to infer it.

- **Same code, same keys as CI tests.** The four programs (`scash_vault`,
  `scash_harvester`, `scash_migrator`, `scash_launch`) are deployed by the
  manual `deploy-mainnet` job from the SBF artifacts of the chosen commit,
  after `rust`, `sbf`, `ts` and the local-validator `e2e` job have passed on
  that commit. The job refuses a program keypair whose public key is not the
  id `declare_id!` in the source, verifies the on-chain ELF against the built
  artifact with `scripts/verify-program.mjs`, and runs the idempotent
  `scripts/init.mjs` (config + tree, SOL pool with its permanent TVL cap,
  launchpad parameters, relayer lookup table). The program ids are in the
  README; the keypairs live only in the GitHub `mainnet` environment and with
  the owner.
- **The proving keys are still the development keys.** Their toxic waste is
  public (`circuits/scripts/setup-dev.mjs`). Anyone can forge a proof for
  these verifying keys. What limits the damage is the turnstile: a forged
  unshield cannot take more than the pool's `total_in − total_out` for that
  asset, so the exposure is bounded by the pool's own TVL. The SOL pool's cap
  (`MAINNET_TVL_CAP_SOL`, default 1,000 SOL) is set once at creation and can
  only ever be lowered by the guardian, never raised, so it is both the loss
  bound and a permanent ceiling; a higher one needs a new vault program. The
  app's banner, FAQ and footer say so
  on every page; the honest summary is **"only shield what you can afford to
  lose"**.
- **The upgrade authority is held, not burned.** The immutability guarantee
  below is the end state, not the current one: replacing the development
  verifying keys with the ceremony's requires either an upgrade or a new
  program plus a migration. Until the ceremony keys are the ones burned in,
  the deployer key can upgrade all four programs, and that key is therefore a
  trust assumption on top of the code. It is the only one; it cannot be hidden
  from (`solana program show` prints it) and the plan is to revoke it in the
  same transaction batch that ships the ceremony keys.
- **The relayer pays mainnet gas.** Its key is funded by the owner; `/health`
  reports its runway. The keyed RPC endpoints are Fly secrets (relayer,
  indexer) and a build argument for the app, where it is necessarily public in
  the bundle and is restricted by origin at the provider.
- **Mainnet-beta is the only cluster.** There is no other deployment target
  in the repository: the hosted services, the SDK defaults, the app, the
  verifier script and the CI deploy job all point at mainnet-beta, and
  addresses use the `scash` HRP. Tests run on a local validator.

### 17. The fee policy: four agent keys, no brake, by the owner's decision

Every launched token's trading fee (its tax) is moved by four keys
recorded in the `Launchpad` account and held by four model-driven agents
(SPEC §16, "Fee policy"). The owner asked for this exactly: *no proposer, no
guardian, no pause*. This section says what that buys and what it costs.

- **What the program enforces, and all it enforces.** A vote is accepted only
  from one of the four keys and only inside the bounds (fee 0–5 %; the
  holders' share is pinned at 0). The fee moves at most one percentage point
  per one-minute epoch toward the median of the fresh votes, needs two fresh
  votes to move at all, and catches up at most four steps after idle time.
  Votes cast in an epoch apply from the next one, so nothing a trader does in
  the same block as a vote can change the fee under them. Those bounds are
  the whole safety envelope: the worst the four keys can do together is take
  the fee to 5 %, one point a minute, or to 0. They cannot drain, pause,
  freeze or redirect anything; every fee goes to the fixed treasury.
- **The treasury is the agents' wallet.** The launchpad's `protocol_treasury`
  is agent 0's key, so the tax funds the agents themselves: the service keeps
  the other three keys and the relayer topped up to a small float, keeps a
  reserve for Raydium migrations, and at random moments (on average every
  four hours, a random 25–100 % of the surplus) buys the scash token through
  Jupiter and, by coin flip, burns it or airdrops it pro rata to its current
  wallet holders (`agents/src/treasury.ts`; program-owned token accounts such
  as pool vaults are skipped). Every action is in `GET /log`. The owner funds
  nothing beyond the first few transactions. If agent 0's key is stolen the
  thief gets the pot, nothing more: curves hold their own SOL and the vault
  is untouched; the launchpad would then be re-initialised under a new
  treasury only by a program upgrade (§16).
- **What nobody can do.** Replace an agent key, add a fifth voter, veto a
  roll, or hold the fee still. The launchpad's `agents` are set once at
  initialisation and have no update instruction; the roll runs inside every
  trade and cannot be skipped. If all four keys were lost, the last votes
  would expire after four minutes and the fee would stay wherever it was,
  forever. If all four were stolen, the thief gets the envelope above and
  nothing else. There is deliberately no key that can fix either case short
  of a program upgrade (§16: that authority exists today and is slated for
  revocation).
- **What the agents are.** Four processes in one service (`agents/`), each
  with its own key and its own model provider (`AGENT_i_MODEL`,
  `provider:model`), given the same public view of a token — curve state,
  recent trades, the other agents' standing votes — and asked for a JSON vote
  once per epoch per live token. The service logs every decision, skip and
  failure at `GET /log` and attaches the model's one-line reason as a memo to
  the vote transaction, so the on-chain record and the stated reason are side
  by side. The keys are Fly secrets. The models are reached, by default,
  through one Sign-in-with-Orbio connection (OAuth 2.1 server app, PKCE,
  client secret on the service, token pair on its volume, refreshed from one
  place because refresh tokens are single use); that connection can only
  spend the owner's Orbio balance on inference, and the owner can cut it from
  the Orbio dashboard at any moment, which stops the agents voting and
  nothing else. The connect route is gated by a secret and nothing in the app
  mentions it. The service holds no other key and talks to nothing but the
  RPC, the indexer and the model gateway.
- **Failure modes, stated plainly.** A provider outage means that agent casts
  no vote; with two or more down, the fee stops moving until they return. A
  model that answers nonsense (unparseable, out of bounds) is treated as
  silent. A compromised provider or prompt injection through a token's name
  or symbol can at most move that agent's vote within the envelope; the
  median of four with a quorum of two means two captured agents can steer
  the target. The agents' prompt therefore includes only numeric state and
  the symbol, and the symbol is the one injection surface we accept. The
  policy is exactly as good as the four models' judgement; the program is
  only the fence.
- **For traders.** The app quotes at the fee the program will charge now and
  sets `min_out` from the highest fee the epoch boundaries within the next ~2
  minutes can bring, so a trade is never failed by a roll and never pays more
  than two steps above its quote. The token page shows the fee now, each
  agent's standing vote, the next epoch's fee and the vote log.

## Design-level guarantees

- **Immutability**: the vault program is deployed without an upgrade authority
  once the ceremony keys are burned in (§16 describes the interim). Bug fixes
  then ship as a new program plus an opt-in migrator.
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
- Launchpad end-to-end on a second fresh validator: launch → private buy →
  claim → harvest → private sell → claim, with the buyer's wallet asserted
  absent from every launchpad transaction
