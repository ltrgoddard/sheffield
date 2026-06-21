"""real council air-quality monitors — sheffield city council's own network.

scc publishes its 11 automatic monitoring stations (incl. the 3 defra aurn sites)
as point geometry on its inspire featureserver, each carrying verified annual-mean
no2 / pm10 / pm2.5 by year. found data at real, irregular locations — not a grid.
(open-meteo's model field was a synthetic 9x7 lattice; it rendered as exactly that.)
"""
from common import arcgis, fc, write, log

POLL = {"no2": "no2", "pm10": "pm10", "pm25": "pm2_5"}  # out key -> arcgis column stem


def latest(p, stem):  # newest non-null annual mean (cap at this year, ignore projections)
    for y in range(2026, 2018, -1):
        v = p.get(f"{stem}_{y}")
        if v not in (None, ""):
            return round(float(v), 1), y
    return None, None


if __name__ == "__main__":
    log("air: sheffield city council air-quality monitors…")
    feats = []
    for f in arcgis("AGOL/INSPIRE", 8, server="FeatureServer"):
        p = f["properties"]
        vals = {k: latest(p, stem) for k, stem in POLL.items()}
        yr = next((y for _, y in vals.values() if y), None)
        feats.append({"type": "Feature", "geometry": f["geometry"],
                      "properties": {"name": p.get("defrasitename"), "type": p.get("sitetype"),
                                     "tech": p.get("monitoring_technique"), "year": yr,
                                     **{k: v for k, (v, _) in vals.items()}}})
    log(f"  {len(feats)} monitors")
    write("air.geojson", fc(feats))
