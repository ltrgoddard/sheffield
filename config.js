// central configuration for the sheffield model. tweak here, not elsewhere.
export const CITY = { center: [-1.4685, 53.3787], dist: 2600, pitch: 62, bearing: -22, fov: 52 }; // m, deg

// the patch of city we render: the bbox of sheffield's full administrative boundary —
// the buildings fetcher and the terrain tiles cover this same box. keep all three in step.
export const BBOX = { w: -1.802, s: 53.304, e: -1.324, n: 53.504 };

// ea-lidar relief: fetchers/lidar.py packs the tiles into one int16 buffer (data/terrain.bin,
// already downsampled), draped as a wire grid. zoom is informational (the .bin carries its own).
export const TERRAIN = { zoom: 14, step: 1, exag: 1.4 }; // step = wire stride over the packed grid, vertical exaggeration

// data files the fetchers write, with how often the frontend re-reads them (ms; 0 = once).
export const FEEDS = {
  buildings: 0, roads: 0, tram_routes: 0, tram_stops: 0, bus_stops: 0,
  vehicles: 12e3,           // live buses, fetched in-browser from bustimes.org
  rivers: 6e4,              // live ea river-level gauges
  air: 6e5,                 // synthesised air-quality grid (hourly source)
  crime: 0, faults: 3e5, cctv: 0,
  trees: 0,                 // osm street/park trees
  planning: 0,              // council development-site polygons
  news: 9e5,                // geolocated city news (llm/gazetteer)
  reddit: 9e5,              // geolocated r/sheffield posts (llm/gazetteer)
  tribune: 9e5,             // sheffield tribune posts (ghost api → llm/gazetteer)
  wards: 0, boundary: 0, clean_air: 0,
  gas_pipes: 0, gas_assets: 0,   // cadent gas network (mains/services .bin + above-ground sites)
  pipelines: 0,                  // osm trunk pipelines — nts gas backbone, water mains, fuel
};

// toggleable layers, grouped — each group toggles as a whole or per item: [id, label, on?].
// `base` is the base map (3d buildings, lidar relief, osm roads) — the only group on by default.
export const GROUPS = [
  ["base", "base", [
    ["buildings", "3d buildings", true],
    ["terrain", "lidar", true],
    ["roads", "osm", true],
  ]],
  ["transport", "transport", [
    ["trams", "trams", false],
    ["stops", "tram stops", false],
    ["bus_stops", "bus stops", false],
    ["vehicles", "live buses", false],
  ]],
  ["environment", "environment", [
    ["rivers", "river levels", false],
    ["air", "air quality", false],
    ["trees", "trees", false],
    ["clean_air", "clean air zone", false],
  ]],
  ["events", "events", [
    ["cctv", "cctv cameras", false],
    ["faults", "fault reports", false],
    ["crime", "crime", false],
    ["news", "city news", false],
    ["reddit", "r/sheffield", false],
    ["tribune", "sheffield tribune", true],
  ]],
  ["administrative", "government", [
    ["wards", "wards", false],
    ["planning", "development sites", false],
  ]],
  ["infra", "infra", [
    ["gas_pipes", "gas pipes", false],
    ["gas_assets", "gas sites", false],
    ["gas_nts", "gas transmission (nts)", false],
    ["water_mains", "water mains", false],
    ["fuel", "fuel pipeline", false],
  ]],
];

// trams have no live avl feed, so we estimate from the published timetable (symca, june 2026):
// each directional osm route runs a tram every `headway` min within the service window, taking
// its real published end-to-end time. honest, no-key, deterministic — NOT anchored to real
// departure clocks, so cadence/spacing are right but an individual tram isn't the real one.
// per line: [end-to-end run min, daytime headway min]. radials 12-min base (was a 10-min stage-
// coach base pre-2024); purple is a 30-min all-day shuttle; tram-train ~20-30. off-peak/evening/
// sunday fall back to `off`. one uniform speed can't fit both slow radials (~6 m/s w/ dwell) and
// the fast tram-train (~9 m/s), so we drive position from each line's own run time instead.
export const TRAM = { service: [6, 24], off: 20, size: 5.5, // [start,end]h, min, px
  line: { YELL: [39, 12], BLUE: [56, 12], PURP: [24, 30], TT: [26, 20] } };

// text labels (lowercase jetbrains mono on a 2d overlay) fade in only when zoomed in,
// keyed off camera distance in metres: street names below `street`, stop names below
// `stop`; each fades over the last `fade` of that range. understated, decluttered.
// `nearStreet` also caps street names to those within that radius (m) of the camera
// focus, so distant roads near the horizon don't pile up as unreadable clutter.
export const LABELS = { street: 1100, stop: 1700, fade: 350, nearStreet: 700, font: "JetBrains Mono" };
