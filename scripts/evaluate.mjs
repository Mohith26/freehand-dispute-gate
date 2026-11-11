// Evaluation: this cycle at several targets, plus a coverage study over fresh
// simulated calibration windows and cycles with different overbilling rates.
// Usage: node scripts/evaluate.mjs   (writes data/results.json)
import { readFileSync, writeFileSync } from 'node:fs';
import * as G from '../src/gate.js';
import { makeWorld, freshWindow } from './generate.mjs';

export const ALPHAS = [0.01, 0.05, 0.1, 0.2];
export const STUDY = { windows: 200, badRates: [0.02, 0.05, 0.08, 0.12, 0.2], alphas: [0.05, 0.1] };

export function load(world) {
  const tr = G.unpackLite(world.train.lines);
  const cal = G.unpackLite(world.cal.lines).filter((l) => !l.ev);
  const all = G.unpackFull(world.test.lines);
  const grey = all.filter((l) => !l.ev);
  const m = G.fitModel(tr, world.train.ships, world.carriers.length, world.facilities.length);
  const cs = G.sortedScores(m, cal);
  return { tr, cal, all, grey, m, cs };
}

const r1 = (x) => Math.round(x * 10) / 10;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

export function cycleTable(D) {
  return ALPHAS.map((alpha) => {
    const g = G.runGate(D.m, D.cs, D.grey, alpha);
    const e = G.evaluate(D.grey, g.rows);
    const tol = G.evaluate(D.grey, G.toleranceRule(D.m, D.grey));
    const pl = G.evaluate(D.grey, G.perLineRule(D.cs, D.m, D.grey, alpha));
    const pack = (x) => ({ disputes: x.disputes, wrong: x.wrong, fdp: r4(x.fdp), caught: x.caught, recall: r4(x.recall), recovered: r1(x.recovered), wrongDollars: r1(x.wrongDollars), review: x.review });
    return { alpha, gate: pack(e), tolerance: pack(tol), perLine: pack(pl), bad: e.bad, overbilled: r1(e.overbilled) };
  });
}

export function coverageStudy(D, worldParams, n = STUDY.windows) {
  const world = makeWorld(worldParams.seed);
  const rows = [];
  for (let w = 0; w < n; w++) {
    const badRate = STUDY.badRates[w % STUDY.badRates.length];
    const { cal, test } = freshWindow(world, 7000 + w, badRate);
    const calG = cal.filter((l) => !l.ev), grey = test.filter((l) => !l.ev);
    const cs = G.sortedScores(D.m, calG);
    const row = { w, badRate };
    for (const a of STUDY.alphas) {
      const e = G.evaluate(grey, G.runGate(D.m, cs, grey, a).rows);
      const pl = G.evaluate(grey, G.perLineRule(cs, D.m, grey, a));
      row[`gate_${a}`] = r4(e.fdp); row[`recall_${a}`] = r4(e.recall); row[`n_${a}`] = e.disputes;
      row[`perline_${a}`] = r4(pl.fdp);
    }
    row.tolerance = r4(G.evaluate(grey, G.toleranceRule(D.m, grey)).fdp);
    rows.push(row);
  }
  const mean = (k, f = () => true) => { const xs = rows.filter(f).map((r) => r[k]); return r4(xs.reduce((s, x) => s + x, 0) / xs.length); };
  const summary = {};
  for (const a of STUDY.alphas) summary[a] = { gate: mean(`gate_${a}`), perLine: mean(`perline_${a}`), recall: mean(`recall_${a}`) };
  summary.tolerance = mean('tolerance');
  const byRate = STUDY.badRates.map((b) => {
    const f = (r) => r.badRate === b;
    const o = { badRate: b, tolerance: mean('tolerance', f) };
    for (const a of STUDY.alphas) { o[`gate_${a}`] = mean(`gate_${a}`, f); o[`perline_${a}`] = mean(`perline_${a}`, f); o[`recall_${a}`] = mean(`recall_${a}`, f); }
    return o;
  });
  return { windows: n, summary, byRate, rows };
}

export function headline(table, cov) {
  const t = table.find((r) => r.alpha === 0.05);
  return {
    alpha: 0.05,
    disputes: t.gate.disputes,
    wrong: t.gate.wrong,
    recovered: t.gate.recovered,
    overbilled: t.overbilled,
    recoveredShare: r4(t.gate.recovered / t.overbilled),
    toleranceFdp: t.tolerance.fdp,
    studyGateFdp: cov.summary[0.05].gate,
    studyToleranceFdp: cov.summary.tolerance,
    windows: cov.windows,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const world = JSON.parse(readFileSync(new URL('../data/world.json', import.meta.url)));
  const D = load(world);
  const table = cycleTable(D);
  const cov = coverageStudy(D, { seed: world.seed });
  const out = { generated_by: 'scripts/evaluate.mjs', cycle: world.months.test, greyLines: D.grey.length, verifiedLines: D.all.length - D.grey.length, table, coverage: { ...cov, rows: cov.rows.map(({ w, badRate, gate_0_05, ...r }) => ({ w, badRate, ...r })) }, headline: headline(table, cov) };
  writeFileSync(new URL('../data/results.json', import.meta.url), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out.headline), '\n', JSON.stringify(cov.summary), '\n', JSON.stringify(cov.byRate));
}
