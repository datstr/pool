// Differential test: this split against the reference implementation in datstr/spec, on random
// windows, owed states and descriptors. SPEC 9.2 says two verifiers produce the same list.
//   REF=~/remote/github.com/datstr/spec node test/split-diff.mjs
import { homedir } from 'node:os';
const REF = (process.env.REF ?? `${homedir()}/remote/github.com/datstr/spec`).replace(/^~/, homedir());
const A = await import('../lib/split.mjs'), B = await import(`${REF}/gateway/lib/split.mjs`);
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const masters = Array.from({ length: 12 }, (_, i) => `${i.toString(16).padStart(2, '0')}`.repeat(32));
let same = 0, diff = 0;
for (let n = 0; n < 20000; n++) {
  const shares = Array.from({ length: Math.floor(rnd() * 40) }, (_, i) => ({ master: masters[Math.floor(rnd() * (1 + rnd() * 11))], weight: Number((rnd() * 4).toFixed(3)), at: 1000 + i * Math.floor(rnd() * 300) }));
  const opts = rnd() < 0.5 ? { maxAge: Math.floor(rnd() * 4000), now: 1000 + 40 * 150 } : {};
  const need = rnd() * 40, win = A.windowOf(shares, need, opts), winB = B.windowOf(shares, need, opts);
  const V = Math.floor(rnd() * 6e9) + 1, p = { feeBps: rnd() < 0.3 ? Math.floor(rnd() * 500) : 0, feeScript: 'ab'.repeat(22), minPayout: [546, 1e6, 1e9][Math.floor(rnd() * 3)], maxOutputs: [512, 3, 1][Math.floor(rnd() * 3)] };
  const owed = {}; if (rnd() < 0.5) for (let i = 0; i < 4; i++) owed[masters[Math.floor(rnd() * 12)]] = Math.floor(rnd() * 3e9);
  const ra = A.computeSplit(win.shares, V, p, owed), rb = B.computeSplit(winB.shares, V, p, owed);
  const norm = (r) => JSON.stringify({ o: r.outputs.map((o) => [o.script ?? o.master, o.value]), owed: r.owed });
  if (norm(ra) === norm(rb) && JSON.stringify(win) === JSON.stringify(winB)) same++; else { diff++; if (diff <= 3) console.log('DIFF', JSON.stringify({ V, p, owed, win: win.shares }).slice(0, 300), '\n  A', norm(ra).slice(0, 200), '\n  B', norm(rb).slice(0, 200)); }
  const outs = ra.outputs.map((o) => [o.script ?? o.master, o.value]); const V2 = Math.floor(rnd() * 6e9) + 1;
  if (JSON.stringify(A.scaleSplit(outs, V2)) !== JSON.stringify(B.scaleSplit(outs, V2))) { diff++; if (diff <= 3) console.log('DIFF scale', V2); }
}
console.log(`${same} identical, ${diff} different`);
process.exit(diff ? 1 : 0);
