// Seeded synthetic world: one shipper, 8 carriers, 14 receiving facilities,
// 18 months of accessorial lines. Fee levels are drawn inside ranges published
// in public accessorial guides (see README "Data"): detention $50-100/hr after
// 2 free hours billed in 15-minute steps, liftgate $50-150, lumper $100-400 per
// unload, layover $150-300/day, TONU $150-350, redelivery $75-150, driver
// assist $50-150. Carrier and facility names are fictional.
//
// Usage: node scripts/generate.mjs   (writes data/world.json)
import { writeFileSync } from 'node:fs';
import { mulberry32, normal, TYPES } from '../src/gate.js';

export const MONTHS = [
  '2025-05', '2025-06', '2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12',
  '2026-01', '2026-02', '2026-03', '2026-04', // training window (12)
  '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', // calibration window (5)
  '2026-10', // this cycle
];
export const TRAIN = 12, CAL = 5;

const CARRIER_NAMES = ['Ridgeline Freight', 'Blue Mesa Transport', 'Harborline LTL', 'Cascade Carriers', 'Prairie Express', 'Summit Haul', 'Delta Coastal', 'Ironwood Logistics'];
const FAC = [
  // name, city, dock, lumper, median dwell (h), layover rate, driver-assist rate, weight
  ['DC-01 Joliet', 'Joliet, IL', 1, 1, 2.6, 0.020, 0.00, 1.4],
  ['DC-02 Ontario', 'Ontario, CA', 1, 1, 3.1, 0.030, 0.00, 1.3],
  ['DC-03 Atlanta', 'McDonough, GA', 1, 1, 2.2, 0.015, 0.00, 1.1],
  ['DC-04 Dallas', 'Lancaster, TX', 1, 0, 1.8, 0.010, 0.05, 1.0],
  ['DC-05 Allentown', 'Allentown, PA', 1, 1, 2.9, 0.025, 0.00, 1.0],
  ['DC-06 Reno', 'Sparks, NV', 1, 0, 1.4, 0.006, 0.08, 0.7],
  ['DC-07 Columbus', 'Groveport, OH', 1, 0, 1.6, 0.008, 0.04, 0.9],
  ['DC-08 Memphis', 'Olive Branch, MS', 1, 1, 2.4, 0.018, 0.00, 0.8],
  ['XD-09 Kent', 'Kent, WA', 1, 0, 1.2, 0.004, 0.10, 0.6],
  ['XD-10 Savannah', 'Pooler, GA', 1, 0, 2.0, 0.012, 0.03, 0.6],
  ['ST-11 Denver stores', 'Denver, CO', 0, 0, 0.9, 0.002, 0.30, 0.5],
  ['ST-12 Phoenix stores', 'Tempe, AZ', 0, 0, 0.8, 0.002, 0.35, 0.5],
  ['ST-13 Boston stores', 'Woburn, MA', 0, 0, 1.0, 0.003, 0.25, 0.4],
  ['CP-14 Co-packer', 'Elkhart, IN', 1, 0, 1.5, 0.006, 0.06, 0.5],
];
export const SHIPS_PER_MONTH = 2400;

function pick(rng, w) {
  const s = w.reduce((a, b) => a + b, 0);
  let r = rng() * s;
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
  return w.length - 1;
}
const U = (rng, lo, hi) => lo + (hi - lo) * rng();
const r2 = (x) => Math.round(x * 100) / 100;

export function makeWorld(seed = 20261101) {
  const rng = mulberry32(seed);
  const carriers = CARRIER_NAMES.map((name, i) => ({
    name,
    weight: [1.6, 1.3, 1.2, 1.0, 0.9, 0.8, 0.7, 0.5][i],
    // schedule (contracted) rates
    det: Math.round(U(rng, 50, 100) / 5) * 5, // $/hr after 2 free hours
    lift: Math.round(U(rng, 60, 150) / 5) * 5,
    lay: Math.round(U(rng, 150, 300) / 25) * 25,
    tonu: Math.round(U(rng, 150, 350) / 25) * 25,
    redel: Math.round(U(rng, 75, 150) / 5) * 5,
    assist: Math.round(U(rng, 50, 150) / 5) * 5,
  }));
  const facilities = FAC.map(([name, city, dock, lumper, dwell, lay, assist, weight]) => ({
    name, city, dock, lumper, dwell, lay, assist, weight,
    lumperPerPallet: lumper ? Math.round(U(rng, 7, 15) * 4) / 4 : 0, // ~$100-400 per 12-26 pallet unload
  }));
  return { seed, carriers, facilities };
}

// One month of VALID lines plus shipment counts and gate-timestamp dwell
// observations. Dwell at a facility on a given day shares a congestion effect,
// so trucks that DO have gate-in/gate-out timestamps that day say a lot about
// how long a truck without timestamps plausibly waited.
export function validMonth(world, rng, n = SHIPS_PER_MONTH) {
  const { carriers: C, facilities: F } = world;
  const cw = C.map((c) => c.weight), fw = F.map((f) => f.weight);
  const dayEff = F.map(() => Array.from({ length: 29 }, () => normal(rng)));
  const lines = [], ships = {}, obs = [];
  for (let s = 0; s < n; s++) {
    const c = pick(rng, cw), f = pick(rng, fw), car = C[c], fac = F[f];
    const key = `${c}|${f}`; ships[key] = (ships[key] || 0) + 1;
    const day = 1 + Math.floor(rng() * 28);
    const ev = rng() < 0.5 ? 1 : 0; // gate timestamps + signed receipts on file
    const dwell = fac.dwell * Math.exp(0.45 * dayEff[f][day] + 0.2 * normal(rng));
    if (ev) obs.push({ f, day, s, d: dwell });
    const jit = () => Math.exp(0.02 * normal(rng)); // fuel/rounding noise on unit price
    const add = (t, q, unit) => lines.push({ c, f, t, q, a: r2(q * unit * jit()), day, ship: s, ev });
    // detention: 2 free hours, billed in 15-minute steps, max 8h
    const billable = Math.min(8, Math.ceil(Math.max(0, dwell - 2) * 4) / 4);
    if (billable > 0 && rng() < 0.85) add(0, billable, car.det);
    if (fac.lumper && rng() < 0.9) add(1, 12 + Math.floor(rng() * 15), fac.lumperPerPallet);
    if (rng() < (fac.dock ? 0.004 : 0.7)) add(2, 1, car.lift);
    if (rng() < fac.lay) add(3, rng() < 0.9 ? 1 : 2, car.lay);
    if (rng() < 0.006) add(4, 1, car.tonu);
    if (rng() < 0.01) add(5, 1, car.redel);
    if (rng() < fac.assist) add(6, 1, car.assist);
  }
  for (const l of lines) { l.bad = 0; l.va = l.a; l.kind = ''; }
  return { lines, ships, obs, nShips: n };
}

// Corrupt a month: about `badRate` of the final lines are overbilled.
// Kinds the rule engine cannot settle without documents:
//   'Hours inflated'   detention hours padded by 1-4h
//   'Unearned charge'  accessorial billed for a service not performed
//                      (liftgate at a dock-equipped DC, lumper at a DC that
//                      does not use lumpers, detention on a fast day, driver
//                      assist at a DC with its own unloading crew)
// va = what should have been billed.
export function corrupt(world, rng, month, badRate) {
  const { carriers: C, facilities: F } = world;
  const lines = month.lines;
  const target = Math.max(1, Math.round(badRate * lines.length));
  const docked = F.map((f, i) => (f.dock ? i : -1)).filter((i) => i >= 0);
  const noLumper = F.map((f, i) => (f.lumper ? -1 : i)).filter((i) => i >= 0);
  const crewed = F.map((f, i) => (f.assist < 0.02 ? i : -1)).filter((i) => i >= 0);
  for (let made = 0; made < target; made++) {
    if (rng() < 0.45) {
      const cand = lines.filter((l) => l.t === 0 && !l.bad);
      const l = cand[Math.floor(rng() * cand.length)];
      const unit = l.a / l.q, extra = Math.round(U(rng, 1, 4) * 4) / 4;
      l.q = Math.min(10, l.q + extra); l.a = r2(l.q * unit); l.bad = 1; l.kind = 'Hours inflated';
    } else {
      const src = lines[Math.floor(rng() * lines.length)];
      const c = src.c, car = C[c], v = rng();
      let l;
      if (v < 0.3) l = { f: docked[Math.floor(rng() * docked.length)], t: 2, q: 1, a: car.lift };
      else if (v < 0.5) { const q = 12 + Math.floor(rng() * 15); l = { f: noLumper[Math.floor(rng() * noLumper.length)], t: 1, q, a: r2(q * U(rng, 8, 14)) }; }
      else if (v < 0.85) { const q = Math.round(U(rng, 1, 3) * 4) / 4; l = { f: src.f, t: 0, q, a: r2(q * car.det) }; }
      else l = { f: crewed[Math.floor(rng() * crewed.length)], t: 6, q: 1, a: car.assist };
      Object.assign(l, { c, day: src.day, ship: -1, ev: src.ev, bad: 1, va: 0, kind: 'Unearned charge' });
      lines.push(l);
    }
  }
  return month;
}

// Peer dwell feature for each line: gate-timestamped trucks at the same
// facility on the same day (excluding the line's own shipment).
function peers(month) {
  const by = new Map();
  for (const o of month.obs) {
    const k = o.f * 100 + o.day;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(o);
  }
  for (const l of month.lines) {
    const P = (by.get(l.f * 100 + l.day) || []).filter((o) => o.s !== l.ship);
    l.pk = P.length;
    l.pm = P.length ? Math.round((P.reduce((s, o) => s + Math.log(o.d), 0) / P.length) * 1000) / 1000 : 0;
  }
}

function stamp(lines, monthLabel) {
  lines.sort((a, b) => a.day - b.day || a.c - b.c || a.t - b.t);
  lines.forEach((l, i) => {
    l.id = `AC-${monthLabel.replace('-', '')}-${String(i + 1).padStart(4, '0')}`;
    l.inv = `INV-${40000 + (l.c + 1) * 1000 + ((l.day * 37 + i) % 997)}`;
  });
}

export const DEFAULT_BAD_RATE = 0.08;

export function generate(seed = 20261101, badRate = DEFAULT_BAD_RATE) {
  const world = makeWorld(seed);
  const rng = mulberry32(seed ^ 0x5eed);
  const months = MONTHS.map((label, i) => {
    const mo = validMonth(world, rng);
    if (i === MONTHS.length - 1) corrupt(world, rng, mo, badRate);
    peers(mo);
    stamp(mo.lines, label);
    return { label, ...mo };
  });
  return { world, months };
}
// a fresh calibration window + cycle from a different seed (for the coverage study)
export function freshWindow(world, seed, badRate) {
  const rng = mulberry32(seed);
  const cal = [];
  for (let i = 0; i < CAL; i++) { const mo = validMonth(world, rng); peers(mo); cal.push(...mo.lines); }
  const test = validMonth(world, rng); corrupt(world, rng, test, badRate); peers(test);
  return { cal, test: test.lines };
}

const packFull = (l) => [l.c, l.f, l.t, l.q, l.a, l.bad, l.va, l.kind, l.id, l.inv, l.day, l.ev, l.pk, l.pm];
const packLite = (l) => [l.c, l.f, l.t, l.q, l.a, l.ev, l.pk, l.pm];
function mergeShips(ms) {
  const out = {};
  for (const m of ms) for (const [k, n] of Object.entries(m.ships)) out[k] = (out[k] || 0) + n;
  return out;
}
export function pack(gen) {
  const { world, months } = gen;
  const train = months.slice(0, TRAIN), cal = months.slice(TRAIN, TRAIN + CAL), test = months[TRAIN + CAL];
  return {
    seed: world.seed,
    note: 'Synthetic. Fee ranges from public accessorial guides; names fictional. Generated by scripts/generate.mjs.',
    types: TYPES,
    carriers: world.carriers,
    facilities: world.facilities,
    months: { train: train.map((m) => m.label), cal: cal.map((m) => m.label), test: test.label },
    train: { ships: mergeShips(train), lines: train.flatMap((m) => m.lines).map(packLite) },
    cal: { lines: cal.flatMap((m) => m.lines).map(packLite) },
    test: { ships: test.ships, nShips: test.nShips, obs: test.obs.map((o) => [o.f, o.day, Math.round(o.d * 100) / 100]), lines: test.lines.map(packFull) },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = pack(generate());
  writeFileSync(new URL('../data/world.json', import.meta.url), JSON.stringify(out));
  console.log('train', out.train.lines.length, 'cal', out.cal.lines.length, 'test', out.test.lines.length,
    'bad', out.test.lines.filter((r) => r[5]).length);
}
