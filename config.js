// central configuration for the sheffield model. tweak here, not elsewhere.
export const CITY = { center: [-1.4685, 53.3787], dist: 2600, pitch: 62, bearing: -22, fov: 52 }; // m, deg

// the patch of city we render: the bbox of sheffield's full administrative boundary —
// the buildings fetcher and the terrain tiles cover this same box. keep all three in step.
export const BBOX = { w: -1.802, s: 53.304, e: -1.324, n: 53.504 };

// local ea-lidar terrarium tiles (built by fetchers/lidar.py) draped as a wire grid.
export const TILES = "data/terrain/{z}/{x}/{y}.png";
export const TERRAIN = { zoom: 14, step: 3, exag: 1.4 }; // grid subsample (px), vertical exaggeration

// data files the fetchers write, with how often the frontend re-reads them (ms; 0 = once).
export const FEEDS = {
  buildings: 0, roads: 0, tram_routes: 0, tram_stops: 0,
  vehicles: 12e3,           // live buses (when BODS_API_KEY is set)
  rivers: 6e4,              // live ea river-level gauges
  air: 6e5,                 // synthesised air-quality grid (hourly source)
  crime: 0, faults: 3e5, cctv: 0,
  trees: 0,                 // osm street/park trees
  planning: 0,              // council development-site polygons
  news: 9e5,                // geolocated city news (llm/gazetteer)
  wards: 0, boundary: 0, clean_air: 0,
};

// toggleable layers, grouped — each group toggles as a whole or per item: [id, label, on?].
// terrain, buildings and roads are the permanent base map (always on, not listed here).
export const GROUPS = [
  ["transport", "transport", [
    ["trams", "trams", true],
    ["stops", "tram stops", false],
    ["vehicles", "live buses", true],
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
  ]],
  ["administrative", "administrative", [
    ["wards", "wards", false],
    ["planning", "development sites", false],
  ]],
];

// trams have no live avl feed, so we estimate from the published timetable: each directional
// osm route runs a tram every `headway` min (peak mon–sat daytime, else off) within the service
// window at the line's real average speed. honest, no-key, deterministic.
export const TRAM = { speed: 8, service: [6, 24], peak: 10, off: 20, size: 5.5 }; // m/s, [start,end]h, min, px
