// Dispute gate: UI. All statistics come from src/gate.js; every number on the
// page is computed in the browser from data/world.json, except the coverage
// study (200 simulated cycles), which is precomputed by scripts/evaluate.mjs
// into data/results.json and re-checked by the unit tests.
import * as G from './src/gate.js';

const LS = 'fh-dispute-gate-v1';
const ALPHAS = [0.01, 0.05, 0.1, 0.2];
const PAGE = 60;
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (x, d = 0) => '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const int = (x) => Math.round(x).toLocaleString('en-US');
const pct = (x, d = 1) => (100 * x).toFixed(d) + '%';
const fmtP = (p) => (p < 0.001 ? p.toExponential(1) : p.toFixed(p < 0.01 ? 4 : 3));
const hrs = (h) => (Math.round(h * 100) / 100).toString();
const day = (d) => `Oct ${d}`;
const ico = (n) => `<i data-lucide="${n}"></i>`;
// Freehand's status-pill glyph: a filled four-point spark with a small plus
const SPARK = '<svg class="spark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M13 4c.55 4.7 3.3 7.45 8 8-4.7.55-7.45 3.3-8 8-.55-4.7-3.3-7.45-8-8 4.7-.55 7.45-3.3 8-8z"/><path d="M5 2.5v4M3 4.5h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

let W = null, R = null, D = null, GATE = null, S = load();
let sel = -1;              // index into visible rows
let shown = PAGE;

function load() {
  const d = { savedAlpha: 0.05, overrides: {}, filed: {}, showTruth: false };
  try { return { ...d, ...(JSON.parse(localStorage.getItem(LS)) || {}) }; } catch { return d; }
}
function save() { try { localStorage.setItem(LS, JSON.stringify(S)); } catch { /* private mode */ } }

// ---------------------------------------------------------------- routing
function route() {
  const [path, qs] = (location.hash.slice(1) || '/queue').split('?');
  const p = new URLSearchParams(qs || '');
  const a = parseFloat(p.get('alpha'));
  return {
    view: ['queue', 'coverage', 'method'].includes(path.replace('/', '')) ? path.replace('/', '') : 'queue',
    alpha: ALPHAS.includes(a) ? a : S.savedAlpha,
    f: ['all', 'dispute', 'review', 'approve', 'filed'].includes(p.get('f')) ? p.get('f') : 'all',
    q: p.get('q') || '',
    line: p.get('line') || '',
  };
}
function go(patch, replace = false) {
  const r = { ...route(), ...patch };
  const p = new URLSearchParams();
  if (r.alpha !== S.savedAlpha) p.set('alpha', r.alpha);
  if (r.f !== 'all') p.set('f', r.f);
  if (r.q) p.set('q', r.q);
  if (r.line) p.set('line', r.line);
  const h = `#/${r.view}${p.toString() ? '?' + p : ''}`;
  if (replace) history.replaceState(null, '', h); else location.hash = h;
  if (replace) render();
}

// ---------------------------------------------------------------- data
async function boot() {
  renderLoading();
  try {
    const [w, r] = await Promise.all([fetch('data/world.json'), fetch('data/results.json')]);
    if (!w.ok || !r.ok) throw new Error(`HTTP ${w.status}/${r.status}`);
    W = await w.json(); R = await r.json();
    const tr = G.unpackLite(W.train.lines);
    const cal = G.unpackLite(W.cal.lines).filter((l) => !l.ev);
    const all = G.unpackFull(W.test.lines);
    const grey = all.filter((l) => !l.ev);
    const m = G.fitModel(tr, W.train.ships, W.carriers.length, W.facilities.length);
    const cs = G.sortedScores(m, cal);
    D = { tr, cal, all, grey, m, cs, verified: all.length - grey.length };
    render();
  } catch (e) {
    $('#app').innerHTML = `<div class="card err">${ico('triangle-alert')}<div><b>Could not load this cycle.</b></div><div>${esc(e.message)}</div><div style="margin-top:12px"><button class="btn sm" onclick="location.reload()">Retry</button></div></div>`;
    lucide.createIcons();
  }
}

function gateFor(alpha) {
  if (GATE && GATE.alpha === alpha) return GATE;
  const g = G.runGate(D.m, D.cs, D.grey, alpha);
  g.alpha = alpha;
  g.rows.forEach((r) => { r.l = D.grey[r.i]; r.k = G.components(D.m, r.l); r.exp = r.l.a - r.claim; r.why = G.reason(D.m, r.l); });
  GATE = g;
  return g;
}
const statusOf = (r) => (S.filed[r.l.id] ? 'filed' : S.overrides[r.l.id] || r.status);

// ---------------------------------------------------------------- render
function renderLoading() {
  $('#app').innerHTML = `
    <div class="ph"><div><div class="sk" style="width:220px;height:30px"></div><div class="sk" style="width:520px;height:16px;margin-top:10px"></div></div></div>
    <div class="grid-top"><div class="card sk" style="height:150px"></div><div class="card sk" style="height:150px"></div></div>
    <div class="card sk" style="height:420px"></div>`;
}

function render() {
  if (!D) return;
  const r = route();
  const g = gateFor(r.alpha);
  const rows = g.rows;
  const st = { dispute: 0, review: 0, approve: 0, filed: 0 };
  let claimD = 0;
  for (const x of rows) { const s = statusOf(x); st[s]++; if (s === 'dispute') claimD += x.claim; }
  const auto = rows.filter((x) => x.status === 'dispute');
  const autoClaim = auto.reduce((s, x) => s + x.claim, 0);
  const pending = rows.filter((x) => statusOf(x) === 'dispute');
  const nFiled = Object.keys(S.filed).length;

  $('#app').innerHTML = `
    <div class="ph">
      <div>
        <h1>Dispute gate</h1>
        <p>Accessorial charges the contract rules cannot settle (no gate-out timestamp, no signed lumper receipt). The Claim Resolution Agent files a dispute on its own only when the gate can guarantee the share of wrong disputes stays under your target.</p>
      </div>
      <div class="ph-actions">
        <button class="btn ghost" id="exp" aria-haspopup="menu" aria-expanded="false">${ico('download')}Export</button>
        <button class="btn pri" id="send" ${pending.length ? '' : 'disabled'}>${ico('send')}${pending.length ? `Send ${pending.length} dispute${pending.length > 1 ? 's' : ''}` : nFiled ? `${nFiled} filed` : 'Nothing to send'}</button>
        <div class="menu" id="expm" role="menu" hidden>
          <button role="menuitem" data-x="csv">${ico('sheet')}Queue as CSV</button>
          <button role="menuitem" data-x="json">${ico('braces')}Decisions + evidence (JSON)</button>
        </div>
      </div>
    </div>

    <div class="grid-top">
      <section class="card guard" aria-labelledby="gh">
        <h3 id="gh">False-dispute target</h3>
        <p class="sub">Studio guardrail. Benjamini-Hochberg on conformal p-values keeps the expected share of wrong disputes at or below this level.</p>
        <div class="guard-row">
          <div class="seg" role="group" aria-label="False-dispute target">${ALPHAS.map((a) => `<button data-a="${a}" aria-pressed="${a === r.alpha}">${a * 100}%</button>`).join('')}</div>
          ${r.alpha === S.savedAlpha ? `<span class="saved">${ico('circle-check')}Saved in Studio</span>` : `<button class="btn sm pri" id="saveA">Save ${r.alpha * 100}% to Studio</button>`}
        </div>
        <div class="sub">BH cut-off this cycle: p ≤ <span class="mono">${g.k ? fmtP(g.threshold) : '-'}</span> (${g.k} of ${int(g.m)} lines)</div>
      </section>
      <section class="card kpis" aria-label="Cycle summary">
        ${kpi('shield-check', '', 'Grey-zone lines', int(rows.length), `${int(D.verified)} more verified by documents`)}
        ${kpi('flag', '', 'Auto-dispute', int(auto.length), `${usd(autoClaim)} claimed`)}
        ${kpi('user-round-search', 'a', 'Analyst review', int(rows.filter((x) => x.status === 'review').length), 'p ≤ 0.05, not selected')}
        ${kpi('check', 'g', 'Approved', int(rows.filter((x) => x.status === 'approve').length), `${usd(rows.filter((x) => x.status === 'approve').reduce((s, x) => s + x.l.a, 0))} released`)}
      </section>
    </div>

    <div class="summary-bar"><span class="mk"><svg viewBox="0 0 32 32"><g stroke="#fff" stroke-width="3.6" stroke-linecap="round"><path d="M16 6v20M7.3 11l17.4 10M7.3 21l17.4-10"/></g></svg></span>
      <span><span class="t">Freehand Summary</span> In 200 simulated cycles the gate's wrong-dispute share averaged <b>${pct(R.coverage.summary['0.05'].gate)}</b> at a 5% target (${pct(R.coverage.summary['0.1'].gate)} at 10%). A 25%-over-typical tolerance rule averaged <b>${pct(R.coverage.summary.tolerance, 0)}</b>.</span></div>

    <section class="card tbl-card">
      <div class="tabs" role="tablist">
        <a role="tab" href="#/queue${r.alpha !== S.savedAlpha ? '?alpha=' + r.alpha : ''}" aria-selected="${r.view === 'queue'}">Queue</a>
        <a role="tab" href="#/coverage${r.alpha !== S.savedAlpha ? '?alpha=' + r.alpha : ''}" aria-selected="${r.view === 'coverage'}">Coverage study</a>
        <a role="tab" href="#/method${r.alpha !== S.savedAlpha ? '?alpha=' + r.alpha : ''}" aria-selected="${r.view === 'method'}">How it is calibrated</a>
      </div>
      ${r.view === 'queue' ? queueView(r, rows, st) : r.view === 'coverage' ? coverageView(r) : methodView(r, g)}
    </section>`;
  wire(r, g, rows);
  lucide.createIcons();
  if (r.line) openDrawer(r.line); else closeDrawer(false);
}

function kpi(icon, cls, l, v, s) {
  return `<div class="kpi"><div class="ic ${cls}">${ico(icon)}</div><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
}

const ST = {
  dispute: ['bad', 'x', 'Auto-dispute'],
  review: ['rev', 'eye', 'Analyst review'],
  approve: ['ok', 'check', 'Approved'],
  filed: ['filed', 'send', 'Filed'],
};
function pill(s) { const [c, , t] = ST[s]; return `<span class="pill ${c}">${SPARK}${t}</span>`; }
function dot(s) { const [c, i] = ST[s]; return `<span class="dot ${c}">${ico(i)}</span>`; }

function visibleRows(r, rows) {
  const q = r.q.trim().toLowerCase();
  return rows
    .filter((x) => r.f === 'all' || statusOf(x) === r.f)
    .filter((x) => !q || [x.l.id, x.l.inv, W.carriers[x.l.c].name, W.facilities[x.l.f].name, G.TYPES[x.l.t]].some((s) => s.toLowerCase().includes(q)))
    .sort((a, b) => a.p - b.p || b.s - a.s || b.l.a - a.l.a);
}

function queueView(r, rows, st) {
  const vis = visibleRows(r, rows);
  const chip = (f, label, n) => `<button class="chip" data-f="${f}" aria-pressed="${r.f === f}">${label}<span class="n">${int(n)}</span></button>`;
  const body = vis.slice(0, shown).map((x, i) => {
    const s = statusOf(x), l = x.l;
    return `<tr data-id="${l.id}" data-i="${i}" class="${l.id === r.line ? 'sel' : ''}">
      <td><div class="cn">${dot(s)}<div>${G.TYPES[l.t]}<small>${l.id}</small></div></div></td>
      <td class="mono">${l.inv}</td>
      <td>${esc(W.carriers[l.c].name)}</td>
      <td>${esc(W.facilities[l.f].name)}<div class="muted" style="font-size:12px">${day(l.day)}</div></td>
      <td class="num">${usd(l.a, 2)}<div class="muted" style="font-size:12px">${hrs(l.q)} ${G.UNIT_LABEL[l.t]}${l.q === 1 ? '' : 's'}</div></td>
      <td class="num">${usd(x.exp, 2)}</td>
      <td class="num pv">${fmtP(x.p)}</td>
      <td>${pill(s)}${S.showTruth ? ` <span class="pill truth">${l.bad ? esc(l.kind) : 'valid'}</span>` : ''}</td>
    </tr>`;
  }).join('');
  return `
    <div class="tbl-head">
      <div class="chips" role="group" aria-label="Filter by status">
        ${chip('all', 'All', rows.length)}${chip('dispute', 'Auto-dispute', st.dispute)}${chip('review', 'Analyst review', st.review)}${chip('approve', 'Approved', st.approve)}${st.filed ? chip('filed', 'Filed', st.filed) : ''}
      </div>
      <label class="toggle"><input type="checkbox" id="truth" ${S.showTruth ? 'checked' : ''}>Show simulation ground truth</label>
    </div>
    ${vis.length ? `<div style="overflow:auto"><table class="t" aria-label="Grey-zone accessorial charges">
      <thead><tr><th>Charge</th><th>Invoice</th><th>Carrier</th><th>Facility</th><th class="num">Billed</th><th class="num">Supported</th><th class="num">p-value</th><th>Status</th></tr></thead>
      <tbody>${body}</tbody></table></div>
      ${vis.length > shown ? `<div class="more"><button class="btn sm ghost" id="more">Show ${Math.min(PAGE, vis.length - shown)} more of ${int(vis.length - shown)}</button></div>` : ''}`
    : `<div class="empty">${ico('inbox')}<div><b>No charges match.</b></div><div>Try another status or clear the search.</div></div>`}`;
}

// ---------------------------------------------------------------- coverage
function coverageView(r) {
  const c = R.coverage, br = c.byRate;
  const W0 = 640, H0 = 318, L = 48, B = 54, T = 14, Rt = 16;
  const xs = (i) => L + (i * (W0 - L - Rt)) / (br.length - 1);
  const ymax = 1;
  const ys = (v) => T + (1 - v / ymax) * (H0 - T - B);
  const series = [
    ['tolerance', '#45433f', '25% tolerance rule'],
    ['perline_0.05', '#e8a524', 'Per-line test at 5% (no BH)'],
    ['gate_0.1', '#f59b5e', 'Gate, 10% target'],
    ['gate_0.05', '#f3600b', 'Gate, 5% target'],
  ];
  const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${L}" x2="${W0 - Rt}" y1="${ys(v)}" y2="${ys(v)}" stroke="#efeee9"/><text x="${L - 8}" y="${ys(v) + 4}" text-anchor="end" font-size="11" fill="#8b8882">${v * 100}%</text>`).join('');
  const xl = br.map((b, i) => `<text x="${xs(i)}" y="${H0 - B + 18}" text-anchor="middle" font-size="11" fill="#8b8882">${b.badRate * 100}%</text>`).join('');
  const lines = series.map(([k, col]) => {
    const pts = br.map((b, i) => `${xs(i)},${ys(b[k])}`).join(' ');
    return `<polyline fill="none" stroke="${col}" stroke-width="2.2" points="${pts}"/>` + br.map((b, i) => `<circle cx="${xs(i)}" cy="${ys(b[k])}" r="3.2" fill="#fff" stroke="${col}" stroke-width="2"><title>${k}: ${pct(b[k])} at ${b.badRate * 100}% overbilled</title></circle>`).join('');
  }).join('');
  const target = [0.05, 0.1].map((a) => `<line x1="${L}" x2="${W0 - Rt}" y1="${ys(a)}" y2="${ys(a)}" stroke="#f3600b" stroke-dasharray="4 4" stroke-opacity=".55"/>`).join('');
  const tbl = br.map((b) => `<tr><td>${b.badRate * 100}%</td><td class="num">${pct(b['gate_0.05'])}</td><td class="num">${pct(b['recall_0.05'], 0)}</td><td class="num">${pct(b['gate_0.1'])}</td><td class="num">${pct(b['perline_0.05'], 0)}</td><td class="num">${pct(b.tolerance, 0)}</td></tr>`).join('');
  return `<div class="two">
    <div>
      <div class="sec-h">Wrong disputes as a share of disputes filed</div>
      <div class="muted" style="font-size:13px;margin:2px 0 8px">${c.windows} simulated cycles, each with a fresh 5-month calibration window; x-axis is how dirty the cycle was (share of grey-zone lines overbilled).</div>
      <svg viewBox="0 0 ${W0} ${H0}" width="100%" role="img" aria-label="False-dispute rate by overbilling rate">${grid}${target}${lines}${xl}
        <text x="${(L + W0) / 2}" y="${H0 - 4}" text-anchor="middle" font-size="11" fill="#8b8882">Share of grey-zone lines overbilled</text></svg>
      <div class="legend">${series.map(([, col, t]) => `<span><i style="background:${col}"></i>${t}</span>`).join('')}<span><i style="background:#f3600b;opacity:.5"></i>Targets (5%, 10%)</span></div>
    </div>
    <div>
      <table class="t" aria-label="Coverage by overbilling rate"><thead><tr><th>Overbilled</th><th class="num">Gate 5%</th><th class="num">Caught</th><th class="num">Gate 10%</th><th class="num">Per-line</th><th class="num">Tolerance</th></tr></thead><tbody>${tbl}</tbody></table>
      <p class="muted" style="font-size:12.5px;margin:12px 4px 0">The guarantee is E[wrong / filed] ≤ target × (valid share). A fixed rule's wrong-dispute share swings with how clean the month is; the gate's does not. "Caught" is the share of overbilled grey-zone lines auto-disputed at 5%; the rest go to review or are missed.</p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- method
function methodView(r, g) {
  const nCal = D.cs.map((x) => x.length);
  const t = R.table.find((x) => x.alpha === r.alpha) || R.table[1];
  return `<div class="method">
    <div><h4>1. What a valid charge looks like</h4><p>Fitted on ${int(D.tr.length)} settled lines from ${W.months.train[0]} to ${W.months.train.at(-1)}: how often each charge type happens at each facility, and for detention, how many billable hours the facility's gate-timestamped trucks that day support (peer dwell, shrinkage ${D.m.shrink} pseudo-observations, fitted).</p>
      <div class="formula">score = max(0, log(network rate / facility rate)) + S_hours</div></div>
    <div><h4>2. Calibrate on lines that settled as valid</h4><p>${int(D.cal.length)} grey-zone lines from ${W.months.cal[0]} to ${W.months.cal.at(-1)}, compared within charge type (Mondrian): ${G.TYPES.map((n, i) => `${n} ${int(nCal[i])}`).join(', ')}.</p>
      <div class="formula">p = (1 + #{valid cal lines of the type with score ≥ s}) / (n_type + 1)</div></div>
    <div><h4>3. Pick disputes with Benjamini-Hochberg</h4><p>Sort this cycle's ${int(g.m)} p-values; dispute the largest k with p(k) ≤ ${r.alpha} · k / ${int(g.m)}. This cycle k = ${g.k}. Conformal p-values are positively dependent, so BH keeps E[wrong / filed] ≤ ${r.alpha * 100}% (Bates, Candès, Lei, Romano and Sesia, Annals of Statistics 2023).</p></div>
    <div><h4>4. This cycle, checked against the simulation's truth</h4><p>At ${r.alpha * 100}%: ${t.gate.disputes} auto-disputes, ${t.gate.wrong} wrong, ${usd(t.gate.recovered)} of ${usd(t.overbilled)} overbilled recovered. The tolerance rule would file ${int(t.tolerance.disputes)} disputes, ${pct(t.tolerance.fdp, 0)} of them wrong.</p></div>
  </div>
  <div class="note">Assumes valid lines this cycle look like the calibration window (no new carrier contracts or facility changes in between); rate-card errors stay with the contract rule engine. Source: <a href="https://github.com/Mohith26/freehand-dispute-gate">github.com/Mohith26/freehand-dispute-gate</a>.</div>`;
}

// ---------------------------------------------------------------- drawer
function openDrawer(id) {
  const g = GATE, x = g.rows.find((y) => y.l.id === id);
  const dr = $('#drawer');
  if (!x) { dr.hidden = true; return; }
  const l = x.l, k = x.k, s = statusOf(x), car = W.carriers[l.c], fac = W.facilities[l.f];
  const cal = D.cs[l.t], n = cal.length;
  const ge = G.countGE(cal, x.s);
  const netRate = D.m.gRates[l.t], facRate = k.occ;
  let story;
  if (l.t === 0) {
    const pd = G.peerDwell(D.m, l);
    story = l.pk
      ? `${esc(car.name)} billed <b>${hrs(l.q)} h</b> of detention at ${esc(fac.name)} on ${day(l.day)}. The ${l.pk} truck${l.pk > 1 ? 's' : ''} with gate timestamps there that day waited about <b>${pd.toFixed(1)} h</b>, which supports ${(Math.ceil(k.hb * 4) / 4).toFixed(2)} billable hours after 2 free.`
      : `${esc(car.name)} billed <b>${hrs(l.q)} h</b> of detention at ${esc(fac.name)} on ${day(l.day)}. No timestamped trucks there that day, so the facility's usual dwell (${pd.toFixed(1)} h) is the reference.`;
  } else {
    story = `${esc(car.name)} billed a <b>${G.TYPES[l.t].toLowerCase()}</b> at ${esc(fac.name)} on ${day(l.day)}. This charge appears on <b>${pct(facRate, facRate < 0.01 ? 2 : 1)}</b> of shipments here versus ${pct(netRate, 1)} across the network${fac.dock && l.t === 2 ? ' (the DC has dock doors)' : ''}${!fac.lumper && l.t === 1 ? ' (the DC unloads with its own crew)' : ''}.`;
  }
  story += ` ${int(ge)} of ${int(n)} valid ${G.TYPES[l.t].toLowerCase()} lines in calibration were at least this unusual (p = ${fmtP(x.p)}).`;
  const decide = x.status === 'dispute' ? `BH selected it at the ${GATE.alpha * 100}% target, so the agent can file without review.` : x.status === 'review' ? `Unusual, but not enough to clear BH at ${GATE.alpha * 100}%; an analyst decides.` : 'Consistent with valid charges; released for payment.';
  // histogram of calibration scores for this type with the line's score marked
  const hi = Math.max(cal[n - 1] || 1, x.s) * 1.05, bins = 36;
  const h = G.histogram(cal, 0, hi, bins);
  const W0 = 470, H0 = 120, mx = Math.log1p(Math.max(...h));
  const bars = h.map((c, i) => { const bh = (Math.log1p(c) / mx) * (H0 - 22); return `<rect x="${(i * W0) / bins + 1}" y="${H0 - 18 - bh}" width="${W0 / bins - 2}" height="${bh}" rx="2" fill="#d9d6cf"/>`; }).join('');
  const xm = (x.s / hi) * W0;
  const cut = GATE.k ? cutScore(cal, GATE.threshold) : null;
  const cutLine = cut != null && cut <= hi ? `<line x1="${(cut / hi) * W0}" x2="${(cut / hi) * W0}" y1="0" y2="${H0 - 18}" stroke="#e5533d" stroke-dasharray="3 3"/><text x="${(cut / hi) * W0 + 4}" y="${H0 - 24}" font-size="10.5" fill="#e5533d">BH cut-off</text>` : '';
  dr.innerHTML = `
    <div class="dh"><div><h2>${G.TYPES[l.t]} · ${usd(l.a, 2)}</h2><div class="meta mono">${l.id} · ${l.inv} · ${esc(car.name)}</div></div><button class="x" id="dx" aria-label="Close">${ico('x')}</button></div>
    <div class="db">
      <div class="fs"><div class="fs-h"><span class="mk"><svg viewBox="0 0 32 32"><g stroke="#fff" stroke-width="3.8" stroke-linecap="round"><path d="M16 6v20M7.3 11l17.4 10M7.3 21l17.4-10"/></g></svg></span>Freehand Summary</div>${story} ${decide}</div>
      <table class="steps" aria-label="Validation steps"><thead><tr><th>Validation step</th><th></th><th style="text-align:right">Value</th></tr></thead><tbody>
        <tr><td>Contract rate</td><td>${pill('approve')}</td><td class="v">${usd(l.a / l.q, 2)} / ${G.UNIT_LABEL[l.t]}</td></tr>
        <tr><td>Documents on file</td><td><span class="pill rev">${SPARK}Missing</span></td><td class="v">${l.t === 0 ? 'no gate-out time' : l.t === 1 ? 'no signed receipt' : 'no POD notation'}</td></tr>
        <tr><td>Charge rate here vs network</td><td>${k.sOcc > 2 ? `<span class="pill bad">${SPARK}Issue Found</span>` : pill('approve')}</td><td class="v">${pct(facRate, 2)} vs ${pct(netRate, 1)}</td></tr>
        ${l.t === 0 ? `<tr><td>Billed hours vs peer-supported</td><td>${k.sHours > 3 ? `<span class="pill bad">${SPARK}Issue Found</span>` : pill('approve')}</td><td class="v">${hrs(l.q)} h vs ${(Math.ceil(k.hb * 4) / 4).toFixed(2)} h</td></tr>` : ''}
        <tr><td>Calibration rank (same type)</td><td></td><td class="v">${int(ge)} / ${int(n)} · p ${fmtP(x.p)}</td></tr>
        <tr><td>Decision at ${GATE.alpha * 100}% target</td><td>${pill(x.status)}</td><td class="v">${x.status === 'dispute' ? 'claim ' + usd(x.claim, 2) : ''}</td></tr>
      </tbody></table>
      <div class="chart-box"><div class="ct">Valid ${G.TYPES[l.t].toLowerCase()} lines in calibration <span>score, log count</span></div>
        <svg viewBox="0 0 ${W0} ${H0}" width="100%" role="img" aria-label="Calibration score histogram">${bars}${cutLine}
          <line x1="${xm}" x2="${xm}" y1="12" y2="${H0 - 18}" stroke="#f3600b" stroke-width="2.5"/><circle cx="${xm}" cy="12" r="4" fill="#f3600b"/>
          <text x="0" y="${H0 - 3}" font-size="10.5" fill="#8b8882">0</text><text x="${W0}" y="${H0 - 3}" font-size="10.5" fill="#8b8882" text-anchor="end">${hi.toFixed(1)}</text>
          <text x="${xm > W0 - 90 ? xm - 8 : xm + 8}" y="16" font-size="10.5" fill="#f3600b" text-anchor="${xm > W0 - 90 ? 'end' : 'start'}">this line ${x.s.toFixed(2)}</text></svg></div>
      ${S.showTruth ? `<div class="muted" style="font-size:12.5px">Simulation truth: ${l.bad ? `<b style="color:#e05a48">${esc(l.kind)}</b>, should have billed ${usd(l.va, 2)}` : 'valid charge'}.</div>` : ''}
      <div class="d-actions">
        ${s === 'filed' ? `<span class="pill filed">${ico('send')}Filed ${new Date(S.filed[l.id]).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>` : `
        <button class="btn sm ${s === 'dispute' ? 'pri' : ''}" data-ov="dispute">${ico('flag')}Dispute <kbd>D</kbd></button>
        <button class="btn sm" data-ov="review">${ico('eye')}Send to review <kbd>R</kbd></button>
        <button class="btn sm" data-ov="approve">${ico('check')}Approve <kbd>A</kbd></button>`}
        ${S.overrides[l.id] && s !== 'filed' ? `<button class="btn sm ghost" data-ov="reset">${ico('rotate-ccw')}Reset to gate</button>` : ''}
      </div>
    </div>`;
  dr.hidden = false;
  $('#dx').onclick = () => go({ line: '' });
  dr.querySelectorAll('[data-ov]').forEach((b) => (b.onclick = () => override(l.id, b.dataset.ov)));
  lucide.createIcons();
}
function closeDrawer() { $('#drawer').hidden = true; }
// lowest score whose p-value clears the BH threshold for this type
function cutScore(cal, thr) {
  const n = cal.length, maxGE = Math.floor(thr * (n + 1) - 1);
  if (maxGE < 0) return null;
  const idx = n - maxGE; // need #(>= s) <= maxGE
  return idx >= n ? cal[n - 1] + 1e-9 : idx <= 0 ? 0 : cal[idx - 1] + 1e-9;
}

function override(id, v) {
  if (v === 'reset') delete S.overrides[id];
  else { const x = GATE.rows.find((y) => y.l.id === id); if (x.status === v) delete S.overrides[id]; else S.overrides[id] = v; }
  save(); render();
  toast(v === 'reset' ? 'Reset to the gate decision' : `Marked ${v === 'dispute' ? 'for dispute' : v === 'review' ? 'for analyst review' : 'approved'}`);
}

// ---------------------------------------------------------------- wiring
function wire(r, g, rows) {
  document.querySelectorAll('.seg button').forEach((b) => (b.onclick = () => { GATE = null; shown = PAGE; go({ alpha: +b.dataset.a }); }));
  const sa = $('#saveA');
  if (sa) sa.onclick = () => { S.savedAlpha = r.alpha; save(); go({ alpha: r.alpha }, true); toast(`Guardrail saved: ${r.alpha * 100}% false-dispute target`); };
  document.querySelectorAll('.chip[data-f]').forEach((b) => (b.onclick = () => { shown = PAGE; sel = -1; go({ f: b.dataset.f }); }));
  document.querySelectorAll('tbody tr[data-id]').forEach((tr) => (tr.onclick = () => { sel = +tr.dataset.i; go({ line: tr.dataset.id }); }));
  const more = $('#more'); if (more) more.onclick = () => { shown += PAGE; render(); };
  const tr = $('#truth'); if (tr) tr.onchange = () => { S.showTruth = tr.checked; save(); render(); };
  const q = $('#q'); if (q.value !== r.q && document.activeElement !== q) q.value = r.q;
  q.oninput = () => { shown = PAGE; go({ q: q.value, view: 'queue' }, true); q.focus(); };
  const exp = $('#exp'), m = $('#expm');
  exp.onclick = (e) => { e.stopPropagation(); m.hidden = !m.hidden; exp.setAttribute('aria-expanded', String(!m.hidden)); };
  m.querySelectorAll('[data-x]').forEach((b) => (b.onclick = () => { m.hidden = true; doExport(b.dataset.x, g, rows); }));
  $('#send').onclick = () => {
    const ids = rows.filter((x) => statusOf(x) === 'dispute').map((x) => x.l.id);
    if (!ids.length) return;
    const now = Date.now();
    ids.forEach((id) => (S.filed[id] = now));
    save(); render();
    toast(`${ids.length} disputes sent to the Claim Resolution Agent`, () => { ids.forEach((id) => delete S.filed[id]); save(); render(); });
  };
  document.querySelectorAll('[data-soon]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); toast('Outside this concept demo'); }));
}

function doExport(kind, g, rows) {
  const out = rows.map((x) => ({
    id: x.l.id, invoice: x.l.inv, carrier: W.carriers[x.l.c].name, facility: W.facilities[x.l.f].name, day: x.l.day,
    type: G.TYPES[x.l.t], quantity: x.l.q, billed: x.l.a, supported: +(x.l.a - x.claim).toFixed(2), claim: +x.claim.toFixed(2),
    score: +x.s.toFixed(4), p_value: +x.p.toFixed(6), gate: x.status, final: statusOf(x), reason: x.why,
  })).sort((a, b) => a.p_value - b.p_value);
  let blob, name;
  if (kind === 'csv') {
    const cols = Object.keys(out[0]);
    const line = (o) => cols.map((c) => { const v = String(o[c]); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',');
    blob = new Blob([[cols.join(','), ...out.map(line)].join('\n')], { type: 'text/csv' });
    name = `dispute-gate-${W.months.test}-alpha${g.alpha}.csv`;
  } else {
    blob = new Blob([JSON.stringify({ cycle: W.months.test, alpha: g.alpha, bh: { k: g.k, threshold: g.threshold, m: g.m }, method: 'Mondrian conformal p-values + Benjamini-Hochberg', lines: out }, null, 1)], { type: 'application/json' });
    name = `dispute-gate-${W.months.test}-alpha${g.alpha}.json`;
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${out.length} lines`);
}

let tt;
function toast(msg, undo) {
  const t = $('#toast');
  t.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button id="undo">Undo</button>' : ''}`;
  t.hidden = false;
  if (undo) $('#undo').onclick = () => { undo(); t.hidden = true; };
  clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 4200);
}

document.addEventListener('click', () => { const m = $('#expm'); if (m) m.hidden = true; });
document.addEventListener('keydown', (e) => {
  if (!D) return;
  const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#q').focus(); return; }
  if (e.key === 'Escape') { if (typing) document.activeElement.blur(); else if (route().line) go({ line: '' }); return; }
  if (typing || e.metaKey || e.ctrlKey) return;
  const r = route();
  if (r.view !== 'queue') return;
  const vis = visibleRows(r, GATE.rows).slice(0, shown);
  if (e.key === 'j' || e.key === 'k') {
    const cur = vis.findIndex((x) => x.l.id === r.line);
    const nx = Math.max(0, Math.min(vis.length - 1, (cur < 0 ? -1 : cur) + (e.key === 'j' ? 1 : -1)));
    if (vis[nx]) go({ line: vis[nx].l.id }, true);
    const row = document.querySelector(`tr[data-id="${vis[nx]?.l.id}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
  } else if (r.line && ['d', 'a', 'r'].includes(e.key)) {
    override(r.line, { d: 'dispute', a: 'approve', r: 'review' }[e.key]);
  } else if (e.key === 'e') {
    doExport('csv', GATE, GATE.rows);
  }
});
addEventListener('hashchange', render);
boot();
setTimeout(() => { document.body.dataset.errs = String((window.__errs || []).length); }, 2500); // read by the headless check
