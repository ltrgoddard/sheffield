"""gas distribution network from cadent's open-data portal (opendatasoft) — the
low/medium-pressure mains + service pipes and above-ground sites beneath the city.
needs CADENT_API_KEY (the free open tier; .env). there are ~55k pipe segments, so
they pack straight into a gpu buffer (data/gas_pipes.bin) the same way buildings do;
the handful of above-ground sites stay geojson points (pickable, with a popup).

pulled via the ods v2.1 geojson export, server-side clipped to the render bbox; the
frontend clips again to lidar coverage. note sheffield itself is northern gas
networks territory — cadent's coverage is the eastern/rotherham fringe of the box.
"""
import os, json
from common import fetch, write, fc, packbin, log

EXPORT = "https://cadentgas.opendatasoft.com/api/explore/v2.1/catalog/datasets/{}/exports/geojson"
S, W, N, E = 53.304, -1.802, 53.504, -1.324            # render bbox (config.js BBOX), s,w,n,e
WHERE = f"in_bbox(geo_point_2d,{S},{W},{N},{E})"


def export(ds):
    raw = fetch(EXPORT.format(ds), params={"where": WHERE, "apikey": os.environ["CADENT_API_KEY"]}, timeout=180)
    return json.loads(raw)["features"]


def parts(g):  # geojson line geom → its coordinate rings
    t = g["type"]
    return g["coordinates"] if t == "MultiLineString" else [g["coordinates"]] if t == "LineString" else []


def yr(f):  # install year from inst_date ("YYYY-…"), or None
    d = f["properties"].get("inst_date")
    return int(d[:4]) if d else None


def age_norm(feats, lo=2, hi=98):  # year→0..1 normaliser; scale clamped to the p2..p98 years (h=-1 when undated)
    s = sorted(y for f in feats if (y := yr(f)) is not None)
    a, b = s[len(s) * lo // 100], s[min(len(s) - 1, len(s) * hi // 100)]      # drop victorian/stray outliers before scaling
    log(f"cadent: install-year colour scale {a}–{b} ({len(s)} dated of {len(feats)})")
    return lambda f: ((min(b, max(a, y)) - a) / (b - a), 0.0) if (y := yr(f)) is not None else (-1.0, 0.0)


def site(f):  # slim an above-ground site point down to what the popup needs
    return {"type": "Feature", "geometry": f["geometry"],
            "properties": {"description": f["properties"].get("description", "Above Ground Site")}}


if __name__ == "__main__":
    log("cadent: exporting gas pipe infrastructure…")
    pipes = export("gas-pipe-infrastructure-gpi_open")
    packbin("gas_pipes.bin", pipes, parts, age_norm(pipes))      # per-segment h = install-age 0..1 for the viridis ramp
    log("cadent: exporting above-ground sites…")
    write("gas_assets.geojson", fc([site(f) for f in export("above-ground-infrastructure-assets-open")]))
