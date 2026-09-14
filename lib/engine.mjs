// The bitcoin-kernel engine (bitcoin-desktop/schema) with the Knots BLAKE2b overlay, from a
// local checkout in Node ($SCHEMA, default ~/bitcoin-desktop/schema) or from jsDelivr in a browser.
const isNode = typeof process !== 'undefined' && !!process.versions?.node;
export const BASE = isNode
  ? (process.env.SCHEMA ?? `${(await import('node:os')).homedir()}/bitcoin-desktop/schema`)
  : 'https://cdn.jsdelivr.net/gh/bitcoin-desktop/schema@v0.0.27';
const json = async (p) => isNode ? JSON.parse(await (await import('node:fs/promises')).readFile(`${BASE}/${p}`, 'utf8')) : (await fetch(`${BASE}/${p}`)).json();
export async function loadEngine(network) {
  const [{ createKernel }, { knotsBlake2b }, pow, hash, nostr, secp] = await Promise.all([
    import(`${BASE}/codec/kernel.js`), import(`${BASE}/codec/overlays/knots-blake2b.js`), import(`${BASE}/codec/pow/knots-header-v2.js`),
    import(`${BASE}/codec/hash.js`), import(`${BASE}/codec/nostr.js`), import(`${BASE}/codec/secp256k1.js`)]);
  const k = createKernel({ core: await json('schema/core.jsonld'), proof: await json('schema/proof.jsonld'), script: await json('schema/script.jsonld'), chain: await json('schema/chain.jsonld'), validate: await json('schema/validate.jsonld'), network, overlays: [knotsBlake2b(await json('schema/overlays/knots-blake2b.jsonld'))] });
  return { k, pow, hash, nostr, secp };
}
