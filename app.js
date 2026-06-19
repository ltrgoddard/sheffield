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
  // no hillshade: the relief reads through the wireframe draped over the 3d terrain.
  try { map.setSky({ "sky-color": "#000", "horizon-color": "#000", "fog-color": "#000", "fog-ground-blend": 0.6, "horizon-fog-blend": 0.5, "sky-horizon-blend": 1, "atmosphere-blend": 0 }); } catch {}
  $("#brand p").textContent = local ? "ea lidar terrain · openstreetmap · open data" : "global dem · run lidar.py for ea lidar terrain";
}

// ─── strip the osm base to a pure black sheet drawn only in white 1px hairlines ───
function basemap() {
  for (const l of map.getStyle().layers) {
    try {
      if (l.type === "background") map.setPaintProperty(l.id, "background-color", "#000");
      else if (l.type === "fill") map.setPaintProperty(l.id, "fill-opacity", 0); // no fills, no grey
      else if (l.type === "fill-extrusion") map.setLayoutProperty(l.id, "visibility", "none");
      else if (l.type === "line") {
        map.setPaintProperty(l.id, "line-color", "#fff");
        map.setPaintProperty(l.id, "line-width", 1);
        map.setPaintProperty(l.id, "line-opacity", 1);
      } else if (l.type === "symbol") map.setLayoutProperty(l.id, "visibility", "none"); // no labels/icons
    } catch {}
  }
}

// ─── 3d buildings as a true wireframe: their real footprint, roofline and vertical
//     edges drawn as white gl lines, built from the vector tiles' polygons + heights ───
function buildings() {
  const lyr = map.getStyle().layers.find((l) => l.id === "building-3d" || (l.type === "fill-extrusion" && /build/.test(l.id)));
  if (!lyr) return;
  if (map.getLayer(lyr.id)) map.removeLayer(lyr.id); // bin the solid faces entirely
  const SRC = lyr.source, SL = lyr["source-layer"];
  const merc = (lng, lat, alt) => maplibregl.MercatorCoordinate.fromLngLat([lng, lat], alt);

  map.addLayer({
    id: "building-wire", type: "custom", renderingMode: "3d",
    onAdd(m, gl) {
      const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); return o; };
      this.p = gl.createProgram();
      gl.attachShader(this.p, sh(gl.VERTEX_SHADER, "uniform mat4 u;attribute vec3 a;void main(){gl_Position=u*vec4(a,1.0);}"));
      gl.attachShader(this.p, sh(gl.FRAGMENT_SHADER, "void main(){gl_FragColor=vec4(1.0);}"));
      gl.linkProgram(this.p);
      this.a = gl.getAttribLocation(this.p, "a"); this.u = gl.getUniformLocation(this.p, "u");
      this.buf = gl.createBuffer(); this.n = 0;
      m.on("idle", () => this.build(gl));
    },
    build(gl) {
      const v = [], P = (lng, lat, alt) => { const c = merc(lng, lat, alt); v.push(c.x, c.y, c.z); };
      for (const f of map.querySourceFeatures(SRC, { sourceLayer: SL })) {
        const pr = f.properties, h = +pr.render_height || +pr.height || 8, b = +pr.render_min_height || 0;
        const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
        for (const poly of polys) for (const ring of poly) {
          const g = map.queryTerrainElevation([ring[0][0], ring[0][1]]) || 0, base = g + b, top = g + h;
          for (let i = 0; i < ring.length - 1; i++) {
            const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
            P(x1, y1, base); P(x2, y2, base);   // footprint edge
            P(x1, y1, top); P(x2, y2, top);      // roofline edge
            P(x1, y1, base); P(x1, y1, top);     // vertical edge at the vertex
          }
        }
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.DYNAMIC_DRAW);
      this.n = v.length / 3; map.triggerRepaint();
    },
    render(gl, args) {
      if (!this.n) return;
      const m = args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args;
      gl.useProgram(this.p); gl.disable(gl.DEPTH_TEST);
      gl.uniformMatrix4fv(this.u, false, new Float32Array(m));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
      gl.enableVertexAttribArray(this.a); gl.vertexAttribPointer(this.a, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, this.n);
    },
  });
}

// ─── trams estimated from the published timetable, along the real osm route geometry ───
const R = 6.371e6, rad = Math.PI / 180;
const hav = (a, b) => {
  const dla = (b[1] - a[1]) * rad, dlo = (b[0] - a[0]) * rad, la = a[1] * rad, lb = b[1] * rad;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dlo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
// each osm feature is one direction of one line; we run a scheduled tram down each.
let tramLines = [];
function seedTrams(fc) {
  tramLines = fc.features.map((f) => {
    const c = f.geometry.coordinates, cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + hav(c[i - 1], c[i]));
    return { c, cum, total: cum[cum.length - 1], color: f.properties.colour || "#666", ref: f.properties.ref, name: f.properties.name };
  }).filter((l) => l.total > 500);
}
// headway (s) for a line right now: peak mon–sat daytime, else off-peak; tram-train always off-peak.
const headway = (ref, now) => (ref !== "TT" && now.getDay() >= 1 && now.getHours() >= 7 && now.getHours() < 19 ? TRAM.peak : TRAM.off) * 60;
// every tram the timetable says is en route now, placed at speed·(time since it left its terminus).
function tramFeatures() {
  const now = new Date(), nowS = now / 1e3;
  const dawn = new Date(now); dawn.setHours(TRAM.service[0], 0, 0, 0);
  const startS = dawn / 1e3, endS = startS + (TRAM.service[1] - TRAM.service[0]) * 3600;
  if (nowS < startS || nowS > endS) return [];
  const feats = [];
  for (const l of tramLines) {
    const h = headway(l.ref, now), T = l.total / TRAM.speed;
    for (let m = Math.max(0, Math.ceil((nowS - startS - T) / h)); ; m++) {
      const dep = startS + m * h, age = nowS - dep;
      if (age < 0 || dep > endS) break;
      const { p, brg } = at(l, age * TRAM.speed);
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { color: l.color, brg, ref: l.ref, name: l.name } });
    }
  }
  return feats;
}
const at = (l, d) => { // position + bearing at distance d along line l
  d = ((d % l.total) + l.total) % l.total;
  let lo = 0, hi = l.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; (l.cum[m] <= d ? lo = m : hi = m); }
  const a = l.c[lo], b = l.c[hi], seg = l.cum[hi] - l.cum[lo] || 1, t = (d - l.cum[lo]) / seg;
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], brg: Math.atan2(b[0] - a[0], b[1] - a[1]) / rad };
};
// ─── live buses: glide between the position snapshots instead of teleporting ───
let vehs = [];
function onVehicles(fc) {
  const prev = Object.fromEntries(vehs.map((v) => [v.id, v]));
  vehs = fc.features.map((f) => {
    const id = f.properties.vehicle || f.geometry.coordinates.join();
    const p = prev[id];
    const from = p ? p.cur : f.geometry.coordinates;
    return { id, from, cur: from, to: f.geometry.coordinates, t0: performance.now(), props: f.properties };
  });
}

function animate(now) {
  map.getSource("trams")?.setData({ type: "FeatureCollection", features: tramFeatures() });
  if (vehs.length) {
    const vf = vehs.map((v) => {
      const k = Math.min(1, (now - v.t0) / FEEDS.vehicles);
      v.cur = [v.from[0] + (v.to[0] - v.from[0]) * k, v.from[1] + (v.to[1] - v.from[1]) * k];
      return { type: "Feature", geometry: { type: "Point", coordinates: v.cur }, properties: v.props };
    });
    map.getSource("vehicles")?.setData({ type: "FeatureCollection", features: vf });
  }
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
  map.addLayer({ id: "wards-l", type: "line", source: "wards", layout: { visibility: "none" }, paint: { "line-color": "#fff", "line-width": 1, "line-opacity": 0.28, "line-dasharray": [3, 2] } });

  src("clean_air", await geo("clean_air")); reg.clean_air = ["clean_air-f", "clean_air-l"];
  map.addLayer({ id: "clean_air-f", type: "fill", source: "clean_air", layout: { visibility: "none" }, paint: { "fill-color": "#fff", "fill-opacity": 0.05 } });
  map.addLayer({ id: "clean_air-l", type: "line", source: "clean_air", layout: { visibility: "none" }, paint: { "line-color": "#fff", "line-width": 1.2, "line-opacity": 0.45, "line-dasharray": [2, 2] } });

  src("boundary", await geo("boundary"));
  map.addLayer({ id: "boundary-l", type: "line", source: "boundary", paint: { "line-color": "#fff", "line-width": 1.2, "line-opacity": 0.3 } });

  // crime + faults (clustered)
  const crime = await geo("crime"); counts.crime = crime.features.length; src("crime", crime, true);
  reg.crime = clusterLayers("crime", "#e4e4e7");
  popup("crime", (p) => `<b>${p.category}</b><div class="v">${p.street || "—"}</div><div class="m">${p.outcome || "under investigation"} · ${p.month}</div>`);

  const faults = await geo("faults"); counts.faults = faults.features.length; src("faults", faults, true);
  reg.faults = clusterLayers("faults", "#a1a1aa");
  popup("faults", (p) => `<b>${p.fault_status || "reported"}</b><div class="v">${(p.fault_description || "").slice(0, 150)}</div><div class="m">opened ${date(p.fault_open_date)}</div>`);

  // cctv
  src("cctv", await geo("cctv")); reg.cctv = ["cctv-l"];
  counts.cctv = (map.getSource("cctv")._data?.features || []).length;
  map.addLayer({ id: "cctv-l", type: "circle", source: "cctv", layout: { visibility: "none" }, paint: { "circle-color": "transparent", "circle-radius": 4, "circle-stroke-color": "#d4d4d8", "circle-stroke-width": 1, "circle-stroke-opacity": 0.8 } });
  popup("cctv-l", (p) => `<b>CCTV ${p.cam_number || ""}</b><div class="v">${p.location || ""}</div><div class="m">${p.notes || ""}</div>`);

  // tram network: faint route lines + stops + the moving trams
  const routes = await geo("tram_routes"); seedTrams(routes);
  src("tram_routes", routes); reg.trams = ["tram-line", "trams"];
  map.addLayer({ id: "tram-line", type: "line", source: "tram_routes", paint: { "line-color": ["get", "colour"], "line-width": 2, "line-opacity": 0.35 } });

  src("tram_stops", await geo("tram_stops")); reg.stops = ["stops-l"];
  map.addLayer({ id: "stops-l", type: "circle", source: "tram_stops", layout: { visibility: "none" }, paint: { "circle-color": "transparent", "circle-radius": 3, "circle-stroke-color": "#fff", "circle-stroke-width": 1.2, "circle-stroke-opacity": 0.85 } });
  popup("stops-l", (p) => `<b>Tram stop</b><div class="v">${p.name || ""}</div>`);

  src("trams", empty);
  map.addLayer({ id: "trams", type: "circle", source: "trams", paint: { "circle-color": ["get", "color"], "circle-radius": TRAM.radius, "circle-stroke-color": "#fff", "circle-stroke-width": 1.6, "circle-stroke-opacity": 0.9 } });
  popup("trams", (p) => `<b>Supertram ${p.ref || ""}</b><div class="v">${p.name || ""}</div>`);

  // live buses (only present when BODS_API_KEY is configured)
  src("vehicles", empty); reg.vehicles = ["vehicles-l"];
  map.addLayer({ id: "vehicles-l", type: "circle", source: "vehicles", paint: { "circle-color": "#fff", "circle-radius": 3.6, "circle-stroke-color": "#fff", "circle-stroke-width": 3, "circle-stroke-opacity": 0.18 } });
  popup("vehicles-l", (p) => `<b>Bus ${p.line || ""}</b><div class="m">${p.operator || ""}</div>`);

  requestAnimationFrame(animate);
  buildUI(); poll(); setCount();
}

// ─── ui: toggles + legend ───
function buildUI() {
  $("#toggles").innerHTML = LAYERS.map(([id, label, on]) =>
    `<div class="row ${on ? "on" : ""}" data-id="${id}">${label}<span class="tk"></span></div>`).join("");
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
  tramLines.forEach((l) => { if (!seen[l.ref]) { seen[l.ref] = 1; lines.push(l); } });
  lg.innerHTML = lines.map((l) => `<div class="li"><i style="background:${l.color}"></i>${l.ref || l.name || "line"}</div>`).join("");
}

// ─── polling live feeds + clock ───
function poll() {
  for (const [f, ms] of Object.entries(FEEDS)) {
    if (!ms) continue;
    const tick = async () => {
      const d = await geo(f);
      if (f === "vehicles") {
        onVehicles(d);
        $("#mode").textContent = d.features.length ? `${d.features.length} live buses · trams from timetable` : "trams from timetable";
      } else {
        map.getSource(f)?.setData(d);
      }
      if (f in counts) { counts[f] = d.features.length; setCount(); }
    };
    setInterval(tick, ms); if (f === "vehicles") tick();
  }
  const clock = () => $("#clock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  clock(); setInterval(clock, 1000);
}

map.on("load", async () => { await terrain(); basemap(); buildings(); await layers(); });
