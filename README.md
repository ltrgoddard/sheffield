# Sheffield — a living model

A full-screen, pan-and-zoom 3D model of Sheffield that fuses **Environment Agency
LIDAR** terrain with **OpenStreetMap** buildings and a handful of **live, primary-source**
open-data feeds. Understated, a little SimCity — trams glide around the real network
while the city's open data quietly layers on top.

## What you're looking at

- **Terrain** — Sheffield's real hills, from EA LIDAR (or a global DEM until you build the LIDAR tiles).
- **Buildings** — OpenStreetMap 3D extrusions, restyled to a calm neutral.
- **Trams** — every Supertram line (Blue, Yellow, Purple and the Tram-Train), drawn from
  the real OSM route geometry, with vehicles animating smoothly along them.
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
| Terrain | Environment Agency National LIDAR Programme | no |

### Fetchers (`fetchers/`)

Each is a dependency-free Python script that writes one compact GeoJSON. They're
independent and fault-tolerant — run them on a cron or `./fetch.sh live` loop.

- `transit.py` — Supertram routes + stops (run when the network changes).
- `crime.py` — latest published month of street-level crime.
- `council.py` — CCTV, open fault reports (last 30 days), boundaries from the council's ArcGIS.
- `vehicles.py` — live SIRI-VM positions; needs `BODS_API_KEY` (free registration).
  Without it, the frontend simulates trams along the OSM routes so the city still moves.
- `lidar.py` — the LIDAR ↔ OSM fusion (below).

### Live buses

Register at [data.bus-data.dft.gov.uk](https://data.bus-data.dft.gov.uk), then:

```sh
export BODS_API_KEY=…
./fetch.sh live      # writes data/vehicles.geojson; the map polls + interpolates it
```

### LIDAR terrain

The [National LIDAR Programme](https://environment.data.gov.uk/dataset/13787b9a-26a4-4775-8523-806d13af58fc)
publishes 1 m DSM/DTM tiles. Download the tiles covering Sheffield from the EA portal, then:

```sh
python3 fetchers/lidar.py ~/Downloads/lidar/*.tif   # needs gdal + numpy
```

It mosaics, reprojects to web mercator, terrarium-encodes the elevation and slices XYZ
tiles into `data/terrain/`. The frontend auto-detects that folder and renders Sheffield's
real ground relief beneath the buildings; until then it falls back to a global DEM.

## Layout

```
index.html  app.js  config.js  style.css   # frontend (maplibre, no build)
fetchers/                                   # one robust script per data source
data/                                       # geojson the fetchers write (terrain/ is gitignored)
fetch.sh  serve.sh
```
