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
