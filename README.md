# scash

**Shielded notes on Solana.** Sapling-style keys and diversified addresses, Groth16 proofs verified
on-chain, relayer-paid transactions, and a vault bounded by a per-asset turnstile (immutable once the ceremony keys are burned in).

> Status: **mainnet beta, not audited.** Proving keys are development keys until the
> [public phase-2 ceremony](ceremony/README.md) completes, and the programs stay upgradeable until
> then. Shield only what you can afford to lose. See [SECURITY.md](SECURITY.md) §16.

## What it does

| | |
|---|---|
| **Shield** | Move SOL, an SPL token, or a Token-2022 token without fee / hook / permanent-delegate extensions into the pool. You receive a *note* holding pool shares. |
| **Send** | Pay any `scash1…` address privately. Amount, sender, recipient: all hidden. Relayer pays the fee. |
| **Unshield** | Withdraw to any public address from a relayer-signed transaction. Your public wallet never appears. |
| **Swap** | Exit through a CPI adapter bound inside the proof (adapter program in review). |
| **Launch** | A token launchpad whose primary market exists only inside the pool: buys and sells are unshields whose exit target is the curve, proceeds land at a one-use key derived from your seed and are shielded straight back. Each token gets its own shielded pool at launch, the mint has no authorities, and 50–100 % of the trading fee is donated to that pool's holders. The fee (0.5–3 %) and the holders' share are set per token by four model-driven agents voting every ~6-minute epoch, with no proposer, guardian or pause anywhere. Until graduation there is no public route in. [SPEC §16](SPEC.md#16-the-launchpad). |
| **Yield** | Notes hold shares; `donate()` raises a pool's share rate. SCASH creator fees are donated to the **SCASH pool only**: SOL or USDC notes do not earn from it. The share rate measures tokens per share, not fiat value. |

## Why it is different

- **Diversified addresses** (`pk_d = [ivk]·GroupHash(d)` on Baby Jubjub): unlimited unlinkable addresses per viewing key.
- **Wallet-derived keys with a second factor**: the seed is `scrypt(sign(SPENDING_KEY_MESSAGE) ‖ passphrase)`. A phished signature alone does not yield the spending key. The seed can be exported as a `scashseed1…` backup and restored without the wallet.
- **Client-side trial decryption**: the indexer serves ciphertexts; only your browser knows which are yours.
- **Nullifier = Poseidon(nk, ρ, position)**: bound to the leaf, immune to duplicate-commitment attacks.
- **One tree for all assets**, depth 26, 128-root ring. Note that the asset id is a public input, so the anonymity set of a transaction is the unspent notes *of that asset*, not every leaf; the app reports it per asset.
- **Turnstile**: `total_out ≤ total_in` per asset is enforced on-chain, so even a circuit soundness bug cannot drain other assets.
- **No upgrade authority.** The guardian can only pause *new* shields and *lower* the TVL cap.
- **Compliance opt-in**: association-set roots (Privacy Pools style) as a public input, scoped viewing keys, payment receipts.
- **VK hygiene**: the exporter refuses a verifying key whose δ equals γ.

Full protocol: [SPEC.md](SPEC.md).

## Repository

```
circuits/     circom 2 circuits (transact2x2: 33,515 constraints · transact4x2: 64,860), build/setup/ceremony scripts
crates/       scash-core: shared instruction & state layouts
programs/     scash_vault (pool, verifier, tree, turnstile, exits) · scash_harvester (SCASH fee router) · scash_migrator (old vault → new vault without a public hop) · scash_launch (shielded-only bonding-curve launchpad behind the vault's exit target)
sdk/          TypeScript: keys, addresses, notes, encryption, Merkle, proving, tx building, wallet
relayer/      Fee-paying relayer with policy checks, simulation, randomized delay queue
indexer/      Event scanner → SQLite, HTTP API for commitments / nullifiers / roots / stats / launches
agents/       Four AI agents (one key, one model provider each) that vote the launchpad fee policy; public decision log
app/          Next.js shielded wallet with in-browser proving
deploy/       Dockerfiles and Fly.io manifests
ceremony/     Phase-2 ceremony: transcript, attestations, tooling (circuits/scripts/ceremony.mjs)
audit/        Audit package: scope, threat model, invariants ↔ tests, test matrix, known issues
```

## Build

Requirements: Node ≥ 22, Rust stable, Solana CLI (for deployment). No native circom needed — the compiler runs as wasm.

```bash
npm ci
npm run -w circuits build         # r1cs + wasm witness generators
node circuits/scripts/setup-dev.mjs   # DEV ONLY zkeys (single contributor)
node circuits/scripts/export-vk.mjs   # Rust verifying keys → programs/scash_vault/src/vk
npm run -w sdk test
node circuits/scripts/prove-fixture.mjs      # real proofs → programs/scash_vault/tests/fixtures
cargo test -p scash-vault                    # verifies those proofs with the on-chain verifier code
cargo build-sbf --manifest-path programs/scash_vault/Cargo.toml
```

## Run locally

```bash
# indexer
RPC_URL=https://api.mainnet-beta.solana.com npm run -w indexer dev
# relayer (fund the key with SOL on the cluster RPC_URL points at)
RELAYER_KEYPAIR_PATH=./keypairs/relayer.json npm run -w relayer dev
# app
NEXT_PUBLIC_INDEXER_URL=http://localhost:8788 NEXT_PUBLIC_RELAYER_URL=http://localhost:8787 npm run -w app dev
```

Copy `circuits/build/<name>/<name>_js/<name>.wasm` and the `.zkey` into `app/public/circuits/` as
`<name>.wasm` / `<name>.zkey`.

## Deploy

Programs: `.github/workflows/ci.yml` builds SBF artifacts on every push. The manual `deploy-mainnet` job
(Actions → ci → Run workflow → `deploy_mainnet`) deploys them to mainnet-beta from the `mainnet` environment’s
secrets (`MAINNET_DEPLOYER_KEYPAIR`, `MAINNET_RPC_URL`, `*_PROGRAM_KEYPAIR`), verifies the on-chain bytecode
against the artifact it just built, and runs `scripts/init.mjs` (idempotent) using the variables
`MAINNET_RELAYER_PUBKEY`, `MAINNET_TREASURY_PUBKEY`, `MAINNET_AGENT_PUBKEYS` (four comma-separated keys), `MAINNET_LOOKUP_TABLE`, `MAINNET_TVL_CAP_SOL`. The older
`deploy-devnet` job runs on pushes to `main` only when `DEVNET_DEPLOYER_KEYPAIR` is present.

Services: `fly deploy -c deploy/fly.indexer.toml`, `fly deploy -c deploy/fly.relayer.toml`,
`fly deploy -c deploy/fly.agents.toml`, `fly deploy -c deploy/fly.app.toml` from the repo root, each with `--build-arg GIT_SHA=$(git rev-parse HEAD)` so the app footer, relayer `/info` and indexer `/health` report the commit they were built from. Set `RELAYER_KEYPAIR`, `RPC_URL` (keyed endpoint) and, after `init.mjs`, `LOOKUP_TABLE` as Fly secrets on the relayer; `RPC_URL` on the indexer; on the agents, `AGENT_0..3_KEYPAIR` (the four keys passed to `init.mjs`), `AGENT_0..3_MODEL` (`provider:model`) and the providers' API keys; pass the keyed endpoint to the app build as `--build-arg NEXT_PUBLIC_RPC_URL=…`.

## Program IDs (mainnet-beta; the same keypairs are used on devnet when that job is funded)

| program | id |
|---|---|
| scash_vault | `89TrDDtwYTkrvxGmfYnSz6EbA1muGStuPBFUt3Dvd8WR` |
| scash_harvester | `Cmvzy6Acq5QsnzpWGYEbUCwgzMK6AHFRJkAL2LgMURqK` |
| scash_migrator | `42CGrJH6QGjHjH1CK9yQLF44UhrYjN9cQwGqVvrSYz4u` |
| scash_launch | `861VJkPL2yUYL1DTCToeziREP4XyraihkqbTM1irFZ3k` |

## License

MIT
