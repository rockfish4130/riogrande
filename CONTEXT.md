# Rio Grande / Big Bend flow project: full context

> **What this file is.** A complete technical handoff for this repo, written so you can paste it into an AI coding assistant (or read it yourself) and keep building. It covers what exists, how it works, every data source and its traps, the model's exact specification and validation results, what was tried and didn't work, and a prioritized roadmap. Last major update: 2026-09-30 (planner model v2).
>
> **Canonical copy:** <https://github.com/rockfish4130/riogrande/blob/main/CONTEXT.md>. Fork the repo and go in your own direction; everything is static HTML plus a stdlib-only Python script.

---

## 1. What the project is

A small static website that answers one practical question:

**"When is there enough water, but not too much, to canoe the Rio Grande from Colorado Canyon (Big Bend Ranch State Park) through Santa Elena Canyon (Big Bend National Park), roughly a week-long trip?"**

- **Flow chart** (`index.html`): daily discharge near Castolon, overlaying any years 2007–present, with an optional "historical normal" band.
- **Trip planner** (`planner.html` + `model.js`): a statistical model giving the probability that a trip starting on a given date stays within a target flow range every day. It's trained on 90 years of daily flow at Johnson Ranch and weighted toward recent years, with a calibration correction, validation tables, a climatology view comparing all years to the last 20, and upstream conditions.

Live site: <https://rockfish4130.github.io/riogrande/> · Planner: <https://rockfish4130.github.io/riogrande/planner.html>

### Flow targets (from the river guide)

Southwest Paddler's guides for [Colorado Canyon](https://southwestpaddler.com/docs/riogrande2.html) (Redford → Lajitas, 34 mi) and [Santa Elena Canyon](https://southwestpaddler.com/docs/riogrande3.html) (Lajitas → Santa Elena take-out, ~22 mi) give identical numbers:

| | cfs |
|---|---|
| Minimum | 200 |
| Optimum | 300–1,000 |
| Maximum | 1,200 |

The guides **do not name a gauge**, and their gauge links are dead. See §6 for the gauge question.

A reference trip that anchors intuition: put in near Colorado Canyon **Nov 12, 2016**, take out below Santa Elena **Nov 18, 2016**. Castolon daily means were 286 → 209 cfs, steadily falling. The paddler described it as "approaching bare minimum by the last day." A 14,600 cfs flash flood had passed on Nov 4, 2016.

---

## 2. Repo map

```
index.html                  Flow chart page (vanilla JS + inline SVG, no libraries) - USGS Castolon data
planner.html                Trip planner page (loads model.js; everything computed in the browser)
model.js                    THE model (UMD: window.RGModel in the browser, require() in Node). Single source of truth.
CONTEXT.md                  This file
data/index.json             USGS: {"site","name","years":[...],"through":"YYYY-MM-DD","updated":"..."}
data/YYYY.json              USGS Castolon: {"year":2016,"rows":[["MM-DD", mean, min, max], ...]}  cfs; min/max may be null
data/stats.json             USGS daily statistics: {"begin","end","fields":[...],"rows":[["MM-DD", ...fields]]}
data/ibwc/<key>.json        IBWC long-record series: {"key","dataset","name","unit","start":"YYYY-MM-DD","end","v":[daily values, null = missing]}
                              keys: johnson_ranch, presidio, conchos_ojinaga, terlingua (cfs); la_boquilla (million m3)
data/ibwc/index.json        Summary of the IBWC files (name, unit, start, end, days with data)
data/climate/oni.json       NOAA CPC Oceanic Niño Index: {"source","note","rows":[["DJF",1950,-1.53],...]}  (year = middle month's year)
data/climate/conchos_rain.json  CHIRPS monthly basin-mean rainfall: {"source","region","polygon":[[lon,lat],...],"unit","months":{"1981-01":mm,...}}
vendor/leaflet-1.9.4/       Leaflet (BSD-2) for the planner's sources map. Vendored so the page has no external JS.
data/validation.json        Cross-validation results for every model spec + recalibration table (written by scripts/validate.mjs)
scripts/update_data.py      USGS pull -> data/*.json (Python stdlib only)
scripts/update_ibwc.py      IBWC pull -> data/ibwc/*.json (Python stdlib only)
scripts/update_climate.py   ONI + CHIRPS pull -> data/climate/*.json (needs numpy + rasterio; CHIRPS read via HTTP range requests on COGs)
scripts/validate.mjs        Node: cross-validates all specs in model.js, fits the recalibration, writes data/validation.json (~3 min)
.github/workflows/update-data.yml   Daily 12:17 UTC: USGS + IBWC + climate pulls, commit if changed (manual "backfill" option for USGS)
.github/workflows/validate.yml      Weekly (Mon) + on changes to model.js/validate.mjs: re-run validation, commit
```

- **No build step.** GitHub Pages serves the repo root from `main`. Run locally with `python3 -m http.server` in the repo root, then open <http://localhost:8000/planner.html>. The pages `fetch()` JSON, so `file://` won't work.
- **Data is cached in the repo.** Browsers never call USGS or IBWC. The Actions commit updated JSON, and each commit triggers a Pages redeploy (~1 min).
- USGS: the current and previous year are re-pulled daily. IBWC: each series' full record is re-pulled daily (a few hundred KB each), so revisions flow in.
- Workflows commit only when files actually change, and they `git pull --rebase` before pushing.

## 3. Data sources in use (USGS)

### 3.1 Gauge

**USGS 08374550, Rio Grande near Castolon, TX.** About 29.138, −103.525. Downstream of the Santa Elena Canyon mouth and the Terlingua Creek confluence. Continuous daily record since **Aug 2007**.

### 3.2 Daily values API (RDB)

```
https://waterservices.usgs.gov/nwis/dv/?format=rdb&sites=08374550&parameterCd=00060&startDT=2026-01-01&endDT=2026-12-31
```

⚠️ **Column trap.** The RDB has three value columns and the **max comes first**:

| column suffix | statistic |
|---|---|
| `_00060_00001` | daily **max** |
| `_00060_00002` | daily **min** |
| `_00060_00003` | daily **mean** |

Always select by suffix, never by position. An earlier summarizer got this wrong and swapped peak and mean. `update_data.py` does it correctly.

- Rows start `USGS\t08374550\tYYYY-MM-DD`. Qualifier `P` = provisional, `A` = approved.
- USGS returns **404** when there's no data in the range, and occasionally **503**. The script retries with 30 s / 60 s / … backoff.
- Instantaneous values (today's partial day): the same URL with `/nwis/iv/`.

### 3.3 Daily statistics (the "historical normal" overlay)

```
https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites=08374550&parameterCd=00060&statReportType=daily&statTypeCd=all
```

Columns are parsed by name: `month_nu, day_nu, begin_yr, end_yr, count_nu, max_va_yr, max_va, min_va_yr, min_va, mean_va, p05_va, p10_va, p20_va, p25_va, p50_va, p75_va, p80_va, p90_va, p95_va`. Written to `data/stats.json` with fields `["mean","p05","p10","p25","p50","p75","p90","p95","min","max"]`. Based on approved data only.

On this flashy river the **mean is badly skewed by floods**. On Sep 9 the median is 384 cfs and the mean is 2,050. Use the median as "typical."

---

## 4. Flow chart page (`index.html`)

- X axis: Jan 1 – Dec 31, indexed on leap-year slots (366) so Feb 29 has a place. Y axis: log, 1 to 30k cfs (100k if a selected year exceeds 30k). Zeros are drawn at 1 cfs.
- Year chips allow up to 8 overlays. **Color follows the year, not its position**: a slot is assigned on selection and freed on deselection. The 8-color categorical palette is validated for color-vision deficiency in light and dark themes.
- The URL hash holds state: `#years=2026,2016&stats=1`.
- Optional daily min–max shading and peak callouts (highest daily max per year). Callouts and direct labels are shown only when ≤4 years are selected.
- "Historical normal" draws the USGS p10–p90 and p25–p75 bands, a dashed median, and a dotted mean.
- Per-year summary table (days, peak daily max, highest daily mean, median, days at 0 cfs) and a collapsible daily data table.

---

## 5. Trip planner model v2 (`model.js`), exact specification

The same `model.js` runs in the browser (the planner) and in Node (`scripts/validate.mjs`), so the validated model and the displayed model can't drift apart. It's plain JavaScript: weighted ridge logistic regression via Newton–Raphson, with small Gaussian-elimination solves.

**History:**

- **v1** (first release): trained on Castolon, 2007+ only (~18 seasons), no weighting.
- **v2** (current): Johnson Ranch target, the full 1936+ record, recency weighting, and a calibration correction.

### 5.1 Target

A trip starting on day *t* with length *L* (default 7) is **runnable** iff the **daily mean** at **Johnson Ranch (IBWC 08375000)** satisfies `lo ≤ Q ≤ hi` on **every** day *t … t+L−1*. The defaults are `lo=200`, `hi=1200`, and the "Ideal" preset is 300–1,000. Any missing day makes the outcome unknown, and it's excluded. Johnson Ranch stands in for Castolon (§6).

### 5.2 Predictors (functions in model.js)

- `xBase` = log10(max(1, min daily mean at the target gauge over the 7 days ending on the as-of date)). Needs ≥5 of 7 days. This is **the only predictor in the default model.**
- `xUp` = log10 of the Presidio (08374200) mean over the 3 days ending on the as-of date. Tested; not in the default.
- `xStore` = La Boquilla storage in km³ (latest value within 7 days). Tested; not in the default.
- `oni` (`oniLookup`) = the ONI anomaly for the latest 3-month season *published by* the as-of date. It uses the season ending last month if the as-of day is ≥10, otherwise the one ending two months back. Tested; not in the default.
- `rain` (`rainLookup`) = log((R4 + 10) / (N4 + 10)), where R4 is CHIRPS basin rainfall summed over the 4 most recent months *published by* the as-of date (a month counts as available from the 21st of the following month), and N4 is the 1991–2020 normal for those calendar months. Tested; not in the default.

### 5.3 Model

For as-of date *d* and lead *k* (start date = *d+k*), a separate weighted logistic regression is fit for each *k*:

```
P = σ(β0 + β1·z1 + β2·z1² [+ β·z_up] [+ β·z_store])     z = standardized features (weighted mean/sd)
```

- **Quadratic blend:** the quadratic term on `xBase` has weight 1 for k ≤ 30, falls linearly to 0 at k = 60, and is 0 beyond. The prediction is `w·P_quad + (1−w)·P_linear`.
- **Training sample:** every year ≥ `minYear` except the excluded year. For each year, the pairs (features on day d′, outcome of the trip starting d′+k) for d′ within ±10 days of the same calendar date, every 2 days. That's ~11 pairs per year, ~1,000 per fit. **The effective sample size ≈ the number of years**, because neighboring pairs are heavily autocorrelated.
- **Recency weighting:** year *y* gets weight `0.5^(|refYear − y| / half)`. For live forecasts `refYear` = the as-of year. Default half = **12 years**.
- **Fit:** ridge λ = 1 on the standardized slopes, Newton–Raphson for 25 iterations (15 in validation).
- **Calibration correction (default on):** Platt scaling `p' = σ(a + b·logit p)`. The (a, b) pairs are fit per lead (3, 7, 14, 30, 45, 60, 90, 120 d) on the default spec's forward-chained validation forecasts, and interpolated linearly by lead. They're stored in `data/validation.json → results[range].recalibrated.params`. The correction applies only to the default spec, 7-day trips, and a validated range (200–1,200 or 300–1,000). Otherwise the page falls back to raw probabilities and says so.
- **Output clamp:** [2%, 95%].
- **Base rate:** the weighted mean outcome in the same training sample, shown as the dashed line.
- **Extrapolation:** if the current `xBase` is outside the training range, the page shows a warning.

### 5.4 Candidate specs (all in `model.js → SPECS`)

| key | predictors | years | half-life |
|---|---|---|---|
| v1-like | base | 2007+ | none |
| A | base | 1936+ | none |
| A-h25 / A-h12 / A-h8 / A-h5 | base | 1936+ | 25 / 12 / 8 / 5 yr |
| B, B-h25, B-h12, B-h8 | base + Presidio | 1936+ | none / 25 / 12 / 8 |
| C | base + Presidio + storage | 1993+ | none |
| C-h12 | base + Presidio + storage | 1993+ | 12 |
| A-h12-1950 / E-h12 | base / base + ONI | 1950+ | 12 |
| A-h12-1982 / R-h12 / ER-h12 | base / base + rain / base + ONI + rain | 1982+ | 12 |

Each added climate input has a baseline trained on exactly the same years (`A-h12-1950`, `A-h12-1982`), so a gain or loss isn't just a side effect of the shorter record.

### 5.5 Validation (`scripts/validate.mjs`)

- **Evaluation years:** 2008–2025. Forecasts are issued every 10 days across the year, at leads 3/7/14/30/45/60/90/120 d, for 7-day trips. Only (date, lead) cases where every spec can forecast are scored.
- **Schemes:**
  - **forward:** train only on years < target year. This is realistic and is the primary scheme.
  - **loyo:** train on all other years.
- **Score:** the Brier skill score against a **common reference**, the unweighted 1993+ base rate for that date and lead (target year excluded; for forward, years < target). "Fall" = issued Aug–Nov (day of year 212–334).
- **Selection rule (fixed in advance):** the score is mean forward BSS over leads 3–60 d, 200–1,200 cfs, fall. **A challenger replaces the default only if it wins by more than 0.02**; `validation.json → selection.recommended` applies that rule. Scores:

| spec | score | | spec | score |
|---|---|---|---|---|
| **A-h12** | **0.316** | | A-h5 | 0.287 |
| B-h12 | 0.313 | | B | 0.270 |
| B-h8 | 0.312 | | C-h12 | 0.242 |
| A-h25 / A-h8 | 0.310 | | C | 0.240 |
| B-h25 | 0.299 | | v1-like | 0.115 |
| A | 0.294 | | E-h12 (+ONI) | 0.302 |
| A-h12-1982 | 0.318 | | R-h12 (+rain) | 0.254 |
| A-h12-1950 | 0.316 | | ER-h12 (+both) | 0.227 |

  A-h12-1982 scored highest, but only by 0.002, so under the rule A-h12 stays the default. A-h12, A-h8, B-h12 and B-h8 are all within noise of each other.

**Default model skill** (forward, 200–1,200 cfs):

| Lead (d) | 3 | 7 | 14 | 30 | 45 | 60 | 90 | 120 |
|---|---|---|---|---|---|---|---|---|
| A-h12 raw, all year | +0.44 | +0.41 | +0.39 | +0.30 | +0.22 | +0.16 | +0.06 | +0.05 |
| A-h12 **+ calibration**, all year | +0.46 | +0.43 | +0.40 | +0.31 | +0.24 | +0.21 | +0.13 | +0.11 |
| A-h12 **+ calibration**, fall | +0.34 | +0.34 | +0.35 | +0.31 | +0.29 | +0.29 | +0.20 | +0.20 |

The recalibrated skill is scored by leaving out one year from the *recalibration fit* too: the correction applied to year *y* is fit on the other years' forward forecasts. Residual optimism: the correction is fit using years after *y*, so it knows the 2008–2025 regime as a whole.

**Calibration** (forward, 200–1,200, predicted → observed):

- Raw A-h12: 0.04→0.03, **0.19→0.12, 0.39→0.23, 0.61→0.49**, 0.79→0.72, 0.90→0.86. Too high in the middle range. Every spec shows this, because 2008–2025 was drier than the weighted training set.
- With the correction: 0.05→0.06, 0.16→0.14, 0.40→0.40, 0.59→0.60, 0.79→0.80, 0.94→0.92.

### 5.6 What was tried and didn't help (negative results)

- **Presidio flow (`xUp`)**: no gain at any lead, including 3 days. Once Johnson Ranch baseflow is known, Presidio adds little for week-long windows, and big upstream pulses are rare on any given issue date. It might still matter for a same-week "go/no-go" at leads of 0–2 days, which weren't scored.
- **La Boquilla storage (`xStore`)**: slightly *worse*. It forces training to 1993+, which loses 57 years, and its signal (Oct-1 storage terciles → November runnable share 46/58/78%) seems mostly captured by current baseflow already.
- **No recency weighting** (spec A): good at short leads but negative skill beyond 90 d. The regime has shifted (§7.1 decade table).
- **v1 design (2007+ only)**: fine under leave-one-year-out (it learns from future years) but poor under forward chaining (≈ +0.12).
- **ENSO (ONI)**: −0.01 to −0.03 vs its same-years baseline at every lead. For 1982–2025, the Oct-1 ONI correlates −0.01 with the November runnable share and −0.01 with Jan–Mar. After accounting for baseflow, the partial correlation is +0.04. November runnable share was 81% / 60% / 68% for La Niña / neutral / El Niño on Oct 1, with n = 5 / 31 / 8: noise. ENSO mainly moves cool-season rain, while this reach runs on the summer monsoon and managed releases.
- **Monsoon rainfall (CHIRPS)**: −0.05 to −0.07 vs baseline, except a small, scheme-dependent gain at 90–120 d leads. The raw signal is real: November was runnable 54% / 60% / 76% after dry / middle / wet 4-month rainfall terciles, and rainfall correlates +0.22 with November and +0.31 with Jan–Mar. But it correlates +0.42 with Oct-1 baseflow. The partial correlation after baseflow is +0.02 for November and +0.17 for Jan–Mar. The river's baseflow already encodes the monsoon, and the extra input mostly adds variance. The Jan–Mar partial (+0.17) is the one thread worth pulling for long-lead winter forecasts, perhaps with a lead-specific or seasonal model.

### 5.7 Other planner views

- **Upstream right now:** tiles for Presidio and the Rio Conchos at Ojinaga (3-day means), La Boquilla storage, Conchos basin rainfall (% of normal, last 4 published months), and ENSO state. Each is ranked against the same date in other years where that makes sense.
- **Where the data comes from:** a Leaflet map (OpenStreetMap tiles) of every gauge, reservoir, trip access point, the approximate trip route and the approximate Conchos basin polygon. There are "Whole basin" / "Big Bend reach" views, and a sources table with live links (IBWC portal location pages, USGS, NWS PRST2, CHIRPS, CPC ONI, the river guides). Clicking a row flies the map to that source. Coordinates come from the IBWC portal's location summaries.
- **Climatology:** runnable share by start date for the last 20 years vs all years since 1936, and a canvas grid of every year × start date (newest at top) colored ideal / workable / too low / too high / no data. The 2016 trip is outlined.
- **Monthly table:** the share of years with ≥1 runnable start in each month, for all years and the last 20.
- **Validation tables** read from `data/validation.json`, with toggles for range, scheme and season. The row in use is highlighted.
- **URL hash state:** `#asof=YYYY-MM-DD&len=7&lo=200&hi=1200[&model=KEY][&recal=0]`. A past as-of date gives a true hindcast (that year is held out) with an "actual outcome" strip.

### 5.8 Readings as of 2026-09-30

- **2026 climate context:** strong El Niño (JJA ONI +1.80). May–Aug Conchos basin rainfall was 68% of normal (4th driest of 45 years since 1982 for that date). Neither is used by the default model (§5.6).
- **2026:** Johnson Ranch 7-day minimum is **3.5 cfs**, the **lowest of 91 years for that date**. The model gives ≤8% for any start in the next 90 days and flags that it's extrapolating. La Boquilla holds ~650 million m³, low (5th lowest of 34 years since 1993 on that date). **Watch:** on 2026-09-30 the Presidio 15-min telemetry jumped from ~2 m³/s to ~17 m³/s (~600 cfs), with the Conchos at Ojinaga also rising. It wasn't yet in the daily series or at Johnson Ranch when this was written.
- **2016 hindcast** (as of Oct 1, 2016, with 2016 held out): early-to-mid November starts ~58–63% with the correction. Actual: the Nov 12–18 trip was runnable, near the minimum by the end.

## 6. The gauge question (important assumption)

The guides' thresholds don't name a gauge. v1 targeted **Castolon (USGS 08374550)**, the only gauge on the reach with a public API and a continuous daily record (from 2007). v2 targets **Johnson Ranch (IBWC 08375000)** for its 1936+ record, on the evidence below that it's effectively the same measurement. The flow chart still shows Castolon.

Evidence gathered since:

- **Johnson Ranch (IBWC 08375000)**, just downstream of Castolon, matches Castolon almost exactly. Over 6,998 overlapping days (2007–2026), the median JR/Castolon ratio for flows of 50–3,000 cfs is **1.00** (p10 0.65, p90 1.33), and the 7-day 200–1,200 "runnable" classification **agrees 95.5% of the time**. So Johnson Ranch is a valid long-record stand-in for Castolon.
- **Presidio below the Conchos (IBWC 08374200)** reads *lower* than Castolon at baseflow. During the 2016 trip: Presidio 180 → 141 cfs vs Castolon 286 → 209. There are gains between Presidio and Castolon (Alamito Creek, springs, Terlingua Creek).
- The 2016 paddler's lived experience ("near bare minimum by the end") lines up with **Castolon ≈ 209 cfs** better than Presidio's 141. That's weak evidence (one trip), but it points the same way.

**Caveat for Colorado Canyon specifically:** it's upstream of Lajitas, so Presidio-area flow is physically closer to what's in that canyon. A two-gauge rule (e.g. Presidio ≥ X *and* Castolon in range) is a reasonable extension.

---

## 7. Data-source feasibility findings (2026-09-30)

All of these were tested from a scripted client.

### 7.1 IBWC Water Data Portal (AQUARIUS WebPortal): the big win

`https://waterdata.ibwc.gov/AQWebportal/` is Aquatic Informatics' AQUARIUS WebPortal. There's no documented public API, but the web app's own endpoints work.

**Session:** the **export endpoint needs no session at all** (tested 2026-09-30; `scripts/update_ibwc.py` just GETs it). The discovery endpoints below are the web UI's own. Accepting the disclaimer (`GET /AQWebportal/Disclaimer`, then `POST /AQWebportal/AcceptDisclaimer` with `returnUrl=/AQWebportal/Data`) was unreliable in testing. It sometimes redirected to `/NotFound`, but the discovery calls worked with the cookies from the GET anyway.

**Discovery endpoints** (POST, form-encoded, `X-Requested-With: XMLHttpRequest`):

- `POST /AQWebportal/Data/Data_List` with `page=1&pageSize=5000` returns JSON `{Data:[{LocationId, LocationIdentifier, Location, LocType, LocationFolder,...}], Total}` (228 locations).
- `POST /AQWebportal/Data/Data_Location?location=<LocationId>` with `page=1&pageSize=100` returns the datasets for that location: `{Identifier, Parameter, Unit, StartTime, EndTime, ...}`.

**Export** (GET, returns a **zip** containing one CSV):

```
/AQWebportal/Export/Dataset?Dataset=<Identifier>&DateRange=EntirePeriodOfRecord&ExportFormat=csv
    DateRange also accepts Days7
```

- CSV: line 1 is a `#Data Set Export - …` comment, line 2 is the header `Timestamp (UTC-06:00),Value (<unit>)`, then `YYYY-MM-DD HH:MM:SS,value` rows, then a long disclaimer row at the end.
- ⚠️ The CSV contains literal `NaN` values on some gap days. Drop them, or `JSON.parse` will choke downstream.
- ⚠️ **Units differ by dataset.** `Discharge.Daily Rounded cfs@…` is ft³/s. `Discharge.Best Available@…` (15-min telemetry) is **m³/s** (multiply by 35.3147). Reservoir datasets are in m³/s ("cms") and million m³ ("mcm").

**Key datasets (LocationId → dataset identifier, record span):**

| Site | LocationId | Dataset | Record |
|---|---|---|---|
| Rio Grande below Rio Conchos nr Presidio (08374200) | 233 | `Discharge.Daily Rounded cfs@08374200` | **1900-05-01 →** present (112 yrs with data; 1914 partial, 1915–29 missing) |
| Rio Grande at Johnson Ranch nr Castolon (08375000) | 236 | `Discharge.Daily Rounded cfs@08375000` | **1936-04-01 →** present, no missing years |
| Terlingua Creek nr Terlingua (08374500) | 235 | `Discharge.Daily Rounded cfs@08374500` | 1932 → present |
| Rio Conchos nr Ojinaga (08373000) | 230 | `Discharge.Daily Rounded cfs@08373000` | 1954 → present |
| Rio Grande above Rio Conchos nr Presidio (08371500) | 229 | `Discharge.Daily Rounded cfs@08371500` | 1900 → present (usually ~0: the "Forgotten River") |
| La Boquilla Reservoir (Conchos) | 536 | `Total Storage.CONAGUA-Web-Daily-Storage-mcm@08-LBQCH-CONAGUA` | **1993 →** present |
| La Boquilla | 536 | `Reservoir Elevation.CONAGUA-SIH-Daily-Elevation-m@…` | 1935 → 2024-04 (could be converted to storage with an area–capacity curve) |
| La Boquilla | 536 | `Discharge.CONAGUA-Web-Daily-Total-Release-cms@…`, `…Release-cms`, `…Spill-cms` | 1992–93 → present |
| La Boquilla | 536 | `Precip Total.CONAGUA-SIH-Daily-Precip-mm@…` | 1961 → 2024-04 |
| Luis L. León, Francisco I. Madero, San Gabriel, Pico del Águila, Chihuahua, El Rejón reservoirs | 526, 537, 541, 540, 538, 539 | `Total Storage.CONAGUA-Daily-Storage@…`, `Percentage.CONAGUA-Daily-Percent-NAMO@…`, releases | mostly 2015–16 → present |
| 1944 Treaty accounting | 557 | `Discharge.Six-Mx-Tributary-Total-cms@08-1944-5yr` | 1954 → present (current-cycle series 2020→) |

**Quick signal checks** (Johnson Ranch, Nov 7-day windows, 200–1,200 cfs):

- **La Boquilla storage on Oct 1** (1993–2025, terciles): November runnable share **46% / 58% / 78%** for low / mid / high storage. That's a real signal, and it's somewhat independent of current baseflow (e.g. 2016: storage high but November only 30% runnable, because of floods and high water early in the month).
- **Non-stationarity by decade** (November runnable share at Johnson Ranch): 1940s 43%, 1950s 70%, 1960s 83%, 1970s 66%, 1980s 69%, 1990s 92%, 2000s 54%, 2010s 61%, **2020s 28%** (partial). Management, allocation and drought have shifted the regime. **Don't train on 90 years as if they're exchangeable.** Weight recent decades, add a trend or regime term, or validate with blocked-by-decade cross-validation.

### 7.2 Other sources

| Source | Access | Notes |
|---|---|---|
| ENSO ONI | `https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt` (plain text, `SEAS YR TOTAL ANOM`, 1950→) | **Now in `data/climate/oni.json`.** Tested: no gain (§5.6). |
| NWS river gauge Presidio (PRST2) | `https://api.water.noaa.gov/nwps/v1/gauges/PRST2` and `/stageflow` | Observed stage/flow works (0.597 kcfs on 2026-09-30). **No forecast issued** (`fcst_not_current`) at test time, so don't rely on it. |
| CHIRPS rainfall | **Use the COGs:** `https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_monthly/cogs/chirps-v2.0.YYYY.MM.cog` (1981→; final data lags ~3 weeks). Read a window with rasterio via `/vsicurl/` (HTTP range requests, ~5 s/month) instead of downloading 14.6 MB tifs or the 7.2 GB netCDF. The server resets connections often, so retry. | **Now in `data/climate/conchos_rain.json`** (548 months, full backfill in ~2 min with 8 threads). Tested: no gain (§5.6). |
| ERA5 | `cds.climate.copernicus.eu` | Needs a free account/API key. 1940→. Optional. |
| CONAGUA direct (`sih.conagua.gob.mx`, `smn.conagua.gob.mx`) | Not needed | IBWC already mirrors the Conchos reservoir series. |

---

## 8. Roadmap

**Done in v2:** Johnson Ranch as the training target (1936+); recency weighting (half-life chosen by validation); Presidio and La Boquilla tested (no gain, documented); Platt recalibration; upstream tiles; a shared `model.js` for browser and Node; weekly validation Action.

**Next, in rough priority order:**

*(ENSO and monsoon rainfall were tested on 2026-09-30: no gain; see §5.6.)*

1. **Seasonal model for winter leads.** Monsoon rainfall keeps a +0.17 partial correlation with Jan–Mar runnability after baseflow. A lead- or season-specific model (e.g. rain enters only for targets in Dec–Mar) might capture that without hurting fall.
2. **A real basin boundary.** Replace the hand-drawn Conchos polygon with HydroSHEDS / CONAGUA, and consider upper-basin-only rainfall (above La Boquilla).
3. **Forward-chained recalibration.** Fit the Platt correction for year *y* only on years < *y*, to remove the residual optimism noted in §5.5. This needs forward forecasts before 2008 (e.g. evaluate 1990–2025).
4. **Nested selection.** The half-life and spec were picked on the same 2008–2025 data they're scored on. A nested scheme (select on years < *y*) would give an unbiased skill estimate. Expect slightly lower numbers.
5. **Same-week layer (leads 0–3 d).** This is where Presidio/Ojinaga upstream flow and NWS rainfall forecasts should matter. Consider a separate short-lead model scored on leads 0–3.
6. **Colorado Canyon two-gauge rule.** Require Presidio ≥ X as well as Johnson Ranch in range, for trips that start above Lajitas.
7. **Storm-risk climatology.** The chance of any day > 1,200 cfs within the window, by date, shown separately from the baseflow outlook.

### Pitfalls to avoid

- **Leakage:** always hold out the whole target year (and ideally neighbors). Pairs within a year are heavily autocorrelated.
- **Overfitting:** the effective N is the number of years (~90, and far fewer that resemble today's regime). Keep models to a handful of parameters, and report forward-chained skill, not in-sample fit.
- **Non-stationarity:** decades aren't exchangeable (§7.1). Unweighted long-record models look fine at short leads and fail at long ones.
- **Same code path:** validate the exact `model.js` the page runs. Don't reimplement the model in Python for validation.
- **Units:** IBWC mixes cfs and m³/s (§7.1). USGS RDB column order (§3.2).
- **Provisional data:** recent values get revised. The Action re-pulls the current and previous year for this reason.
- **Human decisions:** Conchos releases are managed (irrigation districts; Mexico's 1944 Treaty delivery obligations over 5-year cycles). No hydrologic model can foresee a release decision.

---

## 9. Conventions

- Static site, no framework, no build, no external JS. Leaflet is vendored in `vendor/`, and only the OpenStreetMap tiles are external. Inline SVG charts, and canvas for the 90-year grid. Chart CSS is scoped to `.plot svg`: a global `svg{width:100%}` breaks Leaflet's vector layer. CSS custom properties for light/dark themes (`prefers-color-scheme` plus a `data-theme` override).
- The data pipeline is Python standard library only, so it runs on a bare GitHub runner.
- Commit data only when it changes. Keep `data/*.json` compact (no whitespace in the year files).
- Parse external formats by column name/suffix, never by position.
- Every model change should re-run `node scripts/validate.mjs` (or let the workflow do it) and update §5 of this file.

## 10. Open questions

- Why does every spec overforecast mid-range probabilities in 2008–2025? Is it purely the regime shift, or also the ±10-day pooling mixing in wetter neighboring dates?

- Is Castolon (or Johnson Ranch) really the gauge the guide's thresholds were written for? It might be Presidio or Lajitas. A second data point from another trip would help.
- Travel time and attenuation Presidio → Castolon at different flows.
- Whether ENSO adds skill for this basin at 3–6 month leads.
- How to model the treaty-cycle position (Oct 2025 started a new 5-year cycle) as a predictor of release behavior.
