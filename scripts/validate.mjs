// Cross-validate every model spec in model.js and write data/validation.json.
// Usage: node scripts/validate.mjs [--quick]
// Scores: Brier score (BS) and Brier skill score (BSS) against a common reference
// forecast = unweighted base rate over 1993+ training years for that date/lead.
// Two schemes:
//   loyo    - leave one year out (train on every other year, before and after)
//   forward - train only on years before the target year (what a real forecaster had)
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = require(path.join(ROOT, 'model.js'));

const quick = process.argv.includes('--quick');
const load = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'ibwc', f), 'utf8'));
const loadC = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'climate', f), 'utf8'));
const D = M.bundle({ target: load('johnson_ranch.json'), presidio: load('presidio.json'), storage: load('la_boquilla.json'),
  oni: loadC('oni.json'), rain: loadC('conchos_rain.json') });

const EVAL = [2008, 2025];
const LEADS = [3, 7, 14, 30, 45, 60, 90, 120, 150, 180];
const EVERY = quick ? 30 : 10;
const TARGETS = [{ key: '200-1200', lo: 200, hi: 1200 }, { key: '300-1000', lo: 300, hi: 1000 }];
const LEN = 7;
const specKeys = Object.keys(M.SPECS);
const REF = { label: 'reference', up: false, store: false, minYear: 1993, half: Infinity };

function refBase(asof, k, lo, hi, exclude, maxYear) {
  const { Y } = M.sample(D, REF, asof, k, lo, hi, LEN, exclude, M.yearOf(asof), maxYear);
  return Y.length ? Y.reduce((a, b) => a + b, 0) / Y.length : null;
}

const out = { generated: new Date().toISOString(), target: 'johnson_ranch', evalYears: EVAL, leads: LEADS,
  issueEveryDays: EVERY, tripDays: LEN, defaultSpec: M.DEFAULT_SPEC,
  specs: Object.fromEntries(specKeys.map(k => [k, M.SPECS[k].label])), results: {} };

const t0 = Date.now();
for (const T of TARGETS) {
  const res = {};
  for (const scheme of ['loyo', 'forward']) {
    const acc = {}; const calib = {}; const keep = [];
    for (const s of specKeys) { acc[s] = {}; calib[s] = []; for (const k of LEADS) acc[s][k] = { bs: 0, ref: 0, n: 0, fall_bs: 0, fall_ref: 0, fall_n: 0 }; }
    for (let y = EVAL[0]; y <= EVAL[1]; y++) {
      for (let doy = 0; doy < 365; doy += EVERY) {
        const asof = M.dn(y, 1, 1) + doy;
        const fall = doy >= 212 && doy <= 334; // issued Aug-Nov
        for (const k of LEADS) {
          const o = M.outcome(D.T, asof + k, T.lo, T.hi, LEN); if (o === null) continue;
          const opts = scheme === 'loyo' ? { exclude: y, iters: 15 } : { exclude: y, maxYear: y - 1, iters: 15 };
          const rb = refBase(asof, k, T.lo, T.hi, y, scheme === 'forward' ? y - 1 : undefined); if (rb === null) continue;
          const preds = {};
          for (const s of specKeys) {
            const r = M.forecast(D, s, asof, k, T.lo, T.hi, LEN, opts);
            if (r.p === null) { preds[s] = null; continue; }
            preds[s] = r.p;
          }
          if (specKeys.some(s => preds[s] === null)) continue; // score only where every spec could forecast
          const ov = o ? 1 : 0;
          for (const s of specKeys) {
            const a = acc[s][k], e = (preds[s] - ov) ** 2, er = (rb - ov) ** 2;
            a.bs += e; a.ref += er; a.n++;
            if (fall) { a.fall_bs += e; a.fall_ref += er; a.fall_n++; }
            calib[s].push([preds[s], ov]);
            if (scheme === 'forward' && s === M.DEFAULT_SPEC) keep.push({ y, k, fall, p: preds[s], rb, ov });
          }
        }
      }
      process.stderr.write(`${T.key} ${scheme} ${y} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
    }
    const table = {};
    for (const s of specKeys) {
      table[s] = {};
      for (const k of LEADS) {
        const a = acc[s][k];
        table[s][k] = { n: a.n, bs: +(a.bs / a.n).toFixed(4), bss: +(1 - a.bs / a.ref).toFixed(3),
          fall_n: a.fall_n, fall_bss: a.fall_n ? +(1 - a.fall_bs / a.fall_ref).toFixed(3) : null };
      }
    }
    const bins = [[0, .1], [.1, .3], [.3, .5], [.5, .7], [.7, .9], [.9, 1.01]];
    const cal = {};
    for (const s of specKeys) cal[s] = bins.map(([a, b]) => {
      const v = calib[s].filter(p => p[0] >= a && p[0] < b);
      return { bin: [a, Math.min(1, b)], n: v.length, mean_p: v.length ? +(v.reduce((t, p) => t + p[0], 0) / v.length).toFixed(3) : null,
        observed: v.length ? +(v.reduce((t, p) => t + p[1], 0) / v.length).toFixed(3) : null };
    });
    res[scheme] = { skill: table, calibration: cal };
    if (scheme === 'forward') {
      // Recalibration of the default spec (Platt scaling per lead), scored leave-one-year-out
      // over the recalibration step: the correction applied to year y is fit on other years only.
      const rec = { spec: M.DEFAULT_SPEC, params: [], skill: {}, calibration: [] };
      const recPairs = [];
      for (const k of LEADS) {
        const rows = keep.filter(r => r.k === k);
        const all = M.fitPlatt(rows.map(r => [r.p, r.ov]));
        rec.params.push({ lead: k, a: +all.a.toFixed(4), b: +all.b.toFixed(4) });
        let bs = 0, ref = 0, n = 0, fbs = 0, fref = 0, fn = 0;
        for (let y = EVAL[0]; y <= EVAL[1]; y++) {
          const tr = rows.filter(r => r.y !== y), te = rows.filter(r => r.y === y); if (!te.length) continue;
          const pl = M.fitPlatt(tr.map(r => [r.p, r.ov])); const tab = [{ lead: k, a: pl.a, b: pl.b }];
          for (const r of te) { const q = M.recalibrate(r.p, k, tab), e = (q - r.ov) ** 2, er = (r.rb - r.ov) ** 2;
            bs += e; ref += er; n++; if (r.fall) { fbs += e; fref += er; fn++; } recPairs.push([q, r.ov]); }
        }
        rec.skill[k] = { n, bss: +(1 - bs / ref).toFixed(3), fall_bss: fn ? +(1 - fbs / fref).toFixed(3) : null };
      }
      const bins = [[0, .1], [.1, .3], [.3, .5], [.5, .7], [.7, .9], [.9, 1.01]];
      rec.calibration = bins.map(([a, b]) => { const v = recPairs.filter(p => p[0] >= a && p[0] < b);
        return { bin: [a, Math.min(1, b)], n: v.length, mean_p: v.length ? +(v.reduce((t, p) => t + p[0], 0) / v.length).toFixed(3) : null,
          observed: v.length ? +(v.reduce((t, p) => t + p[1], 0) / v.length).toFixed(3) : null }; });
      res.recalibrated = rec;
    }
  }
  out.results[T.key] = res;
}
// Selection metric: mean forward-chained BSS for leads 3-60 d, workable range, issued Aug-Nov.
const SEL = LEADS.filter(k => k <= 60);
out.selection = { metric: 'mean forward-chained Brier skill, leads ' + SEL.join('/') + ' d, 200-1200 cfs, issued Aug-Nov',
  scores: Object.fromEntries(specKeys.map(s => [s, +(SEL.reduce((t, k) => t + out.results['200-1200'].forward.skill[s][k].fall_bss, 0) / SEL.length).toFixed(3)])) };
out.selection.best = Object.entries(out.selection.scores).sort((a, b) => b[1] - a[1])[0][0];
// Pre-set switching rule: only replace the current default if a challenger beats it by more than
// SWITCH (differences smaller than that are within noise for ~18 evaluation years).
const SWITCH = 0.02;
out.selection.switchThreshold = SWITCH;
out.selection.recommended = out.selection.scores[out.selection.best] - out.selection.scores[M.DEFAULT_SPEC] > SWITCH ? out.selection.best : M.DEFAULT_SPEC;
// Long-lead rule (set before looking at results): the composite AM-h12 is kept only if its mean forward fall
// skill over leads 90-180 d beats A-h12's by more than SWITCH (short leads are identical by construction).
const LONG = LEADS.filter(k => k >= 90);
const lscore = sp => +(LONG.reduce((t, k) => t + out.results['200-1200'].forward.skill[sp][k].fall_bss, 0) / LONG.length).toFixed(3);
out.longLead = { metric: 'mean forward-chained Brier skill, leads ' + LONG.join('/') + ' d, 200-1200 cfs, issued Aug-Nov',
  scores: Object.fromEntries(specKeys.map(s => [s, lscore(s)])), rule: 'AM-h12 must beat A-h12 by > ' + SWITCH };
out.longLead.passes = out.longLead.scores['AM-h12'] - out.longLead.scores['A-h12'] > SWITCH;
out.seconds = Math.round((Date.now() - t0) / 1000);
fs.writeFileSync(path.join(ROOT, 'data', 'validation.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`wrote data/validation.json in ${out.seconds}s`);
console.log('selection', JSON.stringify(out.selection));
console.log('longLead', JSON.stringify(out.longLead));
for (const T of TARGETS) { const r = out.results[T.key].recalibrated; console.log(`\nrecalibrated ${r.spec} ${T.key}: BSS`, LEADS.map(k => r.skill[k].bss.toFixed(2)).join(' '), '| fall', LEADS.map(k => r.skill[k].fall_bss.toFixed(2)).join(' '));
  console.log('  params', JSON.stringify(r.params)); console.log('  calib', r.calibration.filter(c => c.n).map(c => `${c.mean_p}->${c.observed}(${c.n})`).join('  ')); }
for (const T of TARGETS) for (const sc of ['loyo', 'forward']) {
  console.log(`\n${T.key} ${sc}  BSS by lead (${LEADS.join('/')})`);
  for (const s of specKeys) console.log(s.padEnd(9), LEADS.map(k => out.results[T.key][sc].skill[s][k].bss.toFixed(2).padStart(6)).join(''), '| fall', LEADS.map(k => (out.results[T.key][sc].skill[s][k].fall_bss ?? NaN).toFixed(2).padStart(6)).join(''));
}
