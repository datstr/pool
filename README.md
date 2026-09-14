# datstr/pool

A datstr coordinator written from the [spec](https://datstr.com/spec/) alone, and the first
that needs no full node. Every question about the chain is answered by a
[blaketestnode](https://github.com/bitcoin-blake/blaketestnode) over its HTTP API and tip
stream: the tip, the previous hash at a height, whether a hash is on the chain, and whether a
share's header is a valid block by the engine's own header rules. Templates never reach a
coordinator in datstr, and a block a share carries was already submitted by the gateway that
found it, so nothing here talks RPC.

It is the second implementation of the spec, kept apart from `datstr/spec`'s coordinator on
purpose: where the two disagree, the spec text is what gets fixed.

```
node serve.mjs --node http://127.0.0.1:3337 --network btc:testnet4-blake2b --port 3401 \
  --window-multiple 0 --window-min-weight 200 --min-difficulty 0.001 --start-difficulty 0.01
```

Gateways connect to `ws://host:3401/ws`. Documents are the ones section 11 lists, at the
same paths as the first coordinator, so `audit/replay.mjs` and the audit page from
`datstr/spec` replay this one unchanged. `/` is a status page.

- `pool.mjs` the coordinator: sections 4, 8, 8.4, 9, 11, 11.1
- `lib/split.mjs` the window, the outputs, scaling: section 9, written from the text
- `lib/chain.mjs` the chain through a blaketestnode
- `lib/nostr.mjs` signing and verification on the engine's curve
- `lib/engine.mjs` the bitcoin-kernel engine, local checkout in Node, jsDelivr in a browser
- `serve.mjs` the standalone server; a JSS plugin comes later

## Where the spec was thin

Written from the text alone, these are the places a second implementer had to decide.
Each is a candidate spec fix rather than a feature of this coordinator.

- **Owed balances (9.2 step 5).** "Paid first from the next block, before the window split"
  does not say whether an owed master who is also in the window gets one output or two,
  or in what order owed masters are paid when the value does not cover them all. Here:
  one output per master, owed plus window share, and owed paid in pubkey order.
- **The fee output.** Section 9.2 places the fee at step 2 but not in the output order of
  step 5. Here it is the last output.
- **Network difficulty for the window (9.1).** "The network difficulty of the coordinator's
  current template" assumes a template. Without one this coordinator uses the tip header's
  bits, which on testnet4 is the minimum-difficulty value between retargets.
- **Template value for the split (9.2).** Without a template the split is computed at the
  block subsidy for the height; the gateway scales it to its own value (9.3), so the
  outputs it mines are the same as they would be from any other V.
- **Is a share a block (8.1).** "Meets the network target" is judged here by running the
  chain's header rules on the share's header at its height, which is what a node does.
- **Relay.** The verifier "submits it to its own node as well" (8.1) is impossible without a
  node; the block record says so and whether the chain has the block is learned from the
  node the coordinator follows.
