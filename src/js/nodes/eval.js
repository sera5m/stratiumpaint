// Evaluate a node graph to float RGBA images in 0..1 (values may leave that range until Apply).
// Preview and full size share UV-space transforms, so a small preview matches the layer.
import { clamp } from '../core/util.js';
import { blendByMask, cropImage } from '../core/image.js';
import { maskBounds } from '../core/mask.js';
import { compileFormula, formulaEnv } from './formula.js';
import { socketsOf } from './types.js';

const formulaCache = new Map();

export function previewSize(doc, maxEdge = 192) {
  const m = Math.max(doc.width, doc.height, 1);
  const s = Math.min(1, maxEdge / m);
  return { width: Math.max(1, Math.round(doc.width * s)), height: Math.max(1, Math.round(doc.height * s)) };
}

export function makeContext(doc, width, height) {
  return {
    width, height,
    docWidth: doc?.width || width,
    docHeight: doc?.height || height,
    scale: doc?.width ? width / doc.width : 1,
    time: doc?.nodeGraph?.time || 0,
    doc,
  };
}

export function evaluateGraph(graph, ctx) {
  return evaluateScope(graph, ctx);
}

function evaluateScope(scope, ctx) {
  const errors = [];
  const values = new Map();
  if (!scope) return { values, errors };
  const order = topo(scope);
  const seen = new Set(order.map((n) => n.id));
  for (const n of scope.nodes || []) {
    if (n.type !== 'frame' && !seen.has(n.id)) errors.push({ id: n.id, error: 'Cycle' });
  }
  for (const node of order) {
    if (node.type === 'frame' || node.type === 'group_out') continue;
    const inputs = gather(scope, node, values);
    try {
      const out = node.muted && node.type !== 'group_in' ? passThrough(node, inputs) : evalNode(node, inputs, ctx);
      values.set(node.id, out || {});
    } catch (err) {
      errors.push({ id: node.id, error: err.message || String(err) });
      values.set(node.id, {});
    }
  }
  return { values, errors };
}

function topo(scope) {
  const nodes = (scope.nodes || []).filter((n) => n.type !== 'frame');
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const next = new Map(nodes.map((n) => [n.id, []]));
  for (const l of scope.links || []) {
    if (!indeg.has(l.from) || !indeg.has(l.to)) continue;
    next.get(l.from).push(l.to);
    indeg.set(l.to, indeg.get(l.to) + 1);
  }
  const q = nodes.filter((n) => indeg.get(n.id) === 0);
  const out = [];
  while (q.length) {
    const n = q.shift();
    out.push(n);
    for (const id of next.get(n.id)) {
      indeg.set(id, indeg.get(id) - 1);
      if (indeg.get(id) === 0) q.push(nodes.find((x) => x.id === id));
    }
  }
  return out;
}

function gather(scope, node, values) {
  const inputs = {};
  for (const l of scope.links || []) {
    if (l.to !== node.id) continue;
    inputs[l.in] = values.get(l.from)?.[l.out];
  }
  return inputs;
}

function passThrough(node, inputs) {
  const socks = socketsOf(node);
  const first = socks.inputs[0] ? inputs[socks.inputs[0].id] : null;
  const out = {};
  for (const s of socks.outputs) out[s.id] = first ?? zero(s.kind);
  return out;
}

function zero(kind) {
  if (kind === 'color') return { kind: 'color', r: 0, g: 0, b: 0, a: 1 };
  if (kind === 'vector') return { kind: 'vector', x: 0, y: 0, z: 0 };
  return { kind: 'value', v: 0 };
}

function evalNode(node, inputs, ctx) {
  const p = node.params || {};
  const w = ctx.width, h = ctx.height;
  switch (node.type) {
    case 'value': return { value: { kind: 'value', v: num(p.value) } };
    case 'rgb': return { color: colorOf(p.color) };
    case 'time': return { value: { kind: 'value', v: ctx.time || 0 } };
    case 'image': return { image: readLayer(ctx, p) };
    case 'texcoord': return texcoord(w, h);
    case 'viewer':
    case 'composite': return { image: inputs.image || colorOf(null) };
    case 'reroute': return { out: inputs.in ?? zero(p.kind || 'value') };
    case 'group_in': {
      const out = {};
      for (const s of p.sockets || []) out[s.id] = ctx.groupInputs?.[s.id] ?? zero(s.kind);
      return out;
    }
    case 'group': return evalGroup(node, inputs, ctx);
    case 'frame':
    case 'group_out': return {};
    case 'mix': return { color: mixNode(node, inputs, w, h) };
    case 'add': return { color: boolNode('add', inputs, w, h) };
    case 'sub': return { color: boolNode('sub', inputs, w, h) };
    case 'xor': return { color: boolNode('xor', inputs, w, h) };
    case 'intersect': return { color: boolNode('intersect', inputs, w, h) };
    case 'brightcontrast': return { color: colorMap(inputs.color, w, h, (c, i) => bright(c, pick(node, inputs, 'bright', i, p.bright), pick(node, inputs, 'contrast', i, p.contrast))) };
    case 'gamma': return { color: colorMap(inputs.color, w, h, (c, i) => gammaPx(c, pick(node, inputs, 'gamma', i, p.gamma || 1))) };
    case 'exposure': return { color: colorMap(inputs.color, w, h, (c, i) => scalePx(c, 2 ** pick(node, inputs, 'exposure', i, p.exposure || 0))) };
    case 'invert': return { color: colorMap(inputs.color || colorOf(null), w, h, (c, i) => invertPx(c, pick(node, inputs, 'fac', i, p.fac ?? 1))) };
    case 'hsv': return { color: hsvNode(node, inputs, w, h) };
    case 'alphaover': return { color: overNode(node, inputs, w, h) };
    case 'setalpha': return { color: alphaNode(node, inputs, w, h) };
    case 'separatecolor': return separateColor(inputs.color, p.mode, w, h);
    case 'combinecolor': return { color: combineColor(node, inputs, w, h) };
    case 'colorramp': return rampNode(inputs.fac, p.stops, w, h);
    case 'curves': return { color: colorMap(inputs.color, w, h, (c) => curvePx(c, p.curve)) };
    case 'colorbalance': return { color: colorMap(inputs.color, w, h, (c) => balancePx(c, p)) };
    case 'rgb2bw': return { value: bwNode(inputs.color, w, h) };
    case 'math': return { value: mathNode(node, inputs, w, h) };
    case 'maprange': return { value: mapRangeNode(node, inputs, w, h) };
    case 'clamp': return { value: clampNode(node, inputs, w, h) };
    case 'formula': return { value: formulaNode(node, inputs, ctx) };
    case 'switch': return { out: switchNode(node, inputs, w, h) };
    case 'compare': return { value: compareNode(node, inputs, w, h) };
    case 'separatexyz': return separateXYZ(inputs.vector, w, h);
    case 'combinexyz': return { vector: combineXYZ(node, inputs, w, h) };
    case 'vectormath': return vectorMath(node, inputs, w, h);
    case 'noise': return noiseNode(node, inputs, ctx);
    case 'voronoi': return voronoiNode(node, inputs, ctx);
    case 'wave': return waveNode(node, inputs, ctx);
    case 'checker': return checkerNode(node, inputs, ctx);
    case 'gradient': return gradientNode(node, inputs, ctx);
    case 'brick': return brickNode(node, inputs, ctx);
    case 'whitenoise': return whiteNode(node, inputs, ctx);
    case 'circle': return shapeNode(node, inputs, ctx, 'circle');
    case 'oval': return shapeNode(node, inputs, ctx, 'oval');
    case 'triangle': return shapeNode(node, inputs, ctx, 'triangle');
    case 'ngon': return shapeNode(node, inputs, ctx, 'ngon');
    case 'line': return shapeNode(node, inputs, ctx, 'line');
    case 'curve': return shapeNode(node, inputs, ctx, 'curve');
    case 'blur': return { image: blurImage(asImage(inputs.image, w, h), Math.round((p.radius || 0) * (ctx.scale || 1))) };
    case 'sharpen': return { image: sharpenImage(inputs.image, p, ctx) };
    case 'pixelate': return { image: pixelate(inputs.image, p.cells || 16, w, h) };
    case 'glare': return { image: glare(inputs.image, p, ctx) };
    case 'dilate': return { image: dilate(inputs.image, p, ctx) };
    case 'transform': return { image: transformImage(inputs.image, p, w, h) };
    case 'flip': return { image: flipImage(inputs.image, p, w, h) };
    case 'crop': return { image: cropNode(inputs.image, p, w, h) };
    case 'displace': return { image: displace(inputs, p, w, h) };
    case 'boxmask': return { mask: maskImage(w, h, (u, v) => boxMask(u, v, p)) };
    case 'ellipsemask': return { mask: maskImage(w, h, (u, v) => ellipseMask(u, v, p)) };
    case 'chromakey': return keyNode(inputs.image, w, h, (c) => chroma(c, p));
    case 'lumakey': return keyNode(inputs.image, w, h, (c) => lumaKey(c, p));
    default: return {};
  }
}

function evalGroup(node, inputs, ctx) {
  const inner = node.params?.graph;
  if (!inner) return {};
  const sub = evaluateScope(inner, { ...ctx, groupInputs: inputs });
  const gout = inner.nodes.find((n) => n.type === 'group_out');
  const out = {};
  for (const s of gout?.params?.sockets || []) {
    const link = inner.links.find((l) => l.to === gout.id && l.in === s.id);
    out[s.id] = link ? sub.values.get(link.from)?.[link.out] : zero(s.kind);
  }
  return out;
}

function num(v) { const n = +v; return Number.isFinite(n) ? n : 0; }

function colorOf(c) {
  if (!c) return { kind: 'color', r: 0, g: 0, b: 0, a: 1 };
  if (c.kind === 'color') return c;
  return { kind: 'color', r: num(c.r), g: num(c.g), b: num(c.b), a: c.a == null ? 1 : num(c.a) };
}

function numAt(v, i) {
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (v.kind === 'value') return v.v;
  if (v.kind === 'color') return (v.r + v.g + v.b) / 3;
  if (v.kind === 'vector') return v.x;
  if (v.kind === 'image') return v.data[i * 4] || 0;
  return 0;
}

function pxAt(v, i) {
  if (!v) return [0, 0, 0, 0];
  if (v.kind === 'image') { const o = i * 4; return [v.data[o], v.data[o + 1], v.data[o + 2], v.data[o + 3]]; }
  if (v.kind === 'color') return [v.r, v.g, v.b, v.a];
  if (v.kind === 'vector') return [v.x, v.y, v.z, 1];
  const n = v.kind === 'value' ? v.v : 0;
  return [n, n, n, 1];
}

function pick(node, inputs, key, i, fallback) {
  return inputs[key] != null ? numAt(inputs[key], i) : num(fallback);
}

export function asImage(v, w, h) {
  if (v?.kind === 'image' && v.width === w && v.height === h) return v;
  if (v?.kind === 'image') return resizeImage(v, w, h);
  const data = new Float32Array(w * h * 4);
  const px = pxAt(v, 0);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    data[o] = px[0]; data[o + 1] = px[1]; data[o + 2] = px[2]; data[o + 3] = px[3];
  }
  return { kind: 'image', width: w, height: h, data };
}

function resizeImage(src, w, h) {
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / w));
      const s = (sy * src.width + sx) * 4;
      const d = (y * w + x) * 4;
      data[d] = src.data[s]; data[d + 1] = src.data[s + 1]; data[d + 2] = src.data[s + 2]; data[d + 3] = src.data[s + 3];
    }
  }
  return { kind: 'image', width: w, height: h, data };
}

function imageOf(w, h, fn) {
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const px = fn(u, v, x, y);
      const o = (y * w + x) * 4;
      data[o] = px[0]; data[o + 1] = px[1]; data[o + 2] = px[2]; data[o + 3] = px[3];
    }
  }
  return { kind: 'image', width: w, height: h, data };
}

function varying(...vals) { return vals.some((v) => v?.kind === 'image'); }

function colorMap(v, w, h, fn) {
  if (!varying(v)) {
    const c = fn(pxAt(v, 0), 0);
    return { kind: 'color', r: c[0], g: c[1], b: c[2], a: c[3] };
  }
  const src = asImage(v, w, h);
  return imageOf(w, h, (_u, _v, x, y) => fn(pxAt(src, y * w + x), y * w + x));
}

function eachValue(inputs, w, h, fn) {
  const vals = Object.values(inputs);
  if (!vals.some((v) => v?.kind === 'image')) return { kind: 'value', v: fn(0) };
  const data = new Float32Array(w * h * 4);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const r = fn(i);
    const o = i * 4;
    data[o] = data[o + 1] = data[o + 2] = r;
    data[o + 3] = 1;
  }
  return { kind: 'image', width: w, height: h, data };
}

function readLayer(ctx, p) {
  const doc = ctx.doc;
  const layers = doc?.layers || [];
  let layer = doc?.layer;
  if (p.source === 'index') layer = layers[Math.max(0, Math.min(layers.length - 1, p.index | 0))] || layer;
  if (!layer?.img) return asImage(null, ctx.width, ctx.height);
  const src = layer.img;
  const data = new Float32Array(ctx.width * ctx.height * 4);
  for (let y = 0; y < ctx.height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(((y + 0.5) * src.height) / ctx.height));
    for (let x = 0; x < ctx.width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(((x + 0.5) * src.width) / ctx.width));
      const s = (sy * src.width + sx) * 4;
      const d = (y * ctx.width + x) * 4;
      data[d] = src.data[s] / 255; data[d + 1] = src.data[s + 1] / 255;
      data[d + 2] = src.data[s + 2] / 255; data[d + 3] = src.data[s + 3] / 255;
    }
  }
  return { kind: 'image', width: ctx.width, height: ctx.height, data };
}

function texcoord(w, h) {
  const uv = imageOf(w, h, (u, v) => [u, v, 0, 1]);
  const U = imageOf(w, h, (u) => [u, u, u, 1]);
  const V = imageOf(w, h, (_u, v) => [v, v, v, 1]);
  return { uv, u: U, v: V };
}

function uvOf(inputs, u, v, i) {
  if (inputs.vector?.kind === 'image') {
    const o = i * 4;
    return [inputs.vector.data[o], inputs.vector.data[o + 1]];
  }
  if (inputs.vector?.kind === 'vector') return [inputs.vector.x, inputs.vector.y];
  return [u, v];
}

const MATH = {
  add: (a, b) => a + b,
  subtract: (a, b) => a - b,
  multiply: (a, b) => a * b,
  divide: (a, b) => (b ? a / b : 0),
  power: (a, b) => (a < 0 && b % 1 ? 0 : a ** b),
  log: (a) => (a > 0 ? Math.log(a) : 0),
  sqrt: (a) => (a > 0 ? Math.sqrt(a) : 0),
  abs: (a) => Math.abs(a),
  min: (a, b) => Math.min(a, b),
  max: (a, b) => Math.max(a, b),
  round: (a) => Math.round(a),
  floor: (a) => Math.floor(a),
  ceil: (a) => Math.ceil(a),
  fract: (a) => a - Math.floor(a),
  modulo: (a, b) => (b ? a - b * Math.floor(a / b) : 0),
  snap: (a, b) => (b ? Math.round(a / b) * b : a),
  pingpong: (a, b) => {
    if (!b) return 0;
    const t = ((a % (b * 2)) + b * 2) % (b * 2);
    return t <= b ? t : b * 2 - t;
  },
  sin: (a) => Math.sin(a),
  cos: (a) => Math.cos(a),
  tan: (a) => Math.tan(a),
  asin: (a) => Math.asin(clamp(a, -1, 1)),
  acos: (a) => Math.acos(clamp(a, -1, 1)),
  atan: (a) => Math.atan(a),
  atan2: (a, b) => Math.atan2(a, b),
  sinh: (a) => Math.sinh(a),
  sign: (a) => Math.sign(a),
  smoothmin: (a, b, c) => {
    const k = Math.max(1e-4, c || 0.1);
    const h = clamp(0.5 + (0.5 * (b - a)) / k, 0, 1);
    return a * (1 - h) + b * h - k * h * (1 - h);
  },
  clamp: (a, b, c) => clamp(a, b, c == null ? 1 : c),
  compare: (a, b) => (a < b ? 1 : 0),
};

function mathNode(node, inputs, w, h) {
  const fn = MATH[node.params?.op] || MATH.add;
  return eachValue(inputs, w, h, (i) => fn(numAt(inputs.a, i), numAt(inputs.b, i), numAt(inputs.c, i)));
}

function mapRangeNode(node, inputs, w, h) {
  const p = node.params || {};
  return eachValue({ value: inputs.value }, w, h, (i) => {
    const t = (numAt(inputs.value, i) - num(p.fromMin)) / (num(p.fromMax) - num(p.fromMin) || 1);
    const u = p.clamp ? clamp(t, 0, 1) : t;
    return num(p.toMin) + u * (num(p.toMax) - num(p.toMin));
  });
}

function clampNode(node, inputs, w, h) {
  const p = node.params || {};
  return eachValue({ value: inputs.value }, w, h, (i) => clamp(numAt(inputs.value, i), num(p.min), num(p.max)));
}

function compareNode(node, inputs, w, h) {
  const op = node.params?.op || 'greater';
  const eps = num(node.params?.epsilon ?? 0.001);
  return eachValue(inputs, w, h, (i) => {
    const a = numAt(inputs.a, i), b = numAt(inputs.b, i);
    if (op === 'less') return a < b ? 1 : 0;
    if (op === 'equal') return Math.abs(a - b) <= eps ? 1 : 0;
    if (op === 'notequal') return Math.abs(a - b) > eps ? 1 : 0;
    return a > b ? 1 : 0;
  });
}

function switchNode(node, inputs, w, h) {
  const fac = (i) => (inputs.fac != null ? numAt(inputs.fac, i) : num(node.params?.fac));
  if (!varying(inputs.fac, inputs.a, inputs.b)) return fac(0) >= 0.5 ? (inputs.b ?? inputs.a ?? zero('color')) : (inputs.a ?? zero('color'));
  return imageOf(w, h, (_u, _v, x, y) => pxAt(fac(y * w + x) >= 0.5 ? inputs.b : inputs.a, y * w + x));
}

function formulaNode(node, inputs, ctx) {
  const latex = node.params?.latex || '0';
  let compiled = formulaCache.get(latex);
  if (!compiled) {
    compiled = compileFormula(latex);
    formulaCache.set(latex, compiled);
  }
  const { width: w, height: h } = ctx;
  const pixels = !!node.params?.pixels;
  return imageOf(w, h, (u, v, x, y) => {
    const i = y * w + x;
    const a = pxAt(inputs.a, i);
    const docX = u * ctx.docWidth;
    const docY = v * ctx.docHeight;
    const env = formulaEnv({
      u: pixels ? docX : u, v: pixels ? docY : v,
      x: docX, y: docY,
      r: a[0], g: a[1], b: a[2], a: a[3],
      A: numAt(inputs.a, i), B: numAt(inputs.b, i), C: numAt(inputs.c, i),
      t: ctx.time || 0, W: ctx.docWidth, H: ctx.docHeight,
    });
    const n = compiled.fn(env);
    const r = Number.isFinite(n) ? n : 0;
    return [r, r, r, 1];
  });
}

function mixChannels(mode, a, b) {
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const x = a[c], y = b[c];
    switch (mode) {
      case 'add': out[c] = x + y; break;
      case 'subtract': out[c] = x - y; break;
      case 'multiply': out[c] = x * y; break;
      case 'screen': out[c] = 1 - (1 - x) * (1 - y); break;
      case 'overlay': out[c] = x < 0.5 ? 2 * x * y : 1 - 2 * (1 - x) * (1 - y); break;
      case 'darken': out[c] = Math.min(x, y); break;
      case 'lighten': out[c] = Math.max(x, y); break;
      case 'difference': out[c] = Math.abs(x - y); break;
      case 'divide': out[c] = y ? x / y : 0; break;
      default: out[c] = y; break;
    }
  }
  if (mode === 'hue' || mode === 'saturation' || mode === 'color' || mode === 'luminosity') {
    const A = rgbToHsv(a[0], a[1], a[2]);
    const B = rgbToHsv(b[0], b[1], b[2]);
    let h = A, s = A, v = A;
    if (mode === 'hue') h = B;
    else if (mode === 'saturation') s = B;
    else if (mode === 'color') { h = B; s = B; }
    else v = B;
    const rgb = hsvToRgb(mode === 'hue' || mode === 'color' ? B[0] : A[0], mode === 'saturation' || mode === 'color' ? B[1] : A[1], mode === 'luminosity' ? B[2] : A[2]);
    void h; void s; void v;
    return rgb;
  }
  return out;
}

function mixNode(node, inputs, w, h) {
  const mode = node.params?.mode || 'mix';
  const img = varying(inputs.fac, inputs.a, inputs.b);
  const once = (i) => {
    const fac = clamp(inputs.fac != null ? numAt(inputs.fac, i) : num(node.params?.fac ?? 1), 0, 1);
    const A = pxAt(inputs.a, i);
    const B = pxAt(inputs.b, i);
    const mixed = mode === 'mix' ? B : mixChannels(mode, A, B);
    return [
      A[0] + (mixed[0] - A[0]) * fac,
      A[1] + (mixed[1] - A[1]) * fac,
      A[2] + (mixed[2] - A[2]) * fac,
      A[3] + (B[3] - A[3]) * fac,
    ];
  };
  if (!img) {
    const c = once(0);
    return { kind: 'color', r: c[0], g: c[1], b: c[2], a: c[3] };
  }
  return imageOf(w, h, (_u, _v, x, y) => once(y * w + x));
}

function bright(c, br, ct) {
  const f = (x) => (x - 0.5) * (1 + ct) + 0.5 + br;
  return [f(c[0]), f(c[1]), f(c[2]), c[3]];
}
function gammaPx(c, g) {
  const e = g ? 1 / g : 1;
  const f = (x) => (x <= 0 ? 0 : x ** e);
  return [f(c[0]), f(c[1]), f(c[2]), c[3]];
}
function scalePx(c, s) { return [c[0] * s, c[1] * s, c[2] * s, c[3]]; }
function invertPx(c, fac) {
  const f = (x) => x + (1 - x - x) * fac;
  return [f(c[0]), f(c[1]), f(c[2]), c[3]];
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max ? d / max : 0, max];
}
function hsvToRgb(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const H = h * 6;
  const c = v * s, x = c * (1 - Math.abs((H % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (H < 1) [r, g, b] = [c, x, 0];
  else if (H < 2) [r, g, b] = [x, c, 0];
  else if (H < 3) [r, g, b] = [0, c, x];
  else if (H < 4) [r, g, b] = [0, x, c];
  else if (H < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [r + m, g + m, b + m];
}

function hsvNode(node, inputs, w, h) {
  const p = node.params || {};
  return colorMap(inputs.color, w, h, (c, i) => {
    const hsv = rgbToHsv(c[0], c[1], c[2]);
    const hue = (hsv[0] + pick(node, inputs, 'hue', i, p.hue ?? 0.5) - 0.5);
    const sat = clamp(hsv[1] * pick(node, inputs, 'sat', i, p.sat ?? 1), 0, 4);
    const val = Math.max(0, hsv[2] * pick(node, inputs, 'val', i, p.val ?? 1));
    const rgb = hsvToRgb(hue, clamp(sat, 0, 1), val);
    return [rgb[0], rgb[1], rgb[2], c[3]];
  });
}

function overNode(node, inputs, w, h) {
  const once = (i) => {
    const fac = clamp(inputs.fac != null ? numAt(inputs.fac, i) : num(node.params?.fac ?? 1), 0, 1);
    const bg = pxAt(inputs.bg, i);
    const fg = pxAt(inputs.fg, i);
    const fa = fg[3] * fac;
    const oa = fa + bg[3] * (1 - fa);
    if (oa <= 0) return [0, 0, 0, 0];
    return [
      (fg[0] * fa + bg[0] * bg[3] * (1 - fa)) / oa,
      (fg[1] * fa + bg[1] * bg[3] * (1 - fa)) / oa,
      (fg[2] * fa + bg[2] * bg[3] * (1 - fa)) / oa,
      oa,
    ];
  };
  if (!varying(inputs.fac, inputs.bg, inputs.fg)) {
    const c = once(0);
    return { kind: 'color', r: c[0], g: c[1], b: c[2], a: c[3] };
  }
  return imageOf(w, h, (_u, _v, x, y) => once(y * w + x));
}

function alphaNode(node, inputs, w, h) {
  return colorMap(inputs.color, w, h, (c, i) => [c[0], c[1], c[2], clamp(pick(node, inputs, 'alpha', i, node.params?.alpha ?? 1), 0, 1)]);
}

function channelImage(v, c, w, h) {
  if (v?.kind !== 'image') return { kind: 'value', v: pxAt(v, 0)[c] ?? 0 };
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const n = v.data[i * 4 + c];
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = n;
    data[i * 4 + 3] = 1;
  }
  return { kind: 'image', width: w, height: h, data };
}

function separateColor(v, mode, w, h) {
  if (mode === 'hsv') {
    if (v?.kind !== 'image') {
      const c = pxAt(v, 0);
      const hsv = rgbToHsv(c[0], c[1], c[2]);
      return { r: { kind: 'value', v: hsv[0] }, g: { kind: 'value', v: hsv[1] }, b: { kind: 'value', v: hsv[2] }, a: { kind: 'value', v: c[3] } };
    }
    const src = asImage(v, w, h);
    const pack = (idx) => imageOf(w, h, (_u, _v, x, y) => {
      const c = pxAt(src, y * w + x);
      const hsv = rgbToHsv(c[0], c[1], c[2]);
      const n = idx === 3 ? c[3] : hsv[idx];
      return [n, n, n, 1];
    });
    return { r: pack(0), g: pack(1), b: pack(2), a: pack(3) };
  }
  return { r: channelImage(v, 0, w, h), g: channelImage(v, 1, w, h), b: channelImage(v, 2, w, h), a: channelImage(v, 3, w, h) };
}

function combineColor(node, inputs, w, h) {
  const p = node.params || {};
  const once = (i) => {
    const r = inputs.r != null ? numAt(inputs.r, i) : 0;
    const g = inputs.g != null ? numAt(inputs.g, i) : 0;
    const b = inputs.b != null ? numAt(inputs.b, i) : 0;
    const a = inputs.a != null ? numAt(inputs.a, i) : num(p.a ?? 1);
    if (p.mode === 'hsv') {
      const rgb = hsvToRgb(r, clamp(g, 0, 1), Math.max(0, b));
      return [rgb[0], rgb[1], rgb[2], a];
    }
    return [r, g, b, a];
  };
  if (!varying(inputs.r, inputs.g, inputs.b, inputs.a)) {
    const c = once(0);
    return { kind: 'color', r: c[0], g: c[1], b: c[2], a: c[3] };
  }
  return imageOf(w, h, (_u, _v, x, y) => once(y * w + x));
}

function parseColorToken(text) {
  const t = text.trim();
  if (t.startsWith('#')) {
    const h = t.slice(1);
    const n = parseInt(h.length === 3 ? [...h].map((c) => c + c).join('') : h, 16);
    if (!Number.isFinite(n)) return null;
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 };
  }
  const parts = t.split(',').map((x) => Number(x.trim()));
  if (parts.length >= 3 && parts.every((x) => Number.isFinite(x))) {
    const scale = parts[0] > 1 || parts[1] > 1 || parts[2] > 1 ? 255 : 1;
    return { r: parts[0] / scale, g: parts[1] / scale, b: parts[2] / scale, a: parts[3] == null ? 1 : parts[3] };
  }
  return null;
}

function parseRamp(text) {
  const stops = [];
  for (const part of String(text || '').split(/[;\n]+/)) {
    const bit = part.trim();
    if (!bit) continue;
    const m = bit.match(/^(-?\d*\.?\d+)\s+(.+)$/);
    if (!m) continue;
    const col = parseColorToken(m[2].replace(/,$/, ''));
    if (col) stops.push({ t: Number(m[1]), ...col });
  }
  if (!stops.length) stops.push({ t: 0, r: 0, g: 0, b: 0, a: 1 }, { t: 1, r: 1, g: 1, b: 1, a: 1 });
  stops.sort((a, b) => a.t - b.t);
  return stops;
}

function sampleRamp(stops, t) {
  if (t <= stops[0].t) return stops[0];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const a = stops[i - 1], b = stops[i];
      const u = (t - a.t) / ((b.t - a.t) || 1);
      return { r: a.r + (b.r - a.r) * u, g: a.g + (b.g - a.g) * u, b: a.b + (b.b - a.b) * u, a: a.a + (b.a - a.a) * u };
    }
  }
  return stops[stops.length - 1];
}

function rampNode(fac, text, w, h) {
  const stops = parseRamp(text);
  const color = (i) => {
    const s = sampleRamp(stops, numAt(fac, i));
    return [s.r, s.g, s.b, s.a];
  };
  if (fac?.kind !== 'image') {
    const c = color(0);
    const alpha = c[3];
    return { color: { kind: 'color', r: c[0], g: c[1], b: c[2], a: c[3] }, alpha: { kind: 'value', v: alpha } };
  }
  const img = imageOf(w, h, (_u, _v, x, y) => color(y * w + x));
  return { color: img, alpha: channelImage(img, 3, w, h) };
}

function parseCurve(text) {
  const pts = [];
  for (const m of String(text || '').matchAll(/(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)/g)) pts.push({ x: Number(m[1]), y: Number(m[2]) });
  if (pts.length < 2) return [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  pts.sort((a, b) => a.x - b.x);
  return pts;
}
function evalCurve(pts, x) {
  if (x <= pts[0].x) return pts[0].y;
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i].x) {
      const a = pts[i - 1], b = pts[i];
      const u = (x - a.x) / ((b.x - a.x) || 1);
      return a.y + (b.y - a.y) * u;
    }
  }
  return pts[pts.length - 1].y;
}
function curvePx(c, text) {
  const pts = parseCurve(text);
  return [evalCurve(pts, c[0]), evalCurve(pts, c[1]), evalCurve(pts, c[2]), c[3]];
}
function balancePx(c, p) {
  const lift = num(p.lift), gamma = num(p.gamma || 1), gain = num(p.gain ?? 1);
  const f = (x) => {
    const y = Math.max(0, x * gain + lift);
    return gamma ? y ** (1 / gamma) : y;
  };
  return [f(c[0]), f(c[1]), f(c[2]), c[3]];
}
function bwNode(v, w, h) {
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  if (v?.kind !== 'image') return { kind: 'value', v: luma(pxAt(v, 0)) };
  return channelLike(asImage(v, w, h), (c) => luma(c));
}
function channelLike(src, fn) {
  const data = new Float32Array(src.width * src.height * 4);
  for (let i = 0; i < src.width * src.height; i++) {
    const n = fn(pxAt(src, i));
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = n;
    data[i * 4 + 3] = 1;
  }
  return { kind: 'image', width: src.width, height: src.height, data };
}

function separateXYZ(v, w, h) {
  return { x: channelImage(vectorAsColor(v, w, h), 0, w, h), y: channelImage(vectorAsColor(v, w, h), 1, w, h), z: channelImage(vectorAsColor(v, w, h), 2, w, h) };
}
function vectorAsColor(v, w, h) {
  if (v?.kind === 'image') return v;
  if (v?.kind === 'vector') return { kind: 'color', r: v.x, g: v.y, b: v.z, a: 1 };
  if (v?.kind === 'color') return v;
  return v?.kind === 'image' ? v : { kind: 'color', r: numAt(v, 0), g: numAt(v, 0), b: numAt(v, 0), a: 1 };
}
function combineXYZ(node, inputs, w, h) {
  const p = node.params || {};
  const once = (i) => [
    inputs.x != null ? numAt(inputs.x, i) : num(p.x),
    inputs.y != null ? numAt(inputs.y, i) : num(p.y),
    inputs.z != null ? numAt(inputs.z, i) : num(p.z),
  ];
  if (!varying(inputs.x, inputs.y, inputs.z)) {
    const c = once(0);
    return { kind: 'vector', x: c[0], y: c[1], z: c[2] };
  }
  return imageOf(w, h, (_u, _v, x, y) => { const c = once(y * w + x); return [c[0], c[1], c[2], 1]; });
}
function vectorMath(node, inputs, w, h) {
  const op = node.params?.op || 'add';
  const once = (i) => {
    const a = pxAt(inputs.a, i);
    const b = pxAt(inputs.b, i);
    const s = inputs.scale != null ? numAt(inputs.scale, i) : 1;
    if (op === 'dot') return { vec: null, value: a[0] * b[0] + a[1] * b[1] + a[2] * b[2] };
    if (op === 'length') return { vec: null, value: Math.hypot(a[0], a[1], a[2]) };
    let x = 0, y = 0, z = 0;
    if (op === 'subtract') { x = a[0] - b[0]; y = a[1] - b[1]; z = a[2] - b[2]; }
    else if (op === 'multiply') { x = a[0] * b[0]; y = a[1] * b[1]; z = a[2] * b[2]; }
    else if (op === 'divide') { x = b[0] ? a[0] / b[0] : 0; y = b[1] ? a[1] / b[1] : 0; z = b[2] ? a[2] / b[2] : 0; }
    else if (op === 'cross') { x = a[1] * b[2] - a[2] * b[1]; y = a[2] * b[0] - a[0] * b[2]; z = a[0] * b[1] - a[1] * b[0]; }
    else if (op === 'scale') { x = a[0] * s; y = a[1] * s; z = a[2] * s; }
    else if (op === 'normalize') { const l = Math.hypot(a[0], a[1], a[2]) || 1; x = a[0] / l; y = a[1] / l; z = a[2] / l; }
    else { x = a[0] + b[0]; y = a[1] + b[1]; z = a[2] + b[2]; }
    return { vec: [x, y, z], value: Math.hypot(x, y, z) };
  };
  if (!varying(inputs.a, inputs.b, inputs.scale)) {
    const r = once(0);
    return {
      vector: r.vec ? { kind: 'vector', x: r.vec[0], y: r.vec[1], z: r.vec[2] } : { kind: 'vector', x: 0, y: 0, z: 0 },
      value: { kind: 'value', v: r.value },
    };
  }
  const vector = imageOf(w, h, (_u, _v, x, y) => {
    const r = once(y * w + x);
    return r.vec ? [r.vec[0], r.vec[1], r.vec[2], 1] : [r.value, r.value, r.value, 1];
  });
  const value = channelLike(vector, (c) => (op === 'dot' || op === 'length' ? c[0] : Math.hypot(c[0], c[1], c[2])));
  return { vector, value };
}

function hash(ix, iy, seed) {
  let n = (ix | 0) * 374761393 + (iy | 0) * 668265263 + (seed | 0) * 1442695041;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
function valueNoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
function fbm(x, y, seed, octaves) {
  let a = 0, amp = 0.5, f = 1, sum = 0;
  const n = clamp(octaves | 0, 1, 8);
  for (let i = 0; i < n; i++) {
    a += valueNoise(x * f, y * f, seed + i * 19) * amp;
    sum += amp; amp *= 0.5; f *= 2;
  }
  return a / sum;
}

function noiseNode(node, inputs, ctx) {
  const p = node.params || {};
  const fac = imageOf(ctx.width, ctx.height, (u, v, x, y) => {
    const uv = uvOf(inputs, u, v, y * ctx.width + x);
    const scale = inputs.scale != null ? numAt(inputs.scale, y * ctx.width + x) : num(p.scale || 5);
    const n = fbm(uv[0] * scale, uv[1] * scale, num(p.seed), num(p.detail || 4));
    return [n, n, n, 1];
  });
  return { color: fac, fac };
}
function voronoiNode(node, inputs, ctx) {
  const p = node.params || {};
  const color = imageOf(ctx.width, ctx.height, (u, v, x, y) => {
    const uv = uvOf(inputs, u, v, y * ctx.width + x);
    const scale = Math.max(0.01, num(p.scale || 5));
    const cx = uv[0] * scale, cy = uv[1] * scale;
    const ix = Math.floor(cx), iy = Math.floor(cy);
    let best = 8, id = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const jx = hash(ix + ox, iy + oy, num(p.seed));
        const jy = hash(ix + ox, iy + oy, num(p.seed) + 101);
        const px = ix + ox + jx, py = iy + oy + jy;
        const d = Math.hypot(cx - px, cy - py);
        if (d < best) { best = d; id = hash(ix + ox + 3, iy + oy + 5, num(p.seed) + 7); }
      }
    }
    return [id, id, id, 1];
  });
  const distance = imageOf(ctx.width, ctx.height, (u, v, x, y) => {
    const uv = uvOf(inputs, u, v, y * ctx.width + x);
    const scale = Math.max(0.01, num(p.scale || 5));
    const cx = uv[0] * scale, cy = uv[1] * scale;
    const ix = Math.floor(cx), iy = Math.floor(cy);
    let best = 8;
    for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
      const px = ix + ox + hash(ix + ox, iy + oy, num(p.seed));
      const py = iy + oy + hash(ix + ox, iy + oy, num(p.seed) + 101);
      best = Math.min(best, Math.hypot(cx - px, cy - py));
    }
    return [best, best, best, 1];
  });
  return { distance, color };
}
function waveNode(node, inputs, ctx) {
  const p = node.params || {};
  const fac = imageOf(ctx.width, ctx.height, (u, v, x, y) => {
    const uv = uvOf(inputs, u, v, y * ctx.width + x);
    const scale = num(p.scale || 8);
    const phase = num(p.phase);
    const t = p.kind === 'rings'
      ? Math.hypot(uv[0] - 0.5, uv[1] - 0.5) * scale
      : uv[0] * scale;
    const n = 0.5 + 0.5 * Math.sin((t + phase) * Math.PI * 2);
    return [n, n, n, 1];
  });
  return { color: fac, fac };
}
function checkerNode(node, inputs, ctx) {
  const p = node.params || {};
  const c1 = colorOf(p.color1), c2 = colorOf(p.color2);
  const fac = imageOf(ctx.width, ctx.height, (u, v, x, y) => {
    const i = y * ctx.width + x;
    const uv = uvOf(inputs, u, v, i);
    const scale = Math.max(0.0001, num(p.scale || 8));
    const on = (Math.floor(uv[0] * scale) + Math.floor(uv[1] * scale)) & 1;
    const A = inputs.color1 ? pxAt(inputs.color1, i) : [c1.r, c1.g, c1.b, c1.a];
    const B = inputs.color2 ? pxAt(inputs.color2, i) : [c2.r, c2.g, c2.b, c2.a];
    return on ? B : A;
  });
  const mask = channelLike(fac, (c) => (c[0] + c[1] + c[2]) / 3);
  return { color: fac, fac: mask };
}
function gradientNode(node, inputs, ctx) {
  const p = node.params || {};
  const kind = p.kind || 'linear';
  const w = ctx.width, h = ctx.height;
  const c1 = colorOf(p.color1 || { r: 0, g: 0, b: 0, a: 1 });
  const c2 = colorOf(p.color2 || { r: 1, g: 1, b: 1, a: 1 });
  const color = new Float32Array(w * h * 4);
  const fac = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const i = y * w + x;
      const uv = uvOf(inputs, u, v, i);
      const start = vec2At(inputs.start, i, kind === 'radial' ? [0.5, 0.5] : (kind === 'diagonal' ? [0, 0] : [0, 0.5]));
      const end = vec2At(inputs.end, i, kind === 'radial' ? [1, 0.5] : (kind === 'diagonal' ? [1, 1] : [1, 0.5]));
      let n;
      if (kind === 'radial') {
        const rad = Math.hypot(end[0] - start[0], end[1] - start[1]) || 1;
        n = clamp(Math.hypot(uv[0] - start[0], uv[1] - start[1]) / rad, 0, 1);
      } else n = projectUv(uv, start, end);
      const A = inputs.color1 ? pxAt(inputs.color1, i) : [c1.r, c1.g, c1.b, c1.a];
      const B = inputs.color2 ? pxAt(inputs.color2, i) : [c2.r, c2.g, c2.b, c2.a];
      const o = i * 4;
      color[o] = A[0] + (B[0] - A[0]) * n;
      color[o + 1] = A[1] + (B[1] - A[1]) * n;
      color[o + 2] = A[2] + (B[2] - A[2]) * n;
      color[o + 3] = A[3] + (B[3] - A[3]) * n;
      fac[o] = fac[o + 1] = fac[o + 2] = n;
      fac[o + 3] = 1;
    }
  }
  return {
    color: { kind: 'image', width: w, height: h, data: color },
    fac: { kind: 'image', width: w, height: h, data: fac },
  };
}

function vec2At(v, i, fallback) {
  if (v == null) return fallback;
  const p = pxAt(v, i);
  return [p[0], p[1]];
}

function projectUv(uv, start, end) {
  const dx = end[0] - start[0], dy = end[1] - start[1];
  const l2 = dx * dx + dy * dy || 1;
  return clamp(((uv[0] - start[0]) * dx + (uv[1] - start[1]) * dy) / l2, 0, 1);
}

function boolNode(mode, inputs, w, h) {
  const once = (i) => boolPx(mode, pxAt(inputs.a, i), pxAt(inputs.b, i));
  if (!varying(inputs.a, inputs.b)) {
    const c = once(0);
    return { kind: 'color', r: c[0], g: c[1], b: c[2], a: c[3] };
  }
  return imageOf(w, h, (_u, _v, x, y) => once(y * w + x));
}

function boolPx(mode, a, b) {
  if (a[3] < 0.999 || b[3] < 0.999) {
    const aA = clamp(a[3], 0, 1), bA = clamp(b[3], 0, 1);
    let outA = 0, t = 0;
    if (mode === 'add') {
      outA = aA + bA * (1 - aA);
      t = outA ? (bA * (1 - aA)) / outA : 0;
    } else if (mode === 'sub') outA = aA * (1 - bA);
    else if (mode === 'xor') {
      const left = aA * (1 - bA), right = bA * (1 - aA);
      outA = left + right;
      t = outA ? right / outA : 0;
    } else {
      outA = aA * bA;
      t = 0.5;
    }
    const mix = (k) => a[k] * (1 - t) + b[k] * t;
    return [mix(0), mix(1), mix(2), outA];
  }
  const ch = (x, y) => {
    if (mode === 'add') return clamp(x + y, 0, 1);
    if (mode === 'sub') return clamp(x - y, 0, 1);
    if (mode === 'xor') return Math.abs(x - y);
    return Math.min(x, y);
  };
  return [ch(a[0], b[0]), ch(a[1], b[1]), ch(a[2], b[2]), ch(a[3], b[3])];
}

function shapeNode(node, inputs, ctx, kind) {
  const p = node.params || {};
  const w = ctx.width, h = ctx.height;
  const minSide = Math.min(w, h);
  const bw = Math.max(0, num(p.border)) * minSide;
  let distAt = (u, v) => 1;
  if (kind === 'circle') {
    const cx = num(p.x) * w, cy = num(p.y) * h, rad = Math.max(0, num(p.radius)) * minSide;
    distAt = (u, v) => Math.hypot(u * w - cx, v * h - cy) - rad;
  } else if (kind === 'oval') {
    const cx = num(p.x) * w, cy = num(p.y) * h;
    const rx = Math.max(0.0001, num(p.rx)) * w, ry = Math.max(0.0001, num(p.ry)) * h;
    distAt = (u, v) => (Math.hypot((u * w - cx) / rx, (v * h - cy) / ry) - 1) * Math.min(rx, ry);
  } else if (kind === 'triangle') {
    const ax = num(p.x1) * w, ay = num(p.y1) * h;
    const bx = num(p.x2) * w, by = num(p.y2) * h;
    const cx = num(p.x3) * w, cy = num(p.y3) * h;
    distAt = (u, v) => sdTriangle(u * w, v * h, ax, ay, bx, by, cx, cy);
  } else if (kind === 'ngon') {
    const cx = num(p.x) * w, cy = num(p.y) * h;
    const rad = Math.max(0, num(p.radius)) * minSide;
    const sides = Math.max(3, Math.min(32, Math.round(num(p.sides || 6))));
    const rot = num(p.angle) * Math.PI / 180;
    distAt = (u, v) => sdNgon(u * w - cx, v * h - cy, rad, sides, rot);
  } else if (kind === 'line') {
    const ax = num(p.x1) * w, ay = num(p.y1) * h, bx = num(p.x2) * w, by = num(p.y2) * h;
    const half = Math.max(0, num(p.width)) * minSide * 0.5;
    distAt = (u, v) => distSeg(u * w, v * h, ax, ay, bx, by) - half;
  } else if (kind === 'curve') {
    const pts = quadPoints(num(p.x1) * w, num(p.y1) * h, num(p.cx) * w, num(p.cy) * h, num(p.x2) * w, num(p.y2) * h, 32);
    const half = Math.max(0, num(p.width)) * minSide * 0.5;
    distAt = (u, v) => {
      const px = u * w, py = v * h;
      let best = Infinity;
      for (let i = 0; i < pts.length - 1; i++) best = Math.min(best, distSeg(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
      return best - half;
    };
  }
  const color = imageOf(w, h, (u, v, x, y) => {
    const i = y * w + x;
    return coverShape(distAt(u, v), bw, paintColor(inputs, 'fill', p.fill, i), paintColor(inputs, 'border', p.edge, i));
  });
  return { color, fac: channelLike(color, (c) => c[3]) };
}
function paintColor(inputs, key, param, i) {
  if (inputs[key]) return pxAt(inputs[key], i);
  const c = colorOf(param);
  return [c.r, c.g, c.b, c.a];
}
function coverShape(d, bw, fill, border) {
  const inner = bw > 0 ? d + bw : d;
  const fillCover = clamp(0.5 - inner, 0, 1);
  const edge = Math.max(0, clamp(0.5 - d, 0, 1) - fillCover);
  const fA = fillCover * clamp(fill[3], 0, 1);
  const bA = edge * clamp(border[3], 0, 1);
  const a = fA + bA * (1 - fA);
  if (a <= 1e-4) return [0, 0, 0, 0];
  const mix = (k) => (fill[k] * fA + border[k] * bA * (1 - fA)) / a;
  return [mix(0), mix(1), mix(2), a];
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function quadPoints(ax, ay, cx, cy, bx, by, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push([u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by]);
  }
  return pts;
}
function sdTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const e0x = bx - ax, e0y = by - ay, e1x = cx - bx, e1y = cy - by, e2x = ax - cx, e2y = ay - cy;
  const v0x = px - ax, v0y = py - ay, v1x = px - bx, v1y = py - by, v2x = px - cx, v2y = py - cy;
  const dot = (x, y, x2, y2) => x * x2 + y * y2;
  const cl = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
  const t0 = cl(dot(v0x, v0y, e0x, e0y) / (dot(e0x, e0y, e0x, e0y) || 1));
  const t1 = cl(dot(v1x, v1y, e1x, e1y) / (dot(e1x, e1y, e1x, e1y) || 1));
  const t2 = cl(dot(v2x, v2y, e2x, e2y) / (dot(e2x, e2y, e2x, e2y) || 1));
  const p0x = v0x - e0x * t0, p0y = v0y - e0y * t0;
  const p1x = v1x - e1x * t1, p1y = v1y - e1y * t1;
  const p2x = v2x - e2x * t2, p2y = v2y - e2y * t2;
  const s = Math.sign(e0x * e2y - e0y * e2x) || 1;
  const c0 = dot(p0x, p0y, p0x, p0y), c1 = dot(p1x, p1y, p1x, p1y), c2 = dot(p2x, p2y, p2x, p2y);
  const s0 = s * (v0x * e0y - v0y * e0x), s1 = s * (v1x * e1y - v1y * e1x), s2 = s * (v2x * e2y - v2y * e2x);
  return -Math.sqrt(Math.min(c0, c1, c2)) * Math.sign(Math.min(s0, s1, s2));
}
function sdNgon(px, py, r, n, rot) {
  const an = (Math.PI * 2) / n;
  let a = Math.atan2(py, px) + rot;
  a = ((a % an) + an) % an - an * 0.5;
  return Math.cos(Math.abs(a)) * Math.hypot(px, py) - r * Math.cos(an * 0.5);
}
function brickNode(node, inputs, ctx) {
  const p = node.params || {};
  const c1 = colorOf(p.color1), c2 = colorOf(p.color2);
  const fac = imageOf(ctx.width, ctx.height, (u, v, x, y) => {
    const i = y * ctx.width + x;
    const uv = uvOf(inputs, u, v, i);
    const scale = Math.max(0.5, num(p.scale || 6));
    const mortar = clamp(num(p.mortar ?? 0.08), 0, 0.45);
    const row = Math.floor(uv[1] * scale);
    const uu = uv[0] + (row & 1 ? 0.5 / scale : 0);
    const fx = (uu * scale) % 1, fy = (uv[1] * scale) % 1;
    const brick = fx > mortar && fx < 1 - mortar * 0.2 && fy > mortar;
    const A = inputs.color1 ? pxAt(inputs.color1, i) : [c1.r, c1.g, c1.b, c1.a];
    const B = inputs.color2 ? pxAt(inputs.color2, i) : [c2.r, c2.g, c2.b, c2.a];
    return brick ? [...A.slice(0, 3), 1] : [...B.slice(0, 3), 1];
  });
  return { color: fac, fac: channelLike(fac, (c) => c[0]) };
}
function whiteNode(node, inputs, ctx) {
  const seed = num(node.params?.seed);
  const color = imageOf(ctx.width, ctx.height, (u, v, x, y) => {
    const uv = uvOf(inputs, u, v, y * ctx.width + x);
    const r = hash(Math.floor(uv[0] * 4096), Math.floor(uv[1] * 4096), seed);
    const g = hash(Math.floor(uv[0] * 4096), Math.floor(uv[1] * 4096), seed + 3);
    const b = hash(Math.floor(uv[0] * 4096), Math.floor(uv[1] * 4096), seed + 9);
    return [r, g, b, 1];
  });
  return { color, value: channelLike(color, (c) => c[0]) };
}

function sampleBilinear(img, u, v) {
  if (!img) return [0, 0, 0, 0];
  const w = img.width, h = img.height;
  const x = clamp(u, 0, 1) * w - 0.5;
  const y = clamp(v, 0, 1) * h - 0.5;
  const x0 = clamp(Math.floor(x), 0, w - 1), y0 = clamp(Math.floor(y), 0, h - 1);
  const x1 = clamp(x0 + 1, 0, w - 1), y1 = clamp(y0 + 1, 0, h - 1);
  const fx = x - Math.floor(x), fy = y - Math.floor(y);
  const at = (xx, yy) => { const o = (yy * w + xx) * 4; return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]]; };
  const a = at(x0, y0), b = at(x1, y0), c = at(x0, y1), d = at(x1, y1);
  const lerp = (p, q, t) => p + (q - p) * t;
  return [0, 1, 2, 3].map((k) => lerp(lerp(a[k], b[k], fx), lerp(c[k], d[k], fx), fy));
}

function boxBlur(img, radius) {
  const r = Math.max(0, Math.min(32, radius | 0));
  if (!img || r < 1) return img;
  const pass = (src, horizontal) => {
    const w = src.width, h = src.height;
    const data = new Float32Array(src.data.length);
    const span = r * 2 + 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let R = 0, G = 0, B = 0, A = 0;
        for (let k = -r; k <= r; k++) {
          const xx = horizontal ? clamp(x + k, 0, w - 1) : x;
          const yy = horizontal ? y : clamp(y + k, 0, h - 1);
          const o = (yy * w + xx) * 4;
          R += src.data[o]; G += src.data[o + 1]; B += src.data[o + 2]; A += src.data[o + 3];
        }
        const o = (y * w + x) * 4;
        data[o] = R / span; data[o + 1] = G / span; data[o + 2] = B / span; data[o + 3] = A / span;
      }
    }
    return { kind: 'image', width: w, height: h, data };
  };
  return pass(pass(img, true), false);
}
function blurImage(img, radius) { return boxBlur(img, radius); }

function sharpenImage(v, p, ctx) {
  const src = asImage(v, ctx.width, ctx.height);
  const blur = boxBlur(src, Math.max(1, Math.round((p.radius || 1) * (ctx.scale || 1))));
  const amount = num(p.amount ?? 0.5);
  const data = new Float32Array(src.data.length);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) data[i + c] = src.data[i + c] + (src.data[i + c] - blur.data[i + c]) * amount;
    data[i + 3] = src.data[i + 3];
  }
  return { kind: 'image', width: src.width, height: src.height, data };
}
function pixelate(v, cells, w, h) {
  const src = asImage(v, w, h);
  const n = Math.max(1, cells | 0);
  return imageOf(w, h, (u, v0) => sampleBilinear(src, (Math.floor(u * n) + 0.5) / n, (Math.floor(v0 * n) + 0.5) / n));
}
function glare(v, p, ctx) {
  const src = asImage(v, ctx.width, ctx.height);
  const thr = num(p.threshold ?? 0.7);
  const glowData = new Float32Array(src.data.length);
  for (let i = 0; i < src.data.length; i += 4) {
    const y = 0.2126 * src.data[i] + 0.7152 * src.data[i + 1] + 0.0722 * src.data[i + 2];
    const k = y > thr ? (y - thr) / (1 - thr || 1) : 0;
    glowData[i] = src.data[i] * k; glowData[i + 1] = src.data[i + 1] * k; glowData[i + 2] = src.data[i + 2] * k; glowData[i + 3] = k;
  }
  const glow = boxBlur({ kind: 'image', width: src.width, height: src.height, data: glowData }, Math.round((p.size || 6) * (ctx.scale || 1)));
  const mix = num(p.mix ?? 0.6);
  const data = new Float32Array(src.data.length);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = src.data[i] + glow.data[i] * mix;
    data[i + 1] = src.data[i + 1] + glow.data[i + 1] * mix;
    data[i + 2] = src.data[i + 2] + glow.data[i + 2] * mix;
    data[i + 3] = src.data[i + 3];
  }
  return { kind: 'image', width: src.width, height: src.height, data };
}
function dilate(v, p, ctx) {
  const src = asImage(v, ctx.width, ctx.height);
  const r = clamp(Math.round((p.radius || 0) * Math.max(ctx.scale || 1, 0.35)), 0, 5);
  if (!r) return src;
  const grow = p.mode !== 'erode';
  const data = new Float32Array(src.data.length);
  const w = src.width, h = src.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let R = grow ? -1e9 : 1e9, G = R, B = R, A = R;
      for (let oy = -r; oy <= r; oy++) for (let ox = -r; ox <= r; ox++) {
        const xx = clamp(x + ox, 0, w - 1), yy = clamp(y + oy, 0, h - 1);
        const o = (yy * w + xx) * 4;
        const take = grow ? Math.max : Math.min;
        R = take(R, src.data[o]); G = take(G, src.data[o + 1]); B = take(B, src.data[o + 2]); A = take(A, src.data[o + 3]);
      }
      const o = (y * w + x) * 4;
      data[o] = R; data[o + 1] = G; data[o + 2] = B; data[o + 3] = A;
    }
  }
  return { kind: 'image', width: w, height: h, data };
}
function transformImage(v, p, w, h) {
  const src = asImage(v, w, h);
  const ang = -num(p.angle) * Math.PI / 180;
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const sc = num(p.scale || 1) || 1;
  const tx = num(p.x), ty = num(p.y);
  return imageOf(w, h, (u, v0) => {
    let x = u - 0.5, y = v0 - 0.5;
    x /= sc; y /= sc;
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    return sampleBilinear(src, rx + 0.5 - tx, ry + 0.5 - ty);
  });
}
function flipImage(v, p, w, h) {
  const src = asImage(v, w, h);
  return imageOf(w, h, (u, v0) => sampleBilinear(src, p.x ? 1 - u : u, p.y ? 1 - v0 : v0));
}
function cropNode(v, p, w, h) {
  const src = asImage(v, w, h);
  const x0 = num(p.x), y0 = num(p.y), rw = num(p.w ?? 1), rh = num(p.h ?? 1);
  return imageOf(w, h, (u, v0) => {
    if (u < x0 || v0 < y0 || u > x0 + rw || v0 > y0 + rh) return [0, 0, 0, 0];
    return sampleBilinear(src, u, v0);
  });
}
function displace(inputs, p, w, h) {
  const src = asImage(inputs.image, w, h);
  const strength = num(p.strength ?? 0.1);
  return imageOf(w, h, (u, v, x, y) => {
    const d = pxAt(inputs.vector, y * w + x);
    return sampleBilinear(src, u + (d[0] - 0.5) * strength, v + (d[1] - 0.5) * strength);
  });
}
function smooth(e0, e1, x) {
  if (e1 <= e0) return x < e0 ? 0 : 1;
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
function maskImage(w, h, fn) {
  return imageOf(w, h, (u, v) => {
    const a = fn(u, v);
    return [a, a, a, 1];
  });
}
function boxMask(u, v, p) {
  const hw = Math.max(1e-4, num(p.w) / 2), hh = Math.max(1e-4, num(p.h) / 2);
  const d = Math.max(Math.abs(u - num(p.x ?? 0.5)) / hw, Math.abs(v - num(p.y ?? 0.5)) / hh);
  const soft = Math.max(0.0001, num(p.soft) || 0.0001);
  return 1 - smooth(1, 1 + soft, d);
}
function ellipseMask(u, v, p) {
  const hw = Math.max(1e-4, num(p.w) / 2), hh = Math.max(1e-4, num(p.h) / 2);
  const d = Math.hypot((u - num(p.x ?? 0.5)) / hw, (v - num(p.y ?? 0.5)) / hh);
  const soft = Math.max(0.0001, num(p.soft) || 0.0001);
  return 1 - smooth(1, 1 + soft, d);
}
function chroma(c, p) {
  const key = colorOf(p.key);
  const d = Math.hypot(c[0] - key.r, c[1] - key.g, c[2] - key.b);
  const a = smooth(num(p.threshold ?? 0.25), num(p.threshold ?? 0.25) + num(p.soft ?? 0.1), d);
  return [c[0], c[1], c[2], c[3] * a, a];
}
function lumaKey(c, p) {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const soft = num(p.soft ?? 0.05);
  const a = smooth(num(p.low) - soft, num(p.low) + soft, y) * (1 - smooth(num(p.high) - soft, num(p.high) + soft, y));
  return [c[0], c[1], c[2], c[3] * a, a];
}
function keyNode(v, w, h, fn) {
  const src = asImage(v, w, h);
  const image = imageOf(w, h, (_u, _v, x, y) => fn(pxAt(src, y * w + x)).slice(0, 4));
  const matte = imageOf(w, h, (_u, _v, x, y) => {
    const a = fn(pxAt(src, y * w + x))[4];
    return [a, a, a, 1];
  });
  return { image, matte };
}

export function floatToUint8(img) {
  const data = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0; i < data.length; i++) {
    const n = img.data[i];
    data[i] = n <= 0 ? 0 : n >= 1 ? 255 : Math.round(n * 255);
  }
  return { width: img.width, height: img.height, data };
}

export function primaryOutput(values, node) {
  const bag = values.get(node.id) || {};
  const sock = socketsOf(node).outputs[0];
  return sock ? bag[sock.id] : null;
}

export function summarize(value, w, h, samples = [[0.5, 0.5]]) {
  const img = asImage(value, w, h);
  let r = 0, g = 0, b = 0, a = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    r += img.data[i * 4]; g += img.data[i * 4 + 1]; b += img.data[i * 4 + 2]; a += img.data[i * 4 + 3];
  }
  return {
    width: w, height: h,
    mean: { r: r / n, g: g / n, b: b / n, a: a / n },
    samples: samples.map(([u, v]) => {
      const x = clamp(Math.floor(clamp(u, 0, 0.999) * w), 0, w - 1);
      const y = clamp(Math.floor(clamp(v, 0, 0.999) * h), 0, h - 1);
      const o = (y * w + x) * 4;
      return { u, v, r: img.data[o], g: img.data[o + 1], b: img.data[o + 2], a: img.data[o + 3] };
    }),
  };
}

export function applyTarget(graph, nodeId) {
  if (!graph) return null;
  if (nodeId && findId(graph, nodeId)) return nodeId;
  const comp = graph.nodes.find((n) => n.type === 'composite');
  if (comp) return comp.id;
  const view = graph.nodes.find((n) => n.type === 'viewer');
  return view?.id || graph.nodes[0]?.id || null;
}

function findId(scope, id) {
  for (const n of scope.nodes || []) {
    if (n.id === id) return true;
    if (n.type === 'group' && n.params?.graph && findId(n.params.graph, id)) return true;
  }
  return false;
}

/** Write the composite (or `nodeId`) into the active layer. A selection limits the write. */
export function applyToLayer(doc, nodeId) {
  const graph = doc?.nodeGraph;
  const id = applyTarget(graph, nodeId);
  if (!id) throw new Error('The graph has no Composite or Viewer to apply.');
  const node = findNodeShallow(graph, id);
  if (!node) throw new Error(`No node ${id}.`);
  const ctx = makeContext(doc, doc.width, doc.height);
  const { values, errors } = evaluateGraph(graph, ctx);
  const value = primaryOutput(values, node);
  if (value == null) {
    const err = errors.find((e) => e.id === id) || errors[0];
    throw new Error(err ? err.error : 'That node produced nothing.');
  }
  const img = floatToUint8(asImage(value, doc.width, doc.height));
  const layer = doc.layer;
  if (!layer) throw new Error('No layer to paint.');
  const bounds = doc.selection ? maskBounds(doc.selection) : { x: 0, y: 0, w: doc.width, h: doc.height };
  if (!bounds) throw new Error('The selection is empty.');
  const blended = blendByMask(layer.img, img, doc.selection);
  const before = cropImage(layer.img, bounds);
  for (let y = 0; y < bounds.h; y++) {
    const row = ((bounds.y + y) * doc.width + bounds.x) * 4;
    layer.img.data.set(blended.data.subarray(row, row + bounds.w * 4), row);
  }
  layer.touch(bounds);
  doc.commitRegion(layer, bounds, before, 'Apply Nodes');
  return { node: id, errors };
}

function findNodeShallow(scope, id) {
  for (const n of scope?.nodes || []) {
    if (n.id === id) return n;
    if (n.type === 'group' && n.params?.graph) {
      const hit = findNodeShallow(n.params.graph, id);
      if (hit) return hit;
    }
  }
  return null;
}
