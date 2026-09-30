#!/usr/bin/env python3
"""Pull long-record daily series from the IBWC Water Data Portal (AQUARIUS WebPortal).

Writes one compact file per series to data/ibwc/<key>.json:
  {"key","id","name","dataset","unit","start":"YYYY-MM-DD","v":[daily values...]}
where v[i] is the value on start+i days (null = missing). Plus data/ibwc/index.json.

The portal has no documented API; this uses the export endpoint its web UI uses:
  GET /AQWebportal/Export/Dataset?Dataset=<id>&DateRange=EntirePeriodOfRecord&ExportFormat=csv
  -> a zip holding one CSV: comment line, header, "YYYY-MM-DD HH:MM:SS,value" rows, disclaimer row.
The export needs no session (tested 2026-09-30). The browsing/discovery endpoints do: see CONTEXT.md.

Units differ by dataset: "Daily Rounded cfs" is ft^3/s; reservoir storage is million m^3.
Standard library only.
"""
import csv
import datetime as dt
import http.cookiejar
import io
import json
import math
import pathlib
import sys
import time
import urllib.parse
import urllib.request
import zipfile

BASE = "https://waterdata.ibwc.gov/AQWebportal"
UA = "riogrande-flow-planner (github.com/rockfish4130/riogrande)"
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "ibwc"

SERIES = [
    # key, dataset identifier, display name, unit, decimals-rule
    ("johnson_ranch", "Discharge.Daily Rounded cfs@08375000",
     "Rio Grande at Johnson Ranch nr Castolon, TX (IBWC 08375000)", "cfs"),
    ("presidio", "Discharge.Daily Rounded cfs@08374200",
     "Rio Grande below Rio Conchos nr Presidio, TX (IBWC 08374200)", "cfs"),
    ("conchos_ojinaga", "Discharge.Daily Rounded cfs@08373000",
     "Rio Conchos nr Ojinaga, Chih. (IBWC 08373000)", "cfs"),
    ("terlingua", "Discharge.Daily Rounded cfs@08374500",
     "Terlingua Creek nr Terlingua, TX (IBWC 08374500)", "cfs"),
    ("la_boquilla", "Total Storage.CONAGUA-Web-Daily-Storage-mcm@08-LBQCH-CONAGUA",
     "La Boquilla Reservoir storage, Rio Conchos (CONAGUA via IBWC)", "million m3"),
]


def opener():
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.addheaders = [("User-Agent", UA)]
    return op


def export(op, dataset, tries=4):
    q = urllib.parse.urlencode({"Dataset": dataset, "DateRange": "EntirePeriodOfRecord", "ExportFormat": "csv"})
    for attempt in range(1, tries + 1):
        try:
            raw = op.open(f"{BASE}/Export/Dataset?{q}", timeout=300).read()
            z = zipfile.ZipFile(io.BytesIO(raw))
            return z.read(z.namelist()[0]).decode("utf-8", "replace")
        except Exception as e:  # network hiccup or HTML error page instead of a zip
            print(f"  attempt {attempt} failed: {e}", file=sys.stderr)
            time.sleep(20 * attempt)
    raise RuntimeError(f"giving up on {dataset}")


def parse(text):
    vals = {}
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2 or not row[0][:2] in ("18", "19", "20"):
            continue
        try:
            d = dt.date.fromisoformat(row[0][:10])
            v = float(row[1])
        except ValueError:
            continue
        if not math.isfinite(v):  # the portal emits NaN for some gap days
            continue
        vals[d] = v  # one value per day for these daily datasets
    return vals


def compact(v):
    if v is None:
        return None
    if abs(v) >= 100:
        return int(round(v))
    return round(v, 1)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    op = opener()
    index = {}
    for key, ds, name, unit in SERIES:
        print(f"{key}: {ds}")
        vals = parse(export(op, ds))
        if not vals:
            print("  no data; keeping previous file", file=sys.stderr)
            continue
        start, end = min(vals), max(vals)
        n = (end - start).days + 1
        arr = [compact(vals.get(start + dt.timedelta(i))) for i in range(n)]
        doc = {"key": key, "dataset": ds, "name": name, "unit": unit,
               "start": start.isoformat(), "end": end.isoformat(), "v": arr}
        path = OUT / f"{key}.json"
        text = json.dumps(doc, separators=(",", ":")) + "\n"
        changed = not path.exists() or path.read_text() != text
        if changed:
            path.write_text(text)
        have = sum(x is not None for x in arr)
        print(f"  {start} -> {end}, {have}/{n} days{'' if changed else ' (unchanged)'}")
        index[key] = {"name": name, "unit": unit, "start": start.isoformat(), "end": end.isoformat(), "days": have}
        time.sleep(2)
    idx = OUT / "index.json"
    old = json.loads(idx.read_text()) if idx.exists() else {}
    old.update(index)
    idx.write_text(json.dumps(old, indent=1) + "\n")


if __name__ == "__main__":
    main()
