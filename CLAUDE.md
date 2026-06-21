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
The **heavy data** is the one *format* exception, to avoid shipping/parsing tens of MB: the heavy
geometry (buildings, gas pipes) ships as a packed binary `data/*.bin` gpu buffer, not geojson
(buildings packs the footprints + a trailing per-building osm-tag section for the click card; gas
pipes 38 MB → 4 MB; see `common.packbin`), and
the **terrain** as a single int16 height grid `data/terrain.bin` (built by `lidar.py` from the lidar
tiles, downsampled) rather than ~450 terrarium pngs — 58 MB → 6.5 MB, and one fetch, no png decode.

```
index.html  app.js  config.js  style.css   # frontend
gpu.js      proj.js                         # webgpu device/pipelines + projection/camera/terrain
fetchers/   common.py + one script per source
data/       geojson + packed .bin the fetchers write (gitignored; lives in the `latest-data` release)
Makefile    data orchestration (`make`, `make lidar`, `make serve`)
.github/workflows/  deploy.yml (pages) + sync.yml (cron refresh → release → redeploy)
pyproject.toml  zero-dep uv project   .env  OPENROUTER_API_KEY/ANTHROPIC_API_KEY for news llm (gitignored)
```

- **config.js** — the only place to tune: `CITY` camera, `BBOX` (the patch we render),
  `TERRAIN` (tile zoom/grid/exaggeration), `FEEDS` (file → poll ms), `LAYERS` (toggle
  id/label/default). Touch this before the JS.
- **proj.js** — the cpu maths: local-metre projection (`ll2m`), the orbit `Camera`'s
  view-proj matrix, and `Terrain` (reads one packed `data/terrain.bin` int16 height grid — no
  per-tile png decode — that we both drape geometry on via `elev()` and draw as a `wire()`
  grid; `lidar.py` builds the buffer). `Terrain.covers()` is the single clip
  authority: every rendered feature (roads, buildings, lines, points, labels — via `inside()`
  in app.js) is trimmed to where lidar coverage actually exists, so nothing floats past the
  ground. fetchers can over-fetch their own boxes; the frontend clip is what defines the extent.
- **gpu.js** — the `Renderer`: one WebGPU device, three pipelines (1px `line-list` + instanced
  point-markers + a translucent triangle `fill` for the one selected building), orbit controls
  (drag pan / right-drag orbit / wheel dolly; one-finger pan / two-finger pinch-twist-tilt on
  touch), and cpu-side `pick()`. API: `setLine`/`setMark`/`setVisible`/`setFill`/`clearFill`/
  `fillStyle`/`frame`/`pick`/`screen` (world→css-px for the label overlay). The fill vertex is
  `(x,y,zTop,zBase)` and `st.size` carries a 0→1 grow factor so the prism rises on selection.
- **app.js** — loads each feed, folds geojson into flat float32 line/point arrays in metres
  (`lineWire`/`setPoints`) — or, for the packed `.bin` layers, reads the buffer straight through
  with no json parse (`bin()`→`feats()`→`lineBin`, plus `buildingData` which in one pass yields
  the wireframe lines *and* a click registry per building — outer ring, bbox, height, osm tags).
  Clicking a building ground-picks it (`cam.ground`→`m2ll`→point-in-polygon, tallest wins),
  lights it with an amber fill prism (ear-clipped roof + walls) and shows an info `#card` on the
  left in the legend's style. **Pipes are tooltipped** too: `lineWire`/`lineBin` with a `regId` keep a
  per-feature `lineReg` (props + visible segments in metres), and `pickLine` ground-rays the cursor →
  nearest segment within a zoom-scaled tolerance → a `#popup` (`POP.gas_pipes`/`gas_nts`/`water_mains`/`fuel`);
  a building wins over the pipes beneath it. Runs `animate()` (rAF loop moving trams +
  interpolating live buses, then `drawLabels()`) and `poll()`, wires the toggles + popups.
  **Labels** (`drawLabels`) are the only text: lowercase JetBrains Mono on a 2d `#labels`
  overlay, projected via `R.screen()` each frame, fading in only at high zoom (`LABELS` in
  config) with greedy collision-avoidance — street names ride the road, stop names sit by the
  dot. `window.R`/`cam`/`terr` are exposed for debugging.
- **fetchers/common.py** — `fetch`/`get_json` (urllib + retries + UA; accepts a raw
  bytes body for JSON POSTs), `overpass`, `arcgis` (paged geojson), `llm` (zero-dep
  llm call — free OpenRouter when `OPENROUTER_API_KEY` is set, else Anthropic), `write` (**atomic** temp-then-rename so
  the poller never sees a half file) and `packbin` (the same atomic write for a packed gpu
  buffer: `u32 nFeatures`, then per feature `f32 h, f32 b, u32 nParts`, then per part `u32
  nVerts` + int32 lon/lat ×1e6 — a ~0.1 m grid; with `tags=` a trailing section — `u32
  nFeatures` then per feature a length-prefixed utf8 json blob — rides along for click-time
  metadata, ignored by the geometry readers). Everything writes compact EPSG:4326 geojson, or a `.bin`.
- **Makefile** runs every fetcher under `uv` **in parallel** (`make` = `-j 8`; each independent,
  one failing never aborts the rest) then `manifest.py`, which writes `data/manifest.json` — a
  per-feed freshness index (feature count, size, age) for the frontend status and ops. Python is
  pure-stdlib so `uv` just pins the interpreter; secrets load from `.env`.

## Running / verifying

```sh
make                 # fetch every feed into data/ (gitignored; not committed)
make serve           # http://localhost:8000
make lidar           # stream EA lidar → data/terrain over the full boundary (no key, ~5 min)
cp .env.example .env && $EDITOR .env   # optional OPENROUTER_API_KEY/ANTHROPIC_API_KEY (news llm; else gazetteer)
```

Verify visually with headless Playwright — it ships a real WebGPU adapter; `window.R`
exposes the renderer (`R.lines`/`R.marks` counts, `R.pick(x,y)`) and `window.cam` the camera.
Terrain + the building wireframes fold in within the first second — wait before judging.

## Deployment — GitHub Pages, no server

Frontend lives in git; **data lives in the `latest-data` GitHub Release** (a `data.zip` of
all of `data/`, geojson + packed `.bin` incl. `terrain.bin`). Two workflows:
- **deploy.yml** (push to main / dispatch) — assembles `_site` = frontend + the release's
  data and publishes it to Pages (live at `ltrg.co.uk/sheffield`).
- **sync.yml** (cron, daily) — re-fetches the *refreshable* feeds (rivers, air, news, reddit,
  tribune, crime, council, planning, trees), re-zips, re-uploads the release, then triggers a
  redeploy. Needs `permissions: contents: write` — `read` lets it download the release but the
  `gh release upload --clobber` 403s without write. The heavy static layers (buildings `.bin`,
  roads, trams, `terrain.bin`, **gas pipes `.bin` + sites**, **trunk pipelines**) carry over from the release untouched —
  rebuild those locally with `make` + `make lidar` and `gh release upload latest-data data.zip
  --clobber` when they need refreshing. Note the frontend fetches `buildings.bin`/`gas_pipes.bin`
  (not geojson) for those layers, so the release must carry the `.bin` — a release missing it 404s
  the layer to empty. Live buses aren't in the cron at all (the browser pulls them direct from bustimes.org).

## Conventions

- Code is deliberately minimal/dense; comments lowercase. Keep it that way.
- **Adding a feed:** write `fetchers/foo.py` that emits `data/foo.geojson`; add it to
  `FEEDS` + `LAYERS` in config.js; in app.js `layers()` call `setPoints("foo", …)` for points
  (add a `PT` style + `POP` popup + `TOG` entry) or `R.setLine("foo", lineWire(…), …)` for
  lines/polygons. Done. For a *heavy* line/wire layer, emit a `.bin` instead (`packbin` in the
  fetcher, `R.setLine("foo", lineBin(await bin("foo")), …)` in app.js) so there's no json to parse.
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
- **LLM-as-geocoder (two-step)**: `news.py` turns unstructured text (headline **+ first ~700 chars
  of body**) into map pins. Step 1 — one `llm()` call *only names* the most specific place per item
  (no coordinates, so it can't hallucinate them); step 2 — `news.geocode()` resolves real lat/lon,
  gazetteer first (the ~35 `GAZ` localities, instant/no network) then **Nominatim** bounded to the
  Sheffield viewbox for anything else (streets, landmarks). Cached per run. `reddit.py`/`tribune.py`
  reuse `GAZ`+`point`+`geocode` (imported from `news`). Always degrades to the gazetteer-only path
  (`via_gazetteer`) on any llm failure, then to empty geojson; never aborts.
- **LLM backend (`common.llm`)**: prefers a **free OpenRouter** model when `OPENROUTER_API_KEY` is set
  (no anthropic spend, so it's the CI-friendly key), else the Anthropic api with `ANTHROPIC_API_KEY`;
  raises without either. OpenRouter path uses a `models` fallback list (`OR_FREE`) + `reasoning:
  {enabled:false}` + a generous `max_tokens` floor — the only free models reachable from here are slow
  *thinking* models (e.g. `nex-agi/nex-n2-pro:free`) that ignore reasoning-off and otherwise 200 with
  **null content**; the fast non-reasoning ones (`llama-3.3-70b`, `qwen3-next-80b`) are frequently
  **429 "rate-limited upstream"**. So `tries`/`timeout` are bounded to fall to the gazetteer fast when
  the whole free pool is busy. Account note: free models need the openrouter privacy/data-policy
  setting enabled (else 404 "no endpoints matching your data policy").
- **Tribune (no key)**: the ghost content api wants a `TRIBUNE_API_KEY`, but the keyless public
  rss feed `sheffieldtribune.co.uk/feed` carries the same posts (title/excerpt/link) — `tribune.py`
  uses the api only if the key is set, else the feed, so it always produces pins without a secret.
- **Reddit (no key)**: the `.json`/`oauth` endpoints **403 datacenter IPs** (so do `old.reddit`),
  but the plain **atom feed** `reddit.com/r/sheffield/.rss` serves fine — once you ride out
  reddit's burst **429s** (it throttles rapid hits, ~15 s; `reddit.py` passes `tries=6` so
  `common.fetch`'s backoff clears them). Atom namespace `{http://www.w3.org/2005/Atom}`.
- **Cadent gas (opendatasoft, `CADENT_API_KEY`)**: `cadent.py` pulls the gas distribution network
  from `cadentgas.opendatasoft.com` via the ods v2.1 **geojson export** endpoint
  (`/exports/geojson?where=in_bbox(geo_point_2d,s,w,n,e)&apikey=`) — one shot, no paging. Our key
  is the **free open tier**: the `*_open` datasets work, the `*_shared` ones 403 (`ForbiddenAccess`).
  Pipes come from the combined national `gas-pipe-infrastructure-gpi_open` (~55k segments in the
  bbox, all `MultiLineString`) — packed to `gas_pipes.bin` and **coloured by install age**: `inst_date`→
  install year, scale clamped to the **p2–p98** years (`age_norm`, ~1955–2024, so victorian/stray
  outliers don't blow the **viridis** ramp), the normalised 0..1 riding in the packbin `h` slot
  (-1 = undated → grey). app.js feeds it through `lineBin(…, ageTint)` → per-vertex rgba into the new
  coloured-line pipeline (`pLineC`/`vlinec` in gpu.js; `setLine`'s optional `cols`). Each pipe also carries a
  slim trailing **tag blob** (`cadent.meta` → packbin `tags=`: type/pressure/material/bore-mm/install-year) so
  clicking it shows a tooltip (`lineBin(…, regId)` builds a pick registry; see line picking below). Above-ground sites from
  `above-ground-infrastructure-assets-open` (Points) → `gas_assets.geojson`. NB **Sheffield itself is
  Northern Gas Networks**, not Cadent — coverage is only the eastern/rotherham fringe of the bbox.
- **Trunk pipelines (osm, no key)**: `pipelines.py` is the *transmission* complement to cadent's
  *distribution* — one overpass `man_made=pipeline` query over the bbox, split by `substance`/`usage`
  into three `kind`s the frontend draws as separate toggleable line layers: `gas` (the uk **national
  transmission system** — national gas's high-pressure backbone, `usage=transmission`), `water` (severn
  trent / yorkshire water trunk mains) and `fuel` (the exolum multi-product line). All written to one
  small `pipelines.geojson` (~30 kb, drawn with `lineWire`, no `.bin`); app.js's `PIPE` table maps each
  kind → layer id + colour. Distribution-pressure gas (overlaps cadent) and minor industrial lines
  (oxygen/cement/sewage/heat) are dropped. Each feature also carries an inferred **`depth`** (see below).
- **Pipe burial depth (rendered below the terrain)**: pipes are draped at their real depth of cover, not
  on the surface. Depths are *inferred from each feed's metadata* against uk standards (njug §4.4 /
  igem/td/3 + td/1 / hse model depths / water fittings regs 1999) — the recorded `depth` column is 100%
  null in cadent's open tier, so it's a fallback, not the source. **cadent** (`cadent.py` `cover()`/`depth()`):
  cover is keyed by pressure *band* in bar (lp & mp are the *same* ≤2 bar band — every source gives them
  identical cover; the lp/mp label doesn't change depth) and main-vs-service (main 0.75 m, service 0.45 m;
  ip 0.75, hp 0.9, >16 bar lts 1.1), then the pipe sits a *bore radius* deeper to its centreline — and the
  bore is the **carrier** (the old cast/spun/ductile-iron host main a pe pipe is inserted through, ~28% of
  the network, almost always wider) where present, not the thin insert. `ag_ind=True` → negative depth (above
  ground). the metre depth rides in the packbin **`b`** slot (was 0); `h` still carries install-age.
  **trunk** (`pipelines.py` `DEPTH`): transmission lines are far deeper — gas nts 1.5, fuel 1.4, water 1.35 m
  (centreline; ~1.1 m cover + large bore). frontend: app.js `bury(depth)` → `-depth·TERRAIN.exag` (same
  exaggerated vertical scale as terrain) feeds `drape`; `lineWire` reads `properties.depth` per feature,
  `lineBin` reads the per-feature `b`. everything non-pipe (depth null) keeps the old +2 m visibility lift.
- **EA LIDAR WCS** (no key!): two subsets `&subset=E(a,b)&subset=N(c,d)` must be hand-appended
  (urlencode can't hold duplicate keys); `&scalefactor=` downsamples; axis labels `E N`, EPSG:27700.
  Only the **DTM** is exposed on the WCS — DSM (rooftops) needs GeoTIFFs passed to lidar.py.
- **Terrarium encoding**: `height = R*256 + G + B/256 - 32768`. This decode now happens **server-side**
  in `lidar.pack()` (pillow, build-only) — it reads the `gdal2tiles` pngs at `PACK_ZOOM` (14),
  downsamples by `PACK_STEP` (3, ≈28 m) and writes `data/terrain.bin` (int16 decimetres, nodata
  -32768), then deletes the png dir. `Terrain` in proj.js just maps lng/lat → grid sample
  (`gx=(lon2x−x0)·SP`) and is silent (flat, no wire grid) if the `.bin` is absent — run `make lidar`.
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
