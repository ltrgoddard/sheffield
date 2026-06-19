"""supertram routes + stops from openstreetmap (via overpass).

the route geometries seed the moving trams in the frontend, so this only needs
running when the network changes. colours come straight from the osm `colour`
tag, giving each line its real livery (blue / yellow / purple).
"""
from common import overpass, fc, write, log

BBOX = "53.32,-1.56,53.44,-1.30"  # s,w,n,e — greater sheffield / supertram reach


def routes():
    q = f'[out:json][timeout:90];relation["route"="tram"]({BBOX});out geom;'
    feats = []
    for el in overpass(q)["elements"]:
        t = el.get("tags", {})
        line = []
        for m in el.get("members", []):
            if m.get("type") != "way" or m.get("role", "").startswith(("stop", "platform")):
                continue
            for pt in m.get("geometry", []):
                c = [round(pt["lon"], 6), round(pt["lat"], 6)]
                if not line or line[-1] != c:
                    line.append(c)
        if len(line) < 2:
            continue
        feats.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": line},
                      "properties": {"name": t.get("name"), "ref": t.get("ref"),
                                     "colour": t.get("colour", "#888"), "from": t.get("from"), "to": t.get("to")}})
    return feats


def stops():
    q = f'[out:json][timeout:60];node["railway"="tram_stop"]({BBOX});out;'
    return [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [e["lon"], e["lat"]]},
             "properties": {"name": e.get("tags", {}).get("name", "Tram stop")}}
            for e in overpass(q)["elements"]]


if __name__ == "__main__":
    log("transit: fetching supertram network from openstreetmap…")
    write("tram_routes.geojson", fc(routes()))
    write("tram_stops.geojson", fc(stops()))
