"""trunk pipelines from openstreetmap — the long-distance transmission networks
that cross the city, distinct from cadent's local gas distribution (cadent.py).

the headline is the uk **national transmission system** (nts): national gas's
high-pressure gas backbone (osm `man_made=pipeline`, `usage=transmission`). plus
the water trunk mains (severn trent / yorkshire water) and the exolum multi-product
fuel line (the old government pipeline & storage system). one overpass query, split
by substance into kinds the frontend draws as separately-toggleable line layers.
no key. minor industrial lines (oxygen, cement, sewage, district heat) are dropped.
"""
from common import overpass, write, fc, log

BBOX = "53.304,-1.802,53.504,-1.324"  # s,w,n,e — config.js BBOX


def kind(t):  # osm tags → one of our trunk classes, or none to skip
    sub, op = t.get("substance", ""), t.get("operator", "")
    if sub == "water":
        return "water"
    if sub in ("fuel", "oil", "diesel", "petroleum", "gas_oil", "multi-product"):
        return "fuel"
    if sub in ("gas", "natural_gas") and (t.get("usage") == "transmission" or "National Grid" in op):
        return "gas"  # the nts high-pressure backbone (not cadent's distribution)


# burial depth (m, surface→pipe centre) per kind. these are *transmission* lines, laid far
# deeper than cadent's distribution: gas nts & the fuel line carry a 1.1 m min cover (igem/td/1,
# pd 8010-1), water trunk mains ~1.0 m; + ~0.3-0.4 m for the large bore down to the centreline.
DEPTH = {"gas": 1.5, "water": 1.35, "fuel": 1.4}


def feature(e):
    t = e.get("tags", {})
    k = kind(t)
    if not k or len(e.get("geometry", [])) < 2:
        return None
    return {"type": "Feature", "properties": {
        "kind": k, "depth": DEPTH[k], "operator": t.get("operator", ""), "substance": t.get("substance", ""), "name": t.get("name", "")},
        "geometry": {"type": "LineString", "coordinates": [[p["lon"], p["lat"]] for p in e["geometry"]]}}


if __name__ == "__main__":
    log("pipelines: querying osm trunk pipelines (nts gas, water mains, fuel)…")
    els = overpass(f'[out:json][timeout:90];way["man_made"="pipeline"]({BBOX});out geom;')["elements"]
    write("pipelines.geojson", fc([f for f in map(feature, els) if f]))
