"""where sheffield will build — development sites from the council's arcgis (primary).

two statutory layers from the city council's own open-data server: the brownfield
land register (sites earmarked for redevelopment, with their net dwelling capacity)
and the helaa (housing & employment land availability assessment). together they map
the city's development pipeline as polygons, each tagged with how many homes it holds.
"""
from common import arcgis, fc, write, log

# outfile is shared; (service, layer, kind, capacity-field) — geometry generalised server-side.
JOBS = [
    ("AGOL/OpenData", 6, "brownfield", "minnetdwellings"),
    ("AGOL/OpenData", 17, "helaa", "dwellings"),
]

if __name__ == "__main__":
    feats = []
    for svc, lyr, kind, cap in JOBS:
        log(f"planning: {kind} ← {svc}/{lyr}")
        try:
            for f in arcgis(svc, lyr, extra={"maxAllowableOffset": 5}):
                p = f.get("properties", {})
                homes = p.get(cap) or p.get("minnetdwellings") or p.get("dwellings")
                f["properties"] = {"kind": kind, "ref": p.get("sitereference") or p.get("siteref"),
                                   "status": p.get("ownershipstatus") or p.get("status"), "homes": homes}
                feats.append(f)
        except Exception as e:
            log(f"  ! skipped ({e})")
    write("planning.geojson", fc(feats))
