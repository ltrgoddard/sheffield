"""live bus & tram positions from the dft bus open data service (siri-vm).

bods is the statutory primary feed every operator in england must publish to.
set BODS_API_KEY (free registration at data.bus-data.dft.gov.uk) to enable; the
frontend smoothly interpolates between the position snapshots written here, and
falls back to simulated trams along the osm routes when this feed is absent.
"""
import os, xml.etree.ElementTree as ET
from common import fetch, fc, write, log

BBOX = "-1.60,53.30,-1.30,53.46"  # minLon,minLat,maxLon,maxLat
KEY = os.environ.get("BODS_API_KEY")


def tag(el, name):
    """find a child by local name, ignoring siri's xml namespace."""
    for e in el.iter():
        if e.tag.rsplit("}", 1)[-1] == name:
            return e.text
    return None


if __name__ == "__main__":
    if not KEY:
        log("vehicles: BODS_API_KEY not set — frontend will simulate trams instead.")
        raise SystemExit(0)
    log("vehicles: polling bods siri-vm…")
    xml = fetch("https://data.bus-data.dft.gov.uk/api/v1/datafeed/",
                params={"api_key": KEY, "boundingBox": BBOX})
    root = ET.fromstring(xml)
    feats = []
    for va in root.iter():
        if va.tag.rsplit("}", 1)[-1] != "VehicleActivity":
            continue
        lon, lat = tag(va, "Longitude"), tag(va, "Latitude")
        if not (lon and lat):
            continue
        feats.append({"type": "Feature",
                      "geometry": {"type": "Point", "coordinates": [float(lon), float(lat)]},
                      "properties": {"line": tag(va, "PublishedLineName") or tag(va, "LineRef"),
                                     "operator": tag(va, "OperatorRef"),
                                     "bearing": float(tag(va, "Bearing") or 0),
                                     "vehicle": tag(va, "VehicleRef")}})
    write("vehicles.geojson", fc(feats))
