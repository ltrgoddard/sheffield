# Sheffield — a living 3D model

Full-screen, pan/zoom 3D map of Sheffield fusing **EA LIDAR** terrain, **OSM** buildings,
and live **open-data** feeds (buses, crime, council CCTV/faults). Understated, SimCity-ish,
with things moving. Watch-words: quality, reliability, care.

## Architecture

No build step. Plain ES modules + MapLibre GL (CDN) on the front; dependency-light Python
fetchers on the back. They're decoupled by files: fetchers write `data/*.geojson`, the
frontend polls them. That's the whole contract.

```
index.html  app.js  config.js  style.css   # frontend
fetchers/   common.py + one script per source
data/       geojson the fetchers write (data/terrain/ = lidar tiles, gitignored)
fetch.sh    transit + all live feeds      live.sh   loop the fast feeds (buses)
serve.sh    static server                 lidar.py  see below
```

- **config.js** — the only place to tune: camera, tile URLs, `FEEDS` (file → poll ms),
  `LAYERS` (toggle id/label/default). Touch this before app.js.
- **app.js** — map setup → `terrain()` (lidar or fallback DEM + hillshade), `buildings()`
  (restyle OSM 3D), `layers()` (add every feed's source+layers), `animate()` (rAF loop that
  moves trams and interpolates live buses), `poll()`. `window.map` is exposed for debugging.
- **fetchers/common.py** — `fetch`/`get_json` (urllib + retries + UA), `overpass`,
  `arcgis` (paged geojson), `write`. Everything writes compact EPSG:4326 geojson.

## Running / verifying

```sh
./fetch.sh            # refresh data (snapshot is committed so it works immediately)
./serve.sh            # http://localhost:8000
python3 fetchers/lidar.py     # stream EA lidar → data/terrain (no key, ~3 min)
export BODS_API_KEY=… && ./live.sh   # real live buses, refreshed every 15s
```

Verify visually with headless Playwright (the map uses real WebGL; `window.map` lets you
read sources). Cold tile load can look black for a few seconds — wait before judging.

## Conventions

- Code is deliberately minimal/dense; comments lowercase. Keep it that way.
- **Adding a feed:** write `fetchers/foo.py` that emits `data/foo.geojson`; add it to
  `FEEDS` + `LAYERS` in config.js; add its source/layers in `layers()` in app.js. Done.
- Prefer **primary sources over aggregators** (this was an explicit ask — e.g. the council's
  own ArcGIS over PlanIt).

## Gotchas (all learned the hard way)

- **Overpass**: use `out geom;` for relation member geometry — `out tags geom;` drops it.
  Send a `User-Agent` or you get 406.
- **Sheffield ArcGIS** (`sheffieldcitycouncil.cloud.esriuk.com/server/rest/services`):
  service paths need the folder prefix (`AGOL/OpenData`, not `OpenData`). Date fields reject
  epoch-ms in `where` — use `TIMESTAMP 'YYYY-MM-DD 00:00:00'`. Generalise heavy polygons with
  `maxAllowableOffset`.
- **police.uk**: `poly` is `lat,lng` pairs colon-separated; data lags ~6 weeks (walk months back).
- **EA LIDAR WCS** (no key!): two subsets `&subset=E(a,b)&subset=N(c,d)` must be hand-appended
  (urlencode can't hold duplicate keys); `&scalefactor=` downsamples; axis labels `E N`, EPSG:27700.
  Only the **DTM** is exposed on the WCS — DSM (rooftops) needs GeoTIFFs passed to lidar.py.
- **Terrarium encoding**: `height = R*256 + G + B/256 - 32768`. Frontend auto-uses
  `data/terrain/` when the probe tile (config `DEM_PROBE`) exists, else a global DEM.
- **Trams are timetable-estimated** (along real OSM geometry) — Supertram has *no* public live
  vehicle feed: not BODS (buses-only — verified: zero tram operators in the live snapshot), and
  the only live signal (departure boards via TSY/livetrams) is bot-walled or broken. So `TRAM`
  in config.js drives `tramFeatures()` in app.js: a tram per direction at its real headway within
  service hours. Buses are genuinely live. The status bar says which; keep that honest.

See `~/.claude/.../memory/sheffield-data-sources.md` for exact endpoints/coverage IDs.
