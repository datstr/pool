// Nostr events: NIP-01 ids, BIP-340 signatures on the engine's curve, verification through
// the engine. The coordinator signs the pool descriptor, assignments, splits and acks.
export function makeSigner({ hash, nostr, secp }) {
  const { sha256, taggedHash, hexToBytes, bytesToHex } = hash;
  const { publicKeyFromPrivate, N } = secp;
  const big = (b) => b.reduce((a, x) => (a << 8n) | BigInt(x), 0n);
  const bytes32 = (n) => { const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 0xffn); n >>= 8n; } return out; };
  const cat = (...a) => { const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { out.set(x, p); p += x.length; } return out; };
  const pubkeyOf = (privHex) => bytesToHex(publicKeyFromPrivate(hexToBytes(privHex)).slice(1));
  function schnorrSign(msg32, privHex, aux = crypto.getRandomValues(new Uint8Array(32))) {
    let d = big(hexToBytes(privHex));
    const P = publicKeyFromPrivate(bytes32(d)); if (!P) throw new Error('bad private key');
    if (P[0] === 0x03) d = N - d;
    const px = P.slice(1);
    const t = bytes32(d ^ big(taggedHash('BIP0340/aux', aux)));
    let kk = big(taggedHash('BIP0340/nonce', cat(t, px, msg32))) % N; if (kk === 0n) throw new Error('zero nonce');
    const R = publicKeyFromPrivate(bytes32(kk)); if (R[0] === 0x03) kk = N - kk;
    const e = big(taggedHash('BIP0340/challenge', cat(R.slice(1), px, msg32))) % N;
    return cat(R.slice(1), bytes32((kk + e * d) % N));
  }
  const eventId = (ev) => bytesToHex(sha256(new TextEncoder().encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))));
  return {
    pubkeyOf,
    randomKey: () => bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    sign(privHex, { kind, tags = [], content = '', created_at = Math.floor(Date.now() / 1000) }) {
      const ev = { kind, pubkey: pubkeyOf(privHex), created_at, tags, content: typeof content === 'string' ? content : JSON.stringify(content) };
      ev.id = eventId(ev); ev.sig = bytesToHex(schnorrSign(hexToBytes(ev.id), privHex)); return ev;
    },
    verify: (ev) => { try { return nostr.verifyNostrEvent(ev); } catch { return false; } },
    content: (ev) => { try { return JSON.parse(ev.content); } catch { return null; } },
  };
}
