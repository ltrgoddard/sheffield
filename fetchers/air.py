"""a live air-quality field over sheffield, synthesised by sampling open-meteo.

there is no dense ground sensor network, so we generate our own: lay a grid of
points across the city and pull each one's current pollutants (no key, one batched
request). the result is a gridded no2 / pm2.5 / aqi surface the frontend can render
as a heat field — alternative data, built rather than found.
"""
from common import get_json, fc, write, log

# city bbox (w,s,e,n) and grid resolution — 9×7 = 63 sample points.
W, S, E, N = -1.56, 53.32, -1.34, 53.44
NX, NY = 9, 7
VARS = "european_aqi,pm2_5,pm10,nitrogen_dioxide,ozone,sulphur_dioxide"


def grid():
    xs = [W + (E - W) * i / (NX - 1) for i in range(NX)]
    ys = [S + (N - S) * j / (NY - 1) for j in range(NY)]
    return [(round(x, 4), round(y, 4)) for y in ys for x in xs]


if __name__ == "__main__":
    log("air: sampling open-meteo air-quality across a city grid…")
    pts = grid()
    rows = get_json("https://air-quality-api.open-meteo.com/v1/air-quality", params={
        "latitude": ",".join(str(y) for _, y in pts),
        "longitude": ",".join(str(x) for x, _ in pts),
        "current": VARS})
    rows = rows if isinstance(rows, list) else [rows]  # api returns a bare object for one point
    feats = []
    for (lon, lat), row in zip(pts, rows):
        c = row.get("current") or {}
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point", "coordinates": [lon, lat]},
                      "properties": {"aqi": c.get("european_aqi"), "pm25": c.get("pm2_5"),
                                     "pm10": c.get("pm10"), "no2": c.get("nitrogen_dioxide"),
                                     "o3": c.get("ozone"), "so2": c.get("sulphur_dioxide"),
                                     "at": c.get("time")}})
    log(f"  {len(feats)} grid points")
    write("air.geojson", fc(feats))
