// SPEC 9: the window (9.1), the outputs (9.2), scaling to a template value (9.3). Pure
// functions of the shares, the descriptor and the owed state, so any verifier reproduces them.

// 9.1: the most recent credited shares whose weights reach `need`, oldest dropped first
export function windowOf(shares, need) {
  let w = 0, i = shares.length;
  while (i > 0 && w < need) { i--; w += shares[i].weight; }
  return { shares: shares.slice(i), weight: w, from: i };
}

// 9.2 for a template value V. Returns { outputs: [{ master | script, value }], owed: { master: sats } }.
export function computeSplit(window, V, p, owedIn = {}) {
  const feeBps = p.feeBps ?? 0, minPayout = p.minPayout ?? 546, maxOutputs = p.maxOutputs ?? 512;
  // step 1: weight per master
  const w = new Map(); for (const s of window) w.set(s.master, (w.get(s.master) ?? 0) + s.weight);
  const W = [...w.values()].reduce((a, b) => a + b, 0);
  // step 2: the fee
  const fee = Math.floor(V * feeBps / 10000);
  let R = V - fee;
  // owed balances are paid first, before the window split, until cleared
  const owed = { ...owedIn }, paidOwed = new Map();
  for (const [m, due] of Object.entries(owed).sort()) { if (R <= 0) break; const pay = Math.min(due, R); if (pay > 0) { paidOwed.set(m, pay); R -= pay; owed[m] = due - pay; if (owed[m] === 0) delete owed[m]; } }
  // step 3: proportional shares of what is left
  const pay = new Map(); for (const [m, wi] of w) pay.set(m, W > 0 ? Math.floor(R * wi / W) : 0);
  // step 4: drop below minPayout, redistribute their sum over the rest by weight, once
  const dropped = [...pay].filter(([, v]) => v < minPayout);
  if (dropped.length && dropped.length < pay.size) {
    const sum = dropped.reduce((a, [, v]) => a + v, 0); for (const [m] of dropped) pay.delete(m);
    const Wk = [...pay.keys()].reduce((a, m) => a + w.get(m), 0);
    for (const m of pay.keys()) pay.set(m, pay.get(m) + Math.floor(sum * w.get(m) / Wk));
  } else if (dropped.length === pay.size) pay.clear();
  // step 5: order by amount descending then pubkey, keep maxOutputs, the rest become owed
  let rows = [...pay].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const kept = rows.slice(0, maxOutputs), over = rows.slice(maxOutputs);
  for (const [m, v] of over) owed[m] = (owed[m] ?? 0) + v;
  // one output per master: owed paid plus window share
  const perMaster = new Map();
  for (const [m, v] of paidOwed) perMaster.set(m, v);
  for (const [m, v] of kept) perMaster.set(m, (perMaster.get(m) ?? 0) + v);
  const outputs = [...perMaster].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([master, value]) => ({ master, value }));
  if (fee > 0 && p.feeScript) outputs.push({ script: p.feeScript, value: fee });
  // step 6: rounding dust to the first output
  const total = outputs.reduce((a, o) => a + o.value, 0);
  if (outputs.length && V - total > 0) outputs[0].value += V - total;
  return { outputs, owed, W, fee };
}

// 9.3: the same list scaled to a gateway's own template value V, order kept, remainder to the first
export function scaleSplit(outputs, V) {
  const sum = outputs.reduce((a, [, v]) => a + v, 0);
  if (!outputs.length || sum === 0) return [];
  const scaled = outputs.map(([spk, v]) => [spk, Math.floor(v * V / sum)]);
  const rem = V - scaled.reduce((a, [, v]) => a + v, 0);
  scaled[0][1] += rem;
  return scaled;
}

// difficulty of a 32-byte big-endian target hex, the pool convention: 2^224 / target
export function difficultyOf(targetHex) {
  let n = 0n; for (let i = 0; i < 64; i += 2) n = (n << 8n) | BigInt(parseInt(targetHex.substr(i, 2), 16));
  return n === 0n ? Infinity : Number((1n << 224n) * 1000000n / n) / 1e6;
}
export function targetOf(difficulty) {
  let q = (1n << 224n) / BigInt(Math.round(difficulty * 1e6)) * 1000000n; if (q < 1n) q = 1n;
  return q.toString(16).padStart(64, '0').slice(-64);
}
// big-endian compare: hash at or below target
export function meets(hashHex, targetHex) { return hashHex.toLowerCase() <= targetHex.toLowerCase(); }
