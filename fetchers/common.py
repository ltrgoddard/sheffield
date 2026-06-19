"""shared helpers for the sheffield fetchers — zero pip dependencies.

every fetcher writes a compact geojson (epsg:4326) into ../data, which the
frontend polls. all sources are primary: openstreetmap, data.police.uk, the
sheffield city council arcgis server, the dft bus open data service and the
environment agency. no aggregators.
"""
import json, time, pathlib, urllib.request, urllib.parse, urllib.error, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "sheffield-model/1.0 (+https://github.com; open-data fetcher)"
SCC = "https://sheffieldcitycouncil.cloud.esriuk.com/server/rest/services"


def fetch(url, params=None, data=None, headers=None, tries=4, timeout=60):
    """http get/post with urlencoded params, exponential backoff, retries."""
    if params:
        url += "?" + urllib.parse.urlencode(params)
    body = urllib.parse.urlencode(data).encode() if data else None
    hdr = {"User-Agent": UA, **(headers or {})}
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, body, hdr), timeout=timeout) as r:
                return r.read()
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ConnectionError) as e:
            if i == tries - 1:
                raise
            log(f"  retry {i+1}/{tries} ({e})")
            time.sleep(2 ** i)


def get_json(url, **kw):
    return json.loads(fetch(url, **kw))


def overpass(query, **kw):
    return get_json("https://overpass-api.de/api/interpreter", data={"data": query}, **kw)


def arcgis(service, layer, where="1=1", fields="*", extra=None, page=2000):
    """query a sheffield arcgis layer, paging through all features as geojson."""
    base = f"{SCC}/{service}/MapServer/{layer}/query"
    feats, offset = [], 0
    while True:
        p = {"where": where, "outFields": fields, "outSR": 4326, "f": "geojson",
             "resultOffset": offset, "resultRecordCount": page, **(extra or {})}
        fc_ = get_json(base, params=p)
        got = fc_.get("features", [])
        feats += got
        if len(got) < page or not fc_.get("exceededTransferLimit"):
            break
        offset += page
    return feats


def fc(features):
    return {"type": "FeatureCollection", "features": features}


def write(name, obj):
    DATA.mkdir(exist_ok=True)
    p = DATA / name
    p.write_text(json.dumps(obj, separators=(",", ":")))
    n = len(obj.get("features", [])) if isinstance(obj, dict) else 0
    log(f"  → {name}  {n} features, {p.stat().st_size // 1024} kb")
    return p


def log(*a):
    print(*a, file=sys.stderr, flush=True)
