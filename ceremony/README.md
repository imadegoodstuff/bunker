# scash phase-2 ceremony

The Groth16 proving keys for `transact2x2` and `transact4x2` need a
circuit-specific trusted setup. scash runs a public, permissionless phase-2
ceremony: as long as **one** participant was honest and destroyed their toxic
waste, the final keys are sound. Everything about the ceremony is in this
directory and checkable offline from the repo.

**Status: open.** 1 contribution per circuit so far (the coordinator's). The
keys deployed today are still the deterministic *dev* keys; the ceremony keys
replace them only after the beacon step below. Until then nothing here is safe
for real value, and SECURITY.md says so.

## What is where

| file | content |
|---|---|
| `transcript.json` | r1cs blake2b of each circuit, hash of every zkey in the chain, every contribution hash, hosting URLs, beacon |
| `contributions/NNNN-<circuit>-<handle>.md` | one attestation per contribution, signed by the participant |
| GitHub release [`ceremony-phase2`](https://github.com/imadegoodstuff/scash/releases/tag/ceremony-phase2) | the zkey files themselves (`_0000` = deterministic start, `_NNNN` = after contribution N) |

CI runs `node circuits/scripts/ceremony.mjs check --fetch` on every push: it
rebuilds the circuits, checks the r1cs hash against the transcript, downloads
the latest hosted zkey for each circuit, verifies it against r1cs + ptau with
snarkjs, and checks that the contribution hashes embedded in the zkey equal the
ones listed in the transcript, in order.

## Phase 1

Perpetual Powers of Tau (BN254) at `2^16`, PSE file
`pot28_0080/ppot_0080_16.ptau`, SHA-256
`ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`. Pinned in
`circuits/scripts/setup-dev.mjs` and `ceremony/transcript.json`.

## How to contribute

Requirements: Node 20+, ~2 GB RAM, ten minutes, ideally a machine you can wipe.

```bash
git clone https://github.com/imadegoodstuff/scash && cd scash && npm ci
npm run -w circuits build          # reproduces the r1cs; its hash must equal transcript.json
npm run -w circuits setup:dev      # downloads and pins the ptau (also builds dev keys; ignore them)

# the latest zkey is the last `url` in transcript.json for each circuit
curl -LO https://github.com/imadegoodstuff/scash/releases/download/ceremony-phase2/transact2x2_0001.zkey
curl -LO https://github.com/imadegoodstuff/scash/releases/download/ceremony-phase2/transact4x2_0001.zkey

node circuits/scripts/ceremony.mjs contribute --circuit transact2x2 \
  --in transact2x2_0001.zkey --out transact2x2_0002.zkey --name "your handle"
node circuits/scripts/ceremony.mjs contribute --circuit transact4x2 \
  --in transact4x2_0001.zkey --out transact4x2_0002.zkey --name "your handle"
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
node circuits/scripts/ceremony.mjs verify --circuit transact2x2 --zkey transact2x2_0002.zkey
node circuits/scripts/ceremony.mjs check --fetch
```

## Closing the ceremony

When the contribution window closes the coordinator announces a future Solana
slot. Its blockhash (base58-decoded to 32 bytes) is the beacon:

```bash
node circuits/scripts/ceremony.mjs beacon --circuit transact2x2 \
  --in transact2x2_00NN.zkey --out transact2x2_final.zkey --hash <blockhash hex> --slot <slot>
```

`beacon` records the slot, hash, final zkey hash and verification-key SHA-256
in the transcript and flips `status` to `finalized` once both circuits are
done. The final VK is exported with `circuits/scripts/export-vk.mjs` into
`programs/scash_vault/src/vk/`, the vault is built and deployed from that
commit, and `app/public/circuits/*.zkey` are replaced by the final zkeys. The
dev beacon in `setup-dev.mjs` stays what it is: a public string, for tests.

## Reproducible circuit hashes

| circuit     | constraints | public inputs | r1cs blake2b (first 16 hex) |
|-------------|------------:|--------------:|-----------------------------|
| transact2x2 | 33,515      | 9             | `138267eca69fdbea` |
| transact4x2 | 64,860      | 11            | see `transcript.json` |

circom and snarkjs versions are pinned in `circuits/package.json`; the full
hashes are in `transcript.json` and CI fails if a rebuild disagrees.
