# scash protocol specification

Version 0.1 (draft). This document is normative for the circuits in `circuits/`, the on-chain program in `programs/scash_vault/`, and the client library in `sdk/`.

scash is a shielded-note system on Solana. It follows the Zcash Sapling construction (notes, commitments, nullifiers, diversified addresses, incoming/outgoing viewing keys) and adapts it to what the Solana runtime can verify cheaply today: Groth16 over BN254 via the `alt_bn128` syscalls, Poseidon via the `sol_poseidon` syscall, one transaction of at most 1.4M compute units and 4096 bytes.

Everything below the "boundary" (shield in, unshield out) is private: sender, receiver, amount, and which notes were spent. Everything at the boundary is public, as it is in Zcash. The pool additionally enforces a per-asset turnstile so that no soundness bug in the proof system can ever release more of an asset than was deposited.

## 1. Notation

- `p` is the BN254 scalar field modulus, `p = 21888242871839275222246405745257275088548364400416034343698204186575808495617`.
- `Poseidon_t(x_1..x_n)` is the Poseidon permutation over `F_p` with the circomlib parameters for `t = n + 1`, as implemented by `sol_poseidon` (BN254, big-endian inputs). All hashes in this document are Poseidon unless stated otherwise.
- `BJJ` is the Baby Jubjub twisted Edwards curve over `F_p`, subgroup order `l = 2736030358979909402780800718157159386076813972158567259200215660948447373041`, cofactor 8.
- `H_blake(domain, ...)` is BLAKE2b-512 with a 16-byte personalization string.
- Integers are encoded big-endian when they are field elements and little-endian when they are `u64` instruction fields.

## 2. Keys

A wallet owns one spending key and derives everything else from it. Derivation is deterministic so that the same wallet reproduces the same keys on any device.

```
sk      : 32 bytes.
          sk = scrypt(password = sig || NFKC(passphrase),
                      salt     = "scash:v2:wallet-seed",
                      N = 2^15, r = 8, p = 1, dkLen = 32)
          where sig is the wallet's signature over SPENDING_KEY_MESSAGE
          (sdk/src/keys.ts; a multi-line text that states what it derives)
          and passphrase is an optional user secret (empty string if unset).
          sk may also be imported directly from a "scashseed1" + hex backup.

ask     = to_scalar(H_blake("scash_ExpandSeed", sk || 0x00))   spend authorizing key
nsk     = to_scalar(H_blake("scash_ExpandSeed", sk || 0x01))   nullifier deriving key
ovk     = H_blake("scash_ExpandSeed", sk || 0x02)[0..32]        outgoing viewing key

ak      = Poseidon(ask)                                           spend validating key
nk      = Poseidon(nsk)                                           nullifier key
ivk     = Poseidon(ak, nk) mod 2^250                              incoming viewing key
```

`to_scalar` reduces the 64-byte hash modulo `p`. `ivk` is truncated to **250** bits. The Baby Jubjub prime-subgroup order is `l = 2736030358979909402780800718157159386076813972158567259200215660948447373041 ≈ 2^250.6`, so `2^250 < l < 2^251`: a 250-bit value is always a valid scalar below `l`, a 251-bit one is not. (Sapling truncates to 251 because Jubjub's `l ≈ 2^251.8`; the width is curve-specific and an earlier draft of this spec copied Sapling's number, which was wrong.) Ephemeral scalars `esk` (§12) use the same 250-bit mask plus rejection of 0. The SDK (`SCALAR_MASK` in `sdk/src/keys.ts`) and the circuit (`ViewingKeys`/`DiversifiedKeyCheck` in `circuits/src/keys.circom`) both use 250 bits; `sdk.test.ts` asserts `ivk < l` over many seeds, and because the circuit re-derives `ivk` from `(ask, nsk)` and checks `pk_d = [ivk]·g_d` against the note, any width mismatch between SDK and circuit makes every proof fail. The Rust fixture test verifies a real SDK proof with the exact on-chain verifier, so the three implementations are cross-checked on every CI run.

Key hierarchy and what each level can do:

| Key | Can spend | Can see incoming notes | Can see outgoing notes | Can derive addresses |
|---|---|---|---|---|
| `sk` | yes | yes | yes | yes |
| full viewing key `(ak, nk, ovk)` | no | yes | yes | yes |
| incoming viewing key `ivk` | no | yes | no | yes |
| outgoing viewing key `ovk` | no | no | yes | no |

This is the Sapling hierarchy minus the re-randomized spend-authorization signature: because the relayer is the only on-chain signer, authorization is proven inside the circuit by knowledge of `ask`, bound to `ext_data_hash`.

**Why a passphrase.** Any web page can ask a connected wallet to sign arbitrary text, and most wallets will sign it after showing the text. A signature-only derivation therefore hands the spending key to any page that can phish one signature. The passphrase is a second factor the page never sees; scrypt makes each guess at it cost about 100 ms. Users may leave it empty, in which case the signature alone is the key and the only protection is the warning text inside the message. See SECURITY.md §1.

**What the passphrase does and does not do.**

- *Single derivation path.* `seedFromSignature` is the only function that turns a signature into `sk`; every other key (`ask`, `nsk`, `ovk`, `ak`, `nk`, `ivk`, all diversified addresses) is derived from `sk` by `ShieldedWallet.fromSeed`. There is no viewing-key or recovery path that skips the passphrase. The passphrase is not stored anywhere, not even hashed.
- *Loss.* Wallet signature + passphrase, or the `scashseed1` backup, each reproduce `sk`. Losing the passphrase without a backup means the notes are unspendable; nobody can reset it. The app offers the backup immediately after first unlock for this reason.
- *Offline guessing.* An attacker who has obtained the signature (phishing, a malicious dapp, a wallet that logs signatures) can test passphrases offline at the cost of one scrypt call each, about 100 ms on a desktop core, roughly 10⁶ guesses per core-day. The app enforces a minimum of 8 characters; that stops nothing against a dictionary. A passphrase of four or more random words is the realistic bar. Without the signature, the passphrase is useless, so the attacker needs both.
- *Cross-site linkage.* Ed25519 signatures are deterministic, so the signature over `SPENDING_KEY_MESSAGE` is a fixed value per wallet. A site that obtains it learns only that it belongs to the public wallet address it already knows; it cannot derive `ivk` or any `scash1…` address without the passphrase, so it cannot link the wallet to shielded activity.

## 3. Diversified addresses

An address is `(d, pk_d)`:

```
d     : 11 random bytes (diversifier)
g_d   = GroupHash_BJJ(d)          a point in the prime-order subgroup, or ⊥
pk_d  = [ivk] g_d
```

`GroupHash_BJJ(d)` is `H_blake("scash_Diversify", d)` interpreted as a candidate `y`, solved for `x` on the curve (taking the even `x`), multiplied by the cofactor 8, rejecting the identity. Roughly half of all `d` succeed; the wallet increments `d` until one does.

One `ivk` has 2^88 unlinkable addresses. Nothing is registered on-chain to receive. Addresses are encoded with bech32m, HRP `scash` on mainnet, `tscash` on devnet, payload `d || compress(pk_d)` (11 + 32 bytes).

## 4. Notes

```
Note = (asset, value, g_d, pk_d, rho, rcm)

asset : F_p    asset identifier, see §8
value : u64    amount in the pool's internal unit (shares, see §9)
rho   : F_p    random, unique per note; input to the nullifier
rcm   : F_p    random commitment trapdoor
```

`rho` and `rcm` are not sampled independently. Each note carries a 32-byte
`rseed`, and (as in ZIP 212):

```
rho = BLAKE2b-512(rseed, personal = "scash_rho_______")  mod p
rcm = BLAKE2b-512(rseed, personal = "scash_rcm_______")  mod p
```

so the encrypted note only has to transmit `rseed` (32 bytes instead of 64).
The circuit sees `rho` and `rcm` directly; the derivation is off-circuit.

Note commitment:

```
cm = Poseidon(asset, value, g_d.x, g_d.y, pk_d.x, pk_d.y, rho, rcm)      (8 inputs)
```

Nullifier of a note at leaf `pos` in the commitment tree:

```
nf = Poseidon(nk, rho, pos)
```

Including `pos` makes two notes with identical contents distinct in their nullifiers, so a sender cannot make a recipient's two payments cancel each other ("faerie gold").

## 5. Commitment tree and roots

A single append-only Poseidon Merkle tree of depth 26 (67,108,864 leaves) holds the commitments of every note of every asset in the pool. Sharing one tree is an engineering choice (one account, one root ring); it does **not** give assets a shared anonymity set, because `asset` is public in every transaction. See §8.

- Leaf hash: the commitment itself.
- Node hash: `Poseidon(left, right)`.
- Empty leaf: `Poseidon("scash_empty") = EMPTY_LEAF` (constant, computed in `sdk/src/constants.ts` and asserted in tests).
- The program keeps `filled_subtrees[26]`, `next_index`, and a ring buffer of the last 128 roots. One ring slot is written per *transaction* (after all of its outputs are appended), not per leaf, so a proof built against root *R* is accepted until 128 later transactions have landed. Proofs may reference any root in the ring, which lets a client prove against a slightly stale tree and lets relayers batch.
- A proof names its root by ring index. If the slot has since been overwritten, the public input no longer matches and the vault returns `InvalidProof`, not `UnknownRoot`; clients treat both as "re-sync and re-prove". `scripts/bench.mjs` (CI, artifact `bench-report`) fires 139 transacts concurrently against one root and fails the build if the stale proof is still accepted after 128 landed, or rejected before.

## 6. The transact circuit

`Transact(nIns, nOuts, levels)` is instantiated as `transact2x2` (2 spends, 2 outputs) and `transact4x2` (4 spends, 2 outputs), both with `levels = 26`. Every private action, whether a send, an unshield, a shield with change, or a swap exit, is one proof.

Public inputs, in order:

```
root            : F_p     commitment tree root
public_amount   : F_p     out_total - in_total encoded as value for positive, p - value for negative
asset           : F_p
ext_data_hash   : F_p     SHA-256(ext_data) mod p, see §7
asp_root        : F_p     association set root, 0 to disable (§10)
nullifiers[nIns]: F_p
out_cms[nOuts]  : F_p
```

Private inputs:

```
ask, nsk                                      (shared by all spends)
per spend i:
  value_i, g_d_i, pk_d_i, rho_i, rcm_i
  path_elements_i[levels], path_index_i      (bits of pos_i)
  asp_path_elements_i[levels], asp_path_index_i
per output j:
  value_j, g_d_j, pk_d_j, rho_j, rcm_j
```

Constraints:

1. `ak = Poseidon(ask)`, `nk = Poseidon(nsk)`, `ivk = Poseidon(ak, nk)` truncated to 250 bits.
2. For every spend: `g_d_i` is on the curve and not of small order (`[8] g_d_i != O`, template `ValidSubgroupPoint`), and `pk_d_i == [ivk] g_d_i`. Since `ivk` is the prover's own key, this is the ownership proof: a note whose `pk_d` was computed under another `ivk` cannot be spent.
3. For every spend: `cm_i = Poseidon(asset, value_i, g_d_i, pk_d_i, rho_i, rcm_i)` and, if `value_i != 0`, `MerkleRoot(cm_i, path_i) == root`. Zero-value spends are dummies and skip the membership check.
4. For every spend: `nullifiers[i] == Poseidon(nk, rho_i, pos_i)` where `pos_i` is the integer formed by `path_index_i`.
5. If `asp_root != 0`: for every non-dummy spend, `MerkleRoot(cm_i, asp_path_i) == asp_root`.
6. For every output: `out_cms[j] == Poseidon(asset, value_j, g_d_j, pk_d_j, rho_j, rcm_j)`, `value_j < 2^64`, `g_d_j` is on the curve and not of small order (`ValidSubgroupPoint`), and `pk_d_j` is on the curve (`BabyCheck`).
7. All `value_i < 2^64`.

**What the circuit does and does not prove about an output address.** Inputs and outputs are deliberately asymmetric. For a spend the prover holds `ivk`, so the circuit proves `pk_d = [ivk] g_d`. For an output the prover is the *sender*, who does not and must not know the recipient's `ivk`, so no circuit can prove that `pk_d_j` is the recipient's key for `g_d_j` (Sapling has the same limit). The circuit proves the output is *structurally* a valid address: both points on the curve, `g_d` outside the small-order subgroup. Whether it is *the recipient's* address is enforced at receive time: `ShieldedWallet.scan` decrypts `d`, recomputes `g_d = GroupHash(d)` and `pk_d = [ivk] g_d` from its own `ivk`, recomputes the commitment, and accepts the note only if it equals the on-chain `cm` (which binds `pk_d`). A note with a `pk_d` that does not match any `ivk` is therefore never credited to anyone and can never be spent: it is value destroyed by the sender, exactly like a transfer to a random public address, and it cannot be used to take or lock anyone else's funds. `circuits/test/adversarial.test.mjs` takes a valid witness and applies one tampering at a time (off-curve `pk_d`, off-curve `g_d`, small-order and identity `g_d`, wrong commitment, value ≥ 2^64, minting, wrong public amount, foreign note, wrong root, tampered path, wrong nullifier, double spend inside one transaction, dummy input carrying value, ASP root without membership) and asserts each is unsatisfiable; it runs in CI against the freshly compiled circuit.
**Why `[8]P ≠ O` and not `[l]P = O`.** `ValidSubgroupPoint` proves a point is on the curve and not of order 1, 2, 4 or 8. It does *not* prove membership in the prime-order subgroup: a point `g_d' = g_d + T` with `T` of order 8 passes. This is the same check the Sapling Spend statement makes on `g_d` ("`g_d` is not of small order", Zcash protocol specification) and it is sufficient here for the following reason. The only attack a small-order or torsion component enables is key leakage through a scalar multiplication by a secret: `[ivk]·T` reveals `ivk mod 8`. In this protocol the sender never multiplies anything by the recipient's secret, and the recipient multiplies a sender-supplied point by `ivk` in exactly one place, key agreement on `epk`, which clears the cofactor first (§12). For the note's `g_d` the receiver does not use the sender's point at all: `scan` computes `g_d = GroupHash(d)` from the diversifier (cofactor cleared), so a torsion `g_d'` in the note never reaches `[ivk]·g_d'`, and the commitment check then refuses the note. On the input side the point being multiplied by `ivk` is the prover's own `g_d`, and a prover who adds torsion to their own address leaks bits only of their own key. A full `[l]P = O` check would cost ≈2,500 constraints per point (four points per transaction) to defend against a leak that has no path. `sdk/src/sdk.test.ts` constructs `g_d + T`, confirms it satisfies the circuit's condition and is not in the subgroup, and confirms `scan` refuses it; `circuits/test/adversarial.test.mjs` confirms the identity, the order-2 point and off-curve points are rejected by the circuit itself.

8. `sum(value_i) + public_amount == sum(value_j)` in `F_p`. Because all values are 64-bit and `nIns, nOuts <= 4`, no wraparound is possible unless `public_amount` is outside `[-2^66, 2^66]`, which the program rejects before verification.
9. `ext_data_hash` is bound by being a public input. The circuit squares it into a dummy constraint so it cannot be optimized away.

## 7. Transaction data

```
ExtData {
  recipient     : Pubkey      destination of a negative public_amount (token account or system account)
  relayer       : Pubkey      receives relayer_fee
  relayer_fee   : u64         in asset base units, deducted from |public_amount| when it is negative
  exit_target   : Pubkey      0 = plain unshield; otherwise a program to CPI with the unshielded funds (§11)
  exit_data     : bytes       opaque, passed to exit_target
  ciphertexts   : [bytes; nOuts]   note ciphertexts for recipients (§12)
  out_ciphertext: bytes       sender-side record under ovk
}
ext_data_hash = SHA-256(borsh(ExtData)) mod p
```

The program recomputes `ext_data_hash` from the instruction payload before verifying the proof. A relayer therefore cannot alter the recipient, fee, exit, or ciphertexts.

The `transact` instruction payload is kept compact so that a 2-in/2-out transaction fits a 1232-byte packet together with an address lookup table:

```
TransactArgs {
  proof          : [u8; 256]        -A || B || C, big-endian
  root_index     : u8               index into the tree's 128-root ring; the program reads the root
  public_amount  : i64              signed shares; the program encodes it as the field element above
  asp_root       : Option<[u8;32]>  None = 0
  nullifiers     : [[u8;32]; nIns]
  out_commitments: [[u8;32]; nOuts]
  ext_data       : ExtData
}
```

Memos inside note ciphertexts are padded to a multiple of 64 bytes, so only a length bucket leaks. The maximum is 64 bytes; §15 explains why.

## 8. Assets

An asset is a Token-2022 or SPL mint, or native SOL (asset id of the system program). `asset = SHA-256("scash_asset" || mint) mod p`. Each asset has a `Pool` account that holds its token account, its turnstile counters and its share rate. All assets share the commitment tree held by the `Tree` account.

**Anonymity is per asset, not per tree.** `asset` is a public input of every `transact`, so each transaction reveals which asset it moves. A spend of asset *A* can only have come from a note of asset *A*; the anonymity set of a withdrawal is therefore the set of unspent notes *of that asset*, not every leaf in the tree. Sharing one tree saves accounts and lets a single root ring serve every pool; it does not merge anonymity sets. Thin pools are thin regardless of how full the tree is, and the app reports the set size per asset for this reason.

## 9. Shares and donations

Inside the pool, `value` is denominated in shares. Each `Pool` has `total_shares` and `total_assets`.

```
shares_for(amount) = amount * total_shares / total_assets       (floor), or amount if total_shares == 0
amount_for(shares) = shares * total_assets / total_shares        (floor)
```

Shield mints `shares_for(amount)` shares; unshield burns `shares` and releases `amount_for(shares)`. Anyone may call `donate(amount)`, which increases `total_assets` without minting shares, so every existing note is worth more. This is how the native token's trading fees are paid to every private holder with no distribution transaction and no information about who holds what (§13).

For assets that are never donated to, `total_shares == total_assets` always and shares equal base units.

**Virtual offset.** All rates are computed over `(total_shares + V, total_assets + V)` with `V = 10^6` (`Pool::VIRTUAL_OFFSET`, mirrored as `VIRTUAL_OFFSET` in the SDK):

```
shares_for_deposit(a) = floor(a · (S+V) / (A+V))
amount_for_mint(s)    = ceil (s · (A+V) / (S+V))      what a shield of s shares costs
amount_for_burn(s)    = floor(s · (A+V) / (S+V))      what an unshield of s shares pays
```

`V` behaves like a holder of `V` shares backed by `V` units who was there from creation. An empty pool is still 1:1. The point is the first-depositor inflation attack: minting one share and donating `D` to inflate the price now gives the attacker back `≈ D/V`, with the rest accruing to the pool for whoever comes later; `state.rs::share_invariants::inflation_attack_is_unprofitable_and_victims_are_whole` shows a 10⁹ donation after a one-unit position moves the share price to ≈1,001 units (not 10⁹), the attacker recovers under 2,000, and a later depositor loses less than one share's worth to rounding. For a pool holding 10¹² units the offset distorts rates by one part per million. Rounding dust is retained by the pool (and thereby by `V`), never extractable. In the current deployment only the `SCASH` pool is donated to (§13); SOL, USDC and every other pool have a constant share rate of 1 and earn nothing. The share rate is base units per share: it never decreases, but it says nothing about the asset's market price.

**Which mints a pool accepts.** The share arithmetic assumes that `shield(amount)` puts exactly `amount` base units into the vault and that only the pool PDA can move them out. Token-2022 extensions can break both, so `create_pool` refuses mints that carry any of: `TransferFeeConfig` (vault receives less than credited), `TransferHook` (foreign code and extra accounts on every transfer), `PermanentDelegate` (a third party can pull from the vault), `NonTransferable`, `DefaultAccountState` (vault created frozen), `Pausable` (unshields can be halted). Harmless extensions (metadata, confidential transfer, interest-bearing display, close authority, memo-required, CPI guard) are accepted. As defence in depth, every inbound token transfer reads the vault balance before and after and fails with `ShortDelivery` unless it grew by exactly `amount`. A base-mint *freeze authority* is not an extension and is not rejected: USDC has one, and a frozen vault account would block every unshield of that asset. That is an accepted, documented counterparty risk of holding such assets in any pool.

## 10. Association sets

An association set provider (ASP) publishes a Merkle root over note commitments it has approved (for example, every shield deposit that passed a screening policy, plus every output it has seen descend from approved inputs). A spender may include `asp_root` in a proof to show its inputs are in the set. The program stores the last 32 ASP roots per registered provider and accepts any of them. Using an ASP is always optional for the spender; recipients and relayers decide whether to require it. A spender whose note is not in any set can always exit publicly by unshielding with `asp_root = 0`.

## 11. Exits

If `exit_target != 0`, the program transfers the unshielded amount (after `relayer_fee`) to a transient program-owned token account and CPIs `exit_target` with `exit_data`, the transient account, and `recipient`. The exit program (for example the swap adapter in `programs/scash_swap/`) must leave the transient account empty; any remainder is forwarded to `recipient`. The exit program may re-shield its result by calling `transact` on its own, which puts the swapped asset back in the pool in the same transaction.

## 12. Note encryption

For each output note the sender samples `esk` (a Baby Jubjub scalar) and computes

```
epk          = [esk] g_d
shared       = [8·esk] pk_d               = [8·ivk] epk on the receiver side   (cofactor-cleared, Sapling KA.Agree)
K_enc        = H_blake("scash_NoteEncKey", compress(shared) || compress(epk))
ciphertext   = compress(epk) || ChaCha20-Poly1305(K_enc, nonce = 0, plaintext)
plaintext    = d || value (8 LE) || rseed (32) || memo
```

The memo is optional. When present it is zero-padded to the next multiple of
64 bytes (max 64, see §15) so that only a length bucket leaks. A ciphertext
without a memo is `32 + 16 + 11 + 8 + 32 = 99` bytes; with a memo, 163.

The factor 8 is the curve cofactor. `epk` is chosen by the sender, so without it a receiver computing `[ivk]·(epk + T)` for a torsion point `T` would accept the note only when `ivk ≡ k (mod 8)` for the `k` the sender guessed, leaking three bits of `ivk` per accepted note. With the cofactor the torsion vanishes on both sides; `sdk.test.ts` checks that `epk + T` yields the same shared point for every residue of `ivk` and that the tampered ciphertext still fails the AEAD (the key commits to the encoded `epk`).

The receiver trial-decrypts every ciphertext in every `transact` with `ivk`, recomputes `g_d = GroupHash(d)`, `pk_d = [ivk] g_d`, `cm`, and accepts the note only if `cm` matches the on-chain commitment at that leaf.

The sender additionally encrypts `(pk_d, esk)` under `K_out = H_blake("scash_OutKey", ovk || cm)` so that holders of `ovk` can reconstruct outgoing notes.

Trial decryption happens on the client. The indexer serves raw ciphertexts and never holds keys.

## 13. The native token and the harvester

The `SCASH` token is a Token-2022 mint launched on Meteora's Dynamic Bonding Curve and graduated to DAMM v2. Creator trading fees accrue to the `scash_harvester` program. Anyone may call `harvest`, which claims the fees, swaps the quote half to `SCASH`, and calls `donate` on the `SCASH` pool. Every private holder's shares appreciate; the other half funds the relayer gas pool and the team, at fixed percentages set at deployment and not changeable.

## 14. Turnstile and immutability

For every pool, `total_in - total_out >= 0` is a program invariant checked on every negative `public_amount`. `total_in` counts shields and donations; `total_out` counts unshields. Should a proof-system flaw let an attacker forge notes, it can at most drain what honest users deposited into that asset's pool, never more, and the drain is visible and measurable.

The vault program is deployed, verified against the public source, and then its upgrade authority is set to `None`. A guardian key can pause shields and lower (never raise) the per-asset TVL cap. Nothing can pause `transact` with `public_amount <= 0`.

A new circuit or proof system means a new vault. `scash_migrator` (`programs/scash_migrator`) moves a balance from the old vault into notes in the new one without a user-held public key on the path:

```
1. Stage    the user writes the complete NEW-vault `transact` (a shield: proof,
            output commitments, ciphertexts) into a staging account they own.
2. Exit     the user unshields from the OLD vault with
            recipient = PDA("migrate", staging). The recipient is bound inside
            the old proof by ext_data_hash, so the funds can only land there.
3. Execute  anyone calls Execute. The PDA signs the staged shield into the new
            vault (payer, depositor, recipient and relayer destination are
            all the PDA). Leftover (rate drift, rent) goes to the refund key
            fixed at staging; the staging account is closed.
```

Two transactions are needed because an old-vault `transact` plus a new-vault `transact` do not fit one 1,232-byte packet; between them the funds sit in a PDA whose only reachable destination is the staged shield, and Execute is permissionless, so they cannot be stranded or redirected. What the pair reveals is that an unshield of X from the old pool funded a shield of X into the new pool, the same as any public shield; the old notes spent and the new notes' owner stay hidden by the two proofs. `scripts/migrate-e2e.mjs` runs this in CI against the vault binary loaded under a second program id.

## 15. Compute and size budget

| Item | Cost |
|---|---|
| Groth16 verify, 7 + nIns + nOuts public inputs | about 110,000 CU |
| Tree append, 2 outputs | 2 x 26 Poseidon(2) = 52 x 786 = 40,872 CU |
| Nullifier PDA creation | about 5,000 CU each |
| SHA-256 of ext_data | under 2,000 CU |
| Total `transact2x2` | about 200,000 CU |
| Proof | 256 bytes (uncompressed G1, G2, G1) |
| Instruction args besides ext_data | 1 + 4 + 1 + 8 + 1 + 4 + 2x32 + 4 + 2x32 = 152 bytes |
| ext_data without memo | 32 + 32 + 8 + 32 + 4 + 4 + 2x(4 + 99) + 4 + 80 = 402 bytes |
| Two ciphertexts | 99 + 99 (no memo) or 163 + 99 (one 64-byte memo) |

Solana transactions are limited to 1,232 bytes and there is no v1 format with a larger budget. Measured on a validator (CI e2e, v0 transaction with the lookup table from §7):

| Transaction | Bytes | CU |
|---|---|---|
| shield, no memo | 1,140 | 192k |
| private send, 64-byte memo, relayer fee | 1,204 | 196k |
| unshield, no memo | 1,172 | 203k |

The lookup table must hold the program, config, tree, system/compute/token programs, each pool's mint, pool PDA and vault, **and the relayer's fee destinations** (its key and its token account per SPL pool). The program id and the signers cannot be table-loaded. With everything else in the table, one 64-byte memo bucket fits and a second does not; `sdk/src/sdk.test.ts` serialises the real instruction for both the SOL and SPL cases and asserts exactly this, so `MEMO_MAX` cannot drift from the packet limit without a test failing. Longer memos require a second transaction (a memo-only note) or a change to the on-chain format; neither is specified yet.
