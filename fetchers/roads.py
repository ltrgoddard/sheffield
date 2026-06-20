"""the road network from openstreetmap (overpass) — the drawn streets of the
city, rendered as 1px white wirelines draped on the terrain. primary source,
no aggregator, no key. no labels: just geometry.

covers the same box the frontend draws (config.js BBOX). the highway hierarchy
is filtered to drivable roads (motorway→residential, plus living streets and
unclassified) — footways, cycleways, paths, tracks and service drives are left
out so the picture reads as the street grid, not every alley.
"""
from common import overpass, fc, write, log

# sheffield's full administrative boundary bbox — keep in step with BBOX in config.js (s, w, n, e).
S, W, N, E = 53.304, -1.802, 53.504, -1.324
ROADS = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street"
LINK = ROADS + "|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
Q = f"""[out:json][timeout:300];
way["highway"~"^({LINK})$"]({S},{W},{N},{E});
out geom;"""


def line(geom):
    c = [[round(g["lon"], 6), round(g["lat"], 6)] for g in geom]
    return c if len(c) >= 2 else None


if __name__ == "__main__":
    log("roads: querying overpass…")
    feats = []
    for el in overpass(Q)["elements"]:
        if (c := line(el.get("geometry", []))):
            feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": c},
                          "properties": {"class": el.get("tags", {}).get("highway", "")}})
    write("roads.geojson", fc(feats))
