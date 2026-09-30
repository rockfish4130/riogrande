#!/usr/bin/env python3
"""Climate predictors for the trip planner.

1. ENSO: NOAA CPC Oceanic Nino Index (ONI), 3-month running SST anomaly in Nino 3.4, 1950+.
   -> data/climate/oni.json  {"source", "rows": [["DJF", 1950, -1.53], ...]}
2. Monsoon / basin rainfall: CHIRPS v2.0 monthly precipitation (0.05 deg, 1981+), averaged over an
   approximate Rio Conchos basin polygon. Read with HTTP range requests from the Cloud-Optimized
   GeoTIFFs, so only the few tiles over Chihuahua are downloaded (~5 s per month).
   -> data/climate/conchos_rain.json  {"source", "polygon", "unit": "mm", "months": {"1981-01": 12.3, ...}}
   Incremental: only months not already in the file are fetched. --all refetches everything.

Needs: numpy, rasterio (pip install rasterio). CHIRPS is flaky; failed months are retried next run.
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import json
import os
import pathlib
import re
import sys
import time
import urllib.request

OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "climate"
ONI_URL = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
COG_DIR = "https://data.chc.ucsb.edu/products/CHIRPS-2.0/global_monthly/cogs/"
UA = "riogrande-flow-planner (github.com/rockfish4130/riogrande)"

# Approximate Rio Conchos basin (lon, lat), hand-drawn from the basin's known extent:
# Sierra Madre divide on the west, Rio Florido headwaters (Durango) on the south, the endorheic
# Bolson de Mapimi excluded on the east, outlet at Ojinaga. Good enough for a basin-mean index;
# replace with a HydroSHEDS/CONAGUA boundary if you need precision.
CONCHOS = [(-107.0, 26.1), (-106.2, 25.9), (-105.4, 26.0), (-104.9, 26.8), (-104.9, 27.8), (-104.6, 28.6),
           (-104.2, 29.3), (-104.4, 29.7), (-105.2, 29.6), (-106.0, 29.3), (-106.6, 29.0), (-107.1, 28.5),
           (-107.6, 27.8), (-107.7, 27.0), (-107.4, 26.4), (-107.0, 26.1)]


def get(url, tries=6):
    for i in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            print(f"  {url}: attempt {i} failed ({e})", file=sys.stderr)
            time.sleep(5 * i)
    raise RuntimeError(url)


def update_oni():
    rows = []
    for line in get(ONI_URL).splitlines():
        p = line.split()
        if len(p) == 4 and p[1].isdigit():
            rows.append([p[0], int(p[1]), float(p[3])])
    doc = {"source": ONI_URL, "note": "ANOM = 3-month running mean SST anomaly, Nino 3.4 (deg C)", "rows": rows}
    (OUT / "oni.json").write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    print(f"ONI: {len(rows)} seasons, last {rows[-1]}")


def basin_mean(month):
    import numpy as np
    import rasterio
    from rasterio.features import geometry_mask
    from rasterio.windows import from_bounds
    url = f"/vsicurl/{COG_DIR}chirps-v2.0.{month[:4]}.{month[5:]}.cog"
    lons = [p[0] for p in CONCHOS]; lats = [p[1] for p in CONCHOS]
    for i in range(1, 6):
        try:
            with rasterio.open(url) as ds:
                w = from_bounds(min(lons) - .1, min(lats) - .1, max(lons) + .1, max(lats) + .1, ds.transform).round_offsets().round_lengths()
                a = ds.read(1, window=w).astype("float64")
                tr = ds.window_transform(w)
            inside = ~geometry_mask([{"type": "Polygon", "coordinates": [CONCHOS]}], out_shape=a.shape, transform=tr)
            v = a[inside & (a >= 0)]
            return month, round(float(v.mean()), 2), int(v.size)
        except Exception as e:
            print(f"  {month}: attempt {i} failed ({e})", file=sys.stderr)
            time.sleep(4 * i)
    return month, None, 0


def update_rain(refetch_all=False):
    os.environ.setdefault("GDAL_DISABLE_READDIR_ON_OPEN", "EMPTY_DIR")
    os.environ.setdefault("GDAL_HTTP_MAX_RETRY", "4")
    os.environ.setdefault("GDAL_HTTP_RETRY_DELAY", "3")
    os.environ.setdefault("CPL_VSIL_CURL_ALLOWED_EXTENSIONS", ".cog")
    path = OUT / "conchos_rain.json"
    doc = json.loads(path.read_text()) if path.exists() and not refetch_all else {}
    months = doc.get("months", {})
    listing = get(COG_DIR)
    avail = sorted(set(re.findall(r"chirps-v2\.0\.(\d{4})\.(\d{2})\.cog", listing)))
    todo = [f"{y}-{m}" for y, m in avail if f"{y}-{m}" not in months]
    print(f"CHIRPS: {len(avail)} months available, {len(todo)} to fetch")
    with cf.ThreadPoolExecutor(max_workers=8) as ex:
        for month, v, n in ex.map(basin_mean, todo):
            if v is not None:
                months[month] = v
                print(f"  {month}: {v} mm ({n} px)")
    doc = {"source": "CHIRPS v2.0 monthly (Funk et al. 2015), UCSB Climate Hazards Center, " + COG_DIR,
           "region": "approximate Rio Conchos basin polygon (see scripts/update_climate.py)",
           "polygon": CONCHOS, "unit": "mm/month (basin mean)", "months": dict(sorted(months.items()))}
    path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    missing = [m for m in (f"{y}-{mm}" for y, mm in avail) if m not in months]
    print(f"rain: {len(months)} months stored; missing {len(missing)} {missing[:6]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    a = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for fn in (update_oni, lambda: update_rain(a.all)):
        try:
            fn()
        except Exception as e:  # one source failing shouldn't block the other
            print(f"failed: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
