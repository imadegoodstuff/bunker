# scash phase-2 ceremony

The Groth16 proving keys for `transact2x2` and `transact4x2` require a
circuit-specific trusted setup. scash runs a public, permissionless phase-2
ceremony. As long as **one** participant was honest and destroyed their
toxic waste, the resulting keys are sound.

## Phase 1

We use the Perpetual Powers of Tau (BN254) at `2^16`, specifically the
PSE contribution `pot28_0080/ppot_0080_16.ptau`
(SHA-256 `ed3622a7c79b0b49aadd134ebbc5b77df8c8c59bccebdfd0d9bf2c1a51561cf9`). The
hash is pinned in `circuits/scripts/setup-dev.mjs` and checked at download time.

## Phase 2 (how to contribute)

Requirements: Node 20+, ~2 GB RAM, a few minutes.

```bash
git clone <this repo> && cd scash && npm ci
npm run -w circuits build            # reproduce r1cs (hash must match below)
# download the latest contribution from the coordinator
node circuits/scripts/ceremony.mjs contribute \
  --in  transact2x2_0007.zkey \
  --out transact2x2_0008.zkey \
  --name "your handle" 
```

The script calls `snarkjs zkey contribute` with entropy from
`crypto.getRandomValues` mixed with whatever you type at the prompt. Upload the
output and post the printed contribution hash somewhere public (your social
account, a signed git commit, etc.). Then **delete** the machine state you used
if you can.

After the contribution window closes the coordinator applies a random beacon
(a future Solana block hash announced in advance) and publishes:

- the final `.zkey` files and their `blake2b` hashes
- `verification_key.json` and the generated Rust constants under
  `programs/scash_vault/src/vk/`
- a transcript with every contribution hash

Anyone can re-run `snarkjs zkey verify <r1cs> <ptau> <final.zkey>` to check the
whole chain.

## Reproducible circuit hashes

| circuit        | constraints | public inputs | r1cs blake2b |
|----------------|------------:|--------------:|--------------|
| transact2x2    | 33,435      | 9             | _published at tag_ |
| transact4x2    | 64,752      | 11            | _published at tag_ |

The circom compiler version is pinned in `circuits/package.json`.
