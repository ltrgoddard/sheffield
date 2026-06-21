"""shared helpers for the sheffield fetchers — zero pip dependencies.

every fetcher writes a compact geojson (epsg:4326) into ../data, which the
frontend polls. all sources are primary: openstreetmap, data.police.uk, the
sheffield city council arcgis server, the dft bus open data service and the
environment agency. no aggregators.
"""
import json, time, pathlib, os, struct, urllib.request, urllib.parse, urllib.error, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
UA = "sheffield-model/1.0 (+https://github.com; open-data fetcher)"
SCC = "https://sheffieldcitycouncil.cloud.esriuk.com/server/rest/services"


def fetch(url, params=None, data=None, headers=None, tries=4, timeout=60):
    """http get/post with urlencoded params, exponential backoff, retries."""
    if params:
        url += "?" + urllib.parse.urlencode(params)
    body = data if isinstance(data, (bytes, bytearray)) else (urllib.parse.urlencode(data).encode() if data else None)
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
    """atomically publish a geojson — write a temp file then rename, so the
    polling frontend never reads a half-written file (fetchers run in parallel)."""
    DATA.mkdir(exist_ok=True)
    p, tmp = DATA / name, DATA / (name + ".tmp")
    tmp.write_text(json.dumps(obj, separators=(",", ":")))
    os.replace(tmp, p)
    n = len(obj.get("features", [])) if isinstance(obj, dict) else 0
    log(f"  → {name}  {n} features, {p.stat().st_size // 1024} kb")
    return p


def packbin(name, features, lines, heights=None):
    """pack polyline/ring geometry straight into a gpu buffer — no json for the
    browser to parse, ~5-11× smaller raw than geojson. layout (little-endian):
      u32 nFeatures; per feature: f32 h, f32 b, u32 nParts;
      per part: u32 nVerts, then nVerts × (i32 lon, i32 lat) ×1e6 (~0.1 m grid).
    `lines(geom)`→iterable of coord lists; `heights(feat)`→(h,b) for extruded
    wireframes, else flat. atomic temp-then-rename like write()."""
    out, nf = bytearray(), 0
    for f in features:
        parts = [ln for ln in lines(f["geometry"]) if len(ln) >= 2]
        if not parts:
            continue
        h, b = heights(f) if heights else (0.0, 0.0)
        out += struct.pack("<ffI", h, b, len(parts))
        for ln in parts:
            flat = [round(c * 1e6) for xy in ln for c in xy[:2]]
            out += struct.pack(f"<I{len(flat)}i", len(ln), *flat)
        nf += 1
    DATA.mkdir(exist_ok=True)
    p, tmp = DATA / name, DATA / (name + ".tmp")
    tmp.write_bytes(struct.pack("<I", nf) + out)
    os.replace(tmp, p)
    (DATA / (p.stem + ".geojson")).unlink(missing_ok=True)  # a layer is bin xor geojson — drop any superseded geojson
    log(f"  → {name}  {nf} features, {p.stat().st_size // 1024} kb")
    return p


# free openrouter models tried in order — the fallback list rides out the free
# pool's frequent upstream 429s (openrouter skips an unavailable one for the next).
OR_FREE = ["meta-llama/llama-3.3-70b-instruct:free", "qwen/qwen3-next-80b-a3b-instruct:free",
           "nex-agi/nex-n2-pro:free"]


def llm(prompt, system="", model=None, max_tokens=2048):
    """one-shot chat completion — text in, text out, zero pip deps. prefers a free
    openrouter model when OPENROUTER_API_KEY is set, else the anthropic api with
    ANTHROPIC_API_KEY; raises without either so callers fall back to the gazetteer."""
    if key := os.environ.get("OPENROUTER_API_KEY"):
        body = json.dumps({"models": [model] if model else OR_FREE, "max_tokens": max(max_tokens, 8192),
            # headroom: the free pool's reachable models are thinking models that ignore
            # reasoning-off and burn budget before answering — too little and content comes back null.
            "reasoning": {"enabled": False},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}]}).encode()
        # tries/timeout bounded: when the whole free list is rate-limited the 429s are
        # instant (quick fall to the gazetteer); a generous per-attempt window lets a slow
        # free model finish without the retry turning into a multi-minute hang.
        r = json.loads(fetch("https://openrouter.ai/api/v1/chat/completions", data=body, tries=3, timeout=120,
            headers={"Authorization": f"Bearer {key}", "content-type": "application/json"}))
        c = r["choices"][0]
        if not c["message"].get("content"):  # busy free models sometimes 200 with null content
            raise RuntimeError(f"openrouter empty content (finish={c.get('finish_reason')})")
        return c["message"]["content"]
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        raise RuntimeError("no LLM key (OPENROUTER_API_KEY / ANTHROPIC_API_KEY)")
    body = json.dumps({"model": model or "claude-haiku-4-5-20251001", "max_tokens": max_tokens,
                       "system": system, "messages": [{"role": "user", "content": prompt}]}).encode()
    r = json.loads(fetch("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"}))
    return "".join(b.get("text", "") for b in r.get("content", []))


def log(*a):
    print(*a, file=sys.stderr, flush=True)
