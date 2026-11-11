// Dispute gate: core statistics (no DOM). Runs in the browser and in Node.
//
// Problem. An autonomous freight-audit agent files disputes with carriers on
// its own. For charges a contract rule can settle (wrong rate on a rate card,
// a duplicate line) that is safe. For the grey zone (detention hours with no
// gate-out timestamp, a lumper fee at a facility that rarely uses lumpers, a
// liftgate at a dock-equipped DC) the agent is guessing, and every wrong
// dispute costs carrier goodwill and analyst time. A fixed rule such as
// "dispute anything 25% over schedule" has a false-dispute rate that depends on
// how clean the month happens to be, so nobody can promise a number.
//
// Method. Conformal outlier testing with Benjamini-Hochberg (Bates, Candes,
// Lei, Romano, Sesia, "Testing for outliers with conformal p-values", Annals
// of Statistics 2023).
//   1. Fit a simple model of what a VALID accessorial line looks like on a
//      training window of settled lines: how often each charge type occurs at
//      each facility, and the usual unit price and quantity per carrier and
//      facility (additive log model with shrinkage).
//   2. Score every line by how surprising it is under that model:
//          s = max(0, log(network rate of type / rate at this facility)) + S_hours
//      where, for detention lines, S_hours = -log(empirical upper-tail
//      probability, among valid training detention lines, of: billed hours
//      minus the hours that same-day, same-facility trucks WITH gate
//      timestamps support). 0 below the median, so under-billing never
//      counts. Unit price is left to the contract rule engine.
//   3. A separate calibration window of lines that settled as valid gives
//      conformal p-values per charge type (Mondrian conformal):
//          p_j = (1 + #{cal scores of same type >= s_j}) / (n_cal,type + 1).
//      If valid lines this cycle are exchangeable with the calibration lines,
//      each p_j is super-uniform for a valid line, whatever the model is.
//   4. Benjamini-Hochberg at level alpha on this cycle's p-values picks the
//      auto-dispute set. Conformal p-values are PRDS, so BH controls the
//      false-dispute rate:  E[wrong disputes / disputes] <= alpha * m0 / m.
// A bad model only costs power (missed overcharges), never the guarantee.

export const TYPES = ['Detention', 'Lumper', 'Liftgate', 'Layover', 'TONU', 'Redelivery', 'Driver assist'];
export const UNIT_LABEL = ['hr', 'pallet', 'stop', 'day', 'order', 'attempt', 'stop'];

// ---------------------------------------------------------------- RNG
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function normal(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------- helpers
export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function mad(xs) {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

// Lines: { c: carrier index, f: facility index, t: type index, q: quantity, a: amount ($) }
// ships: { [`${c}|${f}`]: shipment count } over the same window as the lines.

// Additive log model  log(y) = g[t] + A[t][c] + B[t][f] + e,  fitted by a few
// rounds of shrunk backfitting (each group effect is sum(resid)/(n + k)).
function fitAdditive(lines, val, nC, nF, k = 8) {
  const T = TYPES.length;
  const g = new Array(T).fill(0), A = [], B = [], sd = new Array(T).fill(0.05);
  for (let t = 0; t < T; t++) { A.push(new Array(nC).fill(0)); B.push(new Array(nF).fill(0)); }
  const byT = Array.from({ length: T }, () => []);
  for (const l of lines) byT[l.t].push(l);
  for (let t = 0; t < T; t++) {
    const L = byT[t];
    if (!L.length) continue;
    g[t] = median(L.map((l) => Math.log(val(l))));
    for (let it = 0; it < 6; it++) {
      const sc = new Array(nC).fill(0), nc = new Array(nC).fill(0);
      for (const l of L) { sc[l.c] += Math.log(val(l)) - g[t] - B[t][l.f]; nc[l.c]++; }
      for (let c = 0; c < nC; c++) A[t][c] = sc[c] / (nc[c] + k);
      const sf = new Array(nF).fill(0), nf = new Array(nF).fill(0);
      for (const l of L) { sf[l.f] += Math.log(val(l)) - g[t] - A[t][l.c]; nf[l.f]++; }
      for (let f = 0; f < nF; f++) B[t][f] = sf[f] / (nf[f] + k);
    }
    const res = L.map((l) => Math.log(val(l)) - g[t] - A[t][l.c] - B[t][l.f]);
    sd[t] = Math.max(0.05, mad(res));
  }
  return { g, A, B, sd };
}

export function fitModel(lines, ships, nC, nF, opts = {}) {
  const a = opts.occPrior ?? 5;
  const T = TYPES.length;
  // occurrence: lines of type t at facility f per shipment at f, shrunk to the type-wide rate
  const shipF = new Array(nF).fill(0);
  for (const [key, n] of Object.entries(ships)) shipF[+key.split('|')[1]] += n;
  const totalShips = shipF.reduce((s, x) => s + x, 0);
  const cnt = Array.from({ length: T }, () => new Array(nF).fill(0));
  for (const l of lines) cnt[l.t][l.f]++;
  const occ = [], gRates = [];
  for (let t = 0; t < T; t++) {
    const gRate = (cnt[t].reduce((s, x) => s + x, 0) + 1) / (totalShips + 2);
    gRates.push(gRate);
    occ.push(cnt[t].map((n, f) => (n + a * gRate) / (shipF[f] + a)));
  }
  const price = fitAdditive(lines, (l) => l.a / l.q, nC, nF);
  const qty = fitAdditive(lines, (l) => l.q, nC, nF);
  const m = { occ, gRates, price, qty, nC, nF };
  // facility-level log dwell (mean of peer observations seen on training lines)
  const sumF = new Array(nF).fill(0), nObsF = new Array(nF).fill(0);
  for (const l of lines) if (l.pk > 0) { sumF[l.f] += l.pm; nObsF[l.f]++; }
  const all = sumF.reduce((s, x) => s + x, 0) / Math.max(1, nObsF.reduce((s, x) => s + x, 0));
  m.logDwellF = sumF.map((s, f) => (nObsF[f] ? s / nObsF[f] : all));
  // shrinkage strength (pseudo-observations of the facility mean) chosen on
  // the training detention lines by least squares of the log-dwell residual
  m.shrink = 2;
  let best = Infinity;
  for (const k of [0.1, 0.25, 0.5, 1, 2, 4]) {
    m.shrink = k;
    let ss = 0, n = 0;
    for (const l of lines) if (l.t === 0 && l.pk > 0) { ss += hoursResid(m, l) ** 2; n++; }
    if (n && ss / n < best) { best = ss / n; var bestK = k; }
  }
  m.shrink = bestK ?? 2;
  m.tailH = Array.from({ length: PK_BUCKETS }, () => []);
  // empirical residual distributions per type (training lines), used for
  // nonparametric upper-tail surprise: handles discrete quantities (layover
  // days, flat fees) where a Gaussian z-score would be meaningless.
  m.tailP = Array.from({ length: T }, () => []);
  m.tailQ = Array.from({ length: T }, () => []);
  for (const l of lines) {
    const r = resid(m, l);
    m.tailP[l.t].push(r.rp); m.tailQ[l.t].push(r.rq);
    if (l.t === 0) m.tailH[pkBucket(l.pk)].push(hoursResid(m, l));
  }
  for (let t = 0; t < T; t++) { m.tailP[t].sort((x, y) => x - y); m.tailQ[t].sort((x, y) => x - y); }
  for (const b of m.tailH) b.sort((x, y) => x - y);
  return m;
}

function resid(m, l) {
  const P = m.price, Q = m.qty, t = l.t;
  const muP = P.g[t] + P.A[t][l.c] + P.B[t][l.f];
  const muQ = Q.g[t] + Q.A[t][l.c] + Q.B[t][l.f];
  return { muP, muQ, rp: Math.log(l.a / l.q) - muP, rq: Math.log(l.q) - muQ };
}

// Billable detention hours that the day's gate-timestamped peers at the same
// facility support: shrink the peers' mean log dwell toward the facility's
// usual dwell (2 pseudo-observations), subtract the 2 free hours.
export const FREE_HOURS = 2;
export function peerDwell(m, l) {
  const k = m.shrink ?? 2;
  return Math.exp((l.pk * l.pm + k * m.logDwellF[l.f]) / (l.pk + k));
}
export function peerHours(m, l) {
  return Math.max(0, peerDwell(m, l) - FREE_HOURS);
}
// Residual on the log-dwell scale: billed hours imply a dwell of q + 2 hours;
// compare with the peer-supported dwell. Its spread depends on how many peers
// there were, so the empirical tail is kept per peer-count bucket.
export const PK_BUCKETS = 5;
export const pkBucket = (pk) => Math.min(PK_BUCKETS - 1, pk);
export function hoursResid(m, l) {
  return Math.log((l.q + FREE_HOURS) / peerDwell(m, l));
}

// -log of the smoothed empirical upper-tail probability of residual r among
// sorted training residuals; 0 at or below the median (only excess counts);
// past the largest training residual it keeps growing quadratically so that
// very large overcharges still rank above merely unusual ones.
export function tailSurprise(sorted, r, sd) {
  const n = sorted.length;
  if (!n) return 0;
  if (r <= sorted[(n - 1) >> 1]) return 0;
  const ge = countGE(sorted, r);
  const base = -Math.log((1 + ge) / (n + 1)) + Math.log(2); // 0 at the median
  const top = sorted[n - 1];
  return Math.max(0, base) + (r > top ? 0.5 * ((r - top) / sd) ** 2 : 0);
}

export function components(m, l) {
  const t = l.t;
  const { muP, muQ, rp, rq } = resid(m, l);
  const occ = Math.min(1, m.occ[t][l.f]);
  const isDet = t === 0, usePeers = isDet && l.pk > 0;
  const hb = isDet ? peerHours(m, l) : null;
  return {
    occ, muP, muQ, zp: rp / m.price.sd[t], zq: rq / m.qty.sd[t], usePeers, hb,
    // how many times rarer this charge type is at this facility than across
    // the network (a liftgate at a dock-equipped DC, a lumper where the DC
    // unloads with its own crew); a type that is rare everywhere (layover,
    // TONU) is not suspicious by itself
    sOcc: Math.max(0, Math.log(m.gRates[t] / occ)),
    sPrice: tailSurprise(m.tailP[t], rp, Math.max(0.05, m.price.sd[t])),
    sQty: tailSurprise(m.tailQ[t], rq, Math.max(0.25, m.qty.sd[t])),
    // detention only: billed hours beyond what gate-timestamped peers support
    sHours: isDet ? tailSurprise(m.tailH[pkBucket(l.pk)], hoursResid(m, l), 0.15) : 0,
  };
}
// Unit price is deliberately NOT part of the score: rate-card mismatches are
// settled deterministically by the existing contract rule engine. The gate is
// for what the documents cannot settle: was the service performed, and for how
// long.
export function score(m, l) {
  const k = components(m, l);
  return k.sOcc + k.sHours;
}

// What the model would have expected a valid line of this kind to bill, and
// the amount a dispute would claim back. If occurrence is the main reason the
// line is surprising, the whole line is claimed (charge not earned);
// otherwise the claim is the excess over typical unit price x typical quantity
// (each capped at the billed value).
export function expectedAmount(m, l) {
  const k = components(m, l);
  const unit = Math.min(l.a / l.q, Math.exp(k.muP));
  const qty = l.t === 0
    ? Math.min(l.q, Math.ceil(k.hb * 4) / 4)
    : Math.min(l.q, Math.exp(k.muQ + m.qty.sd[l.t]));
  return unit * qty;
}
export function claimAmount(m, l) {
  const k = components(m, l);
  if (k.sOcc > k.sHours) return l.a;
  return Math.max(0, l.a - expectedAmount(m, l));
}
export function reason(m, l) {
  const k = components(m, l);
  return k.sOcc > k.sHours ? 'occurrence' : 'hours';
}

// ---------------------------------------------------------------- conformal + BH
// Mondrian (type-conditional) calibration: one sorted score list per charge
// type, so a lumper line is compared only with valid lumper lines. p-values
// are then valid conditional on type, and independent across types.
export function sortedScores(m, calLines) {
  const by = TYPES.map(() => []);
  for (const l of calLines) by[l.t].push(score(m, l));
  for (const b of by) b.sort((a, c) => a - c);
  return by;
}
export function pValue(calSorted, l, s) {
  return conformalP(calSorted[l.t], s);
}
// number of calibration scores >= s (sorted ascending), by binary search
export function countGE(sorted, s) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid] >= s) hi = mid; else lo = mid + 1; }
  return sorted.length - lo;
}
export function conformalP(sorted, s) {
  return (1 + countGE(sorted, s)) / (sorted.length + 1);
}
// Benjamini-Hochberg: returns { k, threshold, reject: boolean[] }
export function bh(pvals, alpha) {
  const m = pvals.length;
  const idx = pvals.map((p, i) => i).sort((a, b) => pvals[a] - pvals[b]);
  let k = 0;
  for (let r = 1; r <= m; r++) if (pvals[idx[r - 1]] <= (alpha * r) / m) k = r;
  const threshold = k ? (alpha * k) / m : 0;
  const reject = new Array(m).fill(false);
  for (let r = 0; r < k; r++) reject[idx[r]] = true;
  return { k, threshold, reject };
}

// Full gate for one billing cycle.
// status: 'dispute' (BH rejection: auto-dispute), 'review' (p <= reviewP but not
// selected; sent to an analyst), 'approve' (everything else).
export function runGate(m, calSorted, lines, alpha, reviewP = 0.05) {
  const scores = lines.map((l) => score(m, l));
  const p = scores.map((s, i) => pValue(calSorted, lines[i], s));
  const B = bh(p, alpha);
  const rows = lines.map((l, i) => ({
    i, s: scores[i], p: p[i],
    status: B.reject[i] ? 'dispute' : p[i] <= reviewP ? 'review' : 'approve',
    claim: claimAmount(m, l),
  }));
  return { rows, k: B.k, threshold: B.threshold, m: lines.length };
}

// Truth-based evaluation (only possible on simulated data): lines carry
// bad (0/1) and va (the amount that should have been billed).
export function evaluate(lines, rows) {
  let D = 0, V = 0, R = 0, bad = 0, recovered = 0, wrongDollars = 0, claimed = 0, overbilled = 0;
  for (const r of rows) {
    const l = lines[r.i];
    if (l.bad) { bad++; overbilled += l.a - l.va; }
    if (r.status === 'dispute') {
      D++; claimed += r.claim;
      if (l.bad) { recovered += l.a - l.va; } else { V++; wrongDollars += r.claim; }
    }
    if (r.status === 'review') R++;
  }
  return {
    disputes: D, wrong: V, fdp: D ? V / D : 0, review: R,
    bad, caught: D - V, recall: bad ? (D - V) / bad : 0,
    recovered, overbilled, claimed, wrongDollars,
  };
}

// Baseline 1: tolerance rule used by many audit desks: dispute when the bill
// is more than `tol` above the expected amount, or the charge type is rare at
// the facility (occurrence < rareOcc).
export function toleranceRule(m, lines, tol = 0.25, rareOcc = 0.02) {
  return lines.map((l, i) => {
    const k = components(m, l);
    const exp = Math.exp(k.muP + k.muQ);
    const flag = l.a > (1 + tol) * exp || k.occ < rareOcc;
    return { i, status: flag ? 'dispute' : 'approve', claim: claimAmount(m, l) };
  });
}
// Baseline 2: per-line conformal threshold (each line tested at level alpha,
// no multiplicity correction).
export function perLineRule(calSorted, m, lines, alpha) {
  return lines.map((l, i) => {
    const p = pValue(calSorted, l, score(m, l));
    return { i, status: p <= alpha ? 'dispute' : 'approve', claim: claimAmount(m, l) };
  });
}

export function histogram(values, lo, hi, bins) {
  const h = new Array(bins).fill(0), w = (hi - lo) / bins;
  for (const v of values) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((v - lo) / w)));
    h[b]++;
  }
  return h;
}

// compact JSON packing: arrays of [c,f,t,q,a,(bad,va,kind,id,inv,day,ev)]
export function unpackLite(rows) {
  return rows.map((r) => ({ c: r[0], f: r[1], t: r[2], q: r[3], a: r[4], ev: r[5], pk: r[6], pm: r[7], bad: 0, va: r[4] }));
}
export function unpackFull(rows) {
  return rows.map((r) => ({
    c: r[0], f: r[1], t: r[2], q: r[3], a: r[4], bad: r[5], va: r[6], kind: r[7], id: r[8], inv: r[9], day: r[10], ev: r[11], pk: r[12], pm: r[13],
  }));
}
