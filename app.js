// glue: load the open data, fold it into gpu geometry, run the live feeds and the ui.
// the whole contract is still data/*.geojson — only the renderer changed.
import { CITY, BBOX, FEEDS, GROUPS, TRAM, LABELS } from "./config.js";
import { Camera, Terrain, ll2m } from "./proj.js";
import { Renderer } from "./gpu.js";

const D = Math.PI / 180, $ = (s) => document.querySelector(s);
const geo = (f) => fetch(`data/${f}.geojson`).then((r) => r.ok ? r.json() : empty).catch(() => empty);
// static feeds (tram route/stop geometry) barely change: serve from localStorage instantly, revalidate in the background.
const cgeo = async (f) => { const k = "geo:" + f, hit = localStorage[k];
  const live = geo(f).then((d) => { if (d.features.length) localStorage[k] = JSON.stringify(d); return d; });
  return hit ? JSON.parse(hit) : live; };
const empty = { type: "FeatureCollection", features: [] };
// live buses come straight from bustimes.org — a cors-enabled, no-key json feed that
// re-serves the dft bods siri-vm stream. fetched in the browser and mapped to the
// feature shape the renderer expects, so there's no backend, no api key, no proxy.
const BUSES = `https://bustimes.org/vehicles.json?xmin=${BBOX.w}&ymin=${BBOX.s}&xmax=${BBOX.e}&ymax=${BBOX.n}`;
const liveBuses = () => fetch(BUSES).then((r) => r.ok ? r.json() : []).catch(() => [])
  .then((vs) => ({ type: "FeatureCollection", features: (vs || []).map((v) => ({
    type: "Feature", geometry: { type: "Point", coordinates: v.coordinates },
    properties: { vehicle: v.id, bearing: v.heading || 0, line: v.service?.line_name || "", operator: v.vehicle?.name || "" } })) }));

// colours as linear rgba; the city is white hairlines, the live things pick up a tint.
const WHITE = [1, 1, 1, .85], FAINT = [1, 1, 1, .28], AMBER = [.98, .75, .2, 1];
const FLAT = GROUPS.flatMap(([, , items]) => items);
const counts = {}, on = new Set(FLAT.filter((l) => l[2]).map((l) => l[0])), vis = (id) => on.has(id);
const setCount = () => $("#count").textContent =
  Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(" · ") || "no data";

let R, terr, cam;
// a toggle drives the like-named renderer layer; only these two diverge — trams owns
// the static route line (its dots are gated per-frame by vis()), vehicles is all dynamic.
const TOG = { trams: ["tram_routes"], vehicles: [] }, tog = (id) => TOG[id] || [id];

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
  crime: [[1, 0, 0, 1], 4], faults: [[1, .5, 0, 1], 4], cctv: [[.6, 0, 1, 1], 4],
  stops: [WHITE, 3], trees: [[0, 1, 0, 1], 2.5], air: [[0, 1, 1, 1], 5],
  news: [[1, 1, 0, 1], 6], rivers: [[0, 0, 1, 1], 5], trams: [AMBER, TRAM.size], vehicles: [[1, 0, 1, 1], 4],
  bus_stops: [[1, .55, .85, .7], 2],
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
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: at(l, age * TRAM.speed) }, properties: { ref: l.ref, name: l.name } });
    } }
  return feats;
}
const at = (l, d) => { d = ((d % l.total) + l.total) % l.total; let lo = 0, hi = l.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; l.cum[m] <= d ? lo = m : hi = m; }
  const a = l.c[lo], b = l.c[hi], seg = l.cum[hi] - l.cum[lo] || 1, t = (d - l.cum[lo]) / seg;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };

// ─── live buses: glide each bus along the straight line between its real reported
// fixes. honest (it shows only movement the feed actually reports), monotonic — it
// never bounces backwards or drifts off-road the way fabricated dead-reckoning did —
// and smooth: a new fix becomes the target and the marker eases toward it over the
// time the previous fix took, so motion matches the feed's own cadence. (see CLAUDE.md)
let vehs = [];
function onVehicles(fc) {
  const t = performance.now(), prev = Object.fromEntries(vehs.map((v) => [v.id, v]));
  vehs = fc.features.map((f) => {
    const id = f.properties.vehicle || f.geometry.coordinates.join(), to = f.geometry.coordinates, p = prev[id];
    const dur = p ? Math.min(30, Math.max(4, (t - p.t0) / 1e3)) : 0;
    // glide from the last shown point over the feed's own cadence — but snap (no glide) on first
    // sight or an implausible jump (gps spike / reacquisition), so a bus never streaks across the map
    const snap = !p || hav(p.cur, to) > 40 * dur;
    return { id, from: snap ? to : p.cur, to, t0: t, dur: snap ? 0 : dur, cur: snap ? to.slice() : p.cur, props: f.properties };
  });
}

function animate(now) {
  setPoints("trams", tramFeatures(), vis("trams"));
  if (vehs.length) setPoints("vehicles", vehs.map((v) => {
    const k = v.dur ? Math.min(1, (now - v.t0) / (v.dur * 1e3)) : 1;
    v.cur = [v.from[0] + (v.to[0] - v.from[0]) * k, v.from[1] + (v.to[1] - v.from[1]) * k];
    return { type: "Feature", geometry: { type: "Point", coordinates: v.cur }, properties: v.props }; }), vis("vehicles"));
  R.frame(); drawLabels(); requestAnimationFrame(animate);
}

// ─── popups: a positioned div, formatter per pickable layer ───
const date = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const POP = {
  crime: (p) => `<b>${p.category}</b><div class="v">${p.street || "—"}</div><div class="m">${p.outcome || "under investigation"} · ${p.month}</div>`,
  faults: (p) => `<b>${p.fault_status || "reported"}</b><div class="v">${(p.fault_description || "").slice(0, 150)}</div><div class="m">opened ${date(p.fault_open_date)}</div>`,
  cctv: (p) => `<b>CCTV ${p.cam_number || ""}</b><div class="v">${p.location || ""}</div><div class="m">${p.notes || ""}</div>`,
  stops: (p) => `<b>Tram stop</b><div class="v">${p.name || ""}</div>`,
  bus_stops: (p) => `<b>Bus stop</b><div class="v">${p.name || ""}</div>`,
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

// ─── text labels: lowercase jetbrains mono on a 2d overlay, projected each frame ───
// the only text in an otherwise label-free wireframe — so it stays whisper-quiet:
// fades in only when zoomed in, greedily skips anything that would overlap, halos
// each glyph for legibility over the lines. street names ride the road; stops sit
// beside their dot. drape() lifts each anchor onto the terrain, same as the geometry.
const lcv = $("#labels"), lx = lcv.getContext("2d"), LDPR = Math.min(devicePixelRatio || 1, 2);
const streetLabels = [], stopLabels = [];
function buildStreetLabels(fc) {
  const seen = new Set();   // one label per name per ~370 m cell, so long roads repeat but don't clutter
  for (const f of fc.features) { const nm = f.properties?.name; if (!nm) continue;
    const g = f.geometry, lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
    for (const ln of lines) { if (ln.length < 2) continue; const i = ln.length >> 1, A = ln[i - 1], B = ln[i];
      const k = nm + (A[0] * 300 | 0) + "," + (A[1] * 300 | 0); if (seen.has(k)) continue; seen.add(k);
      streetLabels.push({ a: drape(A[0], A[1], 2), b: drape(B[0], B[1], 2), t: nm.toLowerCase() }); } }
}
const buildStopLabels = (id, tint) => { for (const f of reg[id] || []) { const c = f.geometry.coordinates;
  stopLabels.push({ p: drape(c[0], c[1], 4), t: (f.properties.name || "").toLowerCase(), layer: id, tint }); } };

const fade = (dist, max) => Math.max(0, Math.min(1, (max - dist) / LABELS.fade));
function glyph(x, y, t, color, alpha, ang) {
  lx.save(); lx.translate(x, y); if (ang) lx.rotate(ang); const ox = ang ? -lx.measureText(t).width / 2 : 0;
  lx.globalAlpha = alpha; lx.lineWidth = 3; lx.strokeStyle = "rgba(0,0,0,.6)"; lx.strokeText(t, ox, 0);
  lx.fillStyle = color; lx.fillText(t, ox, 0); lx.restore();
}
function drawLabels() {
  const w = lcv.clientWidth, h = lcv.clientHeight;
  if (lcv.width !== (w * LDPR | 0)) { lcv.width = w * LDPR | 0; lcv.height = h * LDPR | 0; }
  lx.setTransform(LDPR, 0, 0, LDPR, 0, 0); lx.clearRect(0, 0, w, h);
  const dist = cam.dist; if (dist > LABELS.stop) return;        // labels only at high zoom
  lx.textBaseline = "middle"; lx.lineJoin = "round";
  const placed = [], fits = (rx, ry, tw) => { if (rx < 0 || ry < 7 || rx + tw > w || ry + 7 > h) return false;
    for (const q of placed) if (rx < q[2] && rx + tw > q[0] && ry - 7 < q[3] && ry + 7 > q[1]) return false;
    placed.push([rx, ry - 7, rx + tw, ry + 7]); return true; };
  const stopA = fade(dist, LABELS.stop);                        // stops first — they win collisions
  if (stopA > 0) { lx.font = `500 11px '${LABELS.font}', monospace`;
    for (const L of stopLabels) { if (!vis(L.layer)) continue; const s = R.screen(L.p[0], L.p[1], L.p[2]); if (!s) continue;
      const tw = lx.measureText(L.t).width; if (!fits(s[0] + 7, s[1], tw)) continue;
      glyph(s[0] + 7, s[1], L.t, L.tint, stopA, 0); } }
  const stA = fade(dist, LABELS.street);                        // then street names fill the gaps
  if (stA > 0) { lx.font = `400 10px '${LABELS.font}', monospace`;
    for (const L of streetLabels) { const a = R.screen(L.a[0], L.a[1], L.a[2]), b = R.screen(L.b[0], L.b[1], L.b[2]); if (!a || !b) continue;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      const tw = lx.measureText(L.t).width; if (!fits(mx - tw / 2, my, tw)) continue;
      glyph(mx, my, L.t, "rgb(196,196,205)", stA * .85, ang); } }
}

// ─── load everything, build geometry, start ───
async function layers() {
  const buildingsP = geo("buildings");   // kick off the big (~40 MB) fetch now; fold it last
  const roads = await geo("roads"); buildStreetLabels(roads); R.setLine("roads", lineWire(roads), [1, 1, 1, .5], true);
  const routes = await cgeo("tram_routes"); seedTrams(routes); R.setLine("tram_routes", lineWire(routes), [1, 1, 1, .3], vis("trams"));

  // line/polygon overlays: [id, colour] — file name is the id; boundary is base, the rest toggle.
  for (const [id, col] of [["boundary", FAINT], ["wards", [1, 1, 1, .22]], ["clean_air", [.6, .85, 1, .5]], ["planning", [.7, .5, 1, .45]]])
    R.setLine(id, lineWire(await geo(id)), col, id === "boundary" || vis(id));

  // point feeds: [id, file, counted?] — counted ones seed the status-bar tally.
  const cached = new Set(["tram_stops", "bus_stops"]);   // static osm geometry, served from localStorage
  for (const [id, file, n] of [["crime", "crime", 1], ["faults", "faults", 1], ["cctv", "cctv", 1], ["trees", "trees", 1],
    ["stops", "tram_stops"], ["bus_stops", "bus_stops"], ["air", "air"], ["news", "news"], ["rivers", "rivers"]]) {
    const d = await (cached.has(file) ? cgeo : geo)(file);
    if (n) counts[id] = d.features.length;
    setPoints(id, d.features, vis(id));
  }
  buildStopLabels("stops", "rgb(238,238,242)"); buildStopLabels("bus_stops", "rgb(255,150,225)");

  setPoints("trams", [], vis("trams")); setPoints("vehicles", [], vis("vehicles"));
  buildUI(); poll(); setCount();
  // buildings last: ~12k footprints is the heaviest fold — by now the terrain, roads,
  // trams and feeds are already on screen (animate() has been running since startup),
  // so the city wireframe fills in rather than blocking the whole first paint.
  R.setLine("buildings", buildingWire(await buildingsP), WHITE, true);
}

// ─── ui: toggles + legend ───
const set = (id, s) => { s ? on.add(id) : on.delete(id);
  $(`.row[data-id="${id}"]`)?.classList.toggle("on", s); tog(id).forEach((l) => R.setVisible(l, s)); };
const grpItems = (gid) => GROUPS.find((g) => g[0] === gid)[2];
function buildUI() {
  $("#toggles").innerHTML = GROUPS.map(([gid, glabel, items]) =>
    `<div class="gh" data-grp="${gid}">${glabel}<span class="tk"></span></div>` +
    items.map(([id, label]) => `<div class="row ${vis(id) ? "on" : ""}" data-id="${id}">${label}<span class="tk"></span></div>`).join("")).join("");
  $("#toggles").querySelectorAll(".row").forEach((row) =>
    row.onclick = () => { set(row.dataset.id, !on.has(row.dataset.id)); sync(); });
  $("#toggles").querySelectorAll(".gh").forEach((gh) => gh.onclick = () => {
    const items = grpItems(gh.dataset.grp), s = !items.every((i) => vis(i[0]));
    items.forEach((i) => set(i[0], s)); sync();
  });
  sync();
}
function sync() {
  $("#toggles").querySelectorAll(".gh").forEach((gh) =>
    gh.classList.toggle("on", grpItems(gh.dataset.grp).every((i) => vis(i[0]))));
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
    const tick = async () => { const d = f === "vehicles" ? await liveBuses() : await geo(f);
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
    cam = new Camera({ target: [...ll2m(c[0], c[1]), terr.elev(c[0], c[1])],
      dist: CITY.dist, az: CITY.bearing * D, pitch: CITY.pitch * D, fov: CITY.fov });
    R = new Renderer($("#gpu"), cam); await R.init();
    window.R = R; window.cam = cam; window.terr = terr;
    if (terr.ok) R.setLine("terrain", terr.wire(), [1, 1, 1, .12], true);
    $("#bar").onclick = () => $("#panel").classList.toggle("folded");
    wirePicking(); requestAnimationFrame(animate); await layers();   // paint from frame one; layers stream in
  } catch (e) {
    $("#nogpu").style.display = "block"; $("#nogpu").textContent = "this view needs a webgpu browser — " + e.message;
  }
})();
