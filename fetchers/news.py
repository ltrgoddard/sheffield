"""geolocated city news — llm parsing of unstructured text into map pins.

local news is unstructured prose with no coordinates. we fetch sheffield rss
headlines + the opening of each story and turn them into points on the map by a
two-step geocode: one llm call (free openrouter, else anthropic) names the most
specific place each item is about and a category — no coordinates, so it can't
hallucinate them — then geocode() resolves real lat/lng (gazetteer, then
nominatim). without a key we fall back to a built-in gazetteer that matches
neighbourhood names in the text. alternative data, generated from raw text.
"""
import json, re, html, xml.etree.ElementTree as ET
from common import fetch, get_json, llm, fc, write, log

FEEDS = ["https://feeds.bbci.co.uk/news/england/south_yorkshire/rss.xml",
         "https://www.thestar.co.uk/news/local/rss"]

# ~35 sheffield localities → centroid, for the no-key fallback and to bound the llm.
GAZ = {
    "city centre": (-1.4701, 53.3811), "kelham island": (-1.472, 53.388), "ecclesall": (-1.508, 53.353),
    "hillsborough": (-1.503, 53.405), "crookes": (-1.515, 53.383), "broomhill": (-1.498, 53.382),
    "walkley": (-1.500, 53.391), "heeley": (-1.470, 53.357), "sharrow": (-1.483, 53.366),
    "nether edge": (-1.495, 53.360), "meersbrook": (-1.477, 53.351), "gleadless": (-1.428, 53.355),
    "darnall": (-1.395, 53.385), "attercliffe": (-1.420, 53.390), "tinsley": (-1.400, 53.410),
    "firth park": (-1.440, 53.420), "burngreave": (-1.456, 53.397), "pitsmoor": (-1.460, 53.395),
    "norton": (-1.455, 53.340), "woodseats": (-1.470, 53.345), "totley": (-1.530, 53.315),
    "dore": (-1.518, 53.330), "crosspool": (-1.530, 53.378), "stocksbridge": (-1.588, 53.478),
    "chapeltown": (-1.470, 53.460), "mosborough": (-1.360, 53.330), "handsworth": (-1.385, 53.375),
    "manor": (-1.435, 53.378), "fulwood": (-1.545, 53.370), "meadowhall": (-1.412, 53.413),
    "owlerton": (-1.490, 53.402), "parson cross": (-1.480, 53.420), "ecclesfield": (-1.465, 53.443),
    "university": (-1.487, 53.381), "sheffield": (-1.4701, 53.3811),
}


def items():
    """(title, summary, link) for each rss entry across the feeds."""
    out = []
    for url in FEEDS:
        try:
            root = ET.fromstring(fetch(url, headers={"User-Agent": "Mozilla/5.0"}))
        except Exception as e:
            log(f"  ! {url.split('/')[2]} ({e})")
            continue
        for it in root.iter("item"):
            g = lambda t: (it.findtext(t) or "").strip()
            title = html.unescape(g("title"))
            if title:
                out.append((title, html.unescape(re.sub("<[^>]+>", "", g("description")))[:700], g("link")))
    return out[:40]


def geocode(place, _c={}):
    """place name → (lon, lat). gazetteer first (instant, no network), else
    nominatim bounded to the sheffield area. cached per run; None if unresolvable.
    a real geocoder beats asking the llm for coordinates — no hallucinated points."""
    p = (place or "").strip().lower()
    if not p:
        return None
    if p not in _c:
        hit = max((k for k in GAZ if k != "sheffield" and k in p), key=len, default=None)
        if hit:
            _c[p] = GAZ[hit]
        else:
            try:
                r = get_json("https://nominatim.openstreetmap.org/search",
                             params={"q": f"{place}, Sheffield, UK", "format": "jsonv2", "limit": 1,
                                     "viewbox": "-1.85,53.50,-1.25,53.28", "bounded": 1})
                _c[p] = (float(r[0]["lon"]), float(r[0]["lat"])) if r else None
            except Exception:
                _c[p] = None
    return _c[p]


def via_llm(rows):
    """two-step geocode: the llm only names the most specific place each item is
    about (no coordinates), then geocode() resolves real lat/lon for it."""
    prompt = ("These are South Yorkshire news items (headline then the opening of the body). For each "
              "that is clearly about somewhere *within Sheffield*, name the most specific place it concerns "
              "— a street, neighbourhood, landmark or building — using the body for precision. Reply ONLY "
              'with a JSON array of {"i":<index>,"place":<that place name>,'
              '"category":<one of crime, travel, development, environment, community, sport, other>}. '
              "Skip anything not in Sheffield.\n\n"
              + "\n\n".join(f'{i}: {t}\n{s}' for i, (t, s, _) in enumerate(rows)))
    txt = llm(prompt, system="You extract Sheffield place names as JSON. Output JSON only.", max_tokens=2048)
    txt = re.sub(r"^```\w*|```$", "", txt.strip()).strip()
    feats = []
    for o in json.loads(txt):
        i = o.get("i")
        if not isinstance(i, int) or not (0 <= i < len(rows)):
            continue
        ll = geocode(o.get("place"))
        if not ll:
            continue
        t, s, link = rows[i]
        feats.append(point(*ll, t, s, link, o.get("place"), o.get("category", "other")))
    return feats


def via_gazetteer(rows):
    feats = []
    for t, s, link in rows:
        text = (t + " " + s).lower()
        hit = max((k for k in GAZ if k in text), key=len, default=None)
        if hit and hit != "sheffield" or (hit == "sheffield" and "sheffield" in t.lower()):
            lon, lat = GAZ[hit]
            feats.append(point(lon, lat, t, s, link, hit.title(), "other"))
    return feats


def point(lon, lat, title, summary, link, place, category):
    return {"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(float(lon), 5), round(float(lat), 5)]},
            "properties": {"title": title, "summary": summary, "link": link, "place": place, "category": category}}


if __name__ == "__main__":
    log("news: fetching sheffield headlines…")
    rows = items()
    if not rows:
        write("news.geojson", fc([]))
        raise SystemExit(0)
    try:
        feats = via_llm(rows)
        log(f"  llm placed {len(feats)} of {len(rows)} headlines")
    except Exception as e:
        feats = via_gazetteer(rows)
        log(f"  gazetteer placed {len(feats)} of {len(rows)} ({e})")
    write("news.geojson", fc(feats))
