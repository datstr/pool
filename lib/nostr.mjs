// Nostr events: NIP-01 ids, BIP-340 signatures on the engine's curve, verification through
// the engine. The coordinator signs the pool descriptor, assignments, splits and acks.
export function makeSigner({ hash, nostr, secp }) {
  const { sha256, taggedHash, hexToBytes, bytesToHex } = hash;
  const { publicKeyFromPrivate, verifySchnorr, N } = secp;
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
    verifySig: (msg32, sigHex, pubHex) => { try { return !!verifySchnorr(msg32, hexToBytes(sigHex), hexToBytes(pubHex)); } catch { return false; } },
    // SPEC 4: the worker's consent inside a delegation, BIP-340 over taggedHash("datstr/delegation", master ‖ worker)
    verifyConsent(delegation) {
      let c; try { c = JSON.parse(delegation.content); } catch { return false; }
      const worker = (c?.worker ?? '').toLowerCase();
      return /^[0-9a-f]{64}$/.test(worker) && /^[0-9a-f]{128}$/i.test(c?.consent ?? '') && this.verifySig(taggedHash('datstr/delegation', hexToBytes(delegation.pubkey + worker)), c.consent, worker);
    },
    // SPEC 11.1: a signed hello shaped like NIP-98 (kind 27235, u = endpoint dialled, method "hello"), fresh within 60 s, not replayed
    checkAuth(ev, { pubkey, path, seen, method = 'hello', now = Math.floor(Date.now() / 1000) }) {
      if (!ev || ev.kind !== 27235 || !this.verify(ev)) return 'auth: a signed kind 27235 event is needed';
      if (pubkey && ev.pubkey !== pubkey) return `auth: signed by ${ev.pubkey.slice(0, 16)}…, not the socket's worker ${pubkey.slice(0, 16)}…`;
      if (Math.abs(now - ev.created_at) > 60) return `auth: created_at ${ev.created_at} is outside the 60 s window`;
      const tag = (n) => ev.tags.find((t) => t[0] === n)?.[1];
      if (tag('method') !== method) return `auth: method must be ${method}`;
      let u; try { u = new URL(tag('u')); } catch { return 'auth: u must be the endpoint dialled'; }
      if (path && u.pathname !== path) return `auth: u names ${u.pathname}, this endpoint is ${path}`;
      if (seen) { for (const [id, t] of seen) if (now - t > 120) seen.delete(id); if (seen.has(ev.id)) return 'auth: replayed'; seen.set(ev.id, now); }
      return null;
    },
  };
}
