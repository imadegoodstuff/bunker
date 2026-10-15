# BUNKER

**A shielded pool and private launchpad on BNB Smart Chain.** Sapling-style keys and diversified
addresses, Groth16 proofs verified on-chain, relayer-paid transactions, and a pool bounded by a
per-asset turnstile. No owner, no upgrade, no pause on withdrawals. Live at [bunkeronbnb.com](https://bunkeronbnb.com).

> Status: **BSC mainnet.** The proving keys switch to the [public phase-2 ceremony](ceremony/README.md)'s
> keys (new verifier contracts, new pool) when it completes. See [SECURITY.md](SECURITY.md) §11.

## What it does

| | |
|---|---|
| **Shield** | Move BNB or any ERC-20 into the pool. You receive a *note* holding pool shares. The first shield of a token opens its pool; no listing, no permission. |
| **Send** | Pay any `bunker1…` address, or a plain `0x…` address whose owner registered one, privately. Amount, sender, recipient: all hidden. The relayer pays gas and is paid with a *shielded note* of its own, so even the fee is private. |
| **Unshield** | Withdraw to any address from a relayer-signed transaction. The recipient gets exactly the amount; your public wallet never appears. |
| **Swap** | Trade shielded BNB for shielded USDT (or any PancakeSwap V2 pair) in one transaction: the pool pays `SwapExit`, the router fills, the output comes back to the pool as a note of yours. No account on-chain holds either side. |
| **Launch** | A token launchpad whose primary market exists only inside the pool: a buy is one relayed transaction in which the pool pays the curve and the curve pays the tokens straight back into a fresh note of yours; a sell is the mirror image. Each token gets its own shielded pool at launch and the token has no owner. The trading fee (0–5 %) is set per token by four model-driven agents voting every minute, with no proposer, guardian or pause anywhere; the fee goes to the agents' own treasury, which pays their gas and buys back the BUNKER token to burn or airdrop it. Until graduation there is no public route in; at graduation the curve's BNB and the reserved 20.7 % of supply become a PancakeSwap V2 pair with every LP token burned. [SPEC §13](SPEC.md#13-the-launchpad). |
| **Watch** | A full viewing key (`bunkerview1…`) opens a read-only mirror of a vault anywhere: every note, memo and spend, and no way to sign. |
| **Yield** | Notes hold shares; `donate()` raises a pool's share rate for every holder of that asset with no distribution and no information about who holds what. |

Protocol v2 (October 2026) also batches tree insertion: new commitments wait in an on-chain queue that
anyone may `drain()` (the relayer's keeper does, within seconds), so a transaction pays for one root
per batch instead of 26 Poseidon hashes per leaf. Nullifiers are never deferred. The v1 pool
(`0xD327…12bF`) remains live for its existing notes; see `contracts/deployments/56.v1.json`.

## Why it is different

- **Diversified addresses** (`pk_d = [ivk]·GroupHash(d)` on Baby Jubjub): unlimited unlinkable addresses per viewing key.
- **Wallet-derived keys with a second factor**: the seed is `scrypt(sign(SPENDING_KEY_MESSAGE) ‖ passphrase)`. A phished signature alone does not yield the spending key. The seed can be exported as a `bunkerseed1…` backup and restored without the wallet.
- **Client-side proving and trial decryption**: the indexer serves ciphertexts; only your browser knows which are yours, and proofs are made there too.
- **Nullifier = Poseidon(nk, ρ, position)**: bound to the leaf, immune to duplicate-commitment attacks.
- **One tree for all assets**, depth 26, 128-root ring. The asset id is a public input, so the anonymity set of a transaction is the unspent notes *of that asset*; the app reports it per asset.
- **Turnstile**: `totalOut ≤ totalIn` per asset is enforced on-chain, so even a circuit soundness bug cannot drain other assets.
- **No admin over funds.** The guardian can only pause *new* shields and *lower* a TVL cap, and can burn itself.
- **Compliance opt-in**: association-set roots (Privacy Pools style) as a public input.

Full protocol: [SPEC.md](SPEC.md).

## Repository

```
circuits/     circom 2 circuits (transact2x3 · transact4x3: 2 or 4 inputs, 3 outputs), build/setup/ceremony scripts
contracts/    Hardhat: ShieldedPool.sol (tree + insertion queue, verifier, pools, turnstile, registry, exits with reshield) · Launchpad.sol + LaunchToken.sol · SwapExit.sol · generated verifiers · deploy/verify scripts
sdk/          TypeScript: keys, viewing keys, addresses, notes, encryption, Merkle, proving, viem call builders, wallet, and `BunkerClient` for the live deployment (see sdk/README.md)
relayer/      Relayer paid in shielded fee notes: decrypts and verifies its note, simulates, randomized delay queue, drain keeper, fee-note sweeper, PancakeSwap/curve fee pricing
indexer/      eth_getLogs scanner → SQLite, HTTP API for commitments / nullifiers / roots / stats / launches / metadata
agents/       Four AI agents (one key, one model provider each) that vote the launchpad fee policy, keep the curves (harvest, migrate) and run the treasury
app/          Next.js wallet with in-browser proving (bunkeronbnb.com)
deploy/       Dockerfiles, Fly.io manifests, fly-deploy.sh
ceremony/     Phase-2 ceremony: transcript, attestations, tooling
audit/        Audit package: scope, threat model, invariants ↔ tests, test matrix, known issues
scripts/      e2e.mjs (full protocol on a Hardhat node), audit and doc-drift checks
```

## Build and test

Requirements: Node ≥ 22. No native circom needed; the compiler runs as wasm.

```bash
npm ci
npm run -w circuits build              # r1cs + wasm witness generators
node circuits/scripts/setup-dev.mjs    # DEV ONLY zkeys (single contributor)
npm run -w contracts verifiers         # Solidity verifiers from the zkeys
npm run -w contracts build             # compile + export ABIs into sdk/src/abi
npm run -w sdk build && npm test       # contracts, sdk, relayer, indexer, agents
npm run e2e                            # spawns a Hardhat node, deploys, runs the whole protocol
```

Copy `circuits/build/<name>/<name>_js/<name>.wasm` and the `.zkey` into `app/public/circuits/` as
`<name>.wasm` / `<name>.zkey` before building the app.

## Run locally

```bash
npm run -w contracts node                       # Hardhat node on :8545
TREASURY=0x… AGENTS=0x…,0x…,0x…,0x… npm run -w contracts deploy:local   # writes contracts/deployments/31337.json
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 npm run -w indexer dev
CHAIN_ID=31337 RPC_URL=http://127.0.0.1:8545 RELAYER_KEY=0x… npm run -w relayer dev
NEXT_PUBLIC_CHAIN_ID=31337 NEXT_PUBLIC_POOL_ADDRESS=0x… NEXT_PUBLIC_LAUNCHPAD_ADDRESS=0x… npm run -w app dev
```

Services read `POOL_ADDRESS`/`LAUNCHPAD_ADDRESS`/`SWAP_EXIT_ADDRESS` from the environment or from `contracts/deployments/<chainId>.json`.
The relayer also wants `INDEXER_URL` and `ARTIFACTS_DIR` (the circuit build directory) so it can sweep its fee notes back to its account.

## Deploy

Contracts: `DEPLOYER_KEY=0x… TREASURY=0x… AGENTS=0x…,0x…,0x…,0x… npm run -w contracts deploy:bsc` writes
`contracts/deployments/56.json`; `BSCSCAN_API_KEY=… npm run -w contracts verify:bsc` verifies the sources.
The manual `deploy-bsc` CI job does the same from the `bsc` environment's secrets.

Services: `deploy/fly-deploy.sh all` deploys `bunker-indexer`, `bunker-relayer`, `bunker-agents` and
`bunker-app` with the addresses from `56.json`. Secrets are set with `flyctl secrets set`: `RELAYER_KEY`
and a keyed `RPC_URL` on the relayer; `RPC_URL`/`RPC_URLS` on the indexer; `AGENT_0..3_KEY` plus either the
Orbio server app (`ORBIO_CLIENT_ID`, `ORBIO_CLIENT_SECRET`, `ORBIO_CONNECT_SECRET`) or `AGENT_0..3_MODEL`
with the providers' own API keys on the agents.

## License

MIT
