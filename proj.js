// the cpu side: a local-metre projection, the orbit camera's matrices, and the lidar
// terrain decoded into a height-field we both drape geometry on and draw as a wire grid.
import { CITY, BBOX, TERRAIN, TILES } from "./config.js";

const D = Math.PI / 180, [LNG0, LAT0] = CITY.center;
const MLNG = 111320 * Math.cos(LAT0 * D), MLAT = 110540;
// local tangent-plane metres, east/north, origin at the city centre.
export const ll2m = (lng, lat) => [(lng - LNG0) * MLNG, (lat - LAT0) * MLAT];

// ─── vec3 + 4×4 column-major matrices — exactly what the camera needs ───
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
export const mul = (a, b) => { const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; };
const persp = (f, asp, n, fz) => { const t = 1 / Math.tan(f / 2);
  return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, fz / (n - fz), -1, 0, 0, fz * n / (n - fz), 0]); };
const lookAt = (e, c, up) => { const z = norm(sub(e, c)), x = norm(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
    -dot(x, e), -dot(y, e), -dot(z, e), 1]); };

// orbit camera: a target on the ground, a distance, an azimuth and a pitch off vertical.
export class Camera {
  constructor(o) { Object.assign(this, { fov: 52, ...o }); }
  eye() { const h = this.dist * Math.sin(this.pitch);
    return [this.target[0] + h * Math.sin(this.az), this.target[1] - h * Math.cos(this.az),
      this.target[2] + this.dist * Math.cos(this.pitch)]; }
  vp(asp) { return mul(persp(this.fov * D, asp, 1, 1e5), lookAt(this.eye(), this.target, [0, 0, 1])); }
  // world x/y where the cursor ray (ndc nx,ny) meets the target's ground plane — for zoom-to-cursor.
  ground(nx, ny, asp) { const e = this.eye(), z = norm(sub(e, this.target)), x = norm(cross([0, 0, 1], z)),
    y = cross(z, x), t = Math.tan(this.fov * D / 2),
    d = [nx * t * asp * x[0] + ny * t * y[0] - z[0], nx * t * asp * x[1] + ny * t * y[1] - z[1], nx * t * asp * x[2] + ny * t * y[2] - z[2]],
    s = (this.target[2] - e[2]) / d[2];
    return [e[0] + s * d[0], e[1] + s * d[1]]; }
}

const N = (z) => 2 ** z;
const lon2x = (lng, z) => (lng + 180) / 360 * N(z);
const lat2y = (lat, z) => (1 - Math.log(Math.tan(lat * D) + 1 / Math.cos(lat * D)) / Math.PI) / 2 * N(z);

// ─── terrain: decode terrarium tiles → per-pixel metres, exaggerated ───
export class Terrain {
  constructor() { this.z = TERRAIN.zoom; this.t = new Map(); this.ok = false; }
  async load() {
    const z = this.z, x0 = lon2x(BBOX.w, z) | 0, x1 = lon2x(BBOX.e, z) | 0,
      y0 = lat2y(BBOX.n, z) | 0, y1 = lat2y(BBOX.s, z) | 0, jobs = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push(this.tile(x, y));
    await Promise.all(jobs); return (this.ok = this.t.size > 0);
  }
  async tile(x, y) {
    try {
      const r = await fetch(TILES.replace("{z}", this.z).replace("{x}", x).replace("{y}", y));
      if (!r.ok) return;
      const cv = new OffscreenCanvas(256, 256), cx = cv.getContext("2d");
      cx.drawImage(await createImageBitmap(await r.blob()), 0, 0);
      const d = cx.getImageData(0, 0, 256, 256).data, h = new Float32Array(65536);
      // gdal2tiles flags nodata via alpha=0 but leaves the rgb filled with black or
      // white garbage (±32768 m spikes); honour the mask, and NaN any wild value, so
      // coverage edges stop cleanly instead of spiking to the earth's core or sky.
      for (let i = 0; i < 65536; i++) { const r = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        h[i] = d[i * 4 + 3] < 128 || r < -1000 || r > 2000 ? NaN : r * TERRAIN.exag; }
      this.t.set(x + "/" + y, h);
    } catch {}
  }
  // bilinear elevation (exaggerated metres) at lng/lat; 0 outside coverage.
  elev(lng, lat) {
    const z = this.z, fx = lon2x(lng, z), fy = lat2y(lat, z), tx = fx | 0, ty = fy | 0;
    const h = this.t.get(tx + "/" + ty); if (!h) return 0;
    const px = (fx - tx) * 256, py = (fy - ty) * 256, x0 = Math.min(254, px | 0), y0 = Math.min(254, py | 0),
      dx = px - x0, dy = py - y0, i = y0 * 256 + x0;
    const e = (h[i] * (1 - dx) + h[i + 1] * dx) * (1 - dy) + (h[i + 256] * (1 - dx) + h[i + 257] * dx) * dy;
    return isFinite(e) ? e : 0;  // nodata corners → sit draped geometry flat, not in the void
  }
  // the topographic wireframe: a lifted grid of line segments over every loaded tile.
  wire() {
    const z = this.z, s = TERRAIN.step, pos = [];
    const node = (h, tx, ty, i, j) => { const lng = (tx + i / 256) / N(z) * 360 - 180,
      lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (ty + j / 256) / N(z)))) / D, [x, y] = ll2m(lng, lat);
      return [x, y, h[j * 256 + i]]; };
    for (const k of this.t.keys()) { const [tx, ty] = k.split("/").map(Number), h = this.t.get(k);
      for (let j = 0; j < 256 - s; j += s) for (let i = 0; i < 256 - s; i += s) {
        const p = node(h, tx, ty, i, j), a = node(h, tx, ty, i + s, j), b = node(h, tx, ty, i, j + s);
        if (isFinite(p[2]) && isFinite(a[2])) pos.push(p[0], p[1], p[2], a[0], a[1], a[2]);
        if (isFinite(p[2]) && isFinite(b[2])) pos.push(p[0], p[1], p[2], b[0], b[1], b[2]);
      } }
    return new Float32Array(pos);
  }
}
