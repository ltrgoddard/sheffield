// central configuration for the sheffield model. tweak here, not elsewhere.
export const CITY = { center: [-1.4685, 53.3787], dist: 2600, pitch: 62, bearing: -22, fov: 52 }; // m, deg

// the patch of city we render: the buildings fetcher and the terrain tiles cover this box.
export const BBOX = { w: -1.502, s: 53.363, e: -1.432, n: 53.397 };

// local ea-lidar terrarium tiles (built by fetchers/lidar.py) draped as a wire grid.
export const TILES = "data/terrain/{z}/{x}/{y}.png";
export const TERRAIN = { zoom: 14, step: 3, exag: 1.4 }; // grid subsample (px), vertical exaggeration

// data files the fetchers write, with how often the frontend re-reads them (ms; 0 = once).
export const FEEDS = {
  buildings: 0, tram_routes: 0, tram_stops: 0,
  vehicles: 12e3,           // live buses (when BODS_API_KEY is set)
  rivers: 6e4,              // live ea river-level gauges
  air: 6e5,                 // synthesised air-quality grid (hourly source)
  crime: 0, faults: 3e5, cctv: 0,
  trees: 0,                 // osm street/park trees
  planning: 0,              // council development-site polygons
  news: 9e5,                // geolocated city news (llm/gazetteer)
  wards: 0, boundary: 0, clean_air: 0,
  manifest: 6e4,            // per-feed freshness index
};

// toggleable layers in the panel: id, label, on-by-default.
export const LAYERS = [
  ["terrain", "Terrain", true],
  ["buildings", "Buildings", true],
  ["trams", "Trams", true],
  ["stops", "Tram stops", false],
  ["vehicles", "Live buses", true],
  ["rivers", "River levels", true],
  ["air", "Air quality", false],
  ["cctv", "CCTV cameras", false],
  ["faults", "Fault reports", false],
  ["crime", "Crime", false],
  ["trees", "Trees", false],
  ["planning", "Development sites", false],
  ["news", "City news", false],
  ["wards", "Wards", false],
  ["clean_air", "Clean air zone", false],
];

// trams have no live avl feed, so we estimate from the published timetable: each directional
// osm route runs a tram every `headway` min (peak mon–sat daytime, else off) within the service
// window at the line's real average speed. honest, no-key, deterministic.
export const TRAM = { speed: 8, service: [6, 24], peak: 10, off: 20, size: 5.5 }; // m/s, [start,end]h, min, px
