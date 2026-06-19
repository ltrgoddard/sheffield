import { CITY, BASE, DEM, LOCAL_DEM, DEM_PROBE, FEEDS, LAYERS, TRAM } from "./config.js";

const $ = (s) => document.querySelector(s);
const geo = (f) => fetch(`data/${f}.geojson`).then((r) => r.ok ? r.json() : { type: "FeatureCollection", features: [] }).catch(() => ({ type: "FeatureCollection", features: [] }));
const empty = { type: "FeatureCollection", features: [] };

const map = new maplibregl.Map({
  container: "map", style: BASE, hash: true,
  center: CITY.center, zoom: CITY.zoom, pitch: CITY.pitch, bearing: CITY.bearing,
  maxPitch: 80, attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "bottom-right");
window.map = map;

const counts = {};
const setCount = () => $("#count").textContent =
  Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(" · ") || "no data";

// ─── terrain: prefer locally-built ea lidar tiles, else the global aws dem ───
async function terrain() {
  const local = await fetch(DEM_PROBE, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  map.addSource("dem", { type: "raster-dem", tiles: [local ? LOCAL_DEM : DEM], encoding: "terrarium", tileSize: 256, maxzoom: local ? 14 : 13 });
  map.setTerrain({ source: "dem", exaggeration: 1.4 });
  // hillshade makes the lidar relief legible even from straight above
  const firstSym = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  map.addLayer({ id: "hillshade", type: "hillshade", source: "dem", paint: { "hillshade-exaggeration": 0.45, "hillshade-shadow-color": "#52493b", "hillshade-highlight-color": "#fffaf2", "hillshade-accent-color": "#6b6253" } }, firstSym);
  try { map.setSky({ "sky-color": "#9fc4e8", "horizon-color": "#dfeaf2", "fog-color": "#eaf0f4", "fog-ground-blend": 0.4, "horizon-fog-blend": 0.6, "sky-horizon-blend": 0.7, "atmosphere-blend": 0.7 }); } catch {}
  $("#brand p").textContent = local ? "ea lidar terrain · openstreetmap · open data" : "global dem · run lidar.py for ea lidar terrain";
}

// ─── give the osm 3d buildings a calm, understated material ───
function buildings() {
  const lyr = map.getStyle().layers.find((l) => l.id === "building-3d" || (l.type === "fill-extrusion" && /build/.test(l.id)));
  if (!lyr) return;
  map.setPaintProperty(lyr.id, "fill-extrusion-color", ["interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0], 0, "#e7e3da", 25, "#dcd7cc", 80, "#c9c3b6"]);
  map.setPaintProperty(lyr.id, "fill-extrusion-opacity", 0.95);
  map.setPaintProperty(lyr.id, "fill-extrusion-vertical-gradient", true);
}

// ─── moving trams, simulated along the real osm route geometry ───
const R = 6.371e6, rad = Math.PI / 180;
const hav = (a, b) => {
  const dla = (b[1] - a[1]) * rad, dlo = (b[0] - a[0]) * rad, la = a[1] * rad, lb = b[1] * rad;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
let trams = [];
function seedTrams(fc) {
  const lines = fc.features.map((f) => {
    const c = f.geometry.coordinates, cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + hav(c[i - 1], c[i]));
    return { c, cum, total: cum[cum.length - 1], color: f.properties.colour || "#666", ref: f.properties.ref, name: f.properties.name };
  }).filter((l) => l.total > 500);
  trams = [];
  for (const l of lines) {
    const n = Math.max(1, Math.round(l.total / 1000 / TRAM.gapKm));
    for (let i = 0; i < n; i++) trams.push({ l, d: (i + Math.random()) * l.total / n });
  }
}
const at = (l, d) => { // position + bearing at distance d along line l
  d = ((d % l.total) + l.total) % l.total;
  let lo = 0, hi = l.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; (l.cum[m] <= d ? lo = m : hi = m); }
  const a = l.c[lo], b = l.c[hi], seg = l.cum[hi] - l.cum[lo] || 1, t = (d - l.cum[lo]) / seg;
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], brg: Math.atan2(b[0] - a[0], b[1] - a[1]) / rad };
};
let last = performance.now();
function animate(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const feats = trams.map((t) => {
    t.d += TRAM.speed * dt;
    const { p, brg } = at(t.l, t.d);
    return { type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { color: t.l.color, brg, ref: t.l.ref, name: t.l.name } };
  });
  map.getSource("trams")?.setData({ type: "FeatureCollection", features: feats });
  requestAnimationFrame(animate);
}

// ─── helpers for adding clustered point feeds and popups ───
function src(id, data, cluster) { map.addSource(id, { type: "geojson", data, ...(cluster ? { cluster: true, clusterRadius: 46, clusterMaxZoom: 15 } : {}) }); }
function popup(layer, html) {
  map.on("click", layer, (e) => new maplibregl.Popup({ closeButton: false, offset: 12 }).setLngLat(e.lngLat).setHTML(html(e.features[0].properties)).addTo(map));
  map.on("mouseenter", layer, () => map.getCanvas().style.cursor = "pointer");
  map.on("mouseleave", layer, () => map.getCanvas().style.cursor = "");
}
function clusterLayers(id, color) {
  map.addLayer({ id: `${id}-cl`, type: "circle", source: id, filter: ["has", "point_count"], paint: { "circle-color": color, "circle-opacity": 0.85, "circle-radius": ["step", ["get", "point_count"], 12, 25, 16, 100, 22, 500, 30], "circle-stroke-color": "#fff", "circle-stroke-width": 1.2, "circle-stroke-opacity": 0.3 } });
  map.addLayer({ id: `${id}-cln`, type: "symbol", source: id, filter: ["has", "point_count"], layout: { "text-field": ["get", "point_count_abbreviated"], "text-size": 11, "text-font": ["Noto Sans Regular"] }, paint: { "text-color": "#fff" } });
  map.addLayer({ id, type: "circle", source: id, filter: ["!", ["has", "point_count"]], paint: { "circle-color": color, "circle-radius": 5, "circle-opacity": 0.9, "circle-stroke-color": "#fff", "circle-stroke-width": 1, "circle-stroke-opacity": 0.5 } });
  return [`${id}-cl`, `${id}-cln`, id];
}

const reg = {}; // toggle id -> [layer ids]
const date = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

async function layers() {
  // network outlines (wards / clean air / boundary) sit lowest
  src("wards", await geo("wards")); reg.wards = ["wards-l"];
  map.addLayer({ id: "wards-l", type: "line", source: "wards", layout: { visibility: "none" }, paint: { "line-color": "#5b7", "line-width": 1, "line-opacity": 0.4, "line-dasharray": [3, 2] } });

  src("clean_air", await geo("clean_air")); reg.clean_air = ["clean_air-f", "clean_air-l"];
  map.addLayer({ id: "clean_air-f", type: "fill", source: "clean_air", layout: { visibility: "none" }, paint: { "fill-color": "#3fb27f", "fill-opacity": 0.08 } });
  map.addLayer({ id: "clean_air-l", type: "line", source: "clean_air", layout: { visibility: "none" }, paint: { "line-color": "#3fb27f", "line-width": 1.5, "line-opacity": 0.5 } });

  src("boundary", await geo("boundary"));
  map.addLayer({ id: "boundary-l", type: "line", source: "boundary", paint: { "line-color": "#7c8694", "line-width": 1.4, "line-opacity": 0.45 } });

  // crime + faults (clustered)
  const crime = await geo("crime"); counts.crime = crime.features.length; src("crime", crime, true);
  reg.crime = clusterLayers("crime", "#e0654a");
  popup("crime", (p) => `<b>${p.category}</b><div class="v">${p.street || "—"}</div><div class="m">${p.outcome || "under investigation"} · ${p.month}</div>`);

  const faults = await geo("faults"); counts.faults = faults.features.length; src("faults", faults, true);
  reg.faults = clusterLayers("faults", "#e0964a");
  popup("faults", (p) => `<b>${p.fault_status || "reported"}</b><div class="v">${(p.fault_description || "").slice(0, 150)}</div><div class="m">opened ${date(p.fault_open_date)}</div>`);

  // cctv
  src("cctv", await geo("cctv")); reg.cctv = ["cctv-l"];
  counts.cctv = (map.getSource("cctv")._data?.features || []).length;
  map.addLayer({ id: "cctv-l", type: "circle", source: "cctv", layout: { visibility: "none" }, paint: { "circle-color": "#3aa0c9", "circle-radius": 4.5, "circle-opacity": 0.9, "circle-stroke-color": "#fff", "circle-stroke-width": 1, "circle-stroke-opacity": 0.5 } });
  popup("cctv-l", (p) => `<b>CCTV ${p.cam_number || ""}</b><div class="v">${p.location || ""}</div><div class="m">${p.notes || ""}</div>`);

  // tram network: faint route lines + stops + the moving trams
  const routes = await geo("tram_routes"); seedTrams(routes);
  src("tram_routes", routes); reg.trams = ["tram-line", "trams"];
  map.addLayer({ id: "tram-line", type: "line", source: "tram_routes", paint: { "line-color": ["get", "colour"], "line-width": 2, "line-opacity": 0.35 } });

  src("tram_stops", await geo("tram_stops")); reg.stops = ["stops-l"];
  map.addLayer({ id: "stops-l", type: "circle", source: "tram_stops", layout: { visibility: "none" }, paint: { "circle-color": "#fff", "circle-radius": 3.5, "circle-stroke-color": "#444", "circle-stroke-width": 1.5 } });
  popup("stops-l", (p) => `<b>Tram stop</b><div class="v">${p.name || ""}</div>`);

  src("trams", empty);
  map.addLayer({ id: "trams", type: "circle", source: "trams", paint: { "circle-color": ["get", "color"], "circle-radius": TRAM.radius, "circle-stroke-color": "#fff", "circle-stroke-width": 1.6, "circle-stroke-opacity": 0.9 } });
  popup("trams", (p) => `<b>Supertram ${p.ref || ""}</b><div class="v">${p.name || ""}</div>`);

  // live buses (only present when BODS_API_KEY is configured)
  src("vehicles", empty); reg.vehicles = ["vehicles-l"];
  map.addLayer({ id: "vehicles-l", type: "circle", source: "vehicles", paint: { "circle-color": "#1f9e8c", "circle-radius": 4.5, "circle-stroke-color": "#fff", "circle-stroke-width": 1.4, "circle-stroke-opacity": 0.85 } });
  popup("vehicles-l", (p) => `<b>Bus ${p.line || ""}</b><div class="m">${p.operator || ""}</div>`);

  requestAnimationFrame(animate);
  buildUI(); poll(); setCount();
}

// ─── ui: toggles + legend ───
function buildUI() {
  const sw = { trams: "#888", stops: "#fff", vehicles: "#1f9e8c", cctv: "#3aa0c9", faults: "#e0964a", crime: "#e0654a", wards: "#5b7", clean_air: "#3fb27f" };
  $("#toggles").innerHTML = LAYERS.map(([id, label, on]) =>
    `<div class="row ${on ? "on" : ""}" data-id="${id}"><span class="sw" style="background:${sw[id]}"></span>${label}<span class="tk"></span></div>`).join("");
  $("#toggles").querySelectorAll(".row").forEach((row) => {
    const id = row.dataset.id, on = row.classList.contains("on");
    setVis(id, on);
    row.onclick = () => { const v = !row.classList.contains("on"); row.classList.toggle("on", v); setVis(id, v); syncLegend(); };
  });
  syncLegend();
}
function setVis(id, on) { (reg[id] || []).forEach((l) => map.getLayer(l) && map.setLayoutProperty(l, "visibility", on ? "visible" : "none")); }
function syncLegend() {
  const tramsOn = $('.row[data-id="trams"]').classList.contains("on");
  const lg = $("#legend"); lg.classList.toggle("show", tramsOn);
  if (!tramsOn) return;
  const seen = {}, lines = [];
  trams.forEach((t) => { const k = t.l.ref; if (!seen[k]) { seen[k] = 1; lines.push(t.l); } });
  lg.innerHTML = lines.map((l) => `<div class="li"><i style="background:${l.color}"></i>${l.ref || l.name || "line"}</div>`).join("");
}

// ─── polling live feeds + clock ───
function poll() {
  for (const [f, ms] of Object.entries(FEEDS)) {
    if (!ms) continue;
    const tick = async () => {
      const d = await geo(f);
      map.getSource(f)?.setData(d);
      if (f in counts) { counts[f] = d.features.length; setCount(); }
      if (f === "vehicles") $("#mode").textContent = d.features.length
        ? `${d.features.length} live vehicles` : "trams simulated";
    };
    setInterval(tick, ms); if (f === "vehicles") tick();
  }
  const clock = () => $("#clock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  clock(); setInterval(clock, 1000);
}

map.on("load", async () => { await terrain(); buildings(); await layers(); });
