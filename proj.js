// the cpu side: a local-metre projection, the orbit camera's matrices, and the lidar
// terrain decoded into a height-field we both drape geometry on and draw as a wire grid.
import { CITY, TERRAIN } from "./config.js";

const D = Math.PI / 180, [LNG0, LAT0] = CITY.center;
const MLNG = 111320 * Math.cos(LAT0 * D), MLAT = 110540;
// local tangent-plane metres, east/north, origin at the city centre.
export const ll2m = (lng, lat) => [(lng - LNG0) * MLNG, (lat - LAT0) * MLAT];

// ─── vec3 + 4×4 column-major matrices — exactly what the camera needs ───
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; };
const mul = (a, b) => { const o = new Float32Array(16);
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

// ─── terrain: one packed int16 height grid (data/terrain.bin, built by lidar.pack) ───
// the old per-tile terrarium-png decode is gone — fetchers/lidar.py now decodes + downsamples
// the tiles server-side into a single int16 buffer (decimetres, nodata -32768), so we fetch one
// file and skip ~450 png decodes. header `<6i` z,x0,y0,TX,TY,SP; then a TX·SP × TY·SP grid where
// sample (gx,gy) sits at slippy-tile coords (x0+gx/SP, y0+gy/SP) — the whole reader mapping.
export class Terrain {
  constructor() { this.ok = false; }
  async load() {
    const buf = await fetch("data/terrain.bin").then((r) => r.ok ? r.arrayBuffer() : null).catch(() => null);
    if (!buf) return (this.ok = false);
    [this.z, this.x0, this.y0, this.TX, this.TY, this.SP] = new Int32Array(buf, 0, 6);
    this.W = this.TX * this.SP; this.H = this.TY * this.SP; this.g = new Int16Array(buf, 24);
    return (this.ok = true);
  }
  // bilinear elevation (exaggerated metres) at lng/lat; 0 outside coverage.
  elev(lng, lat) {
    const gx = (lon2x(lng, this.z) - this.x0) * this.SP, gy = (lat2y(lat, this.z) - this.y0) * this.SP;
    if (gx < 0 || gy < 0 || gx >= this.W - 1 || gy >= this.H - 1) return 0;
    const x0 = gx | 0, y0 = gy | 0, dx = gx - x0, dy = gy - y0, i = y0 * this.W + x0, g = this.g;
    const V = (k) => { const v = g[k]; return v === -32768 ? NaN : v / 10 * TERRAIN.exag; };
    const e = (V(i) * (1 - dx) + V(i + 1) * dx) * (1 - dy) + (V(i + this.W) * (1 - dx) + V(i + this.W + 1) * dx) * dy;
    return isFinite(e) ? e : 0;  // nodata corners → sit draped geometry flat, not in the void
  }
  // is there real lidar coverage at lng/lat? the single source of truth for the clip extent —
  // every rendered feature is trimmed to this. (no terrain → don't clip, so the flat fallback draws.)
  covers(lng, lat) {
    if (!this.ok) return true;
    const gx = (lon2x(lng, this.z) - this.x0) * this.SP | 0, gy = (lat2y(lat, this.z) - this.y0) * this.SP | 0;
    return gx >= 0 && gy >= 0 && gx < this.W && gy < this.H && this.g[gy * this.W + gx] !== -32768;
  }
  // the topographic wireframe: a lifted grid of line segments over the height field.
  wire() {
    const s = TERRAIN.step, W = this.W, H = this.H, g = this.g, pos = [], Nz = N(this.z);
    const node = (gx, gy) => { const lng = (this.x0 + gx / this.SP) / Nz * 360 - 180,
      lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (this.y0 + gy / this.SP) / Nz))) / D, [x, y] = ll2m(lng, lat);
      const v = g[gy * W + gx]; return [x, y, v === -32768 ? NaN : v / 10 * TERRAIN.exag]; };
    for (let gy = 0; gy < H - s; gy += s) for (let gx = 0; gx < W - s; gx += s) {
      const p = node(gx, gy), a = node(gx + s, gy), b = node(gx, gy + s);
      if (isFinite(p[2]) && isFinite(a[2])) pos.push(p[0], p[1], p[2], a[0], a[1], a[2]);
      if (isFinite(p[2]) && isFinite(b[2])) pos.push(p[0], p[1], p[2], b[0], b[1], b[2]);
    }
    return new Float32Array(pos);
  }
}
