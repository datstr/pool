#!/usr/bin/env node
// Standalone coordinator: HTTP documents and the gateway WebSocket at /ws, chain from a blaketestnode.
//   node serve.mjs --node http://127.0.0.1:3337 --network btc:testnet4-blake2b [--port 3401] [--data ~/.datstr/pool]
//                  [--key-file ~/.datstr/pool-<network>.key] [--window-multiple 2] [--window-min-weight 0]
//                  [--min-difficulty 1] [--start-difficulty 1] [--fee-bps 0] [--fee-script hex] [--public http://host/path/]
import http from 'node:http';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { loadEngine, BASE } from './lib/engine.mjs';
import { NodeChain } from './lib/chain.mjs';
import { Pool } from './pool.mjs';
import { makeSigner } from './lib/nostr.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] === undefined || all[i + 1].startsWith('--') ? true : all[i + 1]] : []).filter(Boolean));
const home = (p) => p.replace(/^~/, homedir());
const NETWORK = args.network ?? 'btc:testnet4-blake2b', NODE = args.node ?? 'http://127.0.0.1:3337', PORT = Number(args.port ?? 3401), HOST = args.host ?? '127.0.0.1';
const DATA = home(args.data ?? `~/.datstr/pool-${NETWORK.replace(/[^a-z0-9]/gi, '-')}`);
const PUBLIC = (args.public ?? `http://${HOST}:${PORT}/`).replace(/\/?$/, '/');
const num = (v) => (v === undefined ? undefined : Number(v));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

mkdirSync(DATA, { recursive: true });
const store = {
  path: (n) => `${DATA}/${n}`,
  read: (n) => { try { return readFileSync(`${DATA}/${n}`, 'utf8'); } catch { return null; } },
  append: (n, line) => appendFileSync(`${DATA}/${n}`, line + '\n'),
  write: (n, text) => { const p = `${DATA}/${n}`; mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); },
};
const engine = await loadEngine(NETWORK);
const signer = makeSigner(engine);
const keyFile = home(args['key-file'] ?? `~/.datstr/pool-${NETWORK.replace(/[^a-z0-9]/gi, '-')}.key`);
if (!existsSync(keyFile)) { mkdirSync(dirname(keyFile), { recursive: true }); writeFileSync(keyFile, signer.randomKey() + '\n', { mode: 0o600 }); log(`new coordinator key written to ${keyFile}`); }
const key = readFileSync(keyFile, 'utf8').trim();

const chain = await new NodeChain(engine.k, NODE, { log }).start();
const pool = new Pool({ engine, chain, key, store, log, endpoints: { ws: PUBLIC.replace(/^http/, 'ws') + 'ws', http: PUBLIC },
  params: { windowMultiple: num(args['window-multiple']), windowMinWeight: num(args['window-min-weight']), minDifficulty: num(args['min-difficulty']), startDifficulty: num(args['start-difficulty']), feeBps: num(args['fee-bps']), feeScript: args['fee-script'] } });
await pool.start();

const { attachWsServer } = await import(`${BASE}/codec/ws.js`);
const cors = { 'access-control-allow-origin': '*' };
const server = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  if (path === '/' || path === '/index.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(new URL('./status.html', import.meta.url))); }
  if (path === '/gateway/lib/split.mjs' || path === '/lib/split.mjs') { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', ...cors }); return res.end(readFileSync(new URL('./lib/split.mjs', import.meta.url))); }
  const r = pool.route(path);
  if (!r) { res.writeHead(404, { 'content-type': 'application/json', ...cors }); return res.end('{"error":"not found"}'); }
  res.writeHead(r[0], { 'content-type': r[1], ...cors }); res.end(r[2]);
});
attachWsServer(server, (client, req) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws') return client.close();
  const conn = { remote: `${req.socket.remoteAddress}:${req.socket.remotePort}`, send: (s) => client.send(new TextEncoder().encode(s)), close: () => client.close(), onMessage: (cb) => client.onMessage((b) => cb(new TextDecoder().decode(b))), onClose: (cb) => client.onClose(cb) };
  pool.connect(conn);
});
server.listen(PORT, HOST, () => log(`datstr-pool ${pool.pubkey.slice(0, 16)}… on http://${HOST}:${PORT}/ (gateways: ${PUBLIC.replace(/^http/, 'ws')}ws), node ${NODE}`));
