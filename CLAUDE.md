# Sheffield — a living 3D model

Full-screen, pan/zoom 3D map of Sheffield fusing **EA LIDAR** terrain, **OSM** buildings,
and live **open-data** feeds (buses, river levels, air quality, crime, council CCTV/faults,
trees, development sites, geolocated news). Understated, SimCity-ish, with things moving.
Watch-words: quality, reliability, care.

## Architecture

No build step, no map library, no CDN. Plain ES modules driving a **custom WebGPU
renderer** on the front; dependency-light Python fetchers on the back. They're decoupled by
files: fetchers write `data/*.geojson`, the frontend polls them. That's the whole contract.
The whole city is drawn as **1px lines** — terrain as a lifted wire grid, buildings as edge
wireframes, feeds as billboarded line-markers — straight from open data onto the GPU.

```
index.html  app.js  config.js  style.css   # frontend
gpu.js      proj.js                         # webgpu device/pipelines + projection/camera/terrain
fetchers/   common.py + one script per source
data/       geojson the fetchers write (data/terrain/ = lidar tiles, gitignored)
Makefile    data orchestration (`make`, `make live`, `make watch`, `make lidar`, `make serve`)
pyproject.toml  zero-dep uv project   .env  BODS_API_KEY / ANTHROPIC_API_KEY (gitignored)
```

- **config.js** — the only place to tune: `CITY` camera, `BBOX` (the patch we render),
  `TERRAIN` (tile zoom/grid/exaggeration), `FEEDS` (file → poll ms), `LAYERS` (toggle
  id/label/default). Touch this before the JS.
- **proj.js** — the cpu maths: local-metre projection (`ll2m`), the orbit `Camera`'s
  view-proj matrix, and `Terrain` (decodes terrarium tiles → a height-field we both drape
  geometry on via `elev()` and draw as a `wire()` grid).
- **gpu.js** — the `Renderer`: one WebGPU device, two pipelines (1px `line-list` + instanced
  point-markers), orbit controls (drag pan / right-drag orbit / wheel dolly), and cpu-side
  `pick()`. API: `setLine`/`setMark`/`setVisible`/`frame`/`pick`.
- **app.js** — loads each feed, folds geojson into flat float32 line/point arrays in metres
  (`buildingWire`/`lineWire`/`setPoints`), runs `animate()` (rAF loop moving trams +
  interpolating live buses) and `poll()`, wires the toggles + popups. `window.R`/`cam`/`terr`
  are exposed for debugging.
- **fetchers/common.py** — `fetch`/`get_json` (urllib + retries + UA; accepts a raw
  bytes body for JSON POSTs), `overpass`, `arcgis` (paged geojson), `llm` (zero-dep
  Anthropic call, gated on `ANTHROPIC_API_KEY`), `write` (**atomic** temp-then-rename so
  the poller never sees a half file). Everything writes compact EPSG:4326 geojson.
- **Makefile** runs every fetcher under `uv` **in parallel** (`make` = `-j 8`; each independent,
  one failing never aborts the rest) then `manifest.py`, which writes `data/manifest.json` — a
  per-feed freshness index (feature count, size, age) for the frontend status and ops. Python is
  pure-stdlib so `uv` just pins the interpreter; secrets load from `.env`.

## Running / verifying

```sh
make                 # refresh every feed (snapshot is committed so it works immediately)
make serve           # http://localhost:8000
make lidar           # stream EA lidar → data/terrain over the full boundary (no key, ~5 min)
cp .env.example .env && $EDITOR .env   # add BODS_API_KEY (real buses) + ANTHROPIC_API_KEY (news llm)
make watch           # loop the live buses every 15s once BODS_API_KEY is set
```

Verify visually with headless Playwright — it ships a real WebGPU adapter; `window.R`
exposes the renderer (`R.lines`/`R.marks` counts, `R.pick(x,y)`) and `window.cam` the camera.
Terrain + 12k building wireframes decode in the first second — wait before judging.

## Conventions

- Code is deliberately minimal/dense; comments lowercase. Keep it that way.
- **Adding a feed:** write `fetchers/foo.py` that emits `data/foo.geojson`; add it to
  `FEEDS` + `LAYERS` in config.js; in app.js `layers()` call `setPoints("foo", …)` for points
  (add a `PT` style + `POP` popup + `TOG` entry) or `R.setLine("foo", lineWire(…), …)` for
  lines/polygons. Done.
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
- **EA flood-monitoring** (no key!): `id/stations?parameter=level&lat&long&dist&_view=full` takes
  geo filters and carries `stageScale` (typical range), but **not** the latest value; `id/measures`
  rejects the same geo filters (400). So `data/readings?latest&parameter=level` (national, ~1.3 MB,
  no geo filter) is pulled once and joined to the local stations by measure `@id` — hence rivers is
  a full-run feed, not a 15 s one.
- **More Sheffield ArcGIS services** (sibling folders to `AGOL/OpenData`): `AGOL/OpenData/6`
  Brownfield Register + `/17` HELAA = development sites (with dwelling capacity); `Planning/…` =
  Local Plan policy map. `AGOL/Community_Forestry_Trees/14` exists but its features have **no
  geometry** — use OSM `natural=tree` for mappable trees instead. (NCR EV chargepoints API was
  unreachable from here — dropped.)
- **LLM-as-geocoder**: `news.py` turns unstructured RSS headlines into map pins — one `llm()` call
  returns place+lat/lng+category per item when `ANTHROPIC_API_KEY` is set, else a built-in
  neighbourhood gazetteer matches names in the text. Always degrades to valid (possibly empty)
  geojson; never aborts the run.
- **EA LIDAR WCS** (no key!): two subsets `&subset=E(a,b)&subset=N(c,d)` must be hand-appended
  (urlencode can't hold duplicate keys); `&scalefactor=` downsamples; axis labels `E N`, EPSG:27700.
  Only the **DTM** is exposed on the WCS — DSM (rooftops) needs GeoTIFFs passed to lidar.py.
- **Terrarium encoding**: `height = R*256 + G + B/256 - 32768`. `Terrain` in proj.js fetches
  every local `data/terrain/` tile intersecting `BBOX` at `TERRAIN.zoom`, decodes via
  `OffscreenCanvas`, and is silent (flat, no wire grid) if none are present — run lidar.py.
- **Trams are timetable-estimated** (along real OSM geometry) — Supertram has *no* public live
  vehicle feed: not BODS (buses-only — verified: zero tram operators in the live snapshot), and
  the only live signal (departure boards via TSY/livetrams) is bot-walled or broken. So `TRAM`
  in config.js drives `tramFeatures()` in app.js: a tram per direction at its real headway within
  service hours. Buses are genuinely live. The status bar says which; keep that honest.

See `~/.claude/.../memory/sheffield-data-sources.md` for exact endpoints/coverage IDs.
