"""bus stops from openstreetmap (via overpass) — no key.

the live buses (bustimes.org) need somewhere to stop; these are the named
roadside stops, drawn as faint dots and labelled at high zoom alongside the
tram stops. kept to the supertram/greater-sheffield box so the file stays light.
"""
from common import overpass, fc, write, log

BBOX = "53.32,-1.56,53.44,-1.30"  # s,w,n,e — matches the tram network reach
ind = lambda s: s if s and not s.isdigit() else None  # naptan indicator, minus bare stop-plate numbers

if __name__ == "__main__":
    log("bus_stops: fetching osm bus stops…")
    q = f'[out:json][timeout:90];node["highway"="bus_stop"]({BBOX});out qt;'
    feats = [{"type": "Feature",
              "geometry": {"type": "Point", "coordinates": [round(e["lon"], 6), round(e["lat"], 6)]},
              "properties": {k: v for k, v in (  # name + the useful naptan locality/bearing, dropping blanks
                  ("name", t.get("name", "Bus stop")), ("street", t.get("naptan:Street")),
                  ("towards", ind(t.get("naptan:Landmark")) or ind(t.get("naptan:Indicator"))),
                  ("bearing", t.get("naptan:Bearing"))) if v}}
             for e in overpass(q)["elements"] for t in [e.get("tags", {})]]
    log(f"  {len(feats)} bus stops")
    write("bus_stops.geojson", fc(feats))
