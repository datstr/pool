// What the coordinator asks about the chain, answered by a blaketestnode over its HTTP API and
// tip stream: no full node anywhere. Keeps the current retarget epoch of headers so a share's
// header can be judged with the engine's own header rules (difficulty, timestamps, proof of work).
export class NodeChain {
  constructor(k, url, { log = () => {}, interval = 2016 } = {}) { Object.assign(this, { k, url: url.replace(/\/$/, ''), log, interval }); this.headers = []; this.hashes = []; this.height = -1; this.listeners = new Set(); }
  async json(p) { const r = await fetch(`${this.url}${p}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); }
  async start() {
    const st = await this.json('/status.json');
    const epochStart = Math.floor(st.height / this.interval) * this.interval;
    for (let h = epochStart; h <= st.height; h++) await this.fetchHeader(h); // the node holds headers from its epoch start
    this.height = st.height; this.hash = st.hash;
    this.log(`chain: node at ${st.height} ${st.hash.slice(0, 16)}…, ${this.headers.filter(Boolean).length} headers held`);
    this.connect();
    return this;
  }
  async fetchHeader(h) { const d = await this.json(`/header/${h}`); this.headers[h] = d.header; this.hashes[h] = d.hash; return d; }
  // follow the node: on every block, refresh from the node's height (handles reorgs by re-reading)
  connect() {
    let ws; try { ws = new WebSocket(`${this.url.replace(/^http/, 'ws')}/tip`); } catch { return setTimeout(() => this.connect(), 5000); }
    ws.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.type === 'block' || d.type === 'tip') this.sync().catch((e) => this.log(`chain: ${e.message}`)); } catch {} };
    ws.onclose = () => setTimeout(() => this.connect(), 5000); ws.onerror = () => {};
    this.poll = setInterval(() => this.sync().catch(() => {}), 10_000);
  }
  sync() { return (this.syncing ??= this.#sync().finally(() => { this.syncing = null; })); }
  async #sync() {
    const st = await this.json('/status.json');
    if (st.height === this.height && st.hash === this.hash) return;
    // walk back to the last height whose hash we agree on, then forward
    let from = Math.min(st.height, this.height);
    while (from > 0) { const d = await this.fetchHeader(from); if (this.hashes[from] === d.hash && this.headers[from]) break; from--; }
    for (let h = from + 1; h <= st.height; h++) await this.fetchHeader(h);
    for (let h = st.height + 1; h <= this.height; h++) { delete this.headers[h]; delete this.hashes[h]; }
    const prev = this.height; this.height = st.height; this.hash = st.hash;
    for (const cb of this.listeners) Promise.resolve().then(() => cb({ height: st.height, hash: st.hash, prev })).catch((e) => this.log(`tip listener: ${e.message}`));
  }
  onTip(cb) { this.listeners.add(cb); }
  hashAt(h) { return this.hashes[h] ?? null; }
  hasBlock(hash) { return this.hashes.includes(hash); }
  // judge a header at height h with the engine's rules against our chain; true if it is a valid next block header
  judge(header, h) {
    const epochStart = Math.floor(h / this.interval) * this.interval;
    const prevContext = []; for (let i = epochStart; i < h; i++) { if (!this.headers[i]) return { ok: null, reason: `no header ${i}` }; prevContext.push(this.headers[i]); }
    const [v] = this.k.headers.validateChain([header], { startHeight: h, prevContext, now: Math.floor(Date.now() / 1000) + 7200 });
    return { ok: v.ok, failed: v.results.filter((r) => r.ok === false).map((r) => r.rule) };
  }
  // the network target for a block at height h, from the rule the engine applies to the header it is judging
  stop() { clearInterval(this.poll); }
}
