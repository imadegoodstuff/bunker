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

A wallet owns one spending key and derives everything else from it. Derivation is deterministic so that the same wallet reproduces the same keys on any device without a backup.

```
sk      : 32 bytes. Either BLAKE2b-256 of a wallet signature over the fixed
          message "scash:v1:spending-key" (domain-separated, never used for
          anything else), or a BIP-39 seed.

ask     = to_scalar(H_blake("scash_ExpandSeed", sk || 0x00))   spend authorizing key
nsk     = to_scalar(H_blake("scash_ExpandSeed", sk || 0x01))   nullifier deriving key
ovk     = H_blake("scash_ExpandSeed", sk || 0x02)[0..32]        outgoing viewing key

ak      = Poseidon(ask)                                           spend validating key
nk      = Poseidon(nsk)                                           nullifier key
ivk     = Poseidon(ak, nk) mod 2^251                              incoming viewing key
```

`to_scalar` reduces the 64-byte hash modulo `p`. `ivk` is truncated to 251 bits so it is a valid Baby Jubjub scalar below `l`.

Key hierarchy and what each level can do:

| Key | Can spend | Can see incoming notes | Can see outgoing notes | Can derive addresses |
|---|---|---|---|---|
| `sk` | yes | yes | yes | yes |
| full viewing key `(ak, nk, ovk)` | no | yes | yes | yes |
| incoming viewing key `ivk` | no | yes | no | yes |
| outgoing viewing key `ovk` | no | no | yes | no |

This is the Sapling hierarchy minus the re-randomized spend-authorization signature: because the relayer is the only on-chain signer, authorization is proven inside the circuit by knowledge of `ask`, bound to `ext_data_hash`.

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

A single append-only Poseidon Merkle tree of depth 26 (67,108,864 leaves) holds the commitments of every note of every asset in the pool. Sharing one tree across assets gives every asset the union anonymity set.

- Leaf hash: the commitment itself.
- Node hash: `Poseidon(left, right)`.
- Empty leaf: `Poseidon("scash_empty") = EMPTY_LEAF` (constant, computed in `sdk/src/constants.ts` and asserted in tests).
- The program keeps `filled_subtrees[26]`, `next_index`, and a ring buffer of the last 128 roots. Proofs may reference any root in the ring, which lets a client prove against a slightly stale tree and lets relayers batch.

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

1. `ak = Poseidon(ask)`, `nk = Poseidon(nsk)`, `ivk = Poseidon(ak, nk)` truncated to 251 bits.
2. For every spend: `pk_d_i == [ivk] g_d_i` (Baby Jubjub scalar multiplication; `g_d_i` must be on the curve and in the subgroup, which is enforced by multiplying `g_d_i` by `l` and checking identity, or more cheaply by requiring the point to be on the curve and relying on the fact that pk_d = [ivk]g_d for a small-order component would be rejected by the owner at receive time; the circuit uses the on-curve check and the client performs the subgroup check).
3. For every spend: `cm_i = Poseidon(asset, value_i, g_d_i, pk_d_i, rho_i, rcm_i)` and, if `value_i != 0`, `MerkleRoot(cm_i, path_i) == root`. Zero-value spends are dummies and skip the membership check.
4. For every spend: `nullifiers[i] == Poseidon(nk, rho_i, pos_i)` where `pos_i` is the integer formed by `path_index_i`.
5. If `asp_root != 0`: for every non-dummy spend, `MerkleRoot(cm_i, asp_path_i) == asp_root`.
6. For every output: `out_cms[j] == Poseidon(asset, value_j, g_d_j, pk_d_j, rho_j, rcm_j)` and `value_j < 2^64`.
7. All `value_i < 2^64`.
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

Memos inside note ciphertexts are padded to a multiple of 64 bytes (max 512), so only a length bucket leaks.

## 8. Assets

An asset is a Token-2022 or SPL mint, or native SOL (asset id of the system program). `asset = SHA-256("scash_asset" || mint) mod p`. Each asset has a `Pool` account that holds its token account, its turnstile counters and its share rate. All assets share the commitment tree held by the `Tree` account.

## 9. Shares and donations

Inside the pool, `value` is denominated in shares. Each `Pool` has `total_shares` and `total_assets`.

```
shares_for(amount) = amount * total_shares / total_assets       (floor), or amount if total_shares == 0
amount_for(shares) = shares * total_assets / total_shares        (floor)
```

Shield mints `shares_for(amount)` shares; unshield burns `shares` and releases `amount_for(shares)`. Anyone may call `donate(amount)`, which increases `total_assets` without minting shares, so every existing note is worth more. This is how the native token's trading fees are paid to every private holder with no distribution transaction and no information about who holds what (§13).

For assets that are never donated to, `total_shares == total_assets` always and shares equal base units.

## 10. Association sets

An association set provider (ASP) publishes a Merkle root over note commitments it has approved (for example, every shield deposit that passed a screening policy, plus every output it has seen descend from approved inputs). A spender may include `asp_root` in a proof to show its inputs are in the set. The program stores the last 32 ASP roots per registered provider and accepts any of them. Using an ASP is always optional for the spender; recipients and relayers decide whether to require it. A spender whose note is not in any set can always exit publicly by unshielding with `asp_root = 0`.

## 11. Exits

If `exit_target != 0`, the program transfers the unshielded amount (after `relayer_fee`) to a transient program-owned token account and CPIs `exit_target` with `exit_data`, the transient account, and `recipient`. The exit program (for example the swap adapter in `programs/scash_swap/`) must leave the transient account empty; any remainder is forwarded to `recipient`. The exit program may re-shield its result by calling `transact` on its own, which puts the swapped asset back in the pool in the same transaction.

## 12. Note encryption

For each output note the sender samples `esk` (a Baby Jubjub scalar) and computes

```
epk          = [esk] g_d
shared       = [esk] pk_d                 = [ivk] epk on the receiver side
K_enc        = H_blake("scash_NoteEncKey", compress(shared) || compress(epk))
ciphertext   = compress(epk) || ChaCha20-Poly1305(K_enc, nonce = 0, plaintext)
plaintext    = d || value (8 LE) || rho || rcm || memo (512 bytes)
```

The receiver trial-decrypts every ciphertext in every `transact` with `ivk`, recomputes `g_d = GroupHash(d)`, `pk_d = [ivk] g_d`, `cm`, and accepts the note only if `cm` matches the on-chain commitment at that leaf.

The sender additionally encrypts `(pk_d, esk)` under `K_out = H_blake("scash_OutKey", ovk || cm)` so that holders of `ovk` can reconstruct outgoing notes.

Trial decryption happens on the client. The indexer serves raw ciphertexts and never holds keys.

## 13. The native token and the harvester

The `SCASH` token is a Token-2022 mint launched on Meteora's Dynamic Bonding Curve and graduated to DAMM v2. Creator trading fees accrue to the `scash_harvester` program. Anyone may call `harvest`, which claims the fees, swaps the quote half to `SCASH`, and calls `donate` on the `SCASH` pool. Every private holder's shares appreciate; the other half funds the relayer gas pool and the team, at fixed percentages set at deployment and not changeable.

## 14. Turnstile and immutability

For every pool, `total_in - total_out >= 0` is a program invariant checked on every negative `public_amount`. `total_in` counts shields and donations; `total_out` counts unshields. Should a proof-system flaw let an attacker forge notes, it can at most drain what honest users deposited into that asset's pool, never more, and the drain is visible and measurable.

The vault program is deployed, verified against the public source, and then its upgrade authority is set to `None`. A guardian key can pause shields and lower (never raise) the per-asset TVL cap. Nothing can pause `transact` with `public_amount <= 0`.

A new circuit or proof system means a new vault. A `scash_migrator` exit target moves a balance from the old vault into a note in the new one in one transaction; the old vault's turnstile only lets out what went in.

## 15. Compute and size budget

| Item | Cost |
|---|---|
| Groth16 verify, 7 + nIns + nOuts public inputs | about 110,000 CU |
| Tree append, 2 outputs | 2 x 26 Poseidon(2) = 52 x 786 = 40,872 CU |
| Nullifier PDA creation | about 5,000 CU each |
| SHA-256 of ext_data | under 2,000 CU |
| Total `transact2x2` | about 200,000 CU |
| Proof | 256 bytes (uncompressed G1, G2, G1) |
| Public inputs | 11 x 32 = 352 bytes |
| Two ciphertexts | 2 x (32 + 16 + 11 + 8 + 64 + 512) = 1,286 bytes |

A `transact2x2` with memo fits in a v1 transaction (4096 bytes). A relayer can place up to 6 `transact2x2` without memos in one transaction under the 1.4M CU limit.
