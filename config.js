// central configuration for the sheffield model. tweak here, not in app.js.
export const CITY = { center: [-1.4685, 53.3787], zoom: 15.4, pitch: 64, bearing: -22 };

// no-key primary tile sources.
export const BASE = "https://tiles.openfreemap.org/styles/liberty"; // osm vector + 3d buildings
export const DEM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"; // global fallback
export const LOCAL_DEM = "data/terrain/{z}/{x}/{y}.png"; // produced by fetchers/lidar.py from ea lidar
export const DEM_PROBE = "data/terrain/12/2031/1327.png"; // a sheffield-centre tile; if it exists we use lidar

// data files written by the fetchers, with how often the frontend re-reads them (ms; 0 = once).
export const FEEDS = {
  tram_routes: 0, tram_stops: 0,
  vehicles: 12e3,            // live buses/trams (when BODS_API_KEY is set)
  crime: 0,
  faults: 3e5,              // council fault reports
  cctv: 0,
  wards: 0, boundary: 0, clean_air: 0,
};

// toggleable map layers shown in the panel: id, label, on-by-default.
export const LAYERS = [
  ["trams", "Trams", true],
  ["stops", "Tram stops", false],
  ["vehicles", "Live buses", true],
  ["cctv", "CCTV cameras", false],
  ["faults", "Fault reports", false],
  ["crime", "Crime", false],
  ["wards", "Wards", false],
  ["clean_air", "Clean air zone", false],
];

export const TRAM = { speed: 13, gapKm: 1.4, radius: 5.5 }; // m/s, spacing, px
