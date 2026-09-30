#!/usr/bin/env python3
"""Pull USGS daily discharge for the Castolon gauge and write per-year JSON.

Output:
  data/<YEAR>.json   {"year": 2016, "rows": [["MM-DD", mean, min, max], ...]}
  data/index.json    {"site": ..., "years": [...], "updated": ..., "through": ...}

By default only the current and previous year are refreshed (cheap daily run).
Use --all to backfill every year since the record began, or --years 2016 2026.

Standard library only, so it runs on a bare GitHub Actions runner.
"""
import argparse
import datetime as dt
import json
import pathlib
import sys
import time
import urllib.error
import urllib.request

SITE = "08374550"
SITE_NAME = "Rio Grande nr Castolon, TX"
PARAM = "00060"  # discharge, cfs
FIRST_YEAR = 2007  # continuous record starts here
API = ("https://waterservices.usgs.gov/nwis/dv/?format=rdb&sites={site}"
       "&parameterCd={param}&startDT={start}&endDT={end}")

# USGS statistic codes. Pick columns by these suffixes, NEVER by position:
# the RDB puts max first, then min, then mean.
STAT_MAX, STAT_MIN, STAT_MEAN = "00001", "00002", "00003"

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"


def fetch(url, tries=5):
    for attempt in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "riogrande-flow-chart (github.com/rockfish4130/riogrande)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            if e.code == 404:  # USGS returns 404 when there is no data in range
                return ""
            err = e
        except (urllib.error.URLError, TimeoutError) as e:
            err = e
        wait = 30 * attempt
        print(f"  attempt {attempt} failed ({err}); retrying in {wait}s", file=sys.stderr)
        time.sleep(wait)
    raise RuntimeError(f"giving up on {url}")


def parse_rdb(text):
    """Return {YYYY-MM-DD: (mean, min, max)} parsed by column suffix."""
    lines = [l for l in text.splitlines() if l and not l.startswith("#")]
    if not lines:
        return {}
    header = lines[0].split("\t")

    def col(stat):
        suffix = f"_{PARAM}_{stat}"
        for i, name in enumerate(header):
            if name.endswith(suffix):
                return i
        return None

    ci = {"mean": col(STAT_MEAN), "min": col(STAT_MIN), "max": col(STAT_MAX)}
    if ci["mean"] is None:
        raise ValueError(f"no mean column (*_{PARAM}_{STAT_MEAN}) in header: {header}")
    di = header.index("datetime")

    def num(parts, i):
        if i is None or i >= len(parts):
            return None
        try:
            return float(parts[i])
        except ValueError:  # blank, "Ice", "Eqp", etc.
            return None

    out = {}
    for line in lines[2:]:  # skip header + format row
        parts = line.split("\t")
        if len(parts) < 3 or parts[0] != "USGS":
            continue
        mean = num(parts, ci["mean"])
        if mean is None:
            continue
        out[parts[di]] = (mean, num(parts, ci["min"]), num(parts, ci["max"]))
    return out


def clean(v):
    if v is None:
        return None
    return int(v) if v == int(v) and abs(v) >= 100 else round(v, 2)


def update_year(year, today):
    end = min(dt.date(year, 12, 31), today)
    url = API.format(site=SITE, param=PARAM, start=f"{year}-01-01", end=end.isoformat())
    print(f"{year}: {url}")
    vals = parse_rdb(fetch(url))
    if not vals:
        print(f"  no data for {year}")
        return None
    rows = [[d[5:], clean(m), clean(lo), clean(hi)] for d, (m, lo, hi) in sorted(vals.items())]
    path = DATA / f"{year}.json"
    text = json.dumps({"year": year, "rows": rows}, separators=(",", ":")) + "\n"
    changed = not path.exists() or path.read_text() != text
    if changed:
        path.write_text(text)
    print(f"  {len(rows)} days, through {year}-{rows[-1][0]}{'' if changed else ' (unchanged)'}")
    return changed


STAT_API = ("https://waterservices.usgs.gov/nwis/stat/?format=rdb&sites={site}"
            "&parameterCd={param}&statReportType=daily&statTypeCd=all")
STAT_FIELDS = ["mean", "p05", "p10", "p25", "p50", "p75", "p90", "p95", "min", "max"]


def update_stats():
    """USGS daily statistics: for each calendar day, the mean and percentiles
    over the approved period of record. Written to data/stats.json as
    {"begin": yr, "end": yr, "fields": [...], "rows": [["MM-DD", ...], ...]}."""
    url = STAT_API.format(site=SITE, param=PARAM)
    print(f"stats: {url}")
    lines = [l for l in fetch(url).splitlines() if l and not l.startswith("#")]
    if len(lines) < 3:
        print("  no stats returned")
        return False
    header = lines[0].split("\t")
    print(f"  columns: {header}")
    idx = {n: i for i, n in enumerate(header)}
    need = ["month_nu", "day_nu"] + [f"{f}_va" for f in STAT_FIELDS]
    missing = [n for n in need if n not in idx]
    if missing:
        print(f"  missing columns {missing}; keeping whatever is available")

    def num(parts, name):
        i = idx.get(name)
        if i is None or i >= len(parts) or parts[i] == "":
            return None
        try:
            return clean(float(parts[i]))
        except ValueError:
            return None

    rows, begin, end = [], None, None
    for line in lines[2:]:
        parts = line.split("\t")
        if parts[0] != "USGS":
            continue
        md = f"{int(parts[idx['month_nu']]):02d}-{int(parts[idx['day_nu']]):02d}"
        rows.append([md] + [num(parts, f"{f}_va") for f in STAT_FIELDS])
        b, e = num(parts, "begin_yr"), num(parts, "end_yr")
        begin = b if begin is None or (b is not None and b < begin) else begin
        end = e if end is None or (e is not None and e > end) else end
    rows.sort()
    path = DATA / "stats.json"
    text = json.dumps({"begin": begin, "end": end, "fields": STAT_FIELDS, "rows": rows},
                      separators=(",", ":")) + "\n"
    changed = not path.exists() or path.read_text() != text
    if changed:
        path.write_text(text)
    print(f"  {len(rows)} days, record {begin}-{end}{'' if changed else ' (unchanged)'}")
    return changed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help=f"backfill every year since {FIRST_YEAR}")
    ap.add_argument("--years", type=int, nargs="*", help="specific years to refresh")
    args = ap.parse_args()

    today = dt.date.today()
    DATA.mkdir(exist_ok=True)
    if args.all:
        years = list(range(FIRST_YEAR, today.year + 1))
    elif args.years:
        years = args.years
    else:
        years = [today.year - 1, today.year]

    changed = False
    for y in years:
        changed |= bool(update_year(y, today))
        time.sleep(1)  # be polite to the API

    try:
        changed |= update_stats()
    except Exception as e:  # stats are optional; never block the daily data
        print(f"stats failed: {e}", file=sys.stderr)

    have = sorted(int(p.stem) for p in DATA.glob("[0-9][0-9][0-9][0-9].json"))
    latest = json.loads((DATA / f"{have[-1]}.json").read_text())["rows"][-1][0] if have else None
    idx_path = DATA / "index.json"
    old = json.loads(idx_path.read_text()) if idx_path.exists() else {}
    index = {
        "site": SITE,
        "name": SITE_NAME,
        "years": have,
        "through": f"{have[-1]}-{latest}" if have else None,
        "updated": (dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ")
                    if changed or "updated" not in old else old["updated"]),
    }
    idx_path.write_text(json.dumps(index, indent=1) + "\n")
    print(f"index: {len(have)} years, through {index['through']}")


if __name__ == "__main__":
    main()
