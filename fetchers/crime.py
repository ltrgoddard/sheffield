"""street-level crime from data.police.uk (home office, primary source).

the api serves one month at a time and lags ~6 weeks, so we walk backwards from
the current month until a published dataset is found. queried over a polygon
covering the sheffield city boundary.
"""
import datetime as dt
from common import get_json, fc, write, log

# coarse polygon around sheffield (lat:lng pairs, police.uk order)
POLY = "53.46,-1.62:53.46,-1.30:53.30,-1.30:53.30,-1.62"
API = "https://data.police.uk/api/crimes-street/all-crime"


def latest():
    d = dt.date.today().replace(day=1)
    for _ in range(6):  # try the last six months
        d = (d - dt.timedelta(days=1)).replace(day=1)
        rows = get_json(API, params={"poly": POLY, "date": d.strftime("%Y-%m")})
        if rows:
            return d.strftime("%Y-%m"), rows
    return None, []


if __name__ == "__main__":
    log("crime: querying data.police.uk…")
    month, rows = latest()
    feats = [{"type": "Feature",
              "geometry": {"type": "Point", "coordinates": [float(r["location"]["longitude"]), float(r["location"]["latitude"])]},
              "properties": {"category": r["category"].replace("-", " "),
                             "street": r["location"]["street"]["name"],
                             "outcome": (r.get("outcome_status") or {}).get("category"),
                             "month": r["month"]}}
             for r in rows if r.get("location")]
    log(f"  month {month}")
    write("crime.geojson", fc(feats))
