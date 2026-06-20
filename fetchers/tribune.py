"""sheffield tribune — geolocated pins from the ghost content api.

the tribune is a high-quality local newsletter on ghost. its content api (one
read-only key, no scraping) serves recent posts with a clean editor's excerpt.
we reuse the news geocoder — llm first, gazetteer fallback — to drop each on the
map, keeping the link + summary for the tooltip. not just hard news: house of
the week, events listings and culture get pinned too, wherever the text names a
sheffield place. degrades to valid (possibly empty) geojson; never aborts.
"""
import os, json, re, html, xml.etree.ElementTree as ET
from common import fetch, fc, write, log
from news import via_llm, via_gazetteer

SITE = "https://www.sheffieldtribune.co.uk"


def items():
    """latest tribune posts as (title, summary, link). ghost content api when a
    TRIBUNE_API_KEY is set (cleaner editor excerpts), else the keyless public rss
    feed — same ghost content, no secret required, so this always runs."""
    key = os.environ.get("TRIBUNE_API_KEY")
    if key:
        url = (f"{SITE}/ghost/api/content/posts/?key={key}&limit=40&order=published_at%20desc"
               "&formats=plaintext&fields=title,url,excerpt,custom_excerpt,plaintext")
        posts = json.loads(fetch(url, headers={"Accept-Version": "v5.0"}))["posts"]
        body = lambda p: (p.get("plaintext") or p.get("custom_excerpt") or p.get("excerpt") or "")
        return [(p["title"], " ".join(body(p).split())[:700], p["url"]) for p in posts]
    root = ET.fromstring(fetch(f"{SITE}/feed", headers={"User-Agent": "Mozilla/5.0"}))
    g = lambda it, t: html.unescape((it.findtext(t) or "").strip())
    return [(g(it, "title"), re.sub("<[^>]+>", "", g(it, "description"))[:700], g(it, "link"))
            for it in root.iter("item") if g(it, "title")][:40]


if __name__ == "__main__":
    log("tribune: fetching ghost posts…")
    try:
        rows = items()
    except Exception as e:
        log(f"  ! {e}")
        write("tribune.geojson", fc([]))
        raise SystemExit(0)
    try:
        feats = via_llm(rows)
        log(f"  llm placed {len(feats)} of {len(rows)} posts")
    except Exception as e:
        feats = via_gazetteer(rows)
        log(f"  gazetteer placed {len(feats)} of {len(rows)} ({e})")
    write("tribune.geojson", fc(feats))
