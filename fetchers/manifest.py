"""publish data/manifest.json — a freshness index over every feed.

run last by the makefile's `data` target. scans the geojson files and records, per feed, its feature
count, size and age in seconds, so the frontend can show honest "updated 12s ago"
status and ops can spot a stale or empty feed at a glance. derived purely from the
files on disk, so it never races the parallel fetchers that produce them.
"""
import json, time, struct, datetime as dt
from common import DATA, write, log

if __name__ == "__main__":
    now = time.time()
    feeds = {}
    for p in sorted([*DATA.glob("*.geojson"), *DATA.glob("*.bin")]):
        try:
            n = (struct.unpack("<I", p.read_bytes()[:4])[0] if p.suffix == ".bin"  # packed buffers: feature count is the u32 header
                 else len(json.loads(p.read_text()).get("features", [])))
        except Exception:
            n = None
        st = p.stat()
        feeds[p.stem] = {"features": n, "kb": st.st_size // 1024,
                         "age_s": round(now - st.st_mtime),
                         "updated": dt.datetime.fromtimestamp(st.st_mtime, dt.timezone.utc)
                                      .isoformat(timespec="seconds")}
    write("manifest.json", {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
                            "feeds": feeds})
    log(f"manifest: {len(feeds)} feeds indexed")
