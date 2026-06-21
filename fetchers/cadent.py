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


def site(f):  # slim an above-ground site point down to what the popup needs
    return {"type": "Feature", "geometry": f["geometry"],
            "properties": {"description": f["properties"].get("description", "Above Ground Site")}}


if __name__ == "__main__":
    log("cadent: exporting gas pipe infrastructure…")
    packbin("gas_pipes.bin", export("gas-pipe-infrastructure-gpi_open"), parts)
    log("cadent: exporting above-ground sites…")
    write("gas_assets.geojson", fc([site(f) for f in export("above-ground-infrastructure-assets-open")]))
