"""primary-source layers straight from sheffield city council's arcgis server.

includes the things citizens actually ask about — public cctv cameras and the
live highways/street fault reports (potholes, broken lights, blocked drains) —
plus civic boundaries for context. fault reports are filtered to those still
open and raised in the last 90 days so the layer feels current.
"""
import datetime as dt
from common import arcgis, fc, write, log

CUTOFF = (dt.datetime.now() - dt.timedelta(days=30)).strftime("TIMESTAMP '%Y-%m-%d 00:00:00'")

# outfile, service, layer, where, fields, simplify(m) — simplify generalises
# polygon geometry server-side to keep the files light.
JOBS = [
    ("cctv.geojson", "AGOL/OpenData", 7, "1=1", "cam_number,location,notes", 0),
    ("faults.geojson", "AGOL/Verint_PublicFaultReporting", 11,
     f"fault_closed_date IS NULL AND fault_open_date>={CUTOFF}",
     "fault_description,fault_status,fault_open_date,fault_priority", 0),
    ("boundary.geojson", "AGOL/OpenData", 11, "1=1", "*", 10),
    ("wards.geojson", "AGOL/OpenData", 12, "1=1", "*", 10),
    ("clean_air.geojson", "AGOL/OpenData", 28, "1=1", "*", 10),
]

if __name__ == "__main__":
    for name, svc, lyr, where, fields, simp in JOBS:
        log(f"council: {name} ← {svc}/{lyr}")
        try:
            extra = {"maxAllowableOffset": simp} if simp else None
            write(name, fc(arcgis(svc, lyr, where, fields, extra)))
        except Exception as e:
            log(f"  ! skipped ({e})")
