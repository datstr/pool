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

Written from the text alone, these were the places a second implementer had to decide. All
are now stated in the spec (14 Sep 2026), and `test/split-diff.mjs` runs this split against
the reference implementation in `datstr/spec` on 20,000 random windows, owed states and
descriptors: identical.

- **Owed balances (9.2).** Paid first, in ascending pubkey order, each as its own output
  when at least `minPayout`, before the window split; the window's cap is reduced by them.
- **The fee output** is the last output; the list is owed, window, fee.
- **Network difficulty for the window (9.1)** is that of the next block: the template's
  target when there is one, else what the chain's rules require after the tip.
- **The value the split is computed at (9.2)** is the template value when there is one,
  else the subsidy at the height; it fixes proportions and rounding only.
- **A share is a block (8.1)** when its header is a valid next block header by the chain's
  rules; a template's target is the same test.
- **Relay (8.1).** A verifier without a node records the block and learns from the chain it
  follows whether the block is on it; the record's `relay` field says so.
- **Which assignment a share may name (8.4)** is relative to the share's signing time.
- **Delegations carry the worker's consent (4)** and the hello is signed (11.1, NIP-98 shape),
  since 15 Sep 2026; a delegation without consent binds nothing here either.
