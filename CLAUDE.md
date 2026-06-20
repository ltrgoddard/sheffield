# Sheffield — a living 3D model

Full-screen, pan/zoom 3D map of Sheffield fusing **EA LIDAR** terrain, **OSM** buildings,
and live **open-data** feeds (buses, river levels, air quality, crime, council CCTV/faults,
trees, development sites, geolocated news + r/sheffield). Understated, SimCity-ish, with things moving.
Watch-words: quality, reliability, care.

## Architecture

No build step, no map library, no CDN. Plain ES modules driving a **custom WebGPU
renderer** on the front; dependency-light Python fetchers on the back. They're decoupled by
files: fetchers write `data/*.geojson`, the frontend polls them. That's the whole contract.
The whole city is drawn as **1px lines** — terrain as a lifted wire grid, buildings as edge
wireframes, feeds as billboarded line-markers — straight from open data onto the GPU.
(One exception to the file contract: **live buses** are fetched in the browser straight from
bustimes.org — a cors-enabled, no-key json feed — so they're live with no backend at all.)

```
index.html  app.js  config.js  style.css   # frontend
gpu.js      proj.js                         # webgpu device/pipelines + projection/camera/terrain
fetchers/   common.py + one script per source
data/       geojson the fetchers write (gitignored; lives in the `latest-data` release)
Makefile    data orchestration (`make`, `make lidar`, `make serve`)
.github/workflows/  deploy.yml (pages) + sync.yml (cron refresh → release → redeploy)
pyproject.toml  zero-dep uv project   .env  ANTHROPIC_API_KEY for news llm (gitignored)
```

- **config.js** — the only place to tune: `CITY` camera, `BBOX` (the patch we render),
  `TERRAIN` (tile zoom/grid/exaggeration), `FEEDS` (file → poll ms), `LAYERS` (toggle
  id/label/default). Touch this before the JS.
- **proj.js** — the cpu maths: local-metre projection (`ll2m`), the orbit `Camera`'s
  view-proj matrix, and `Terrain` (decodes terrarium tiles → a height-field we both drape
  geometry on via `elev()` and draw as a `wire()` grid).
- **gpu.js** — the `Renderer`: one WebGPU device, two pipelines (1px `line-list` + instanced
  point-markers), orbit controls (drag pan / right-drag orbit / wheel dolly; one-finger pan /
  two-finger pinch-twist-tilt on touch), and cpu-side `pick()`. API:
  `setLine`/`setMark`/`setVisible`/`frame`/`pick`/`screen` (world→css-px for the label overlay).
- **app.js** — loads each feed, folds geojson into flat float32 line/point arrays in metres
  (`buildingWire`/`lineWire`/`setPoints`), runs `animate()` (rAF loop moving trams +
  interpolating live buses, then `drawLabels()`) and `poll()`, wires the toggles + popups.
  **Labels** (`drawLabels`) are the only text: lowercase JetBrains Mono on a 2d `#labels`
  overlay, projected via `R.screen()` each frame, fading in only at high zoom (`LABELS` in
  config) with greedy collision-avoidance — street names ride the road, stop names sit by the
  dot. `window.R`/`cam`/`terr` are exposed for debugging.
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
make                 # fetch every feed into data/ (gitignored; not committed)
make serve           # http://localhost:8000
make lidar           # stream EA lidar → data/terrain over the full boundary (no key, ~5 min)
cp .env.example .env && $EDITOR .env   # optional ANTHROPIC_API_KEY (news llm; else gazetteer)
```

Verify visually with headless Playwright — it ships a real WebGPU adapter; `window.R`
exposes the renderer (`R.lines`/`R.marks` counts, `R.pick(x,y)`) and `window.cam` the camera.
Terrain + 12k building wireframes decode in the first second — wait before judging.

## Deployment — GitHub Pages, no server

Frontend lives in git; **data lives in the `latest-data` GitHub Release** (a `data.zip` of
all of `data/`, geojson + terrain). Two workflows:
- **deploy.yml** (push to main / dispatch) — assembles `_site` = frontend + the release's
  data and publishes it to Pages (live at `ltrg.co.uk/sheffield`).
- **sync.yml** (cron, daily) — re-fetches the *refreshable* feeds (rivers, air, news,
  crime, council, planning, trees), re-zips, re-uploads the release, then triggers a redeploy.
  The heavy static layers (buildings, roads, trams, terrain) carry over from the release
  untouched — rebuild those locally with `make` + `make lidar` and `gh release upload
  latest-data data.zip --clobber` when they need refreshing. Live buses aren't in the cron
  at all (the browser pulls them direct from bustimes.org).

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
  geojson; never aborts the run. `reddit.py` reuses that same `GAZ`+`point` (imported from
  `news`) on r/sheffield posts.
- **Reddit (no key)**: the `.json`/`oauth` endpoints **403 datacenter IPs** (so do `old.reddit`),
  but the plain **atom feed** `reddit.com/r/sheffield/.rss` serves fine — once you ride out
  reddit's burst **429s** (it throttles rapid hits, ~15 s; `reddit.py` passes `tries=6` so
  `common.fetch`'s backoff clears them). Atom namespace `{http://www.w3.org/2005/Atom}`.
- **EA LIDAR WCS** (no key!): two subsets `&subset=E(a,b)&subset=N(c,d)` must be hand-appended
  (urlencode can't hold duplicate keys); `&scalefactor=` downsamples; axis labels `E N`, EPSG:27700.
  Only the **DTM** is exposed on the WCS — DSM (rooftops) needs GeoTIFFs passed to lidar.py.
- **Terrarium encoding**: `height = R*256 + G + B/256 - 32768`. `Terrain` in proj.js fetches
  every local `data/terrain/` tile intersecting `BBOX` at `TERRAIN.zoom`, decodes via
  `OffscreenCanvas`, and is silent (flat, no wire grid) if none are present — run lidar.py.
- **Live buses, no key, no backend**: bustimes.org's `/vehicles.json?xmin&ymin&xmax&ymax`
  re-serves the DfT BODS SIRI-VM stream as plain json **with `access-control-allow-origin: *`**,
  so `app.js` (`liveBuses()`) fetches it straight from the browser and maps each record to the
  feature shape `onVehicles()` expects (`coordinates`/`heading`/`service.line_name`). This
  replaced the old BODS-key fetcher + the need for any proxy/Worker.
- **Trams are timetable-estimated** (along real OSM geometry) — Supertram has *no* public live
  vehicle feed: not BODS (buses-only — verified: zero tram operators in the live snapshot), and
  the only live signal (departure boards via TSY/livetrams) is bot-walled or broken. So `TRAM`
  in config.js drives `tramFeatures()` in app.js: a tram per direction at its real headway within
  service hours. Buses are genuinely live. The status bar says which; keep that honest.

See `~/.claude/.../memory/sheffield-data-sources.md` for exact endpoints/coverage IDs.
