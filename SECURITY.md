# Security

scash is pre-release software. The circuits and programs are **not audited**
and the current proving keys come from a **development setup** whose toxic
waste is public by construction (see `circuits/scripts/setup-dev.mjs`). Do not
use with real value until a public phase-2 ceremony (`ceremony/README.md`) has
concluded, the mainnet verifying keys are pinned in a tagged release, and an
independent audit report is linked from this file.

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
  new vault; balances move by unshielding or, when it ships, through a
  `scash_migrator` exit target in a single transaction. No migrator exists yet.
- **Not done:** public ceremony, independent audit, mainnet deployment,
  formal privacy analysis, incident runbook, bug bounty. None of these are
  implied by anything in the README or the app.

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
