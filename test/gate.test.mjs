import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as G from '../src/gate.js';
import { generate, pack, makeWorld, freshWindow } from '../scripts/generate.mjs';
import { load, cycleTable, coverageStudy, headline } from '../scripts/evaluate.mjs';

const world = JSON.parse(readFileSync(new URL('../data/world.json', import.meta.url)));
const results = JSON.parse(readFileSync(new URL('../data/results.json', import.meta.url)));
const D = load(world);

test('mulberry32 is deterministic and in [0,1)', () => {
  const a = G.mulberry32(9), b = G.mulberry32(9);
  for (let i = 0; i < 1000; i++) { const x = a(); assert.equal(x, b()); assert.ok(x >= 0 && x < 1); }
});

test('committed world.json is exactly what the seeded generator produces', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(pack(generate()))), world);
});

test('conformal p-value matches the definition (1 + #>=) / (n + 1)', () => {
  const cal = [0.1, 0.5, 0.5, 2, 3];
  assert.equal(G.conformalP(cal, 0.5), (1 + 4) / 6);
  assert.equal(G.conformalP(cal, 9), 1 / 6);
  assert.equal(G.conformalP(cal, -1), 1);
  assert.equal(G.countGE(cal, 2.5), 1);
});

test('Benjamini-Hochberg matches a brute-force step-up on random inputs', () => {
  const rng = G.mulberry32(42);
  for (let rep = 0; rep < 300; rep++) {
    const m = 1 + Math.floor(rng() * 40), alpha = [0.01, 0.05, 0.1, 0.2][rep % 4];
    const p = Array.from({ length: m }, () => (rng() < 0.3 ? rng() * 0.01 : rng()));
    const { k, reject } = G.bh(p, alpha);
    const sorted = [...p].sort((x, y) => x - y);
    let kk = 0;
    for (let r = 1; r <= m; r++) if (sorted[r - 1] <= (alpha * r) / m) kk = r;
    assert.equal(k, kk);
    assert.equal(reject.filter(Boolean).length, kk);
    if (kk) { const thr = sorted[kk - 1]; p.forEach((x, i) => assert.equal(reject[i], x <= thr)); }
  }
});

test('property: conformal p-values of exchangeable valid lines are super-uniform', () => {
  // valid lines from fresh months, scored against a calibration window from the same world
  const w = makeWorld(world.seed);
  let below = 0, n = 0;
  for (let rep = 0; rep < 6; rep++) {
    const { cal, test } = freshWindow(w, 900 + rep, 0.0001);
    const cs = G.sortedScores(D.m, cal.filter((l) => !l.ev));
    for (const l of test) if (!l.bad && !l.ev) { n++; if (G.pValue(cs, l, G.score(D.m, l)) <= 0.1) below++; }
  }
  // P(p <= 0.1) <= 0.1 for valid lines; allow binomial noise (n ~ 7,000)
  assert.ok(below / n <= 0.1 + 3 * Math.sqrt(0.09 / n), `share ${below / n}`);
});

test('scores ignore under-billing: lowering billed hours never raises the score', () => {
  const det = D.grey.filter((l) => l.t === 0).slice(0, 200);
  for (const l of det) {
    const lower = { ...l, q: Math.max(0.25, l.q - 1), a: l.a * (Math.max(0.25, l.q - 1) / l.q) };
    assert.ok(G.score(D.m, lower) <= G.score(D.m, l) + 1e-12);
  }
});

test('peer-supported hours drop to zero when timestamped peers waited under 2 h', () => {
  const l = { c: 0, f: 0, t: 0, q: 3, a: 240, pk: 5, pm: Math.log(1.2) };
  assert.ok(G.peerDwell(D.m, l) < 2);
  assert.equal(G.peerHours(D.m, l), 0);
  const padded = { ...l, pm: Math.log(4.9) };
  assert.ok(G.score(D.m, l) > G.score(D.m, padded), 'billing 3 h on a 1.2 h day is more surprising than on a 4.9 h day');
});

test('a lumper at a facility that never uses lumpers is maximally surprising for its type', () => {
  const noLumper = world.facilities.findIndex((f) => !f.lumper);
  const l = { c: 0, f: noLumper, t: 1, q: 18, a: 190, pk: 0, pm: 0 };
  const p = G.pValue(D.cs, l, G.score(D.m, l));
  assert.equal(p, 1 / (D.cs[1].length + 1));
  assert.equal(G.reason(D.m, l), 'occurrence');
  assert.equal(G.claimAmount(D.m, l), 190);
});

test('runGate statuses are consistent with BH and the review threshold', () => {
  for (const a of [0.01, 0.05, 0.1, 0.2]) {
    const g = G.runGate(D.m, D.cs, D.grey, a);
    const disputes = g.rows.filter((r) => r.status === 'dispute');
    assert.equal(disputes.length, g.k);
    for (const r of g.rows) {
      if (r.status === 'dispute') assert.ok(r.p <= g.threshold + 1e-15);
      else assert.ok(r.p > g.threshold || g.k === 0 || r.p === g.threshold);
      if (r.status === 'review') assert.ok(r.p <= 0.05);
      assert.ok(r.claim >= 0 && r.claim <= D.grey[r.i].a + 1e-9);
    }
  }
});

test('more permissive target never selects fewer disputes (BH monotone in alpha)', () => {
  let prev = -1;
  for (const a of [0.01, 0.02, 0.05, 0.1, 0.2, 0.3]) {
    const k = G.runGate(D.m, D.cs, D.grey, a).k;
    assert.ok(k >= prev); prev = k;
  }
});

test('headline numbers in results.json are reproduced from the committed data', () => {
  const t = cycleTable(D);
  assert.deepEqual(t, results.table);
  const h = results.headline;
  assert.equal(h.disputes, 27);
  assert.equal(h.wrong, 2);
  assert.equal(h.disputes, t[1].gate.disputes);
  assert.equal(h.recovered, t[1].gate.recovered);
});

test('coverage study: mean false-dispute share stays under target, baselines do not', () => {
  const s = results.coverage.summary;
  assert.ok(s['0.05'].gate <= 0.05, `gate@5% ${s['0.05'].gate}`);
  assert.ok(s['0.1'].gate <= 0.1, `gate@10% ${s['0.1'].gate}`);
  assert.ok(s.tolerance > 0.5);
  assert.ok(s['0.05'].perLine > 0.05);
  for (const b of results.coverage.byRate) assert.ok(b['gate_0.05'] <= 0.05 && b['gate_0.1'] <= 0.1);
});

test('coverage study is reproducible (first 20 windows recomputed)', () => {
  const cov = coverageStudy(D, { seed: world.seed }, 20);
  for (let i = 0; i < 20; i++) {
    const a = cov.rows[i], b = results.coverage.rows[i];
    assert.equal(a['gate_0.05'], b['gate_0.05']);
    assert.equal(a.tolerance, b.tolerance);
  }
  assert.equal(headline(results.table, results.coverage).studyGateFdp, results.headline.studyGateFdp);
});

test('histogram counts every value once', () => {
  const v = [0, 0.1, 0.5, 0.99, 1, 2, -3];
  const h = G.histogram(v, 0, 1, 4);
  assert.equal(h.reduce((s, x) => s + x, 0), v.length);
});
