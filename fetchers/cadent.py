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


# uk gas depth-of-cover (m, surface→top of pipe), per njug §4.4 / igem/td/3 / hse model depths.
# the network is NOT one depth: cover is keyed by pressure *band* (bar) and service-vs-main, and
# the pipe then sits a radius deeper to its centreline. note lp & mp are the *same* band (≤2 bar) —
# every authoritative source (hse, njug) gives them identical cover — so depth varies by tier and
# bore, not the lp/mp label. higher bands (ip/hp/lts) run deeper; the >16 bar transmission tier is
# the osm trunk layer (pipelines.py), not this distribution feed, which tops out at mp.
BAR = {"LP": 0.075, "MP": 2, "IP": 7, "HP": 16, "LTS": 70}   # nominal upper-bound bar of each tier label


def dia_m(v, u):  # a diameter value + unit → metres (the open feed mixes mm and inches)
    return (v * 0.0254 if u == "I" else v / 1000) if v else 0


def bore(p):  # the real outside bore in the ground: the carrier (old host main) when this is a
    return max(dia_m(p.get("diameter"), p.get("diam_unit")),     # pe insert threaded through it (28% of the network), else the pipe's own
               dia_m(p.get("carr_dia"), p.get("carr_di_un")))


def cover(p):  # depth of cover (m) to the top of the pipe, by pressure band + main/service
    bar, svc = BAR.get(p.get("pressure"), 2), p["type"] == "Service Pipe"
    if bar <= 2:    return 0.45 if svc else 0.75    # lp/mp: service 0.45 (footway), main 0.75 (carriageway)
    if bar <= 7:    return 0.75                      # intermediate pressure
    if bar <= 16:   return 0.90                      # high-pressure distribution
    return 1.10                                      # >16 bar lts (igem/td/1 min cover)


def depth(f):  # metres from surface to pipe *centre* = cover + radius; negative = above ground
    p = f["properties"]
    if p.get("ag_ind") == "True":
        return -1.0                                  # above-ground main: sit it on the surface, not buried
    cov = float(p["depth"]) if p.get("depth") else cover(p)   # cadent's surveyed cover wins where recorded (else inferred)
    return cov + bore(p) / 2


def meta(f):  # slim per-pipe metadata for the click tooltip (depth rides the bin b-slot, so not repeated here)
    p = f["properties"]
    return {k: v for k, v in (
        ("t", "service" if p.get("type") == "Service Pipe" else "main"),
        ("p", p.get("pressure")),                               # tier label lp/mp/ip/hp/lts
        ("m", p.get("material")),                               # carried-medium pipe material (pe, …)
        ("d", round(bore(p) * 1000) or None),                   # outside bore (carrier when inserted) in mm
        ("y", yr(f)),                                           # install year
        ("c", p.get("carr_mat")),                               # host main material where a pe insert runs through one
    ) if v}


def site(f):  # slim an above-ground site point down to what the popup needs
    return {"type": "Feature", "geometry": f["geometry"],
            "properties": {"description": f["properties"].get("description", "Above Ground Site")}}


if __name__ == "__main__":
    log("cadent: exporting gas pipe infrastructure…")
    pipes = export("gas-pipe-infrastructure-gpi_open")
    ramp = age_norm(pipes)                                       # per-segment h = install-age 0..1 (viridis), b = burial depth (m)
    packbin("gas_pipes.bin", pipes, parts, lambda f: (ramp(f)[0], depth(f)), tags=meta)
    log("cadent: exporting above-ground sites…")
    write("gas_assets.geojson", fc([site(f) for f in export("above-ground-infrastructure-assets-open")]))
