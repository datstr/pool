// A datstr coordinator from the spec (https://datstr.com/spec/): identities (4), share
// verification and weight (8), assignments (8.4), the split (9), documents and ledgers (11),
// transport (11.1). Chain questions go to a node client (lib/chain.mjs); no full node.
import { windowOf, computeSplit, scaleSplit, difficultyOf, targetOf, meets } from './lib/split.mjs';
import { makeSigner } from './lib/nostr.mjs';

export const KIND = { share: 23400, ack: 23401, assignment: 23402, split: 23403, pool: 33400, miner: 33401, delegation: 33402 };
export const DEFAULTS = {
  feeBps: 0, feeScript: null, windowMultiple: 2, windowMinWeight: 0, minDifficulty: 1, startDifficulty: 1, vardiffSeconds: 10, assignmentGrace: 120, maxDifficulty: 1e8,
  minPayout: 546, maxOutputs: 512, staleDepth: 3, splitDelayMs: 500,
  maxConnections: 256, maxPerAddress: 16, maxMessageBytes: 4 << 20, maxMessagesPerSecond: 500, helloTimeoutMs: 15_000,
};
const WL = 'https://w3id.org/webledgers', DATSTR_CTX = 'https://datstr.com/spec/context.jsonld';
const now = () => Math.floor(Date.now() / 1000);

export class Pool {
  // store: { read(name) -> text|null, append(name, line), write(name, text) }
  constructor({ engine, chain, key, store, params = {}, endpoints = {}, log = () => {} }) {
    const { k, pow, hash } = engine;
    Object.assign(this, { k, pow, hash, engine, chain, key, store, log, endpoints });
    this.nostr = makeSigner(engine);
    this.pubkey = this.nostr.pubkeyOf(key);
    this.chainId = k.network;
    this.params = { ...DEFAULTS, ...Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v))) };
    this.masters = new Map(); this.workers = new Map(); this.shares = []; this.seen = new Set();
    this.assignments = new Map(); this.assignmentsByMaster = new Map(); this.receipts = 0;
    this.splits = new Map(); this.blocks = []; this.pendingBlocks = []; this.owed = {}; this.paid = new Map();
    this.clients = new Set(); this.byAddress = new Map(); this.lastRetarget = 0; this.started = Date.now(); this.recentReceipts = [];
    this.stats = { shares: 0, receipts: 0, rejected: 0, blocks: 0, byCode: {}, refusedConnections: 0, droppedConnections: 0 };
  }
  lines(name) { return (this.store.read(name) ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  async start() {
    for (const m of this.lines('masters.jsonl')) this.masters.set(m.pubkey, m);
    for (const d of this.lines('delegations.jsonl')) this.workers.set(d.worker, d);
    for (const s of this.lines('shares.jsonl')) { this.shares.push(s); this.seen.add(s.hash); }
    for (const a of this.lines('assignments.jsonl')) this.addAssignment(a);
    for (const r of this.lines('receipts.jsonl')) { this.seen.add(r.hash); this.receipts++; }
    for (const b of this.lines('blocks.jsonl')) { this.blocks.unshift(b); if (!b.onChain) this.pendingBlocks.push(b); }
    try { this.owed = JSON.parse(this.store.read('owed.json') ?? '{}'); } catch { this.owed = {}; }
    try { for (const [a, v] of Object.entries(JSON.parse(this.store.read('paid.json') ?? '{}'))) this.paid.set(a, v); } catch {}
    this.descriptor = this.nostr.sign(this.key, { kind: KIND.pool, tags: [['d', this.chainId]], content: { chain: this.chainId, ...this.params, endpoints: this.endpoints } });
    this.store.write('pool.json', JSON.stringify(this.descriptor, null, 1));
    this.chain.onTip((t) => this.onTip(t));
    this.timer = setInterval(() => this.retargetAssignments().catch((e) => this.log(`retarget: ${e.message}`)), 5000);
    this.log(`pool ${this.pubkey.slice(0, 16)}… on ${this.chainId}: ${this.shares.length} shares, ${this.masters.size} masters, ${this.blocks.length} blocks; node at ${this.chain.height}`);
    await this.onTip({ height: this.chain.height, hash: this.chain.hash });
  }

  // --- the tip and the split (9) ---
  networkDifficulty() { const h = this.chain.headers[this.chain.height]; if (!h) return 0; return difficultyOf(this.k.codec.expandCompact(h.bits).toString(16).padStart(64, '0')); }
  need() { return Math.max(this.params.windowMultiple * this.networkDifficulty(), this.params.windowMinWeight); }
  async onTip({ height }) {
    await this.checkPendingBlocks();
    const next = height + 1;
    if (this.splits.has(next)) return;
    await new Promise((r) => setTimeout(r, this.params.splitDelayMs));
    if (this.chain.height !== height) return; // moved again meanwhile
    await this.issueSplit(next);
  }
  async issueSplit(height) {
    const need = this.need(), win = windowOf(this.shares, need);
    const V = this.k.blocks.subsidy(height);
    const r = computeSplit(win.shares, V, this.params, this.owed);
    const outputs = r.outputs.map((o) => [o.script ?? this.masters.get(o.master)?.payout, o.value]).filter(([s]) => s);
    const seqs = win.shares.map((s) => s.seq);
    const content = { chain: this.chainId, height, outputs, window: { from: seqs[0] ?? null, to: seqs.at(-1) ?? null, weight: win.weight, need }, owed: Object.entries(r.owed) };
    const ev = this.nostr.sign(this.key, { kind: KIND.split, tags: [['chain', this.chainId], ['h', String(height)]], content });
    const split = { height, event: ev, outputs, owedBefore: { ...this.owed }, owedAfter: r.owed, sharesUpTo: this.shares.length, win };
    this.splits.set(height, split);
    for (const h of [...this.splits.keys()]) if (h < height - 50) this.splits.delete(h);
    const perMaster = {}; for (const s of win.shares) perMaster[s.master] = (perMaster[s.master] ?? 0) + s.weight;
    this.store.write(`snapshots/${height}.json`, JSON.stringify({ '@context': DATSTR_CTX, '@type': 'datstr:LedgerSnapshot', chain: this.chainId, coordinator: this.pubkey, height, split: ev.id, outputs, sharesUpTo: split.sharesUpTo, window: { fromSeq: seqs[0] ?? null, toSeq: seqs.at(-1) ?? null, weight: win.weight, shares: win.shares.map((s) => s.id) }, need, perMaster, tipValue: V, owedBefore: split.owedBefore, owedAfter: r.owed, at: now() }, null, 1));
    this.writeLedgers(height, win, r, outputs, ev.id);
    this.log(`split h${height}: ${outputs.length} outputs from ${win.shares.length} shares (weight ${win.weight} of ${need}), value ${V}`);
    this.broadcast({ type: 'split', event: ev });
  }
  did(pk) { return `did:nostr:${pk}`; }
  addressOf(spk) { try { return this.k.script.classify(spk).address ?? spk; } catch { return spk; } }
  ledger(name, height, entries, extra = {}) {
    return JSON.stringify({ '@context': [WL, DATSTR_CTX], type: 'WebLedger', id: `${this.endpoints.http ?? ''}ledgers/${name}.json`, chain: this.chainId, coordinator: this.did(this.pubkey), height, ...extra, entries: entries.map(([url, amount]) => ({ type: 'Entry', url, amount })) }, null, 1);
  }
  writeLedgers(height, win, r, outputs, splitId) {
    const perMaster = {}; for (const s of win.shares) perMaster[s.master] = (perMaster[s.master] ?? 0) + s.weight;
    this.store.write('ledgers/window.json', this.ledger('window', height, Object.entries(perMaster).map(([m, w]) => [this.did(m), w]), { currency: 'share' }));
    const byScript = new Map(); for (const [spk, v] of outputs) byScript.set(spk, (byScript.get(spk) ?? 0) + v);
    const masterOf = new Map([...this.masters.values()].map((m) => [m.payout, m.pubkey]));
    const splitEntries = [...byScript].map(([spk, v]) => [masterOf.has(spk) ? this.did(masterOf.get(spk)) : `bitcoin:${this.addressOf(spk)}`, v]);
    const splitDoc = this.ledger('split', height, splitEntries, { currency: 'sat', split: splitId });
    this.store.write('ledgers/split.json', splitDoc); this.store.write(`ledgers/split-${height}.json`, splitDoc);
    this.store.write('ledgers/owed.json', this.ledger('owed', height, Object.entries(r.owed).map(([m, v]) => [this.did(m), v]), { currency: 'sat' }));
  }
  writePaid(height) {
    this.store.write('ledgers/paid.json', this.ledger('paid', height, [...this.paid].map(([a, v]) => [`bitcoin:${a}`, v]), { currency: 'sat' }));
    this.store.write('paid.json', JSON.stringify(Object.fromEntries(this.paid)));
  }

  // --- assignments (8.4) ---
  addAssignment(rec) { this.assignments.set(rec.id, rec); const l = this.assignmentsByMaster.get(rec.master) ?? []; l.push(rec); l.sort((a, b) => a.from - b.from || a.at - b.at); this.assignmentsByMaster.set(rec.master, l); }
  currentAssignment(master) { return this.assignmentsByMaster.get(master)?.at(-1) ?? null; }
  // 8.4: the latest issued at or before the share's signing time, the one before it within the
  // grace, or the first issued after it within the grace (clock skew); never anything later
  validAssignments(master, height, time) {
    const grace = this.params.assignmentGrace;
    const all = (this.assignmentsByMaster.get(master) ?? []).filter((a) => a.from <= height);
    const before = all.filter((a) => a.at <= time), latest = before.at(-1), prev = before.at(-2);
    const next = all.find((a) => a.at > time && a.at <= time + grace);
    const ok = [];
    if (latest) ok.push(latest); if (latest && prev && time <= latest.at + grace) ok.push(prev); if (next) ok.push(next);
    return ok;
  }
  issueAssignment(master, difficulty, why) {
    const target = targetOf(difficulty), from = Math.max(0, this.chain.height + 1);
    const ev = this.nostr.sign(this.key, { kind: KIND.assignment, tags: [['p', master], ['chain', this.chainId]], content: { chain: this.chainId, master, target, difficulty: difficultyOf(target), from } });
    const rec = { id: ev.id, master, target, from, at: ev.created_at, event: ev };
    this.addAssignment(rec); this.store.append('assignments.jsonl', JSON.stringify(rec));
    for (const c of this.clients) if (c.identities?.has(master)) c.send({ type: 'assignment', event: ev });
    this.log(`assignment for ${master.slice(0, 12)}…: difficulty ${difficultyOf(target)} from h${from} (${why})`);
    return rec;
  }
  // northbound vardiff: aim at one credited share per vardiffSeconds for every connected master,
  // measured on the shares credited since the master's current assignment
  async retargetAssignments() {
    const now = Math.floor(Date.now() / 1000);
    if (now - this.lastRetarget < 10) return; this.lastRetarget = now;
    const p = this.params, maxD = p.maxDifficulty ?? 1e8;
    const connected = new Set(); for (const c of this.clients) for (const m of c.identities ?? []) connected.add(m);
    for (const master of connected) {
      const cur = this.currentAssignment(master); if (!cur) continue;
      const since = now - cur.at; let n = 0;
      for (let i = this.shares.length - 1; i >= 0 && this.shares[i].at >= cur.at; i--) if (this.shares[i].master === master) n++;
      for (let i = this.recentReceipts.length - 1; i >= 0 && this.recentReceipts[i].at >= cur.at; i--) if (this.recentReceipts[i].master === master) n++; // receipts prove the rate too
      const d0 = difficultyOf(cur.target); let d;
      if (d0 >= maxD) d = Math.min(maxD, 1000);                              // a runaway: back to a level any ASIC produces shares at within a minute
      else if (n >= 200 && since >= 5) d = d0 * p.vardiffSeconds * n / since; // a flood: go straight to the measured rate
      else if (since < 60) continue;                                         // otherwise one step a minute
      else if (n === 0) d = since >= 120 ? d0 / 64 : d0;                    // nothing for two minutes: come down fast
      else d = d0 * p.vardiffSeconds * n / since;
      d = Math.min(d0 * 256, Math.max(d0 / 64, d)); d = Math.max(p.minDifficulty, Math.min(maxD, this.networkDifficulty() || Infinity, Number(d.toPrecision(3)))); // never above what a block takes, never below the pool's floor
      if (d / d0 > 1.4 || d / d0 < 0.7) await this.issueAssignment(master, d, `${n} shares in ${since} s`);
    }
  }

  // --- transport (11.1) ---
  broadcast(msg) { const s = JSON.stringify(msg); for (const c of this.clients) c.send(s); }
  connect(conn) {
    const p = this.params;
    const raw = conn.send.bind(conn); conn.send = (m) => { try { raw(typeof m === 'string' ? m : JSON.stringify(m)); } catch {} };
    const addr = (conn.remote ?? '').replace(/:\d+$/, ''), perAddr = this.byAddress.get(addr) ?? 0;
    const drop = (why) => { this.stats.refusedConnections++; conn.send({ type: 'error', error: why }); try { conn.close?.(); } catch {} };
    if (this.clients.size >= p.maxConnections) return drop(`too many connections (${p.maxConnections})`);
    if (perAddr >= p.maxPerAddress) return drop(`too many connections from ${addr} (${p.maxPerAddress})`);
    this.byAddress.set(addr, perAddr + 1); this.clients.add(conn); conn.identities = new Set();
    let tokens = p.maxMessagesPerSecond * 2, last = Date.now(), closed = false;
    const kick = (why) => { if (closed) return; closed = true; this.stats.droppedConnections++; conn.send({ type: 'error', error: why }); try { conn.close?.(); } catch {} };
    const helloTimer = setTimeout(() => { if (!conn.master) kick('no hello'); }, p.helloTimeoutMs);
    conn.onClose(() => { closed = true; clearTimeout(helloTimer); this.clients.delete(conn); const n = (this.byAddress.get(addr) ?? 1) - 1; if (n > 0) this.byAddress.set(addr, n); else this.byAddress.delete(addr); });
    const handle = async (text) => {
      if (closed) return;
      if (text.length > p.maxMessageBytes) return kick(`message over ${p.maxMessageBytes} bytes`);
      const t = Date.now(); tokens = Math.min(p.maxMessagesPerSecond * 2, tokens + (t - last) / 1000 * p.maxMessagesPerSecond); last = t;
      if (tokens < 1) return kick(`more than ${p.maxMessagesPerSecond} messages a second`); tokens -= 1;
      let m; try { m = JSON.parse(text); } catch { return conn.send({ type: 'error', error: 'bad json' }); }
      try {
        if (m?.type === 'hello') {
          const r = this.register(conn, m); if (r.error) return conn.send({ type: 'error', error: r.error });
          // SPEC 11.1: the hello is signed by the key the socket will sign shares with, fresh, for this endpoint
          let authPath = null; try { authPath = this.endpoints.ws ? new URL(this.endpoints.ws).pathname : null; } catch {}
          const bad = this.nostr.checkAuth(m.auth, { pubkey: r.worker ?? r.master, path: authPath, seen: this.authSeen ??= new Map() });
          if (bad) { this.stats.refusedConnections++; this.log(`gateway ${conn.remote ?? ''} refused: ${bad}`); return kick(bad); }
          conn.master = r.master; conn.worker = r.worker; conn.agent = m.agent ?? '';
          this.log(`gateway ${conn.remote ?? ''} hello: master ${r.master.slice(0, 16)}…${r.worker ? ` worker ${r.worker.slice(0, 16)}…` : ''} (${conn.agent})`);
          conn.send({ type: 'welcome', pool: this.descriptor, split: this.splits.get(this.chain.height + 1)?.event ?? null });
          return conn.send({ type: 'assignment', event: r.assignment });
        }
        if (!conn.master) return conn.send({ type: 'error', error: 'hello first' });
        if (m?.type === 'register') { const r = this.register(conn, m); if (r.error) return conn.send({ type: 'error', error: r.error }); conn.send({ type: 'registered', master: r.master, worker: r.worker ?? null }); return conn.send({ type: 'assignment', event: r.assignment }); }
        if (m?.type === 'share') return await this.share(conn, m.event);
        conn.send({ type: 'error', error: `unknown type ${m?.type}` });
      } catch (e) { this.log(`gateway ${conn.remote ?? ''}: ${e.message}`); conn.send({ type: 'error', error: e.message }); }
    };
    let chain = Promise.resolve();
    conn.onMessage((text) => { chain = chain.then(() => handle(text)).catch((e) => this.log(`gateway: ${e.message}`)); return chain; });
  }
  // a gateway's identities (4, 7): a signed miner descriptor, plus a delegation when a worker signs for a master
  register(conn, m) {
    const d = m.descriptor;
    if (!d || d.kind !== KIND.miner || !this.nostr.verify(d)) return { error: 'a signed miner descriptor (kind 33401) is needed' };
    const c = this.nostr.content(d); const payout = c?.payout?.[this.chainId] ?? c?.payout;
    if (typeof payout !== 'string' || !/^[0-9a-f]+$/i.test(payout)) return { error: 'descriptor has no payout script for this chain' };
    const known = this.masters.get(d.pubkey);
    if (!known || known.descriptor.created_at < d.created_at) { const rec = { pubkey: d.pubkey, payout: payout.toLowerCase(), descriptor: d }; this.masters.set(d.pubkey, rec); this.store.append('masters.jsonl', JSON.stringify(rec)); }
    let worker = null;
    if (m.delegation) {
      const g = m.delegation;
      if (g.kind !== KIND.delegation || !this.nostr.verify(g) || g.pubkey !== d.pubkey) return { error: 'delegation must be kind 33402 signed by the descriptor\'s master' };
      const gc = this.nostr.content(g); const rule = gc?.chains?.[this.chainId];
      if (!/^[0-9a-f]{64}$/i.test(gc?.worker ?? '') || !rule) return { error: 'delegation names no worker for this chain' };
      if (!this.nostr.verifyConsent(g)) return { error: 'delegation carries no valid consent from the worker (SPEC 4)' };
      const rec = { worker: gc.worker.toLowerCase(), master: d.pubkey, expires: rule.expires ?? null, delegation: g };
      const old = this.workers.get(rec.worker);
      if (!old || old.delegation.created_at < g.created_at) { this.workers.set(rec.worker, rec); this.store.append('delegations.jsonl', JSON.stringify(rec)); }
      worker = rec.worker;
    }
    conn.identities.add(d.pubkey);
    const a = this.currentAssignment(d.pubkey) ?? this.issueAssignment(d.pubkey, this.params.startDifficulty, 'first assignment');
    return { master: d.pubkey, worker, assignment: a.event };
  }

  // --- verification (8.1), in order ---
  async verify(ev) {
    const fail = (code, detail) => ({ ok: false, code, detail });
    if (!ev || ev.kind !== KIND.share || !this.nostr.verify(ev)) return fail('sig');
    const c = this.nostr.content(ev); if (!c) return fail('content');
    const del = this.workers.get(ev.pubkey); const masterKey = del ? del.master : ev.pubkey; const master = this.masters.get(masterKey);
    if (!master) return fail('delegation-missing', del ? 'delegating master has no descriptor' : 'no miner descriptor or delegation for this key');
    if (del && del.expires != null && c.height > del.expires) return fail('delegation-expired', `expired at height ${del.expires}`);
    if (c.chain !== this.chainId) return fail('chain-unknown', c.chain);
    let header; try { header = this.k.codec.decode('BlockHeader', c.header); } catch (e) { return fail('header-decode', e.message); }
    if (header.height != null && header.height !== c.height) return fail('header-decode', 'height mismatch');
    // a share one height ahead of our node: the node may have the block already, ask before refusing
    if (c.height === this.chain.height + 2) { try { await this.chain.sync(); } catch {} }
    const tip = this.chain.height;
    if (!(c.height <= tip + 1 && c.height > tip + 1 - this.params.staleDepth)) return fail('stale', `height ${c.height}, next ${tip + 1}`);
    const prev = this.chain.hashAt(c.height - 1); if (!prev) return fail('stale', 'unknown height');
    if (header.prevBlockHash !== prev) return fail('stale', 'prev mismatch');
    let coinbase; try { coinbase = this.k.codec.decode('Transaction', c.coinbase); } catch (e) { return fail('coinbase-decode', e.message); }
    if (this.k.blocks.bip34Height(coinbase) !== c.height) return fail('coinbase-height');
    const cbTxid = this.k.codec.txid(coinbase);
    if (this.merkleRoot(cbTxid, c.branches ?? []) !== header.merkleRoot) return fail('merkle');
    const last = coinbase.outputs.at(-1);
    const expected = '6a20' + this.hash.bytesToHex(this.hash.taggedHash('datstr/share', this.hash.hexToBytes(ev.pubkey + '00'.repeat(32))));
    if (!last || last.value !== 0 || last.scriptPubKey !== expected) return fail('commitment');
    const hasWitness = coinbase.outputs.length >= 2 && coinbase.outputs.at(-2).scriptPubKey.startsWith('6a24aa21a9ed');
    const pays = coinbase.outputs.slice(0, coinbase.outputs.length - 1 - (hasWitness ? 1 : 0));
    if (c.split === 'solo') {
      if (pays.length !== 1 || pays[0].scriptPubKey !== master.payout) return fail('split', 'solo share must pay the master alone');
    } else {
      const split = [...this.splits.values()].find((s) => s.event.id === c.split);
      if (!split) return fail('split', 'unknown split');
      if (split.height !== c.height) return fail('split', 'split is for another height');
      if (split.outputs.length === 0) { if (pays.length !== 1 || pays[0].scriptPubKey !== master.payout) return fail('split', 'an empty split pays the master alone'); }
      else { const V = pays.reduce((a, o) => a + o.value, 0), want = scaleSplit(split.outputs, V); if (pays.length !== want.length || pays.some((o, i) => o.scriptPubKey !== want[i][0] || o.value !== want[i][1])) return fail('split', 'coinbase outputs differ from the split'); }
    }
    const d = this.pow.hashHeaderV2Detailed(header);
    if (!/^[0-9a-f]{64}$/i.test(c.target ?? '')) return fail('pow', 'no target');
    if (!meets(d.blake2b2, c.target)) return fail('pow', 'hash above the share target');
    let weight = 0, assignmentId = null;
    if (c.split !== 'solo') {
      const a = this.assignments.get(c.assignment ?? '');
      if (!a) return fail('assignment', 'unknown assignment');
      if (a.master !== masterKey) return fail('assignment', 'assignment is for another master');
      if (!this.validAssignments(masterKey, c.height, ev.created_at).includes(a)) return fail('assignment', 'assignment not valid for this height');
      if (c.target.toLowerCase() !== a.target) return fail('assignment', 'target differs from the assignment');
      weight = difficultyOf(a.target); assignmentId = a.id;
      if (weight < this.params.minDifficulty) return fail('difficulty-floor', `${weight} < ${this.params.minDifficulty}`);
    }
    if (this.seen.has(d.blockHash)) return fail('duplicate');
    // a block: the header passes every header rule of the chain, proof of work included, at its height
    const j = this.chain.judge(header, c.height);
    const isBlock = j.ok === true;
    return { ok: true, weight, master: masterKey, worker: ev.pubkey, hash: d.blockHash, isBlock, height: c.height, coinbaseTxid: cbTxid, splitId: c.split, assignment: assignmentId };
  }
  merkleRoot(cbTxid, branches) {
    const { dsha256, hexToBytes, bytesToHex } = this.hash;
    const rev = (h) => bytesToHex(hexToBytes(h).reverse());
    return branches.reduce((h, b) => rev(bytesToHex(dsha256(new Uint8Array([...hexToBytes(rev(h)), ...hexToBytes(rev(b))])))), cbTxid);
  }
  async share(conn, ev) {
    const r = await this.verify(ev);
    if (!r.ok) {
      this.stats.rejected++; this.stats.byCode[r.code] = (this.stats.byCode[r.code] ?? 0) + 1;
      this.log(`share ${ev?.id?.slice(0, 12)}… refused: ${r.code}${r.detail ? ' (' + r.detail + ')' : ''}`);
      return conn.send({ type: 'ack', event: this.nostr.sign(this.key, { kind: KIND.ack, tags: [['e', ev?.id ?? '']], content: { share: ev?.id ?? null, result: r.code, detail: r.detail ?? null, weight: 0 } }) });
    }
    this.store.write(`shares/${ev.id}.json`, JSON.stringify(ev));
    if (r.splitId === 'solo') { // a receipt (8.2): verified, kept, weight 0, never windowed
      const rec = { id: ev.id, master: r.master, worker: r.worker, height: r.height, hash: r.hash, at: now() };
      this.seen.add(r.hash); this.receipts++; this.stats.receipts++; this.store.append('receipts.jsonl', JSON.stringify(rec)); this.recentReceipts.push({ master: r.master, at: rec.at }); if (this.recentReceipts.length > 5000) this.recentReceipts.splice(0, 1000);
      conn.send({ type: 'ack', event: this.nostr.sign(this.key, { kind: KIND.ack, tags: [['e', ev.id]], content: { share: ev.id, result: 'ok', weight: 0, seq: null, receipt: true } }) });
      this.log(`receipt ${r.hash.slice(0, 16)}… h${r.height} master ${r.master.slice(0, 12)}… (solo)${r.isBlock ? ' BLOCK' : ''}`);
      if (r.isBlock) await this.block(ev, r);
      return;
    }
    const rec = { seq: this.shares.length + 1, id: ev.id, master: r.master, worker: r.worker, weight: r.weight, height: r.height, hash: r.hash, split: r.splitId, assignment: r.assignment, at: now() };
    this.shares.push(rec); this.seen.add(r.hash); this.stats.shares++; this.store.append('shares.jsonl', JSON.stringify(rec));
    conn.send({ type: 'ack', event: this.nostr.sign(this.key, { kind: KIND.ack, tags: [['e', ev.id]], content: { share: ev.id, result: 'ok', weight: r.weight, seq: rec.seq } }) });
    this.log(`share #${rec.seq} ${r.hash.slice(0, 16)}… h${r.height} master ${r.master.slice(0, 12)}… weight ${r.weight}${r.isBlock ? ' BLOCK' : ''}`);
    if (r.isBlock) await this.block(ev, r);
  }
  // a block: recorded now; whether it is on the chain is what the node says, re-checked at every tip
  async block(ev, r) {
    const split = r.splitId === 'solo' ? null : [...this.splits.values()].find((s) => s.event.id === r.splitId);
    const rec = { '@type': 'datstr:BlockRecord', chain: this.chainId, height: r.height, hash: r.hash, share: ev.id, master: r.master, coinbase: r.coinbaseTxid, split: r.splitId, relay: 'gateway (no node here)', onChain: this.chain.hasBlock(r.hash), at: now() };
    this.blocks.unshift(rec); this.stats.blocks++;
    this.store.append('blocks.jsonl', JSON.stringify(rec)); this.store.write(`blocks/${r.hash}.json`, JSON.stringify(rec, null, 1));
    if (rec.onChain) await this.settle(rec, split); else this.pendingBlocks.push(rec);
    this.log(`BLOCK h${r.height} ${r.hash} by ${r.master.slice(0, 12)}… ${rec.onChain ? 'on chain' : 'awaiting the node'}`);
  }
  async settle(rec, split) {
    if (split) { this.owed = split.owedAfter; this.store.write('owed.json', JSON.stringify(this.owed)); for (const [spk, v] of split.outputs) { const a = this.addressOf(spk); this.paid.set(a, (this.paid.get(a) ?? 0) + v); } this.writePaid(rec.height); }
  }
  async checkPendingBlocks() {
    const keep = [];
    for (const rec of this.pendingBlocks) {
      if (this.chain.hasBlock(rec.hash)) { rec.onChain = true; this.store.write(`blocks/${rec.hash}.json`, JSON.stringify(rec, null, 1)); await this.settle(rec, rec.split === 'solo' ? null : [...this.splits.values()].find((s) => s.event.id === rec.split)); this.log(`block h${rec.height} ${rec.hash.slice(0, 16)}… confirmed by the node`); }
      else if (this.chain.height < rec.height + 20) keep.push(rec);
    }
    this.pendingBlocks = keep;
  }

  // --- documents (11) ---
  snapshot() {
    const win = windowOf(this.shares, this.need());
    const perMaster = {}; for (const s of win.shares) perMaster[s.master] = (perMaster[s.master] ?? 0) + s.weight;
    const cut = now() - 600, recent = this.shares.filter((s) => s.at >= cut);
    return { version: 'datstr-pool/0.0.1', pubkey: this.pubkey, chain: this.chainId, node: this.chain.url, height: this.chain.height, hash: this.chain.hash, uptime_seconds: Math.floor((Date.now() - this.started) / 1000), params: this.params,
      stats: this.stats, shares_total: this.shares.length, receipts: this.receipts, shares_last_10min: recent.length, window: { shares: win.shares.length, weight: win.weight, need: this.need(), perMaster }, masters: this.masters.size, connections: this.clients.size,
      split: this.splits.get(this.chain.height + 1)?.event.id ?? null, blocks: this.blocks.slice(0, 20), owed: this.owed, network_difficulty: this.networkDifficulty() };
  }
  route(path) {
    const text = (name, type = 'application/x-ndjson') => [200, type, this.store.read(name) ?? ''];
    if (path === '/stats.json') return [200, 'application/json', JSON.stringify(this.snapshot(), null, 1)];
    if (path === '/pool.json') return [200, 'application/json', JSON.stringify(this.descriptor, null, 1)];
    for (const n of ['masters', 'shares', 'assignments', 'receipts', 'delegations', 'blocks']) if (path === `/${n}.jsonl`) return text(`${n}.jsonl`);
    if (path === '/ledgers' || path === '/ledgers/') return [200, 'application/ld+json', JSON.stringify({ '@context': DATSTR_CTX, type: 'datstr:Ledgers', coordinator: this.did(this.pubkey), chain: this.chainId, ledgers: ['window', 'split', 'owed', 'paid'].map((n) => `ledgers/${n}.json`) })];
    let m;
    if ((m = /^\/ledgers\/([a-z0-9-]+)\.json$/.exec(path))) { const t = this.store.read(`ledgers/${m[1]}.json`); return t ? [200, 'application/ld+json', t] : [404, 'application/json', '{"error":"no such ledger"}']; }
    if ((m = /^\/shares\/([0-9a-f]{64})\.json$/.exec(path))) { const t = this.store.read(`shares/${m[1]}.json`); return t ? [200, 'application/json', t] : [404, 'application/json', '{"error":"unknown share"}']; }
    if ((m = /^\/snapshots\/(\d+)\.json$/.exec(path))) { const t = this.store.read(`snapshots/${m[1]}.json`); return t ? [200, 'application/json', t] : [404, 'application/json', '{"error":"no snapshot"}']; }
    if ((m = /^\/blocks\/([0-9a-f]{64})\.json$/.exec(path))) { const t = this.store.read(`blocks/${m[1]}.json`); return t ? [200, 'application/json', t] : [404, 'application/json', '{"error":"unknown block"}']; }
    return null;
  }
}
