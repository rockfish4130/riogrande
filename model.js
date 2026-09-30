/* Rio Grande trip-window model (v2). One implementation, used by:
 *   - planner.html (browser: window.RGModel)
 *   - scripts/validate.mjs (Node: import via createRequire / require)
 * Plain JavaScript, no dependencies. See CONTEXT.md §5 for the full spec.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RGModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DAY = 86400000;
  const dn = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / DAY);
  const toDate = n => new Date(n * DAY);
  const yearOf = n => toDate(n).getUTCFullYear();
  const isLeap = y => (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0));
  const isoToDn = s => dn(+s.slice(0, 4), +s.slice(5, 7), +s.slice(8, 10));
  const dnToIso = n => toDate(n).toISOString().slice(0, 10);

  /** Wrap an IBWC-style {start:'YYYY-MM-DD', v:[...]} doc as a fast day-number lookup. */
  function series(doc) {
    const start = isoToDn(doc.start), v = doc.v;
    return {
      start, end: start + v.length - 1, name: doc.name, unit: doc.unit,
      get(n) { const i = n - start; if (i < 0 || i >= v.length) return undefined; const x = v[i]; return x === null ? undefined : x; }
    };
  }
  /** Same calendar day as day n, in year y (Feb 29 -> Feb 28 in non-leap years). */
  function sameDay(y, n) {
    const d = toDate(n); let mo = d.getUTCMonth() + 1, da = d.getUTCDate();
    if (mo === 2 && da === 29 && !isLeap(y)) da = 28;
    return dn(y, mo, da);
  }

  // ---------------- outcome ----------------
  function outcome(S, t, lo, hi, len) { // true / false / null (unknown)
    for (let i = 0; i < len; i++) { const v = S.get(t + i); if (v === undefined) return null; if (v < lo || v > hi) return false; }
    return true;
  }
  function classify(S, t, lo, hi, len) { // 'ideal' | 'ok' | 'low' | 'high' | null
    let low = false, high = false, ideal = true;
    for (let i = 0; i < len; i++) {
      const v = S.get(t + i); if (v === undefined) return null;
      if (v > hi) high = true; else if (v < lo) low = true; if (v < 300 || v > 1000) ideal = false;
    }
    return high ? 'high' : low ? 'low' : ideal ? 'ideal' : 'ok';
  }

  // ---------------- predictors ----------------
  // xb: log10 of the lowest daily mean at the target gauge in the 7 days ending on d (baseflow proxy)
  function xBase(S, d) {
    let m = Infinity, n = 0;
    for (let i = 0; i < 7; i++) { const v = S.get(d - i); if (v !== undefined) { n++; if (v < m) m = v; } }
    return n >= 5 ? Math.log10(Math.max(m, 1)) : null;
  }
  // xp: log10 of the mean daily flow below the Conchos at Presidio over the 3 days ending on d (upstream signal)
  function xUp(P, d) {
    if (!P) return null; let s = 0, n = 0;
    for (let i = 0; i < 3; i++) { const v = P.get(d - i); if (v !== undefined) { s += v; n++; } }
    return n >= 2 ? Math.log10(Math.max(s / n, 1)) : null;
  }
  // xs: La Boquilla storage (thousand million m3 = km3), latest value within 7 days of d
  function xStore(R, d) {
    if (!R) return null;
    for (let i = 0; i < 7; i++) { const v = R.get(d - i); if (v !== undefined) return v / 1000; }
    return null;
  }

  // ENSO: ONI anomaly for the latest 3-month season that would have been published by day d.
  // CPC posts a season early in the following month, so we use the season ending in the previous
  // month once we're past the 10th, otherwise the one ending two months back.
  // ONI rows are [SEAS, YEAR, ANOM]; YEAR is the year of the season's middle month.
  const SEAS = ['DJF', 'JFM', 'FMA', 'MAM', 'AMJ', 'MJJ', 'JJA', 'JAS', 'ASO', 'SON', 'OND', 'NDJ'];
  function oniLookup(doc) {
    const m = new Map(); for (const [sea, yr, a] of doc.rows) m.set(yr * 12 + SEAS.indexOf(sea), a); // key = middle month (0-based seq)
    return d => {
      const t = toDate(d); let last = t.getUTCFullYear() * 12 + t.getUTCMonth() - (t.getUTCDate() >= 10 ? 1 : 2);
      const v = m.get(last - 1); return v === undefined ? null : v; // middle month = last - 1
    };
  }
  // Basin rainfall: log ratio of CHIRPS Rio Conchos rainfall over the 4 most recent months that
  // were published by day d (a month is treated as available 20 days after it ends) to the
  // 1991-2020 normal for those same calendar months. + means wetter than normal.
  function rainLookup(doc) {
    const M = doc.months, clim = Array(12).fill(0), cnt = Array(12).fill(0);
    for (const [k, v] of Object.entries(M)) { const y = +k.slice(0, 4), mo = +k.slice(5, 7) - 1; if (y >= 1991 && y <= 2020) { clim[mo] += v; cnt[mo]++; } }
    for (let i = 0; i < 12; i++) clim[i] /= cnt[i] || 1;
    return d => {
      const t = toDate(d); let y = t.getUTCFullYear(), mo = t.getUTCMonth() - 1; // previous month
      if (t.getUTCDate() < 21) mo -= 1;                                          // not yet published
      let s = 0, c = 0;
      for (let i = 0; i < 4; i++) {
        let mm = mo - i, yy = y; while (mm < 0) { mm += 12; yy--; }
        const v = M[`${yy}-${String(mm + 1).padStart(2, '0')}`]; if (v === undefined) return null;
        s += v; c += clim[mm];
      }
      return Math.log((s + 10) / (c + 10));
    };
  }

  // ---------------- specs ----------------
  // Each spec: which predictors, earliest training year, recency half-life (years; Infinity = none).
  const SPECS = {
    'v1-like':   { label: 'Baseflow only, trained 2007+ (≈ v1 on the Johnson Ranch series)', up: false, store: false, minYear: 2007, half: Infinity },
    'A':         { label: 'Baseflow only, all years 1936+', up: false, store: false, minYear: 1936, half: Infinity },
    'A-h25':     { label: 'Baseflow only, 1936+, 25-yr half-life weighting', up: false, store: false, minYear: 1936, half: 25 },
    'B':         { label: 'Baseflow + Presidio, 1936+', up: true, store: false, minYear: 1936, half: Infinity },
    'B-h25':     { label: 'Baseflow + Presidio, 1936+, 25-yr half-life', up: true, store: false, minYear: 1936, half: 25 },
    'B-h12':     { label: 'Baseflow + Presidio, 1936+, 12-yr half-life', up: true, store: false, minYear: 1936, half: 12 },
    'C':         { label: 'Baseflow + Presidio + La Boquilla storage, 1993+', up: true, store: true, minYear: 1993, half: Infinity },
    'A-h12':     { label: 'Baseflow only, 1936+, 12-yr half-life', up: false, store: false, minYear: 1936, half: 12 },
    'A-h8':      { label: 'Baseflow only, 1936+, 8-yr half-life', up: false, store: false, minYear: 1936, half: 8 },
    'A-h5':      { label: 'Baseflow only, 1936+, 5-yr half-life', up: false, store: false, minYear: 1936, half: 5 },
    'B-h8':      { label: 'Baseflow + Presidio, 1936+, 8-yr half-life', up: true, store: false, minYear: 1936, half: 8 },
    'C-h12':     { label: 'Baseflow + Presidio + storage, 1993+, 12-yr half-life', up: true, store: true, minYear: 1993, half: 12 },
    'A-h12-1950':{ label: 'Baseflow only, 1950+, 12-yr half-life (fair baseline for ENSO)', up: false, store: false, minYear: 1950, half: 12 },
    'E-h12':     { label: 'Baseflow + ENSO (ONI), 1950+, 12-yr half-life', up: false, store: false, extra: ['oni'], minYear: 1950, half: 12 },
    'A-h12-1982':{ label: 'Baseflow only, 1982+, 12-yr half-life (fair baseline for rainfall)', up: false, store: false, minYear: 1982, half: 12 },
    'R-h12':     { label: 'Baseflow + Conchos basin rainfall (4-mo anomaly), 1982+, 12-yr half-life', up: false, store: false, extra: ['rain'], minYear: 1982, half: 12 },
    'ER-h12':    { label: 'Baseflow + ENSO + basin rainfall, 1982+, 12-yr half-life', up: false, store: false, extra: ['oni', 'rain'], minYear: 1982, half: 12 },
    'M-h12':     { label: 'Baseflow + 365-day mean flow (wet/dry regime memory), 1936+, 12-yr half-life', up: false, store: false, extra: ['m365'], minYear: 1936, half: 12 },
    'AM-h12':    { label: 'Composite: A-h12 to 60 d, blended into M-h12 by 90 d (long-lead memory)', composite: ['A-h12', 'M-h12', 60, 90] },
  };
  const DEFAULT_SPEC = 'AM-h12'; // A-h12 short leads (best forward skill 3-60 d) + regime memory beyond 60 d; see data/validation.json

  // Quadratic baseflow term: full weight to 30 d lead, blended to linear by 60 d.
  const BLEND_A = 30, BLEND_B = 60;
  const quadWeight = k => Math.min(1, Math.max(0, (BLEND_B - k) / (BLEND_B - BLEND_A)));
  const P_MIN = 0.02, P_MAX = 0.95, L2 = 1.0, WINDOW = 10, STEP = 2;

  function features(D, spec, d) {
    const xb = xBase(D.T, d); if (xb === null) return null;
    const f = [xb];
    if (spec.up) { const xp = xUp(D.P, d); if (xp === null) return null; f.push(xp); }
    if (spec.store) { const xs = xStore(D.R, d); if (xs === null) return null; f.push(xs); }
    if (spec.extra) for (const k of spec.extra) { const fn = D.aux && D.aux[k]; const v = fn ? fn(d) : null; if (v === null || v === undefined) return null; f.push(v); }
    return f;
  }

  /** Training pairs for as-of day `asof`, lead `k`. Excludes year `exclude` (and anything after `maxYear`). */
  function sample(D, spec, asof, k, lo, hi, len, exclude, refYear, maxYear) {
    const X = [], Y = [], W = [];
    for (const y of D.years) {
      if (y === exclude || y < spec.minYear || (maxYear !== undefined && y > maxYear)) continue;
      const w = spec.half === Infinity ? 1 : Math.pow(0.5, Math.abs(refYear - y) / spec.half);
      const base = sameDay(y, asof);
      for (let s = -WINDOW; s <= WINDOW; s += STEP) {
        const d = base + s, o = outcome(D.T, d + k, lo, hi, len); if (o === null) continue;
        const f = features(D, spec, d); if (!f) continue;
        X.push(f); Y.push(o ? 1 : 0); W.push(w);
      }
    }
    return { X, Y, W };
  }

  function solve(A, b) {
    const n = b.length; A = A.map(r => r.slice()); b = b.slice();
    for (let i = 0; i < n; i++) {
      let p = i; for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      for (let r = i + 1; r < n; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < n; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
    }
    const x = Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c]; x[i] = s / A[i][i]; }
    return x;
  }

  /** Weighted ridge logistic regression on standardized features. quad adds xb^2. */
  function fit(X, Y, W, quad, iters = 25) {
    const rows = X.map(f => quad ? [f[0], f[0] * f[0], ...f.slice(1)] : f.slice());
    const p = rows.length ? rows[0].length : 0;
    let sw = 0; const mu = Array(p).fill(0), sd = Array(p).fill(0);
    for (let i = 0; i < rows.length; i++) { sw += W[i]; for (let j = 0; j < p; j++) mu[j] += W[i] * rows[i][j]; }
    for (let j = 0; j < p; j++) mu[j] /= sw || 1;
    for (let i = 0; i < rows.length; i++) for (let j = 0; j < p; j++) sd[j] += W[i] * (rows[i][j] - mu[j]) ** 2;
    for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j] / (sw || 1)) || 1;
    let yb = 0; for (let i = 0; i < Y.length; i++) yb += W[i] * Y[i]; const base = sw ? yb / sw : null;
    if (!rows.length || base === 0 || base === 1) return { w: null, base, mu, sd, quad };
    const k = p + 1; let w = Array(k).fill(0); w[0] = Math.log(base / (1 - base));
    const Z = rows.map(r => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])]);
    for (let it = 0; it < iters; it++) {
      const g = Array(k).fill(0), H = [...Array(k)].map(() => Array(k).fill(0));
      for (let i = 0; i < Z.length; i++) {
        const z = Z[i]; let e = 0; for (let j = 0; j < k; j++) e += w[j] * z[j];
        const pr = 1 / (1 + Math.exp(-e)), r = W[i] * pr * (1 - pr), gi = W[i] * (pr - Y[i]);
        for (let a = 0; a < k; a++) { g[a] += gi * z[a]; const ra = r * z[a]; for (let b = a; b < k; b++) H[a][b] += ra * z[b]; }
      }
      for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) H[a][b] = H[b][a];
      for (let a = 1; a < k; a++) { g[a] += L2 * w[a]; H[a][a] += L2; }
      H[0][0] += 1e-6;
      const step = solve(H, g); let mx = 0;
      for (let a = 0; a < k; a++) { w[a] -= step[a]; mx = Math.max(mx, Math.abs(step[a])); }
      if (mx < 1e-6) break;
    }
    return { w, base, mu, sd, quad };
  }
  function predict(m, f) {
    if (!m.w) return m.base;
    const r = m.quad ? [f[0], f[0] * f[0], ...f.slice(1)] : f;
    let e = m.w[0]; for (let j = 0; j < r.length; j++) e += m.w[j + 1] * (r[j] - m.mu[j]) / m.sd[j];
    return 1 / (1 + Math.exp(-e));
  }
  const clamp = p => Math.min(P_MAX, Math.max(P_MIN, p));

  /** Forecast P(runnable) for a trip starting at asof+k. */
  function forecast(D, specKey, asof, k, lo, hi, len, opts = {}) {
    const spec = SPECS[specKey];
    if (spec.composite) { // lead-dependent blend of two specs
      const [sa, sb, a, b] = spec.composite, w = Math.min(1, Math.max(0, (k - a) / (b - a)));
      if (w === 0) return forecast(D, sa, asof, k, lo, hi, len, opts);
      if (w === 1) return forecast(D, sb, asof, k, lo, hi, len, opts);
      const ra = forecast(D, sa, asof, k, lo, hi, len, opts), rb = forecast(D, sb, asof, k, lo, hi, len, opts);
      if (ra.p === null || rb.p === null) return ra.p === null ? rb : ra;
      return { ...ra, p: clamp((1 - w) * ra.p + w * rb.p), base: (1 - w) * ra.base + w * rb.base };
    }
    const refYear = yearOf(asof);
    const exclude = opts.exclude === undefined ? refYear : opts.exclude;
    const { X, Y, W } = sample(D, spec, asof, k, lo, hi, len, exclude, refYear, opts.maxYear);
    const f = features(D, spec, asof);
    let sw = 0, sy = 0; for (let i = 0; i < Y.length; i++) { sw += W[i]; sy += W[i] * Y[i]; }
    const base = sw ? sy / sw : null;
    if (!f || !Y.length) return { p: null, base, n: Y.length, f };
    const wq = quadWeight(k); let p = 0;
    if (wq > 0) p += wq * predict(fit(X, Y, W, true, opts.iters), f);
    if (wq < 1) p += (1 - wq) * predict(fit(X, Y, W, false, opts.iters), f);
    let lo0 = Infinity, hi0 = -Infinity; for (const r of X) { if (r[0] < lo0) lo0 = r[0]; if (r[0] > hi0) hi0 = r[0]; }
    return { p: clamp(p), base, n: Y.length, f, extrap: f[0] < lo0 ? 'below' : f[0] > hi0 ? 'above' : null };
  }

  /** Platt recalibration: p' = σ(a + b·logit(p)), with (a,b) interpolated by lead from a fitted table
   *  [{lead, a, b}, ...] (see data/validation.json .recalibration). */
  function recalibrate(p, lead, table) {
    if (p === null || !table || !table.length) return p;
    const t = table.slice().sort((x, y) => x.lead - y.lead);
    let a, b;
    if (lead <= t[0].lead) ({ a, b } = t[0]);
    else if (lead >= t[t.length - 1].lead) ({ a, b } = t[t.length - 1]);
    else for (let i = 0; i < t.length - 1; i++) if (lead >= t[i].lead && lead <= t[i + 1].lead) {
      const f = (lead - t[i].lead) / (t[i + 1].lead - t[i].lead); a = t[i].a + f * (t[i + 1].a - t[i].a); b = t[i].b + f * (t[i + 1].b - t[i].b); break;
    }
    const q = Math.min(1 - 1e-6, Math.max(1e-6, p)), z = a + b * Math.log(q / (1 - q));
    return clamp(1 / (1 + Math.exp(-z)));
  }
  /** Fit Platt parameters (raw scale) from [[p, outcome], ...]. */
  function fitPlatt(pairs) {
    const X = pairs.map(([p]) => { const q = Math.min(1 - 1e-6, Math.max(1e-6, p)); return [Math.log(q / (1 - q))]; });
    const m = fit(X, pairs.map(r => r[1]), pairs.map(() => 1), false, 30);
    if (!m.w) return { a: 0, b: 1 };
    return { a: m.w[0] - m.w[1] * m.mu[0] / m.sd[0], b: m.w[1] / m.sd[0] };
  }

  /** Build the data bundle the model needs from loaded JSON docs. */
  function bundle(docs) {
    const T = series(docs.target), P = docs.presidio ? series(docs.presidio) : null, R = docs.storage ? series(docs.storage) : null;
    const years = []; for (let y = yearOf(T.start); y <= yearOf(T.end); y++) years.push(y);
    const aux = {}; if (docs.oni) aux.oni = oniLookup(docs.oni); if (docs.rain) aux.rain = rainLookup(docs.rain);
    // Regime memory: log10 of mean daily flow at the target gauge over the 365 days ending on d (>=80% coverage).
    aux.m365 = d => { let s = 0, n = 0; for (let i = 0; i < 365; i++) { const v = T.get(d - i); if (v !== undefined) { s += v; n++; } } return n >= 292 ? Math.log10(Math.max(s / n, 1)) : null; };
    return { T, P, R, years, aux };
  }

  return { SPECS, DEFAULT_SPEC, P_MIN, P_MAX, L2, WINDOW, STEP, BLEND_A, BLEND_B,
    dn, toDate, yearOf, isoToDn, dnToIso, sameDay, series, bundle,
    oniLookup, rainLookup, outcome, classify, xBase, xUp, xStore, features, sample, fit, predict, forecast, quadWeight, recalibrate, fitPlatt, clamp };
});
