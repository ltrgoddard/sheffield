"""building footprints + heights from openstreetmap (overpass), the geometry the
gpu renderer extrudes into wireframes. primary source, no aggregator, no key.

covers the same box the frontend draws (config.js BBOX). heights come from
the `height` tag, else `building:levels`×3, else a sensible default.
"""
from common import overpass, packbin, log

# sheffield's full administrative boundary bbox — keep in step with BBOX in config.js (s, w, n, e).
S, W, N, E = 53.304, -1.802, 53.504, -1.324
Q = f"""[out:json][timeout:300];
(way["building"]({S},{W},{N},{E});
 relation["building"]["type"="multipolygon"]({S},{W},{N},{E}););
out geom;"""


def num(s):
    try:
        return float(str(s).split()[0])
    except (ValueError, TypeError, IndexError):
        return None


def height(t):
    return num(t.get("height")) or (num(t.get("building:levels")) or 0) * 3 or 8.0


def ring(geom):
    r = [[round(g["lon"], 6), round(g["lat"], 6)] for g in geom]
    if len(r) >= 3 and r[0] != r[-1]:
        r.append(r[0])
    return r if len(r) >= 4 else None


def feature(coords, t):
    mh = num(t.get("min_height")) or (num(t.get("building:min_level")) or 0) * 3 or 0
    return {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [coords]},
            "properties": {"height": round(height(t), 1), "min_height": round(mh, 1)}}


if __name__ == "__main__":
    log("buildings: querying overpass…")
    feats = []
    for el in overpass(Q)["elements"]:
        t = el.get("tags", {})
        if el["type"] == "way" and (r := ring(el.get("geometry", []))):
            feats.append(feature(r, t))
        elif el["type"] == "relation":
            for m in el.get("members", []):
                if m.get("role") == "outer" and (r := ring(m.get("geometry", []))):
                    feats.append(feature(r, t))
    # ~12k footprints, 1.1M vertices — pack straight to a gpu buffer (was a 44 MB geojson).
    packbin("buildings.bin", feats, lambda g: g["coordinates"],
            lambda f: (f["properties"]["height"], f["properties"]["min_height"]))
