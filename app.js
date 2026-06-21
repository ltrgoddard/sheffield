// glue: load the open data, fold it into gpu geometry, run the live feeds and the ui.
// the whole contract is still data/*.geojson — only the renderer changed.
import { CITY, BBOX, FEEDS, GROUPS, TRAM, LABELS } from "./config.js";
import { Camera, Terrain, ll2m } from "./proj.js";
import { Renderer } from "./gpu.js";

const D = Math.PI / 180, $ = (s) => document.querySelector(s);
// the bit currently streaming in, shown centred on the black splash while it loads.
const load = (m) => { const e = $("#splash > span"); if (e) e.textContent = "loading " + m + "…"; };
const geo = (f) => fetch(`data/${f}.geojson`).then((r) => r.ok ? r.json() : empty).catch(() => empty);
// heavy geometry (buildings, gas pipes) ships as a packed gpu buffer, not geojson — nothing
// for the browser to JSON.parse, ~5-11× smaller raw. see packbin() in fetchers/common.py.
const bin = (f) => fetch(`data/${f}.bin`).then((r) => r.ok ? r.arrayBuffer() : null).catch(() => null);
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
    properties: { vehicle: v.id, line: v.service?.line_name || "", dest: v.destination || "",
      fleet: v.vehicle?.name || "", kind: v.vehicle?.features || "" } })) }));

// colours as linear rgba; the city is white hairlines, the live things pick up a tint.
const WHITE = [1, 1, 1, .85], FAINT = [1, 1, 1, .28], AMBER = [.98, .75, .2, 1], GAS = [1, .5, .12, .6], BLDG = [.62, .64, .68, .8];
// osm trunk pipelines (pipelines.geojson), split by `kind` into one toggleable line layer each.
const PIPE = [["gas_nts", "gas", [1, .3, .12, .9]], ["water_mains", "water", [.3, .7, 1, .7]], ["fuel", "fuel", [.85, .85, .2, .85]]];
const FLAT = GROUPS.flatMap(([, , items]) => items);
const on = new Set(FLAT.filter((l) => l[2]).map((l) => l[0])), vis = (id) => on.has(id);

let R, terr, cam;
// a toggle drives the like-named renderer layer; only these two diverge — trams owns
// the static route line (its dots are gated per-frame by vis()), vehicles is all dynamic.
const TOG = { trams: ["tram_routes"], vehicles: [] }, tog = (id) => TOG[id] || [id];

// ─── geometry builders: geojson → flat float32 line/point arrays in local metres ───
const drape = (lng, lat, dz = 0) => { const [x, y] = ll2m(lng, lat); return [x, y, terr.elev(lng, lat) + dz]; };
// the one clip authority: every feature — roads, buildings, lines, points, labels — is
// trimmed to the lidar terrain coverage (proj.js Terrain.covers), so nothing draws beyond it.
const inside = (lng, lat) => terr.covers(lng, lat);

function lineWire(fc) {
  const p = [];
  for (const f of fc.features) {
    const g = f.geometry, lines = g.type === "LineString" ? [g.coordinates]
      : g.type === "MultiLineString" || g.type === "Polygon" ? g.coordinates
      : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
    for (const ln of lines) for (let i = 0; i < ln.length - 1; i++)
      if (inside(ln[i][0], ln[i][1]) && inside(ln[i + 1][0], ln[i + 1][1]))
        p.push(...drape(ln[i][0], ln[i][1], 2), ...drape(ln[i + 1][0], ln[i + 1][1], 2));
  }
  return new Float32Array(p);
}

// ─── packed gpu buffers: same draping/clipping, fed from the binary the packer wrote ───
function* feats(buf) {   // yield { h, b, parts:[Int32Array] } per feature — coords are lon/lat ×1e6
  const dv = new DataView(buf); let o = 4;
  for (let n = dv.getUint32(0, true); n--; ) {
    const h = dv.getFloat32(o, true), b = dv.getFloat32(o + 4, true), np = dv.getUint32(o + 8, true); o += 12;
    const parts = [];
    for (let j = 0; j < np; j++) { const nv = dv.getUint32(o, true); o += 4; parts.push(new Int32Array(buf, o, nv * 2)); o += nv * 8; }
    yield { h, b, parts };
  }
}
// viridis ramp (10 anchors, lerped) — tints gas pipes by install age.
const VIRIDIS = [[68, 1, 84], [72, 40, 120], [62, 74, 137], [49, 104, 142], [38, 130, 142], [31, 158, 137], [53, 183, 121], [110, 206, 88], [181, 222, 43], [253, 231, 37]];
function viridis(t) { const x = Math.max(0, Math.min(1, t)) * 9, i = x | 0, f = x - i, a = VIRIDIS[i], b = VIRIDIS[Math.min(i + 1, 9)];
  return [0, 1, 2].map((k) => (a[k] + (b[k] - a[k]) * f) / 255); }
const ageTint = (h) => h < 0 ? [.5, .5, .55, .45] : [...viridis(h), .85];   // h<0 = undated pipe → dim grey

function lineBin(buf, tint) {       // flat polylines (gas pipes) — the binary twin of lineWire; tint(h)→rgba paints each vertex
  const p = [], cols = tint ? [] : null; if (!buf) return { pos: new Float32Array(p), cols };
  for (const { h, parts } of feats(buf)) { const col = tint && tint(h);
    for (const c of parts) for (let i = 0; i < c.length - 2; i += 2) {
      const ax = c[i] / 1e6, ay = c[i + 1] / 1e6, bx = c[i + 2] / 1e6, by = c[i + 3] / 1e6;
      if (inside(ax, ay) && inside(bx, by)) { p.push(...drape(ax, ay, 2), ...drape(bx, by, 2)); if (col) cols.push(...col, ...col); }
    } }
  return { pos: new Float32Array(p), cols: cols && new Float32Array(cols) };
}
function buildingBin(buf) {        // extruded footprint wireframes (footprint+roof+verticals) from the packed buffer
  const p = []; if (!buf) return new Float32Array(p);
  for (const { h: H, b: B, parts } of feats(buf)) for (const c of parts)
    for (let i = 0; i < c.length - 2; i += 2) {
      const lax = c[i] / 1e6, lay = c[i + 1] / 1e6, lbx = c[i + 2] / 1e6, lby = c[i + 3] / 1e6;
      if (!(inside(lax, lay) && inside(lbx, lby))) continue;
      const [ax, ay] = ll2m(lax, lay), [bx, by] = ll2m(lbx, lby);
      const ga = terr.elev(lax, lay), gb = terr.elev(lbx, lby);
      p.push(ax, ay, ga + B, bx, by, gb + B, ax, ay, ga + H, bx, by, gb + H, ax, ay, ga + B, ax, ay, ga + H);
    }
  return new Float32Array(p);
}

// ─── point feeds: one style table, a feature registry backing picking + popups ───
const reg = {};
const PT = {
  crime: [[1, 0, 0, 1], 4], faults: [[1, .5, 0, 1], 4], cctv: [[.6, 0, 1, 1], 4],
  stops: [WHITE, 3], trees: [[0, 1, 0, 1], 2.5], air: [[0, 1, 1, 1], 5],
  news: [[1, 1, 0, 1], 6], reddit: [[1, .27, .13, 1], 6], tribune: [[1, .3, .45, 1], 7], rivers: [[0, 0, 1, 1], 5], trams: [AMBER, TRAM.size], vehicles: [[1, 0, 1, 1], 4],
  bus_stops: [[1, .55, .85, .7], 2], gas_assets: [[1, .6, .15, 1], 4],
};
// #rrggbb → rgba float, lifting near-black liveries (e.g. tram-train #000) off the black map.
const rgb = (h) => { const n = parseInt(h.slice(1), 16), c = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; return Math.max(...c) < .2 ? [.7, .7, .7, 1] : [...c, 1]; };
function setPoints(id, features, vis) {
  features = features.filter((f) => inside(f.geometry.coordinates[0], f.geometry.coordinates[1]));
  const a = new Float32Array(features.length * 3); let cols;
  features.forEach((f, k) => { const c = f.geometry.coordinates; a.set(drape(c[0], c[1], 4), k * 3);
    if (f.properties.color) (cols ||= new Float32Array(features.length * 4)).set(rgb(f.properties.color), k * 4); });
  R.setMark(id, a, PT[id][0], PT[id][1], vis, true, cols); reg[id] = features;
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
    const ref = f.properties.ref, total = cum[cum.length - 1];
    return { c, cum, total, dur: (TRAM.line[ref]?.[0] || total / 360) * 60, ref, name: f.properties.name, color: f.properties.colour || "#999" };
  }).filter((l) => l.total > 500);
}
const headway = (ref, now) => { const hw = (TRAM.line[ref] || [0, TRAM.off])[1],
  day = now.getDay() >= 1 && now.getHours() >= 7 && now.getHours() < 19;
  return (day ? hw : Math.max(TRAM.off, hw)) * 60; };
function tramFeatures() {
  const now = new Date(), nowS = now / 1e3, dawn = new Date(now); dawn.setHours(TRAM.service[0], 0, 0, 0);
  const startS = dawn / 1e3, endS = startS + (TRAM.service[1] - TRAM.service[0]) * 3600;
  if (nowS < startS || nowS > endS) return [];
  const feats = [];
  for (const l of tramLines) { const h = headway(l.ref, now), T = l.dur;
    for (let m = Math.max(0, Math.ceil((nowS - startS - T) / h)); ; m++) {
      const dep = startS + m * h, age = nowS - dep; if (age < 0 || dep > endS) break;
      feats.push({ type: "Feature", geometry: { type: "Point", coordinates: at(l, age / T * l.total) }, properties: { ref: l.ref, name: l.name, color: l.color } });
    } }
  return feats;
}
const at = (l, d) => { d = ((d % l.total) + l.total) % l.total; let lo = 0, hi = l.cum.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; l.cum[m] <= d ? lo = m : hi = m; }
  const a = l.c[lo], b = l.c[hi], seg = l.cum[hi] - l.cum[lo] || 1, t = (d - l.cum[lo]) / seg;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; };

// ─── live buses: plot each fix exactly, then glide in a straight line to the next
// fix over the poll interval. no dead-reckoning, no road-snapping — just the raw
// bustimes.org positions, linearly interpolated between consecutive updates. a new
// fix becomes the target and the marker travels from wherever it is to it. (see CLAUDE.md)
const DUR = FEEDS.vehicles;          // ms per fix — the span to interpolate a leg over
let vehs = [];
function onVehicles(fc) {
  const t = performance.now(), prev = Object.fromEntries(vehs.map((v) => [v.id, v]));
  vehs = fc.features.map((f) => {
    const id = f.properties.vehicle || f.geometry.coordinates.join(), to = f.geometry.coordinates, p = prev[id];
    return { id, from: p ? p.cur : to, to, t0: t, cur: p ? p.cur : to.slice(), props: f.properties };
  });
}

function animate(now) {
  setPoints("trams", tramFeatures(), vis("trams"));
  if (vehs.length) setPoints("vehicles", vehs.map((v) => {
    const k = Math.min(1, (now - v.t0) / DUR);
    v.cur = [v.from[0] + (v.to[0] - v.from[0]) * k, v.from[1] + (v.to[1] - v.from[1]) * k];
    return { type: "Feature", geometry: { type: "Point", coordinates: v.cur }, properties: v.props }; }), vis("vehicles"));
  R.frame(); drawLabels(); requestAnimationFrame(animate);
}

// ─── popups: a positioned div, formatter per pickable layer ───
const date = (ms) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const ago = (iso) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const link = (p) => p.link ? `<a href="${p.link}" target="_blank" rel="noopener">${p.title || "open"}</a>` : (p.title || "");
const TRAMLINE = { BLUE: "Blue", YELL: "Yellow", PURP: "Purple", TT: "Tram-train" };
const POP = {
  crime: (p) => `<b>${p.category}</b><div class="v">${p.street || "—"}</div><div class="m">${p.outcome || "under investigation"} · ${p.month}</div>`,
  faults: (p) => `<b>${p.fault_status || "reported"}</b><div class="v">${(p.fault_description || "").slice(0, 150)}</div><div class="m">opened ${date(p.fault_open_date)}</div>`,
  cctv: (p) => `<b>CCTV ${p.cam_number || ""}</b><div class="v">${p.location || ""}</div><div class="m">${p.notes || ""}</div>`,
  stops: (p) => `<b>Tram stop</b><div class="v">${p.name || ""}</div>${p.lines?.length ? `<div class="m">${p.lines.map((l) => TRAMLINE[l] || l).join(" · ")} line</div>` : ""}`,
  bus_stops: (p) => `<b>Bus stop${p.bearing ? " · faces " + p.bearing : ""}</b><div class="v">${p.name || ""}</div>${(p.street || p.towards) ? `<div class="m">${[p.street, p.towards].filter(Boolean).join(" · ")}</div>` : ""}`,
  trams: (p) => `<b>Supertram ${p.ref || ""}</b><div class="v">${p.name || ""}</div>`,
  vehicles: (p) => `<b>Bus ${p.line || "?"}${p.dest ? " → " + p.dest : ""}</b>${(p.fleet || p.kind) ? `<div class="m">${[p.fleet, p.kind].filter(Boolean).join(" · ")}</div>` : ""}`,
  trees: (p) => `<b>Tree</b><div class="v">${p.species || "—"}</div>${p.height ? `<div class="m">${p.height} m</div>` : ""}`,
  air: (p) => `<b>Air · AQI ${p.aqi ?? "—"}</b><div class="v">PM2.5 ${p.pm25 ?? "—"} · PM10 ${p.pm10 ?? "—"} · NO₂ ${p.no2 ?? "—"} · O₃ ${p.o3 ?? "—"}</div>${p.at ? `<div class="m">${ago(p.at)}</div>` : ""}`,
  news: (p) => `<b>${p.category || "News"}</b><div class="v">${link(p)}</div><div class="m">${p.summary || p.place || ""}</div>`,
  reddit: (p) => `<b>r/sheffield · ${p.category || "post"}</b><div class="v">${link(p)}</div><div class="m">${p.place || ""}</div>`,
  tribune: (p) => `<b>sheffield tribune${p.place ? " · " + p.place : ""}</b><div class="v">${link(p)}</div><div class="m">${p.summary || ""}</div>`,
  rivers: (p) => `<b>${p.river || "River gauge"}</b><div class="v">${p.label || ""}${p.level != null ? " · " + p.level + " m" : ""}</div>${(p.ratio != null || p.at) ? `<div class="m">${p.ratio != null ? Math.round(p.ratio * 100) + "% of typical max" : ""}${p.at ? (p.ratio != null ? " · " : "") + ago(p.at) : ""}</div>` : ""}`,
  gas_assets: (p) => `<b>Gas · above-ground site</b><div class="m">${p.description || ""}</div>`,
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
      const k = nm + (A[0] * 300 | 0) + "," + (A[1] * 300 | 0); if (seen.has(k) || !inside(A[0], A[1])) continue; seen.add(k);
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
  if (stA > 0 && vis("roads")) { lx.font = `400 10px '${LABELS.font}', monospace`;
    const [tx, ty] = cam.target, near2 = LABELS.nearStreet ** 2;   // cull roads far from the camera focus
    for (const L of streetLabels) {
      const cx = (L.a[0] + L.b[0]) / 2 - tx, cy = (L.a[1] + L.b[1]) / 2 - ty; if (cx * cx + cy * cy > near2) continue;
      const a = R.screen(L.a[0], L.a[1], L.a[2]), b = R.screen(L.b[0], L.b[1], L.b[2]); if (!a || !b) continue;
      const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; let ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      if (ang > Math.PI / 2) ang -= Math.PI; else if (ang < -Math.PI / 2) ang += Math.PI;
      const tw = lx.measureText(L.t).width; if (!fits(mx - tw / 2, my, tw)) continue;
      glyph(mx, my, L.t, "rgb(196,196,205)", stA * .85, ang); } }
}

// ─── load everything, build geometry, start ───
async function layers() {
  // fire *every* fetch up front so the network runs fully in parallel, then fold each
  // as it resolves — folding is cpu-bound and cheap next to the round-trips it replaces.
  const buildingsP = bin("buildings");   // the big fetch (packed gpu buffer); fold it last
  const gasP = bin("gas_pipes"), pipesP = geo("pipelines");
  const roadsP = geo("roads"), routesP = cgeo("tram_routes");
  const lineP = [["boundary", FAINT], ["wards", [1, 1, 1, .22]], ["clean_air", [.6, .85, 1, .5]], ["planning", [0, 1, 0, 1]]]
    .map(([id, col]) => [id, col, geo(id)]);
  const cached = new Set(["tram_stops", "bus_stops"]);   // static osm geometry, served from localStorage
  const ptP = [["crime", "crime"], ["faults", "faults"], ["cctv", "cctv"], ["trees", "trees"],
    ["stops", "tram_stops"], ["bus_stops", "bus_stops"], ["air", "air"], ["news", "news"], ["reddit", "reddit"], ["tribune", "tribune"], ["rivers", "rivers"], ["gas_assets", "gas_assets"]]
    .map(([id, file]) => [id, (cached.has(file) ? cgeo : geo)(file)]);

  load("infra"); const gas = lineBin(await gasP, ageTint); R.setLine("gas_pipes", gas.pos, GAS, vis("gas_pipes"), gas.cols);
  const trunk = (await pipesP).features;   // osm trunk pipelines, one line layer per kind
  for (const [id, k, col] of PIPE) R.setLine(id, lineWire({ features: trunk.filter((f) => f.properties.kind === k) }), col, vis(id));
  load("roads"); const roads = await roadsP; buildStreetLabels(roads); R.setLine("roads", lineWire(roads), [1, 1, 1, .5], vis("roads"));
  load("trams"); const routes = await routesP; seedTrams(routes); R.setLine("tram_routes", lineWire(routes), [1, 1, 1, .3], vis("trams"));
  load("districts"); for (const [id, col, p] of lineP) R.setLine(id, lineWire(await p), col, id === "boundary" || vis(id));
  load("feeds"); for (const [id, p] of ptP) setPoints(id, (await p).features, vis(id));
  buildStopLabels("stops", "rgb(238,238,242)"); buildStopLabels("bus_stops", "rgb(255,150,225)");

  setPoints("trams", [], vis("trams")); setPoints("vehicles", [], vis("vehicles"));
  buildUI(); poll();
  load("buildings");
  // buildings last: ~12k footprints is the heaviest fold — by now the terrain, roads,
  // trams and feeds are already on screen (animate() has been running since startup),
  // so the city wireframe fills in rather than blocking the whole first paint.
  R.setLine("buildings", buildingBin(await buildingsP), BLDG, vis("buildings"));
}

// ─── ui: toggles + legend ───
const set = (id, s) => { s ? on.add(id) : on.delete(id);
  $(`.row[data-id="${id}"]`)?.classList.toggle("on", s); tog(id).forEach((l) => R.setVisible(l, s)); };
const grpItems = (gid) => GROUPS.find((g) => g[0] === gid)[2];
function buildUI() {
  $("#toggles").innerHTML = GROUPS.map(([gid, glabel, items]) =>
    `<div class="grp collapsed" data-grp="${gid}"><div class="gh"><i class="cv"></i>${glabel}<span class="tk"></span></div>` +
    items.map(([id, label]) => `<div class="row ${vis(id) ? "on" : ""}" data-id="${id}">${label}<span class="tk"></span></div>`).join("") + `</div>`).join("");
  // sub-item: clicking the row enables/disables it
  $("#toggles").querySelectorAll(".row").forEach((row) => row.onclick = () => {
    set(row.dataset.id, !on.has(row.dataset.id)); sync(); });
  // group header: clicking toggles every item; only the chevron expands/collapses
  $("#toggles").querySelectorAll(".grp").forEach((grp) => {
    grp.querySelector(".gh").onclick = () => {
      const items = grpItems(grp.dataset.grp), s = !items.every((i) => vis(i[0]));
      items.forEach((i) => set(i[0], s)); sync(); };
    grp.querySelector(".cv").onclick = (e) => { e.stopPropagation(); grp.classList.toggle("collapsed"); };
  });
  sync();
}
function sync() {
  $("#toggles").querySelectorAll(".grp").forEach((grp) =>
    grp.querySelector(".gh").classList.toggle("on", grpItems(grp.dataset.grp).every((i) => vis(i[0]))));
  syncLegend();
}
function syncLegend() {
  const lg = $("#legend"); lg.classList.toggle("show", on.has("trams"));
  if (!on.has("trams")) return; const seen = {}, lines = [];
  tramLines.forEach((l) => { if (!seen[l.ref]) { seen[l.ref] = 1; lines.push(l); } });
  lg.innerHTML = lines.map((l) => `<div class="li">${l.ref || l.name || "line"}<i style="background:${l.color}"></i></div>`).join("");
}

// ─── polling live feeds ───
function poll() {
  for (const [f, ms] of Object.entries(FEEDS)) {
    if (!ms) continue;
    const tick = async () => { const d = f === "vehicles" ? await liveBuses() : await geo(f);
      if (f === "vehicles") onVehicles(d);
      else if (reg[f]) setPoints(f, d.features, vis(f));
    };
    setInterval(tick, ms); if (f === "vehicles") tick();
  }
}

(async () => {
  try {
    load("terrain"); terr = new Terrain(); await terr.load();
    const c = CITY.center;
    cam = new Camera({ target: [...ll2m(c[0], c[1]), terr.elev(c[0], c[1])],
      dist: CITY.dist, az: CITY.bearing * D, pitch: CITY.pitch * D, fov: CITY.fov });
    R = new Renderer($("#gpu"), cam); await R.init();
    window.R = R; window.cam = cam; window.terr = terr;
    if (terr.ok) R.setLine("terrain", terr.wire(), [1, 1, 1, .12], vis("terrain"));
    $("#bar").onclick = () => $("#panel").classList.toggle("folded");
    wirePicking(); requestAnimationFrame(animate); await layers();   // paint from frame one; layers stream in
  } catch (e) {
    $("#nogpu").style.display = "block"; $("#nogpu").textContent = "this view needs a webgpu browser — " + e.message;
  }
  $("#splash").classList.add("gone");   // everything's loaded (or failed) — fade the black away, city + legend in
})();
