"""live river levels from the environment agency flood-monitoring api (no key).

sheffield sits at the confluence of five rivers — the don, sheaf, loxley, rivelin
and porter brook — and floods badly (2007, 2019). this fetches every level gauge
within 15 km and its latest 15-minute reading, plus the station's typical range so
the frontend can colour each gauge by how high the water is running right now.
"""
from common import get_json, fc, write, log

API = "https://environment.data.gov.uk/flood-monitoring"
HERE = {"lat": 53.3811, "long": -1.4701, "dist": 15}  # km radius from the city centre


def stations():
    """level gauges near sheffield, keyed by measure uri → station context."""
    items = get_json(f"{API}/id/stations", params={"parameter": "level", "_view": "full",
                                                    "_limit": 500, **HERE})["items"]
    by_measure = {}
    for s in items:
        if s.get("lat") is None or s.get("long") is None:
            continue
        ss = s.get("stageScale") or {}
        ctx = {"river": s.get("riverName"), "label": s.get("label"),
               "lon": float(s["long"]), "lat": float(s["lat"]),
               "low": ss.get("typicalRangeLow"), "high": ss.get("typicalRangeHigh"),
               "max": (s.get("maxOnRecord") or ss.get("maxOnRecord") or {}).get("value")}
        for m in (s.get("measures") or []):
            mid = m["@id"] if isinstance(m, dict) else m
            if isinstance(mid, str):
                by_measure[mid] = ctx
    return by_measure


def ratio(v, low, high):
    """0 at the bottom of the typical range, 1 at the top — a quick flood gauge."""
    if v is None or low is None or high is None or high <= low:
        return None
    return round(max(0.0, min(1.6, (v - low) / (high - low))), 3)


if __name__ == "__main__":
    log("rivers: querying environment agency flood-monitoring…")
    ctx = stations()
    # the readings endpoint takes no geo filter, so pull the latest level nationally
    # (one cached call) and keep only the gauges we resolved near sheffield.
    latest = get_json(f"{API}/data/readings", params={"latest": "", "parameter": "level"})["items"]
    feats = []
    for r in latest:
        c = ctx.get(r.get("measure"))
        v = r.get("value")
        if not c or not isinstance(v, (int, float)):
            continue
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point", "coordinates": [c["lon"], c["lat"]]},
                      "properties": {"river": c["river"], "label": c["label"], "level": round(v, 3),
                                     "ratio": ratio(v, c["low"], c["high"]), "max": c["max"],
                                     "at": r.get("dateTime")}})
    log(f"  {len(feats)} live gauges")
    write("rivers.geojson", fc(feats))
