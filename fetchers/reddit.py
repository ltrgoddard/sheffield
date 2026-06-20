"""geolocated r/sheffield chatter — same llm-geocoding trick as news.py.

reddit posts are unstructured prose with no coordinates, exactly like local news.
we pull the subreddit's public atom feed (no key — the .json/oauth endpoints 403
datacenter ips, but the .rss feed serves once you ride out reddit's burst 429s,
which common.fetch retries) and turn each post that's clearly about a sheffield
place into a map pin: an ANTHROPIC_API_KEY runs one llm call returning
place/lat/lng/category, else the shared neighbourhood gazetteer matches names in
the text. degrades to valid (possibly empty) geojson.
"""
import json, re, html, xml.etree.ElementTree as ET
from common import fetch, llm, fc, write, log
from news import GAZ, point  # reuse the sheffield gazetteer + feature builder

URL = "https://www.reddit.com/r/sheffield/.rss"
A = "{http://www.w3.org/2005/Atom}"  # atom namespace


def items():
    """(title, body, url) for each post in the subreddit's atom feed."""
    root = ET.fromstring(fetch(URL, headers={"User-Agent": "Mozilla/5.0 (sheffield-model)"}, tries=6))
    out = []
    for e in root.iter(A + "entry"):
        t = html.unescape((e.findtext(A + "title") or "").strip())
        body = re.sub("<[^>]+>", " ", html.unescape(e.findtext(A + "content") or ""))
        ln = e.find(A + "link")
        link = ln.get("href", "") if ln is not None else ""
        if t:
            out.append((t, " ".join(body.split())[:300], link))
    return out[:40]


def via_llm(rows):
    prompt = ("These are r/sheffield (Reddit) post titles. For each clearly about a specific place "
              "*within Sheffield*, return its location. Reply ONLY with a JSON array of "
              '{"i":<index>,"place":<area>,"lat":<float>,"lng":<float>,'
              '"category":<one of crime, travel, development, environment, community, sport, other>}. '
              "Use real Sheffield coordinates; skip anything not about a Sheffield place.\n\n"
              + "\n".join(f'{i}: {t}' for i, (t, _, _) in enumerate(rows)))
    txt = llm(prompt, system="You are a precise geocoder. Output JSON only.", max_tokens=4096)
    txt = txt.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    feats = []
    for o in json.loads(txt):
        i = o.get("i")
        if isinstance(i, int) and 0 <= i < len(rows):
            t, s, link = rows[i]
            feats.append(point(o["lng"], o["lat"], t, s, link, o.get("place"), o.get("category", "other")))
    return feats


def via_gazetteer(rows):
    feats = []
    for t, s, link in rows:
        text = (t + " " + s).lower()
        hit = max((k for k in GAZ if k != "sheffield" and k in text), key=len, default=None)
        if hit:
            lon, lat = GAZ[hit]
            feats.append(point(lon, lat, t, s, link, hit.title(), "other"))
    return feats


if __name__ == "__main__":
    log("reddit: fetching r/sheffield…")
    try:
        rows = items()
    except Exception as e:
        log(f"  ! reddit unreachable ({e})"); rows = []
    if not rows:
        write("reddit.geojson", fc([])); raise SystemExit(0)
    try:
        feats = via_llm(rows)
        log(f"  llm placed {len(feats)} of {len(rows)} posts")
    except Exception as e:
        feats = via_gazetteer(rows)
        log(f"  gazetteer placed {len(feats)} of {len(rows)} ({e})")
    write("reddit.geojson", fc(feats))
