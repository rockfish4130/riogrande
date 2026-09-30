# Rio Grande / Big Bend flow project: full context

> **What this file is.** A complete technical handoff for this repo, written so you can paste it into an AI coding assistant (or read it yourself) and keep building. It covers what exists, how it works, every data source and its traps, the model's exact specification and validation results, and a prioritized roadmap based on data-access work done on 2026-09-30.
>
> **Canonical copy:** <https://github.com/rockfish4130/riogrande/blob/main/CONTEXT.md>. Fork the repo and go in your own direction; everything is static HTML plus a stdlib-only Python script.

---

## 1. What the project is

A small static website that answers one practical question:

**"When is there enough water, but not too much, to canoe the Rio Grande from Colorado Canyon (Big Bend Ranch State Park) through Santa Elena Canyon (Big Bend National Park), roughly a week-long trip?"**

- **Flow chart** (`index.html`): daily discharge near Castolon, overlaying any years 2007–present, with an optional "historical normal" band.
- **Trip planner** (`planner.html`): a statistical model giving the probability that a trip starting on a given date stays within a target flow range every day, plus a climatology view and live cross-validation.

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
index.html                  Flow chart page (vanilla JS + inline SVG, no libraries)
planner.html                Trip planner page (model runs in the browser, no libraries)
CONTEXT.md                  This file
data/index.json             {"site","name","years":[...],"through":"YYYY-MM-DD","updated":"..."}
data/YYYY.json              {"year":2016,"rows":[["MM-DD", mean, min, max], ...]}   cfs; min/max may be null
data/stats.json             USGS daily statistics: {"begin","end","fields":[...],"rows":[["MM-DD", ...fields]]}
scripts/update_data.py      Pulls USGS data → data/*.json (Python stdlib only)
.github/workflows/update-data.yml   Daily cron (12:17 UTC) + manual "backfill" dispatch
```

- **No build step.** GitHub Pages serves the repo root from `main`. Run locally with `python3 -m http.server` in the repo root, then open <http://localhost:8000/>. The pages `fetch()` JSON, so `file://` won't work.
- **Data is cached in the repo.** Browsers never call USGS. The Action commits updated JSON, and each commit triggers a Pages redeploy (~1 min).
- The Action re-pulls **the current and previous year** daily, so USGS provisional revisions flow in. `workflow_dispatch` with `backfill=true` re-pulls every year since 2007.
- It commits only when data actually changed. `index.json.updated` changes only then.

---

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

## 5. Trip planner model (`planner.html`), exact specification

Everything is computed client-side from `data/*.json`. The model is plain JavaScript (logistic regression via Newton–Raphson, Gaussian elimination for the 2×2 / 3×3 solves).

### 5.1 Target

A trip starting on day *t* with length *L* (default 7) is **runnable** iff the USGS **daily mean** at Castolon satisfies `lo ≤ Q ≤ hi` on **every** day *t … t+L−1*. The defaults are `lo=200`, `hi=1200`, and the "Ideal" preset is 300–1,000. Any missing day makes the outcome unknown, and it's excluded.

### 5.2 Predictor

`x = log10(max(1, min(daily mean over the 7 days ending on the as-of date)))`. At least 5 of the 7 days must be present.

Rationale: the 7-day minimum approximates **baseflow** and ignores storm spikes, which pass in days. The log handles 0 to ~50k cfs.

### 5.3 Model

For as-of date *d* and lead *k* (start date = *d+k*), a separate logistic regression is fit for each *k*:

```
P(runnable) = σ(β0 + β1·x + β2·x²)
```

- The quadratic weight is 1 for k ≤ 30, falls linearly to 0 at k = 60, and is 0 after that. For k between 30 and 60 the prediction is `w·P_quad + (1−w)·P_linear`. The blend removes a visible step where the two models meet.
- **Training sample:** for every year except the as-of year, the pairs (x on day d′, outcome of the trip starting d′+k) for d′ within ±10 days of the same calendar date, every 2 days. That's about 11 pairs per year, ~200 per fit. **The effective sample size is about the number of years (~18), not 200**, because neighboring pairs overlap heavily.
- Ridge λ = 0.1 on the non-intercept terms, and 25 Newton iterations (15 in cross-validation).
- **Output clamp: [2%, 90%].** The uncapped model was overconfident at the top end (when it said ≥90%, the trip worked 78% of the time).
- **Base rate** = mean outcome in the same training sample. The dashed line on the chart is the benchmark the model has to beat.
- If *x* is outside the training range, the page shows an "extrapolating" warning.

### 5.4 Validation (leave-one-year-out, computed live on the page)

The model is refit without year *y* and then asked to predict year *y*. Forecasts are issued every 10 days across the year, for every year. The score is the Brier skill score against the base rate (0 = no better than the calendar, 1 = perfect). These are the default settings (7 days, 200–1,200):

| Lead | Skill, all issue dates | Skill, issued Aug–Nov |
|---|---|---|
| 7 d | +0.35 | +0.36 |
| 14 d | +0.30 | +0.33 |
| 30 d | +0.19 | +0.33 |
| 45 d | +0.13 | +0.21 |
| 60 d | +0.13 | +0.21 |
| 90 d | +0.04 | +0.10 |
| 120 d | +0.02 | +0.05 |

Calibration was good below 70%, with slight overconfidence at 70–90% (78% forecast vs 72% observed). Values from about 4,900 out-of-sample forecasts.

### 5.5 How the design was chosen

Prototyped in Python and scored by leave-one-year-out Brier skill:

- **Predictors compared:** the 7-day median, the 30-day median, and the 7-day minimum. The 7-day minimum was slightly best at every lead.
- **Quadratic term:** it added skill at short leads (e.g. +0.32 → +0.36 at 7 days) and lost skill beyond ~60 days, hence the blend.
- **Why so few inputs:** with ~18 seasons, additional inputs mostly fit noise.

### 5.6 Other planner views

- **Climatology line:** the share of years runnable, by start date.
- **Year × start-date grid:** each cell is classified ideal / workable / too low / too high / no data, and the 2016 trip is marked.
- **Monthly table:** the share of years with at least one runnable start in each month.
- **URL hash state:** `#asof=YYYY-MM-DD&len=7&lo=200&hi=1200`. A past as-of date gives a true hindcast (that year is held out) with an "actual outcome" strip.

### 5.7 Readings as of 2026-09-30

- **2026:** Castolon baseflow is about 32 cfs, the **lowest of all years on that date**, and the model gives ≤15% for any November start. Caution: on **Sep 30, 2026 the IBWC gauge below the Conchos at Presidio jumped from ~2 m³/s to ~17 m³/s (~600 cfs)**, with the Conchos at Ojinaga also rising. That pulse hadn't reached Castolon when this was written. It's exactly the kind of upstream signal the current model can't see (§8).
- **2016 hindcast:** as of Oct 1, 2016 (2016 held out), early-November starts were ~80%.

---

## 6. The gauge question (important assumption)

The model targets **Castolon (USGS 08374550)** because it's the only gauge on the reach with a long, public, API-accessible daily record at the time the model was built, and because both guides give the same numbers.

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

**Session:**

1. `GET /AQWebportal/Disclaimer?returnUrl=/AQWebportal/Data` sets the `.AspNetCore.Session` and antiforgery cookies.
2. `POST /AQWebportal/AcceptDisclaimer` with form `returnUrl=/AQWebportal/Data` returns a 302 to `/Data`. Keep the cookies. Use a real cookie-handling client: Python `requests.Session()` worked, while curl's cookie jar didn't persist these cookies in testing.

**Discovery endpoints** (POST, form-encoded, `X-Requested-With: XMLHttpRequest`):

- `POST /AQWebportal/Data/Data_List` with `page=1&pageSize=5000` returns JSON `{Data:[{LocationId, LocationIdentifier, Location, LocType, LocationFolder,...}], Total}` (228 locations).
- `POST /AQWebportal/Data/Data_Location?location=<LocationId>` with `page=1&pageSize=100` returns the datasets for that location: `{Identifier, Parameter, Unit, StartTime, EndTime, ...}`.

**Export** (GET, returns a **zip** containing one CSV):

```
/AQWebportal/Export/Dataset?Dataset=<Identifier>&DateRange=EntirePeriodOfRecord&ExportFormat=csv
    DateRange also accepts Days7
```

- CSV: line 1 is a `#Data Set Export - …` comment, line 2 is the header `Timestamp (UTC-06:00),Value (<unit>)`, then `YYYY-MM-DD HH:MM:SS,value` rows, then a long disclaimer row at the end.
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
| ENSO ONI | `https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt` (plain text, `SEAS YR TOTAL ANOM`, 1950→) | JJA 2026 anomaly **+1.80** (strong El Niño developing). Expect a modest effect here (cool-season rain; the Conchos is monsoon-fed), but it has to be tested. |
| NWS river gauge Presidio (PRST2) | `https://api.water.noaa.gov/nwps/v1/gauges/PRST2` and `/stageflow` | Observed stage/flow works (0.597 kcfs on 2026-09-30). **No forecast issued** (`fcst_not_current`) at test time, so don't rely on it. |
| CHIRPS rainfall | `https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_monthly/tifs/chirps-v2.0.YYYY.MM.tif.gz` (~14.6 MB each, 1981→) | Feasible as a one-time backfill: download, clip to the Conchos basin polygon, basin-average, discard. Too heavy to re-run in the daily Action; append monthly. |
| ERA5 | `cds.climate.copernicus.eu` | Needs a free account/API key. 1940→. Optional. |
| CONAGUA direct (`sih.conagua.gob.mx`, `smn.conagua.gob.mx`) | Not needed | IBWC already mirrors the Conchos reservoir series. |

---

## 8. Roadmap (recommended order)

1. **Retarget training onto Johnson Ranch (1936→) and keep Castolon for display.** That's ~90 seasons instead of ~18. Handle non-stationarity explicitly (recency weighting or decade-blocked CV). This one change is expected to help more than any new input.
2. **Add Presidio (08374200) and Conchos at Ojinaga (08373000) as short-lead predictors.** Travel time Ojinaga → Presidio → Castolon is on the order of 1–3 days (verify empirically by lagged cross-correlation). They catch pulses before they reach Castolon, like the 2026-09-30 pulse.
3. **Add Conchos reservoir storage** (La Boquilla 1993→, and the others 2015→), probably as a total or percent-full index, for 1–4 month leads.
4. **Two-stage structure:**
   - *Stage 1:* predict the season's baseflow level (e.g. the median of daily minima for the target month) from storage, current baseflow, Presidio flow, the monsoon rainfall index and ONI.
   - *Stage 2:* map that level plus flash-flood climatology to trip-window odds.

   This keeps the parameter count low relative to the data.
5. **Rainfall:** a CHIRPS Jun–Sep Conchos-basin total as a monsoon index. Test it against storage, which likely already captures most of it.
6. **ENSO and NOAA seasonal outlooks:** add only if leave-one-year-out skill improves. Report the result either way.
7. **Short-range layer:** NWS rainfall forecasts plus a storm-risk climatology (the chance of a >1,200 cfs day within the window, by date).
8. **Two-gauge runnable rule for Colorado Canyon:** see §6.

### Pitfalls to avoid

- **Leakage:** always hold out the whole target year (and ideally neighbors). Pairs within a year are heavily autocorrelated.
- **Overfitting:** with N ≈ 18 (or ~90 with Johnson Ranch), keep models to a handful of parameters. Report cross-validated skill, not in-sample fit.
- **Units:** IBWC mixes cfs and m³/s (§7.1). USGS RDB column order (§3.2).
- **Provisional data:** recent values get revised. The Action re-pulls the current and previous year for this reason.
- **Human decisions:** Conchos releases are managed (irrigation districts; Mexico's 1944 Treaty delivery obligations over 5-year cycles). No hydrologic model can foresee a release decision.

---

## 9. Conventions

- Static site, no framework, no build, no external JS. Inline SVG charts. CSS custom properties for light/dark themes (`prefers-color-scheme` plus a `data-theme` override).
- The data pipeline is Python standard library only, so it runs on a bare GitHub runner.
- Commit data only when it changes. Keep `data/*.json` compact (no whitespace in the year files).
- Parse external formats by column name/suffix, never by position.
- Every model change should update the validation table (§5.4) and this file.

## 10. Open questions

- Is Castolon (or Johnson Ranch) really the gauge the guide's thresholds were written for? It might be Presidio or Lajitas. A second data point from another trip would help.
- Travel time and attenuation Presidio → Castolon at different flows.
- Whether ENSO adds skill for this basin at 3–6 month leads.
- How to model the treaty-cycle position (Oct 2025 started a new 5-year cycle) as a predictor of release behavior.
