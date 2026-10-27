// WGSL for the WebGPU renderer. Separable blend modes are generated from blendmath.js so the
// shader and the JS reference share one definition.
import { BLEND_MODES } from '../core/blend.js';
import { SEPARABLE } from './blendmath.js';

const fnName = (id) => `blend_${id.replace(/-/g, '_')}`;

function blendFunctions() {
  const sep = Object.entries(SEPARABLE).map(([id, expr]) =>
    `fn ${fnName(id)}_ch(cb: f32, cs: f32) -> f32 { return ${expr}; }\n` +
    `fn ${fnName(id)}(cb: vec3f, cs: vec3f) -> vec3f { return vec3f(${fnName(id)}_ch(cb.r, cs.r), ${fnName(id)}_ch(cb.g, cs.g), ${fnName(id)}_ch(cb.b, cs.b)); }`).join('\n');
  const cases = BLEND_MODES.map(([id], i) => {
    if (SEPARABLE[id]) return `    case ${i}u: { return ${fnName(id)}(cb, cs); }`;
    const expr = {
      hue: 'set_lum(set_sat(cs, sat(cb)), lum(cb))',
      saturation: 'set_lum(set_sat(cb, sat(cs)), lum(cb))',
      color: 'set_lum(cs, lum(cb))',
      luminosity: 'set_lum(cb, lum(cs))',
    }[id];
    return `    case ${i}u: { return ${expr}; }`;
  }).join('\n');
  return `${sep}

fn lum(c: vec3f) -> f32 { return dot(c, vec3f(0.3, 0.59, 0.11)); }
fn clip_color(c: vec3f) -> vec3f {
  let l = lum(c);
  let n = min(c.r, min(c.g, c.b));
  let x = max(c.r, max(c.g, c.b));
  var o = c;
  if (n < 0.0) { o = l + (o - l) * l / max(l - n, 0.000001); }
  if (x > 1.0) { o = l + (o - l) * (1.0 - l) / max(x - l, 0.000001); }
  return o;
}
fn set_lum(c: vec3f, l: f32) -> vec3f { return clip_color(c + (l - lum(c))); }
fn sat(c: vec3f) -> f32 { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
fn set_sat(c: vec3f, s: f32) -> vec3f {
  let x = max(c.r, max(c.g, c.b));
  let n = min(c.r, min(c.g, c.b));
  if (x > n) { return (c - n) * s / (x - n); }
  return vec3f(0.0);
}

fn blend(mode: u32, cb: vec3f, cs: vec3f) -> vec3f {
  switch mode {
${cases}
    default: { return cs; }
  }
}`;
}

const FULLSCREEN = `
struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4f(p[i], 0.0, 1.0);
  o.uv = vec2f((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}`;

/** One layer over the accumulator: dst is premultiplied (rgba16float), src is the straight-alpha layer. */
export const COMPOSITE_WGSL = `${FULLSCREEN}
struct Params { opacity: f32, mode: u32, premul: u32, _b: u32 };
@group(0) @binding(0) var dstTex: texture_2d<f32>;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> P: Params;
${blendFunctions()}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let d = textureLoad(dstTex, p, 0);
  var s = textureLoad(srcTex, p, 0);
  if (P.premul == 1u) { // a pre-flattened group of layers (premultiplied)
    if (s.a > 0.0) { s = vec4f(s.rgb / s.a, s.a); } else { s = vec4f(0.0); }
  }
  let as_ = s.a * P.opacity;
  let ab = d.a;
  var cb = vec3f(0.0);
  if (ab > 0.0) { cb = d.rgb / ab; }
  let b = clamp(blend(P.mode, cb, s.rgb), vec3f(0.0), vec3f(1.0));
  let mixed = (1.0 - ab) * s.rgb + ab * b;
  return vec4f(as_ * mixed + (1.0 - as_) * d.rgb, as_ + ab * (1.0 - as_));
}`;

/** Draws the composite into the view: checkerboard under the document, pan/zoom, nothing outside it. */
export const PRESENT_WGSL = `${FULLSCREEN}
struct View { origin: vec2f, size: vec2f, docSize: vec2f, dpr: f32, taps: f32 };
@group(0) @binding(0) var comp: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> V: View;
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let css = in.pos.xy / V.dpr;              // CSS pixels, like the 2D view's coordinates
  let local = css - V.origin;               // relative to the document's top-left on screen
  if (local.x < 0.0 || local.y < 0.0 || local.x >= V.size.x || local.y >= V.size.y) { return vec4f(0.0); }
  let cell = vec2i(floor(local / 8.0));
  let light = ((cell.x + cell.y) & 1) == 0;
  let checker = select(vec3f(1.0), vec3f(0.812, 0.812, 0.831), light);
  // Zoomed out: average a small grid of taps across the pixel footprint (cheap minification).
  let n = i32(V.taps);
  let foot = 1.0 / (V.size * V.dpr);        // one device pixel, in texture UV
  let base = local / V.size;
  var c = vec4f(0.0);
  for (var j = 0; j < n; j++) {
    for (var i = 0; i < n; i++) {
      let o = (vec2f(f32(i), f32(j)) + 0.5) / f32(n) - 0.5;
      c += textureSampleLevel(comp, samp, base + o * foot, 0.0);
    }
  }
  c /= f32(n * n);
  return vec4f(c.rgb + checker * (1.0 - c.a), 1.0);
}`;


/** Clears the scissored part of a target (a loadOp clear would wipe all of it). */
export const CLEAR_WGSL = `${FULLSCREEN}
@fragment fn fs(in: VOut) -> @location(0) vec4f { return vec4f(0.0); }`;

/**
 * The float's layer with the float drawn into it, blended onto the layers below. The float is the
 * lifted pixels as a texture, sampled through the inverse of its box transform with a
 * premultiplied bilinear filter (exact at identity), so a drag only changes this matrix.
 */
export const FLOAT_WGSL = `${FULLSCREEN}
struct FP { opacity: f32, mode: u32, falpha: f32, _b: u32, m0: vec4f, m1: vec4f };
@group(0) @binding(0) var dstTex: texture_2d<f32>;
@group(0) @binding(1) var layerTex: texture_2d<f32>;
@group(0) @binding(2) var floatTex: texture_2d<f32>;
@group(0) @binding(3) var<uniform> F: FP;
${blendFunctions()}
fn tap(i: vec2i, size: vec2i) -> vec4f {
  if (i.x < 0 || i.y < 0 || i.x >= size.x || i.y >= size.y) { return vec4f(0.0); }
  let c = textureLoad(floatTex, i, 0);
  return vec4f(c.rgb * c.a, c.a);
}
fn floatAt(p: vec2f) -> vec4f {
  let q = vec2f(F.m0.x * p.x + F.m0.z * p.y + F.m1.x, F.m0.y * p.x + F.m0.w * p.y + F.m1.y) - 0.5;
  let size = vec2i(F.m1.zw);
  let i0 = vec2i(floor(q));
  let f = q - floor(q);
  let a = mix(tap(i0, size), tap(i0 + vec2i(1, 0), size), f.x);
  let b = mix(tap(i0 + vec2i(0, 1), size), tap(i0 + vec2i(1, 1), size), f.x);
  return mix(a, b, f.y);
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let p = vec2i(in.pos.xy);
  let d = textureLoad(dstTex, p, 0);
  let base = textureLoad(layerTex, p, 0);
  let fl = floatAt(in.pos.xy) * F.falpha;
  let comb = fl + vec4f(base.rgb * base.a, base.a) * (1.0 - fl.a); // float over the layer, premultiplied
  var cs = vec3f(0.0);
  if (comb.a > 0.0) { cs = comb.rgb / comb.a; }
  let as_ = comb.a * F.opacity;
  let ab = d.a;
  var cb = vec3f(0.0);
  if (ab > 0.0) { cb = d.rgb / ab; }
  let bl = clamp(blend(F.mode, cb, cs), vec3f(0.0), vec3f(1.0));
  let mixed = (1.0 - ab) * cs + ab * bl;
  return vec4f(as_ * mixed + (1.0 - as_) * d.rgb, as_ + ab * (1.0 - as_));
}`;
