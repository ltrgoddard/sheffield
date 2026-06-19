# Sheffield — a living model

A full-screen, pan-and-zoom 3D model of Sheffield that fuses **Environment Agency
LIDAR** terrain with **OpenStreetMap** buildings and a handful of **live, primary-source**
open-data feeds. Understated, a little SimCity — trams glide around the real network
while the city's open data quietly layers on top.

## What you're looking at

The whole base is stripped to a black sheet drawn only in white 1px hairlines — no labels,
no fills, no grey. It reads like a blueprint of the living city.

- **Terrain** — Sheffield's real hills, from EA LIDAR (or a global DEM until you build the LIDAR
  tiles). No hillshade — the relief reads through the wireframe draped over the 3D terrain.
- **Buildings** — OpenStreetMap 3D extrusions rebuilt as a glowing white wireframe: a fine grid
  tiled over every face, so the city centre rises in see-through lattice towers.
- **Trams** — every Supertram line (Blue, Yellow, Purple and the Tram-Train), drawn from
  the real OSM route geometry. Supertram publishes **no** live vehicle feed (not to BODS,
  which is buses-only, nor anywhere open and reliable), so positions are *estimated from the
  published timetable*: each direction runs a tram at its real headway (every 10 min peak
  Mon–Sat, 20 min off-peak/Sundays) within service hours, at the line's true average speed.
  Deterministic, no key, and honest — the status bar says "trams from timetable".
- **Live buses** — DfT Bus Open Data when a key is set (see below).
- **Open data** — police crime, the council's live highway fault reports, public CCTV
  cameras, wards, and the Clean Air Zone — each a toggleable layer.

## Run it

```sh
./fetch.sh        # pull fresh data into data/*.geojson  (snapshot already committed)
./serve.sh        # static server → http://localhost:8000
```

That's it — no build step, no framework. The frontend is plain ES modules + MapLibre GL
and reads the `data/*.geojson` files the fetchers produce.

## Data sources — all primary, no aggregators

| Feed | Source | Key? |
|------|--------|------|
| Trams, stops, buildings | OpenStreetMap (Overpass / OpenFreeMap tiles) | no |
| Street crime | [data.police.uk](https://data.police.uk) (Home Office) | no |
| CCTV, fault reports, wards, Clean Air Zone | Sheffield City Council ArcGIS server | no |
| Live bus/tram positions | [DfT Bus Open Data Service](https://data.bus-data.dft.gov.uk) (SIRI-VM) | yes |
| Terrain | EA LIDAR Composite DTM 1 m, via open WCS | no |

### Fetchers (`fetchers/`)

Each is a dependency-free Python script that writes one compact GeoJSON. They're
independent and fault-tolerant — run them on a cron or `./fetch.sh live` loop.

- `transit.py` — Supertram routes + stops (run when the network changes).
- `crime.py` — latest published month of street-level crime.
- `council.py` — CCTV, open fault reports (last 30 days), boundaries from the council's ArcGIS.
- `vehicles.py` — live SIRI-VM **bus** positions; needs `BODS_API_KEY` (free registration).
  Trams aren't in BODS; the frontend estimates them from the timetable regardless.
- `lidar.py` — the LIDAR ↔ OSM fusion (below).

### Live buses

Register at [data.bus-data.dft.gov.uk](https://data.bus-data.dft.gov.uk) for a free key, then:

```sh
export BODS_API_KEY=…
./live.sh            # refresh every 15s so ~330 real buses glide around the city
```

`live.sh` loops `./fetch.sh live`; the frontend interpolates each vehicle between
snapshots so they move smoothly rather than jumping. The status bar then reads
"N live buses · trams from timetable". (Supertram publishes no live vehicle feed to BODS
or anywhere reliable, so the buses are real and the trams are timetable-estimated.)

### LIDAR terrain

This is the LIDAR ↔ OSM fusion, and it needs no key and no manual download:

```sh
python3 fetchers/lidar.py        # streams EA LIDAR for Sheffield (needs gdal + numpy)
```

It pulls the [EA LIDAR Composite DTM (1 m)](https://environment.data.gov.uk/dataset/13787b9a-26a4-4775-8523-806d13af58fc)
straight from the agency's open **WCS** over the Sheffield bounding box (16 blocks at 5 m),
mosaics them, reprojects to web mercator, terrarium-encodes the elevation and slices XYZ
tiles into `data/terrain/` (~3 min, ~25 MB). The frontend auto-detects that folder and
renders Sheffield's real hills beneath the OSM buildings — the brand line switches to
"ea lidar terrain". Until you run it, terrain falls back to a global DEM.

You can also pass your own GeoTIFFs (e.g. the 1 m DSM, which includes rooftops) instead:
`python3 fetchers/lidar.py ~/dsm/*.tif`.

## Layout

```
index.html  app.js  config.js  style.css   # frontend (maplibre, no build)
fetchers/                                   # one robust script per data source
data/                                       # geojson the fetchers write (terrain/ is gitignored)
fetch.sh  serve.sh
```
