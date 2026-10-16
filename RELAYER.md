# BUNKER relayer specification

A relayer submits other people's shielded transactions so that the account
paying gas is not theirs. It holds no keys to anyone's notes, cannot alter a
transaction (everything is under `ext_data_hash`, SPEC §7), and is paid in a
shielded note like any other recipient. Anyone may run one: the reference
implementation is `relayer/`, this document is what a client expects of any
relayer, and `NetworkConfig.relayerUrls` in the SDK takes a list, from which
the client picks the cheapest healthy one per transaction. A user who trusts no
relayer submits from their own account (`unshieldDirect`, `sendDirect`,
`exitDirect`); the protocol does not need a relayer, only the unlinkability of
the gas payer does.

## 1. Endpoints

All responses are JSON. Amounts are decimal strings in the pool's internal
units (SPEC §8) unless stated otherwise.

### `GET /info`

```jsonc
{
  "protocolVersion": 2, "revision": 1,
  "chainId": 56, "pool": "0x…", "launchpad": "0x…", "swapExit": "0x…" | null,
  "relayer": "0x…",                 // the EOA that submits
  "shieldedAddress": "bunker1…",    // where fee notes go
  "fees": [{ "token": "0x0…0", "min": "300000", "bps": 0, "costWei": "…" }, …],   // priced assets; BNB `min` is the effective floor
  "dynamicAssets": true,            // any ERC-20 with a pool can be quoted at /asset/:token
  "delay": { "minMs": 5000, "maxMs": 90000 },   // random hold before submission
  "minValidityMs": 210000,          // ext.validUntil must be at least this far in the future
  "gasPrice": {…}, "gasLimit": "1600000",
  "asp": { "provider": "0x…", "required": false, "publishes": true, "root": "0x…", "onChain": true, "leaves": 1234 } | null,
  "submit": "private" | "public",   // whether signed transactions bypass the public mempool
  "batches": { "max": 4, "sent": 17 },
  "queued": 0, "pending": 0, "drains": true,
  "legacy": { "pool": "0x…", "info": "/v1/info" } | null
}
```

### `GET /asset/:token`

Fee quote for an ERC-20 the operator did not price statically: `{ token, min,
bps, supported, reason?, price… }`. 400 if the asset cannot be relayed.

### `POST /relay`

Body: `TransactCallJson` (SDK `transactCallToJson`): the struct argument of
`ShieldedPool.transact` with every field element as a decimal string, bytes as
`0x` hex, plus `value` (must be `"0"`). The relayer MUST:

1. reject shields (`publicAmount > 0`) and any call with value: a shield names
   its depositor, which would be the relayer;
2. check `ext.validUntil` is `0` or at least `now + delay.maxMs + slack`, so
   the call cannot expire inside its own hold (400 with `minValidityMs`);
3. if it requires association-set proofs (`asp.required`), reject
   `aspRoot == 0` (400);
4. for an exit, check the target is one it forwards to (the launchpad or
   SwapExit), that `recipient == exitTarget`, that the proceeds are reshielded,
   and that the exit data is consistent with the asset spent (400 otherwise);
5. decrypt `ext.ciphertext2` with its own `ivk`; it must be a note to the
   relayer's shielded address whose commitment equals `outCommitments[2]`
   (402 `no fee note`, 400 on mismatch). The note carries its token (SPEC
   §12); for an unshield it must equal the public `token`, for a send it is the
   only place the asset exists;
6. price the fee in that asset (`fees` / `GET /asset`) and reject a note below
   the required amount (402 `{ error: "fee too low", required, offered }`);
7. simulate the call as itself and reject on revert (422 `{ error, contractError,
   details }` where `contractError` is the pool's custom error name, e.g.
   `UnknownRoot`, `NullifierSpent`, `Expired`);
8. be idempotent on nullifiers: a second request carrying a nullifier of a live
   job returns that job (`duplicate: true`) rather than a second submission.

Response: `{ id, releaseAt, gas }`; the job is then polled.

### `GET /job/:id`

`{ id, status: "queued" | "submitting" | "confirmed" | "failed", txHash?, error?, releaseAt }`.
A failed job's `error` is `simulation failed: <ContractError>` when the pool
rejected it, so clients can decide whether to re-prove (stale root) or give up
(spent note).

### `POST /drain`, `POST /pool`, `GET /health`

Keeper hooks: fold queued leaves into the tree now (anyone may ask; one
transaction however many ask), open a pool for an ERC-20, and the operator's
liveness view. None of them is needed for correctness: the pool auto-drains
when a proof cites a root that is not yet known, and pools are permissionless.

## 2. Submission

The reference relayer holds each accepted job for a uniform random
`delay.minMs..delay.maxMs`, shuffles the due set, and submits from a single EOA
(one nonce stream). Two optional behaviours it advertises:

- **`submit: "private"`** — signed transactions go to a private / MEV-protected
  endpoint (`SUBMIT_RPC_URL`), so a withdrawal is not visible in the public
  mempool before inclusion. Reads, simulation and receipts stay on the public
  RPC; the private endpoint sees only `eth_sendRawTransaction`. The endpoint is
  verified at boot to answer `eth_chainId` with the pool's chain.
- **`batches.max > 1`** — several due transactions to the same pool are sent as
  one `transactBatch` (SPEC §7). Each member is simulated alone first, so one
  stale job cannot sink the others; a bundle that fails as a whole falls back to
  single submission. A batch removes the one-transaction-per-user shape from
  the public record; it does not change what any member proves or pays.

A job past its `validUntil` is failed without being sent.

## 3. Association sets

A relayer may act as the on-chain provider for an association set the indexer
builds (SPEC §10): it polls `GET /asp/root` on its indexer and calls
`publishAspRoot(root)` from its EOA whenever the root is not yet known on-chain
(`ASP_PUBLISH`, default on when `INDEXER_URL` is set). `asp.provider` at
`/info` is the address clients pass as `aspProvider`. `ASP_REQUIRED=1` makes
the relayer forward only transactions that prove membership; it is off by
default, because a user whose note is outside the set must always be able to
leave, with another relayer or on their own.

## 4. Fees and money flow

The relayer is paid only in notes (output 2). It turns accumulated fee notes
into gas money by withdrawing them to its own EOA now and then (`SWEEP_*`),
which is an ordinary unshield and as visible as any. On-chain nothing says
what a relayed transaction paid in fees or that it was relayed at all, apart
from the submitter being the relayer's EOA.

## 5. What a relayer cannot do

Redirect funds, change the recipient, exit, reshield or ciphertexts (all under
the proof), spend anyone's notes, learn the sender, the amount of a send, or
the asset of a send. It can refuse service, delay, and see the IP address of
whoever posts to it; run it behind the usual network protections, and use a
relayer you trust not to log, or none.

## 6. Running one

```
RELAYER_KEY=0x…           # the submitting EOA; fee notes derive from it (or RELAYER_SEED)
RPC_URL=…                 # public reads / simulation / receipts
SUBMIT_RPC_URL=…          # optional private submission endpoint
INDEXER_URL=…             # for the sweeper and the association-set keeper
BATCH_MAX=4               # 1 disables batching
MIN_DELAY_MS / MAX_DELAY_MS, VALIDITY_SLACK_MS
FEE_POLICY, MIN_FEE_UNITS, COST_MARGIN_BPS, DYNAMIC_ASSETS, DYNAMIC_FEE_BPS
ASP_PUBLISH=1, ASP_REQUIRED=0, ASP_INTERVAL_MS
```

Deployments are read from `contracts/deployments/<chainId>.json`; every
address can be overridden with its `*_ADDRESS` variable. `npm run -w relayer
start`.
