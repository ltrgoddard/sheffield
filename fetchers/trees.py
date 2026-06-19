"""street & park trees from openstreetmap (via overpass) — no key.

sheffield is the greenest city in england and fought a famous battle over its
street trees; mapping them is on-brand. the council's own forestry layer has no
geometry, so we take the osm `natural=tree` nodes, which carry real positions and
often a species. kept to the visible city bbox so the file stays light.
"""
from common import overpass, fc, write, log

BBOX = "53.355,-1.52,53.405,-1.42"  # s,w,n,e — around the rendered city patch


def genus(t):
    """a short label: the mapped species, else genus, else just 'tree'."""
    return t.get("species") or t.get("species:en") or t.get("genus") or "tree"


if __name__ == "__main__":
    log("trees: fetching osm tree nodes…")
    q = f'[out:json][timeout:90];node["natural"="tree"]({BBOX});out qt;'
    feats = [{"type": "Feature",
              "geometry": {"type": "Point", "coordinates": [round(e["lon"], 6), round(e["lat"], 6)]},
              "properties": {"species": genus(e.get("tags", {})),
                             "height": e.get("tags", {}).get("height")}}
             for e in overpass(q)["elements"]]
    log(f"  {len(feats)} trees")
    write("trees.geojson", fc(feats))
