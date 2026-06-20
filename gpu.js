// the gpu side: one webgpu device, two pipelines — crisp 1px lines and instanced
// point-markers — plus the orbit controls and cpu-side picking. everything the city is
// made of (terrain grid, building wireframes, routes, live dots) is just lines.

const SHADER = `
struct Cam { vp: mat4x4f, vps: vec2f };
struct Style { color: vec4f, size: f32 };
@group(0) @binding(0) var<uniform> cam: Cam;
@group(1) @binding(0) var<uniform> st: Style;

@vertex fn vline(@location(0) p: vec3f) -> @builtin(position) vec4f { return cam.vp * vec4f(p, 1.0); }

@vertex fn vmark(@location(0) off: vec2f, @location(1) c: vec3f) -> @builtin(position) vec4f {
  let clip = cam.vp * vec4f(c, 1.0);
  return vec4f(clip.xy + off * st.size / cam.vps * clip.w * 2.0, clip.zw);
}
@fragment fn fsolid() -> @location(0) vec4f { return st.color; }`;

// project a world point through the current view-proj to css pixels (for picking).
const project = (m, x, y, z, w, h) => {
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15]; if (cw <= 0) return null;
  return [((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * w,
    (0.5 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5) * h];
};

export class Renderer {
  constructor(canvas, cam) {
    this.cv = canvas; this.cam = cam; this.lines = new Map(); this.marks = new Map();
    this.dpr = Math.min(devicePixelRatio || 1, 2); this.vp = new Float32Array(16);
  }
  async init() {
    if (!navigator.gpu) throw new Error("no webgpu");
    const dev = this.dev = await (await navigator.gpu.requestAdapter()).requestDevice();
    this.ctx = this.cv.getContext("webgpu");
    const fmt = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: dev, format: fmt, alphaMode: "opaque" });
    const m = dev.createShaderModule({ code: SHADER });
    this.camBuf = dev.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const vis = GPUShaderStage.VERTEX, vf = vis | GPUShaderStage.FRAGMENT;
    const L0 = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: vis, buffer: {} }] });
    this.L1 = dev.createBindGroupLayout({ entries: [{ binding: 0, visibility: vf, buffer: {} }] });
    this.cbg = dev.createBindGroup({ layout: L0, entries: [{ binding: 0, resource: { buffer: this.camBuf } }] });
    const layout = dev.createPipelineLayout({ bindGroupLayouts: [L0, this.L1] });
    const blend = { color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
      alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
    const targets = [{ format: fmt, blend }], primitive = { topology: "line-list" };
    this.pLine = dev.createRenderPipeline({ layout, primitive, vertex: { module: m, entryPoint: "vline",
      buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
      fragment: { module: m, entryPoint: "fsolid", targets } });
    this.pMark = dev.createRenderPipeline({ layout, primitive: { topology: "triangle-list" }, vertex: { module: m, entryPoint: "vmark", buffers: [
      { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
      { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 1, offset: 0, format: "float32x3" }] }] },
      fragment: { module: m, entryPoint: "fsolid", targets } });
    // a filled unit diamond (2 triangles) billboarded per instance — the marker glyph.
    const d = new Float32Array([0, 1, 1, 0, 0, -1, 0, -1, -1, 0, 0, 1]);
    this.diamond = dev.createBuffer({ size: d.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    new Float32Array(this.diamond.getMappedRange()).set(d); this.diamond.unmap();
    this.resize(); new ResizeObserver(() => this.resize()).observe(this.cv); this.controls();
  }
  resize() { this.cv.width = Math.max(1, this.cv.clientWidth * this.dpr | 0);
    this.cv.height = Math.max(1, this.cv.clientHeight * this.dpr | 0); }

  style(color, size) { const b = this.dev.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.dev.queue.writeBuffer(b, 0, new Float32Array([color[0], color[1], color[2], color[3] ?? 1, size || 0, 0, 0, 0]));
    const bg = this.dev.createBindGroup({ layout: this.L1, entries: [{ binding: 0, resource: { buffer: b } }] });
    return bg; }

  setLine(id, pos, color, vis) {
    const b = this.dev.createBuffer({ size: Math.max(12, pos.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    if (pos.length) this.dev.queue.writeBuffer(b, 0, pos);
    this.lines.set(id, { buf: b, count: pos.length / 3, bg: this.style(color, 0), vis });
  }
  // markers rebuild cheaply each frame for the live feeds; reuse the buffer when the count holds.
  setMark(id, xyz, color, size, vis, pick) {
    const e = this.marks.get(id);
    if (e && e.count === xyz.length / 3) { if (xyz.length) this.dev.queue.writeBuffer(e.inst, 0, xyz); e.cpu = xyz; e.vis = vis; return; }
    e?.inst.destroy();
    const inst = this.dev.createBuffer({ size: Math.max(12, xyz.byteLength), usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    if (xyz.length) this.dev.queue.writeBuffer(inst, 0, xyz);
    this.marks.set(id, { inst, count: xyz.length / 3, cpu: xyz, bg: this.style(color, size * this.dpr), vis, pick });
  }
  setVisible(id, on) { const e = this.lines.get(id) || this.marks.get(id); if (e) e.vis = on; }

  frame() {
    const w = this.cv.width, h = this.cv.height;
    this.vp = this.cam.vp(w / h);
    const u = new Float32Array(20); u.set(this.vp, 0); u[16] = w; u[17] = h;
    this.dev.queue.writeBuffer(this.camBuf, 0, u);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.setBindGroup(0, this.cbg);
    pass.setPipeline(this.pLine);
    for (const l of this.lines.values()) if (l.vis && l.count) { pass.setBindGroup(1, l.bg); pass.setVertexBuffer(0, l.buf); pass.draw(l.count); }
    pass.setPipeline(this.pMark); pass.setVertexBuffer(0, this.diamond);
    for (const m of this.marks.values()) if (m.vis && m.count) { pass.setBindGroup(1, m.bg); pass.setVertexBuffer(1, m.inst); pass.draw(6, m.count); }
    pass.end(); this.dev.queue.submit([enc.finish()]);
  }
  // nearest visible, pickable marker within ~12px of the cursor, projected on the cpu.
  pick(cx, cy) {
    const w = this.cv.clientWidth, h = this.cv.clientHeight; let best = null;
    for (const [id, m] of this.marks) if (m.vis && m.pick) for (let i = 0; i < m.count; i++) {
      const o = i * 3, s = project(this.vp, m.cpu[o], m.cpu[o + 1], m.cpu[o + 2], w, h); if (!s) continue;
      const d = Math.hypot(s[0] - cx, s[1] - cy); if (d < 12 && (!best || d < best.d)) best = { id, i, d, x: s[0], y: s[1] };
    }
    return best;
  }
  // left-drag pans the ground, right/shift-drag orbits, wheel dollies.
  controls() {
    const cv = this.cv; let px = 0, py = 0, btn = -1;
    cv.oncontextmenu = (e) => e.preventDefault();
    cv.onpointerdown = (e) => { btn = e.shiftKey ? 2 : e.button; px = e.clientX; py = e.clientY; cv.setPointerCapture(e.pointerId); };
    cv.onpointerup = () => (btn = -1);
    cv.onpointermove = (e) => {
      if (btn < 0) return; const dx = e.clientX - px, dy = e.clientY - py; px = e.clientX; py = e.clientY; const c = this.cam;
      if (btn === 0) { const mpp = 2 * c.dist * Math.tan(c.fov * Math.PI / 360) / cv.clientHeight, a = c.az;
        c.target[0] -= (Math.cos(a) * dx + Math.sin(a) * dy) * mpp;
        c.target[1] -= (Math.sin(a) * dx - Math.cos(a) * dy) * mpp;
      } else { c.az -= dx * 0.004; c.pitch = Math.max(0.08, Math.min(1.45, c.pitch - dy * 0.004)); }
    };
    cv.onwheel = (e) => { e.preventDefault(); const c = this.cam,
      f = Math.max(200, Math.min(40000, c.dist * Math.exp(e.deltaY * 0.0012))) / c.dist,
      g = c.ground(e.clientX / cv.clientWidth * 2 - 1, 1 - e.clientY / cv.clientHeight * 2, cv.clientWidth / cv.clientHeight);
      c.target[0] += (1 - f) * (g[0] - c.target[0]); c.target[1] += (1 - f) * (g[1] - c.target[1]); c.dist *= f; };
  }
}
