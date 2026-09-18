// SPEC 9: the window (9.1), the outputs (9.2), scaling to a template value (9.3). Pure
// functions of the shares, the descriptor and the owed state, so any verifier reproduces them.

// 9.1: the most recent credited shares whose weights reach `need`, oldest dropped first
// With `maxAge` (seconds) set, a share older than `now - maxAge` is never in the window however
// light the recent shares are: a miner that left hours ago is not paid by a window that could
// not fill without it. A share with no `at` never ages out. `now` is the split's time and is
// recorded in the snapshot, so a replay reproduces the same window.
export function windowOf(shares, need, { maxAge = 0, now = null } = {}) {
  const cutoff = maxAge > 0 && now != null ? now - maxAge : -Infinity;
  let w = 0, i = shares.length;
  while (i > 0 && w < need && (shares[i - 1].at ?? Infinity) >= cutoff) { i--; w += shares[i].weight; }
  return { shares: shares.slice(i), weight: w, from: i };
}

// 9.2 for a value V. Returns { outputs: [{ master | script, value }], owed: { master: sats }, W, fee }.
export function computeSplit(window, V, p, owedIn = {}) {
  const minPayout = p.minPayout ?? 546, maxOutputs = p.maxOutputs ?? 512;
  // step 1: weight per master
  const w = new Map(); for (const s of window) w.set(s.master, (w.get(s.master) ?? 0) + s.weight);
  const W = [...w.values()].reduce((a, b) => a + b, 0);
  // step 2: the fee
  const fee = Math.floor(V * (p.feeBps ?? 0) / 10000);
  let R = V - fee;
  // step 3: owed first, ascending pubkey, each its own output when at least minPayout
  const owed = { ...owedIn }, owedOut = [];
  for (const m of Object.keys(owed).sort()) {
    if (R <= 0) break;
    const pay = Math.min(owed[m], R); if (pay < minPayout) continue;
    owedOut.push({ master: m, value: pay }); R -= pay; owed[m] -= pay; if (owed[m] === 0) delete owed[m];
  }
  // step 4: proportional shares of what is left
  const pays = [...w].map(([master, wi]) => ({ master, value: W > 0 ? Math.floor(R * wi / W) : 0, wi }));
  // step 5: drop below minPayout, redistribute their sum over the rest by weight, once
  const kept = pays.filter((x) => x.value >= minPayout), dropped = pays.filter((x) => x.value < minPayout);
  const extra = dropped.reduce((a, x) => a + x.value, 0), keptW = kept.reduce((a, x) => a + x.wi, 0);
  for (const x of kept) x.value += keptW > 0 ? Math.floor(extra * x.wi / keptW) : 0;
  // step 6: order, cap at maxOutputs less the owed outputs, the rest become owed
  kept.sort((a, b) => b.value - a.value || (a.master < b.master ? -1 : 1));
  const cap = Math.max(0, maxOutputs - owedOut.length);
  for (const x of kept.slice(cap)) owed[x.master] = (owed[x.master] ?? 0) + x.value;
  const paid = kept.slice(0, cap);
  // step 7: dust to the first window output, or the first owed output when the window pays none
  const dust = R - paid.reduce((a, x) => a + x.value, 0) - kept.slice(cap).reduce((a, x) => a + x.value, 0);
  if (paid.length) paid[0].value += dust; else if (owedOut.length) owedOut[0].value += dust;
  // step 8: owed, window, fee
  const outputs = [...owedOut, ...paid.map((x) => ({ master: x.master, value: x.value }))];
  if (fee > 0 && p.feeScript) outputs.push({ script: p.feeScript, value: fee });
  return { outputs, owed, W, fee };
}

// 9.3: the same list scaled to a gateway's own template value V, order kept, remainder to the first
export function scaleSplit(outputs, V) {
  const sum = outputs.reduce((a, [, v]) => a + v, 0);
  if (sum === V || sum === 0) return outputs.map(([s, v]) => [s, v]);
  const scaled = outputs.map(([spk, v]) => [spk, Math.floor(v * V / sum)]);
  scaled[0][1] += V - scaled.reduce((a, [, v]) => a + v, 0);
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
