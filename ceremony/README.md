# BUNKER phase-2 ceremony (protocol v2, revision 1)

The Groth16 proving keys for `transact2x3` and `transact4x3` need a
circuit-specific trusted setup. BUNKER runs a public, permissionless phase-2
ceremony: as long as **one** participant was honest and destroyed their toxic
waste, the final keys are sound. Everything about the ceremony is in this
directory and checkable offline from the repo.

**Status: open, 0 contributions.** The keys deployed today are the
deterministic *dev* keys from `circuits/scripts/setup-dev.mjs` (public,
fixed entropy): anyone can reproduce them, which also means anyone could in
principle reproduce the toxic waste. They are not safe for real value, and
SECURITY.md and the site say so. The ceremony keys replace them only after the
beacon step below, with new verifier contracts and a new pool.

The v1 ceremony (`transact2x2` / `transact4x2`, one coordinator contribution)
is kept under `v1/` for the record; those circuits are frozen with the v1 pool.

## What is where

| file | content |
|---|---|
| `transcript.json` | r1cs blake2b of each circuit, hash of every zkey in the chain, every contribution hash, hosting URLs, beacon |
| `contributions/NNNN-<circuit>-<handle>.md` | one attestation per contribution, signed by the participant |
| GitHub release `ceremony-v2` | the zkey files themselves (`_0000` = deterministic start, `_NNNN` = after contribution N) |

CI runs `node circuits/scripts/ceremony.mjs check --fetch` on every push: it
rebuilds the circuits, checks the r1cs hash against the transcript, downloads
the latest hosted zkey for each circuit, verifies it against r1cs + ptau with
snarkjs, and checks that the contribution hashes embedded in the zkey equal the
ones listed in the transcript, in order.

## Phase 1

Perpetual Powers of Tau (BN254), PSE files `pot28_0080/ppot_0080_16.ptau`
(SHA-256 `ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`)
for `transact2x3` and `pot28_0080/ppot_0080_17.ptau` (SHA-256
`f807e065fde53f72f4bf4d57140fab85b26daa6cc95bdfec7cce93622b3a367c`) for
`transact4x3`. Pinned in `circuits/scripts/setup-dev.mjs`,
`circuits/scripts/ceremony.mjs` and `transcript.json`.

## How to contribute

Requirements: Node 20+, ~3 GB RAM, fifteen minutes, ideally a machine you can wipe.

```bash
git clone https://github.com/imadegoodstuff/bunker && cd bunker && npm ci
npm run -w circuits build          # reproduces the r1cs; its hash must equal transcript.json
node circuits/scripts/setup-dev.mjs   # downloads and pins both ptau files (also builds dev keys; ignore them)

# the latest zkey is the last `url` in transcript.json for each circuit (`initialZkeyUrl` before any contribution)
curl -LO https://github.com/imadegoodstuff/bunker/releases/download/ceremony-v2/transact2x3_0000.zkey
curl -LO https://github.com/imadegoodstuff/bunker/releases/download/ceremony-v2/transact4x3_0000.zkey

node circuits/scripts/ceremony.mjs contribute --circuit transact2x3 \
  --in transact2x3_0000.zkey --out transact2x3_0001.zkey --name "your handle"
node circuits/scripts/ceremony.mjs contribute --circuit transact4x3 \
  --in transact4x3_0000.zkey --out transact4x3_0001.zkey --name "your handle"
```

`contribute` refuses an input zkey whose hash is not the latest in the
transcript, so two people cannot branch the chain by accident. It mixes 64
bytes of OS randomness with whatever you type, runs `snarkjs zkey contribute`,
appends your entry to `transcript.json`, and writes
`contributions/NNNN-<circuit>-<handle>.md`.

Then:

1. Post the printed contribution hash somewhere tied to you (a signed commit, a
   social post, a PGP-signed message) and link it from the attestation file.
   Sign the attestation file if you can (`gpg --clearsign`).
2. Send the two output zkeys to the coordinator (open an issue; a release asset
   is added and the `url` field filled in).
3. Open a PR with `transcript.json` and your attestation file. CI verifies the
   chain before merge.
4. Destroy the machine state you used.

A contribution takes a few minutes per circuit. If two contributors race, the
second one rebases on the new latest zkey and re-runs.

## Verifying someone else's contribution

```bash
node circuits/scripts/ceremony.mjs verify --circuit transact2x3 --zkey transact2x3_0002.zkey
node circuits/scripts/ceremony.mjs check --fetch
```

## Closing the ceremony

When the contribution window closes the coordinator announces a future BNB Smart
Chain block number. Its block hash (32 bytes) is the beacon:

```bash
node circuits/scripts/ceremony.mjs beacon --circuit transact2x3 \
  --in transact2x3_00NN.zkey --out transact2x3_final.zkey --hash <block hash hex> --slot <block number>
```

`beacon` records the block number (the `--slot` field of the transcript), hash,
final zkey hash and verification-key SHA-256 in the transcript and flips
`status` to `finalized` once both circuits are done. New verifier contracts
are generated with `npm run -w contracts verifiers`, a new pool and launchpad
are deployed from that commit (SECURITY.md §11), and
`app/public/circuits/*.zkey` are replaced by the final zkeys. The
dev beacon in `setup-dev.mjs` stays what it is: a public string, for tests.

## Reproducible circuit hashes

| circuit     | constraints | public inputs | ptau | r1cs blake2b (first 16 hex) |
|-------------|------------:|--------------:|------|-----------------------------|
| transact2x3 | 35,091      | 10            | 2^16 | `943d9594e6169ef5` |
| transact4x3 | 66,868      | 12            | 2^17 | `f039f23f9a639b9b` |

circom and snarkjs versions are pinned in `circuits/package.json`; the full
hashes are in `transcript.json` and CI fails if a rebuild disagrees.
