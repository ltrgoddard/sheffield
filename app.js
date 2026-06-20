// glue: load the open data, fold it into gpu geometry, run the live feeds and the ui.
// the whole contract is still data/*.geojson — only the renderer changed.
import { CITY, FEEDS, LAYERS, TRAM } from "./config.js";
import { Camera, Terrain, ll2m } from "./proj.js";
import { Renderer } from "./gpu.js";

const D = Math.PI / 180, $ = (s) => document.querySelector(s);
const geo = (f) => fetch(`data/${f}.geojson`).then((r) => r.ok ? r.json() : empty).catch(() => empty);
const empty = { type: "FeatureCollection", features: [] };

// colours as linear rgba; the city is white hairlines, the live things pick up a tint.
const WHITE = [1, 1, 1, .85], FAINT = [1, 1, 1, .28], AMBER = [.98, .75, .2, 1];
const counts = {}, on = new Set(LAYERS.filter((l) => l[2]).map((l) => l[0])), vis = (id) => on.has(id);
const setCount = () => $("#count").textContent =
  Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(" · ") || "no data";

let R, terr;
// static toggle id → renderer layer ids; trams/vehicles are dynamic, gated by vis() each frame.
const TOG = { terrain: ["terrain"], buildings: ["buildings"], roads: ["roads"], trams: ["tram_routes"], stops: ["stops"],
  vehicles: [], cctv: ["cctv"], faults: ["faults"], crime: ["crime"], wards: ["wards"], clean_air: ["clean_air"],
  trees: ["trees"], air: ["air"], news: ["news"], rivers: ["rivers"], planning: ["planning"] };

// ─── geometry builders: geojson → flat float32 line/point arrays in local metres ───
const drape = (lng, lat, dz = 0) => { const [x, y] = ll2m(lng, lat); return [x, y, terr.elev(lng, lat) + dz]; };

function buildingWire(fc) {
  const p = [];
  for (const f of fc.features) {
    const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    const pr = f.properties, H = +pr.height || +pr.render_height || 8, B = +pr.min_height || 0;
    for (const poly of polys) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) {
      const [ax, ay] = ll2m(ring[i][0], ring[i][1]), [bx, by] = ll2m(ring[i + 1][0], ring[i + 1][1]);
      const ga = terr.elev(ring[i][0], ring[i][1]), gb = terr.elev(ring[i + 1][0], ring[i + 1][1]);
      p.push(ax, ay, ga + B, bx, by, gb + B,   // footprint edge
        ax, ay, ga + H, bx, by, gb + H,         // roofline edge
        ax, ay, ga + B, ax, ay, ga + H);        // vertical edge at the vertex
    }
  }
  return new Float32Array(p);
}

function lineWire(fc) {
  const p = [];
  for (const f of fc.features) {
    const g = f.geometry, lines = g.type === "LineString" ? [g.coordinates]
      : g.type === "MultiLineString" || g.type === "Polygon" ? g.coordinates
      : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
    for (const ln of lines) for (let i = 0; i < ln.length - 1; i++)
      p.push(...drape(ln[i][0], ln[i][1], 2), ...drape(ln[i + 1][0], ln[i + 1][1], 2));
  }
  return new Float32Array(p);
}

// ─── point feeds: one style table, a feature registry backing picking + popups ───
const reg = {};
const PT = {
  crime: [[1, 0, 0, 1], 4], faults: [[1, .5, 0, 1], 4], cctv: [[1, 0, 1, 1], 4],
  stops: [WHITE, 3], trees: [[0, 1, 0, 1], 2.5], air: [[0, 1, 1, 1], 5],
  news: [[1, 1, 0, 1], 6], rivers: [[0, 0, 1, 1], 5], trams: [AMBER, TRAM.size], vehicles: [WHITE, 4],
};
function setPoints(id, features, vis) {
  const a = new Float32Array(features.length * 3);
  features.forEach((f, k) => { const c = f.geometry.coordinates; a.set(drape(c[0], c[1], 4), k * 3); });
  R.setMark(id, a, PT[id][0], PT[id][1], vis, true); reg[id] = features;
}

// ─── trams from the timetable, along the real osm route geometry (see CLAUDE.md) ───
const Re = 6.371e6;
const hav = (a, b) => { const dla = (b[1] - a[1]) * D, dlo = (b[0] - a[0]) * D, la = a[1] * D, lb = b[1] * D;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dlo / 2) ** 2;
  return 2 * Re * Math.asin(Math.sqrt(h)); };
let tramLines = [];
function seedTrams(fc) {
  tramLines = fc.features.map((f) => { const c = f.geometry.coordinates, cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + hav(c[i - 1], c[i]));
    return { c, cum, total: cum[cum.length - 1], color: f.properties.colour || "#999", ref: f.properties.ref, name: f.properties.name };
  }).filter((l) => l.total > 500);
}
const headway = (ref, now) => (ref !== "TT" && now.getDay() >= 1 && now.getHours() >= 7 && now.getHours() < 19 ? TRAM.peak : TRAM.off) * 60;
function tramFeatures() {
  const now = new Date(), nowS = now / 1e3, dawn = new Date(now); dawn.setHours(TRAM.service[0], 0, 0, 0);
  const startS = dawn / 1e3, endS = startS + (TRAM.service[1] - TRAM.service[0]) * 3600;
  if (nowS < startS || nowS > endS) return [];
  const feats = [];
  for (const l of tramLines) { const h = headway(l.ref, now), T = l.total / TRAM.speed;
    for (let m = Math.max(0, Math.ceil((nowS - startS - T) / h)); ; m++) {
      const dep = startS + m * h, age = nowS - dep; if (age < 0 || dep > endS) break;
      const { p } = at(l, age * TRAM.speed);
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: { ref: l.ref, name: l.name } });
    } }
  return feats;
}
const at = (l, d) => { d = ((d % l.total) + l.total) % l.total; let lo = 0, hi = l.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; l.cum[m] <= d ? lo = m : hi = m; }
  const a = l.c[lo], b = l.c[hi], seg = l.cum[hi] - l.cum[lo] || 1, t = (d - l.cum[lo]) / seg;
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] }; };

// ─── live buses: glide between position snapshots instead of teleporting ───
let vehs = [];
function onVehicles(fc) {
  const prev = Object.fromEntries(vehs.map((v) => [v.id, v]));
  vehs = fc.features.map((f) => { const id = f.properties.vehicle || f.geometry.coordinates.join(), p = prev[id];
    const from = p ? p.cur : f.geometry.coordinates;
    return { id, from, cur: from, to: f.geometry.coordinates, t0: performance.now(), props: f.properties }; });
}

function animate(now) {
  setPoints("trams", tramFeatures(), vis("trams"));
  if (vehs.length) setPoints("vehicles", vehs.map((v) => { const k = Math.min(1, (now - v.t0) / FEEDS.vehicles);
    v.cur = [v.from[0] + (v.to[0] - v.from[0]) * k, v.from[1] + (v.to[1] - v.from[1]) * k];
    return { type: "Feature", geometry: { type: "Point", coordinates: v.cur }, properties: v.props }; }), vis("vehicles"));
  R.frame(); requestAnimationFrame(animate);
}

// ─── popups: a positioned div, formatter per pickable layer ───
const date = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const POP = {
  crime: (p) => `<b>${p.category}</b><div class="v">${p.street || "—"}</div><div class="m">${p.outcome || "under investigation"} · ${p.month}</div>`,
  faults: (p) => `<b>${p.fault_status || "reported"}</b><div class="v">${(p.fault_description || "").slice(0, 150)}</div><div class="m">opened ${date(p.fault_open_date)}</div>`,
  cctv: (p) => `<b>CCTV ${p.cam_number || ""}</b><div class="v">${p.location || ""}</div><div class="m">${p.notes || ""}</div>`,
  stops: (p) => `<b>Tram stop</b><div class="v">${p.name || ""}</div>`,
  trams: (p) => `<b>Supertram ${p.ref || ""}</b><div class="v">${p.name || ""}</div>`,
  vehicles: (p) => `<b>Bus ${p.line || ""}</b><div class="m">${p.operator || ""}</div>`,
  trees: (p) => `<b>Tree</b><div class="v">${p.species || "—"}</div>${p.height ? `<div class="m">${p.height} m</div>` : ""}`,
  air: (p) => `<b>Air · AQI ${p.aqi ?? "—"}</b><div class="v">PM2.5 ${p.pm25 ?? "—"} · NO₂ ${p.no2 ?? "—"}</div>`,
  news: (p) => `<b>${p.category || "News"}</b><div class="v">${p.title || ""}</div><div class="m">${p.place || ""}</div>`,
  rivers: (p) => `<b>River gauge</b><div class="v">${p.name || p.river || p.label || ""}</div><div class="m">${p.level ?? p.value ?? ""}</div>`,
};
function wirePicking() {
  const el = $("#popup");
  $("#gpu").addEventListener("click", (e) => {
    const hit = R.pick(e.clientX, e.clientY);
    if (!hit || !POP[hit.id]) { el.style.display = "none"; return; }
    el.innerHTML = POP[hit.id](reg[hit.id][hit.i].properties);
    el.style.left = hit.x + 12 + "px"; el.style.top = hit.y + 12 + "px"; el.style.display = "block";
  });
}

// ─── load everything, build geometry, start ───
async function layers() {
  R.setLine("buildings", buildingWire(await geo("buildings")), WHITE, vis("buildings"));
  R.setLine("roads", lineWire(await geo("roads")), [1, 1, 1, .5], vis("roads"));

  const routes = await geo("tram_routes"); seedTrams(routes);
  R.setLine("tram_routes", lineWire(routes), [1, 1, 1, .3], vis("trams"));
  R.setLine("boundary", lineWire(await geo("boundary")), FAINT, true);
  R.setLine("wards", lineWire(await geo("wards")), [1, 1, 1, .22], vis("wards"));
  R.setLine("clean_air", lineWire(await geo("clean_air")), [.6, .85, 1, .5], vis("clean_air"));
  R.setLine("planning", lineWire(await geo("planning")), [.7, .5, 1, .45], vis("planning"));

  const crime = await geo("crime"); counts.crime = crime.features.length; setPoints("crime", crime.features, vis("crime"));
  const faults = await geo("faults"); counts.faults = faults.features.length; setPoints("faults", faults.features, vis("faults"));
  const cctv = await geo("cctv"); counts.cctv = cctv.features.length; setPoints("cctv", cctv.features, vis("cctv"));
  const trees = await geo("trees"); counts.trees = trees.features.length; setPoints("trees", trees.features, vis("trees"));
  setPoints("stops", (await geo("tram_stops")).features, vis("stops"));
  setPoints("air", (await geo("air")).features, vis("air"));
  setPoints("news", (await geo("news")).features, vis("news"));
  setPoints("rivers", (await geo("rivers")).features, vis("rivers"));

  setPoints("trams", [], vis("trams")); setPoints("vehicles", [], vis("vehicles"));
  buildUI(); poll(); setCount(); requestAnimationFrame(animate);
}

// ─── ui: toggles + legend ───
function buildUI() {
  $("#toggles").innerHTML = LAYERS.map(([id, label]) =>
    `<div class="row ${vis(id) ? "on" : ""}" data-id="${id}">${label}<span class="tk"></span></div>`).join("");
  $("#toggles").querySelectorAll(".row").forEach((row) => {
    const id = row.dataset.id;
    row.onclick = () => { const s = !on.has(id); s ? on.add(id) : on.delete(id);
      row.classList.toggle("on", s); (TOG[id] || []).forEach((l) => R.setVisible(l, s)); syncLegend(); };
  });
  syncLegend();
}
function syncLegend() {
  const lg = $("#legend"); lg.classList.toggle("show", on.has("trams"));
  if (!on.has("trams")) return; const seen = {}, lines = [];
  tramLines.forEach((l) => { if (!seen[l.ref]) { seen[l.ref] = 1; lines.push(l); } });
  lg.innerHTML = lines.map((l) => `<div class="li"><i style="background:${l.color}"></i>${l.ref || l.name || "line"}</div>`).join("");
}

// ─── polling live feeds + clock ───
function poll() {
  for (const [f, ms] of Object.entries(FEEDS)) {
    if (!ms) continue;
    const tick = async () => { const d = await geo(f);
      if (f === "vehicles") { onVehicles(d);
        $("#mode").textContent = d.features.length ? `${d.features.length} live buses · trams from timetable` : "trams from timetable";
      } else if (reg[f]) setPoints(f, d.features, vis(f));
      if (f in counts) { counts[f] = d.features.length; setCount(); }
    };
    setInterval(tick, ms); if (f === "vehicles") tick();
  }
  const clock = () => $("#clock").textContent = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  clock(); setInterval(clock, 1000);
}

(async () => {
  try {
    terr = new Terrain(); await terr.load();
    const c = CITY.center;
    const cam = new Camera({ target: [...ll2m(c[0], c[1]), terr.elev(c[0], c[1])],
      dist: CITY.dist, az: CITY.bearing * D, pitch: CITY.pitch * D, fov: CITY.fov });
    R = new Renderer($("#gpu"), cam); await R.init();
    window.R = R; window.cam = cam; window.terr = terr;
    if (terr.ok) R.setLine("terrain", terr.wire(), [1, 1, 1, .13], vis("terrain"));
    $("#brand p").textContent = terr.ok ? "ea lidar terrain · openstreetmap · open data" : "no terrain — run lidar.py · openstreetmap · open data";
    wirePicking(); await layers();
  } catch (e) {
    $("#nogpu").style.display = "block"; $("#nogpu").textContent = "this view needs a webgpu browser — " + e.message;
  }
})();
