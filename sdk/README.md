# @bunker/sdk

TypeScript client for [BUNKER](https://bunkeronbnb.com), the shielded pool and
private launchpad on BNB Smart Chain. It talks to the same contracts, indexer,
relayer and agents the web app uses, so anything you build with it shares one
anonymity set with every BUNKER user.

Works in Node ≥ 20 and in browsers (ESM only). Proofs are generated locally
with snarkjs; nothing secret ever leaves the process.

## Install

```sh
npm install @bunker/sdk viem
```

Or from source:

```sh
git clone https://github.com/imadegoodstuff/bunker && cd bunker
npm ci && npm run -w sdk build        # then import ./sdk/dist/index.js
```

## Quickstart

```ts
import { BunkerClient } from "@bunker/sdk";
import { parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// 1. A spending seed. Keep the backup string: it is the only way to see or spend these notes.
const seed = BunkerClient.randomSeed();
console.log("backup:", BunkerClient.seedToBackup(seed)); // bunkerseed1…

// 2. Connect to BSC mainnet (contracts, indexer, relayer and proving keys are preconfigured).
const bunker = await BunkerClient.connect({ seed });
console.log("shielded address:", bunker.address()); // bunker1…

// 3. Sync: pull commitments from the indexer, decrypt yours, rebuild the Merkle tree.
await bunker.sync();

// 4. Shield 0.01 BNB from a public account (you pay gas).
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
await bunker.shield("BNB", parseEther("0.01"), { signer: account });

// 5. Private send: nothing public links you to the recipient. The relayer pays gas.
await bunker.send("BNB", parseEther("0.004"), "bunker1…recipient…");

// 6. Unshield to any public address.
await bunker.unshield("BNB", parseEther("0.003"), "0xRecipient…");

const { amount } = await bunker.balance("BNB");
console.log("left in the vault:", formatEther(amount), "BNB");
```

Amounts are always wei / token base units (`bigint`). The pool's internal
units and share accounting stay inside the SDK.

### Keys the way the web app derives them

The web app derives the seed from a wallet signature plus a passphrase, so a
developer can open the same vault a user already has:

```ts
const sig = await walletClient.signMessage({ account, message: BunkerClient.SPENDING_KEY_MESSAGE });
const seed = await BunkerClient.seedFromSignature(sig, passphrase);
```

Or restore from a backup string: `BunkerClient.seedFromBackup("bunkerseed1…")`.

### ERC-20s

Any ERC-20 works. The first shield of a token opens its pool (one extra
transaction); `shield` handles that and the approval for you.

```ts
await bunker.shield("0xTokenAddress", 1_000_000n, { signer: account });
await bunker.send("0xTokenAddress", 250_000n, "bunker1…");
console.log(await bunker.balances()); // every token you hold notes of
```

### Fees and progress

```ts
await bunker.relayerFee("BNB", parseEther("0.01")); // wei the relayer keeps for this unshield
await bunker.send("BNB", amt, to, {
  memo: "invoice 42",                                 // encrypted to the recipient
  onEvent: (e) => console.log(e.stage, e.message),    // proving → relaying → confirming → done
});
```

A send or unshield proves locally, posts the proof to the relayer, and
resolves with the transaction hash once it is mined. If the Merkle root the
proof used was pushed out of the contract's 128-root ring while proving, the
SDK re-syncs and proves once more before giving up.

## Launchpad

```ts
const lp = bunker.launchpad;

const tokens = await lp.list();                        // what has launched, newest first
const curve = await lp.curve(tokens[0].token);         // reserves, fee, graduation state at the current block
const q = await lp.quoteBuy(tokens[0].token, parseEther("0.05"));
console.log("you would receive", q.out, "tokens at", q.curve.tradeFeeBps, "bps");

// Private buy: one relayed transaction. The pool pays the curve through its exit
// hook and the curve hands the tokens straight back to the pool as a note of yours.
const r = await lp.buy(tokens[0].token, parseEther("0.05"), { slippageBps: 100n });
console.log(r.txHash);

// Private sell is the mirror image: the BNB comes back as a note in the same tx.
await lp.sell(tokens[0].token, 1_000_000n);

// Launch your own token from a public account (metadata is hosted by the indexer).
const token = await lp.launch({ name: "Bunker Cat", symbol: "BCAT", image: dataUrl, description: "…" }, account);
```

## Private swaps, pay-by-address, viewing keys

```ts
// Shielded BNB → shielded USDT on PancakeSwap V2, atomically, through SwapExit.
const q = await bunker.quoteSwap("BNB", parseEther("0.1"), USDT);
await bunker.swap("BNB", parseEther("0.1"), USDT, { slippageBps: 100n });

// Let anyone pay your plain 0x address privately: one public registration.
await bunker.register(account);
await bunker.send("BNB", parseEther("0.01"), "0xFriendWhoRegistered…");

// A watch-only mirror: sees every note and spend, signs nothing.
const mirror = await BunkerClient.connect({ viewingKey: bunker.viewingKey() });
await mirror.sync();
console.log(await mirror.balance("BNB"));
```

## Settling

New commitments wait in an on-chain queue until someone calls `drain()`; the
relayer's keeper does within seconds, and `bunker.ensureInserted()` hurries
it (with a `signer`, it drains itself if nobody else does). `balance()` reports
`amount` (spendable) and `queued` separately; `send`/`unshield` wait for the
queue when the spendable notes alone fall short.

## Reading the network

Every service is exposed as a typed client:

```ts
await bunker.indexer.health();          // scan progress, commitment count
await bunker.indexer.stats(30);         // shields / unshields per token, daily tx counts
await bunker.indexer.launch(token);     // one launch with its trades and fee votes
await bunker.relayer.info();            // fee policy, delay window, gas cap
await bunker.agents.health();           // the four fee-policy agents and their models
await bunker.agents.log(token);         // every vote and the reasoning behind it
```

The low-level pieces (`ShieldedWallet`, `MerkleTree`, `prove`, `transactCall`,
curve math, ABIs) are exported too for anyone who wants to run their own
relayer or indexer, or build a different wallet.

## Network

| | |
|---|---|
| chain | BNB Smart Chain (56) |
| protocol | v2, revision 1 |
| pool | `0x19D7Ae0287507A9A16E3F5c726E1d2dA62787A39` |
| launchpad | `0xC0016aFC627FF96041a64347485F58B4ed1DD94E` |
| swap exit | `0x7Ebe074b0378860C0f088ace26158Af737f05126` |
| timelock (governance) | `0x70c3898970E3D440cD94B16DDD72Dca46120C954` |
| v1 pool (read-only in this SDK, `bscV1`) | `0xD327D391Ba9f5924F4fD82AB0cd23A2b4F5812bF` |
| indexer | https://bunker-indexer.fly.dev |
| relayer | https://bunker-relayer.fly.dev |
| agents | https://bunker-agents.fly.dev |
| proving keys | https://bunkeronbnb.com/circuits/ |

Pass `overrides` to `connect` to use your own RPC, indexer or relayers. With
several `relayerUrls` the client picks the cheapest healthy one for the pool:

```ts
await BunkerClient.connect({ seed, overrides: { rpcUrl: "https://my-node", relayerUrls: ["https://my-relayer", "https://bunker-relayer.fly.dev"] } });
```

Proving artifacts (≈ 4 MB wasm, 24 MB and 45 MB zkeys) are downloaded on
first use and cached for the life of the client. Supply them yourself with
`artifacts: { transact2x3: { wasm, zkey }, transact4x3: { wasm, zkey } }`
(bytes or URLs), or an `artifactLoader(circuit)` callback, to skip the download.

## Caveats

The protocol is new and unaudited; read [SECURITY.md](../SECURITY.md) and
[audit/KNOWN_ISSUES.md](../audit/KNOWN_ISSUES.md) before moving real value.
Amount and timing correlations are not hidden by cryptography.

MIT.
