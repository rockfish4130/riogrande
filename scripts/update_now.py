#!/usr/bin/env python3
"""Live snapshot for the planner's map popups -> data/now.json.

Runs every 3 hours from .github/workflows/now.yml. Standard library only.

Rivers   : IBWC "Discharge.Best Available" (15-min telemetry, m^3/s -> cfs), last ~30 days;
           USGS Castolon instantaneous values (cfs); NWS NWPS Presidio (PRST2) observed stage/flow.
Reservoirs: CONAGUA daily series mirrored by IBWC - percent of normal max operating level (NAMO),
           storage (million m^3), inflow / total release / spill (m^3/s -> cfs).
All values are provisional. Missing days are left missing (not zero).
"""
import csv
import datetime as dt
import io
import json
import math
import pathlib
import sys
import time
import urllib.parse
import urllib.request
import zipfile

OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "now.json"
IBWC = "https://waterdata.ibwc.gov/AQWebportal/Export/Dataset"
UA = "riogrande-flow-planner (github.com/rockfish4130/riogrande)"
CFS = 35.3146667  # ft^3 per m^3

RIVERS = {  # key -> IBWC location id
    "jr": "08375000", "pre": "08374200", "oji": "08373000", "ter": "08374500", "above": "08371500",
}
RESERVOIRS = {"lbq": "08-LBQCH-CONAGUA", "lln": "08-LLNCH-CONAGUA", "fim": "08-FIMCH-CONAGUA"}
RES_SERIES = {  # field -> (dataset prefix, unit conversion)
    "pct": ("Percentage.CONAGUA-Daily-Percent-NAMO", 1),
    "storage": ("Total Storage.CONAGUA-Daily-Storage", 1),          # million m^3
    "inflow": ("Discharge.CONAGUA-Daily-Inflow", CFS),
    "release": ("Discharge.CONAGUA-Daily-Total-Release", CFS),
    "spill": ("Discharge.CONAGUA-Daily-Spill", CFS),
}


def fetch(url, binary=False, tries=4):
    for i in range(1, tries + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=90) as r:
                b = r.read()
                return b if binary else b.decode("utf-8", "replace")
        except Exception as e:
            print(f"  attempt {i} failed for {url[:100]}: {e}", file=sys.stderr)
            time.sleep(6 * i)
    return None


def ibwc(dataset, days="Days30"):
    """[(iso timestamp with -06:00 offset, value), ...] or []"""
    q = urllib.parse.urlencode({"Dataset": dataset, "DateRange": days, "ExportFormat": "csv"})
    raw = fetch(f"{IBWC}?{q}", binary=True)
    if not raw:
        return []
    try:
        z = zipfile.ZipFile(io.BytesIO(raw))
        text = z.read(z.namelist()[0]).decode("utf-8", "replace")
    except zipfile.BadZipFile:
        return []
    out = []
    for row in csv.reader(io.StringIO(text)):
        if len(row) < 2 or row[0][:2] != "20":
            continue
        try:
            v = float(row[1])
        except ValueError:
            continue
        if math.isfinite(v):
            out.append((row[0].replace(" ", "T") + "-06:00", v))
    return out


def rnd(v):
    return None if v is None else (int(round(v)) if abs(v) >= 100 else round(v, 1))


def daily_means(pts, k=1.0):
    d = {}
    for t, v in pts:
        d.setdefault(t[:10], []).append(v * k)
    return [[day, rnd(sum(vs) / len(vs))] for day, vs in sorted(d.items())]


def river(loc):
    pts = ibwc(f"Discharge.Best Available@{loc}")
    if not pts:
        return None
    t, v = pts[-1]
    last = dt.datetime.fromisoformat(t)
    prior = [(tt, vv) for tt, vv in pts if dt.datetime.fromisoformat(tt) <= last - dt.timedelta(hours=24)]
    return {"kind": "river", "t": t, "cfs": rnd(v * CFS),
            "cfs_24h_ago": rnd(prior[-1][1] * CFS) if prior else None,
            "daily": daily_means(pts, CFS)[-30:]}


def reservoir(loc):
    doc = {"kind": "reservoir"}
    for field, (prefix, k) in RES_SERIES.items():
        pts = ibwc(f"{prefix}@{loc}")
        series = [[t[:10], rnd(v * k)] for t, v in pts]
        doc[field] = {"t": pts[-1][0], "v": rnd(pts[-1][1] * k)} if pts else None
        doc[field + "_daily"] = series[-30:]
    s = doc.get("storage_daily") or []
    if s:
        last = dt.date.fromisoformat(s[-1][0])
        wk = [r for r in s if dt.date.fromisoformat(r[0]) <= last - dt.timedelta(days=7)]
        doc["storage_7d_change"] = rnd(s[-1][1] - wk[-1][1]) if wk else None
    return doc


def castolon():
    txt = fetch("https://waterservices.usgs.gov/nwis/iv/?format=json&sites=08374550&parameterCd=00060&period=P30D")
    if not txt:
        return None
    try:
        vals = json.loads(txt)["value"]["timeSeries"][0]["values"][0]["value"]
    except (KeyError, IndexError, ValueError):
        return None
    pts = [(x["dateTime"], float(x["value"])) for x in vals if float(x["value"]) >= 0]
    if not pts:
        return None
    t, v = pts[-1]
    last = dt.datetime.fromisoformat(t)
    prior = [(tt, vv) for tt, vv in pts if dt.datetime.fromisoformat(tt) <= last - dt.timedelta(hours=24)]
    return {"kind": "river", "t": t, "cfs": rnd(v), "cfs_24h_ago": rnd(prior[-1][1]) if prior else None,
            "daily": daily_means(pts)[-30:]}


def nws():
    txt = fetch("https://api.water.noaa.gov/nwps/v1/gauges/PRST2")
    if not txt:
        return None
    try:
        g = json.loads(txt)
        o, f = g["status"]["observed"], g["status"]["forecast"]
        return {"kind": "nws", "t": o.get("validTime"), "stage_ft": o.get("primary"),
                "cfs": rnd(o["secondary"] * 1000) if o.get("secondary") not in (None, -999) else None,
                "flood": o.get("floodCategory"),
                "forecast": None if f.get("primary") in (None, -999) else {"t": f.get("validTime"), "stage_ft": f.get("primary"),
                                                                          "cfs": rnd(f["secondary"] * 1000) if f.get("secondary") not in (None, -999) else None,
                                                                          "flood": f.get("floodCategory")}}
    except (KeyError, ValueError, TypeError):
        return None


def main():
    old = json.loads(OUT.read_text()) if OUT.exists() else {"sites": {}}
    sites = {}
    for key, loc in RIVERS.items():
        print(key, loc); sites[key] = river(loc)
    for key, loc in RESERVOIRS.items():
        print(key, loc); sites[key] = reservoir(loc)
    print("cas"); sites["cas"] = castolon()
    print("prst2"); sites["prst2"] = nws()
    for k, v in list(sites.items()):  # keep the previous snapshot for a site that failed this time
        if v is None and k in old.get("sites", {}):
            sites[k] = dict(old["sites"][k], stale=True)
    doc = {"generated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "sites": sites}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
    ok = [k for k, v in sites.items() if v and not v.get("stale")]
    print(f"wrote {OUT.name}: {len(ok)}/{len(sites)} sites fresh")


if __name__ == "__main__":
    main()
