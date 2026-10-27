// Blend-mode math shared by the WebGPU compositor and the JS reference used in tests.
//
// The separable modes are written as per-channel expressions in the small subset of syntax that
// is valid both as JavaScript and as WGSL (arithmetic, min, max, abs, sqrt and
// select(falseValue, trueValue, condition)). shaders.js pastes them into WGSL functions. The app's
// CSP forbids eval, so CHANNEL below spells the same maths out as plain JS; test/gpu.test.mjs
// evaluates the expression strings and checks CHANNEL against them, so the two cannot drift.
// Non-separable modes (hue, saturation, color, luminosity) are vector maths, written out twice
// (WGSL in shaders.js, JS here) and checked against each other's defining properties in tests.
//
// cb = backdrop channel, cs = source channel, both straight (not premultiplied) 0..1.
// Definitions follow the W3C Compositing and Blending Level 1 spec, which is what Canvas 2D's
// globalCompositeOperation implements, so GPU output matches the existing renderer.
import { BLEND_MODES } from '../core/blend.js';

export const SEPARABLE = {
  'source-over': 'cs',
  multiply: 'cb * cs',
  screen: 'cb + cs - cb * cs',
  overlay: 'select(cs + (2.0 * cb - 1.0) - cs * (2.0 * cb - 1.0), 2.0 * cs * cb, cb <= 0.5)',
  darken: 'min(cb, cs)',
  lighten: 'max(cb, cs)',
  'color-dodge': 'select(select(min(1.0, cb / max(1.0 - cs, 0.000001)), 1.0, cs >= 1.0), 0.0, cb <= 0.0)',
  'color-burn': 'select(select(1.0 - min(1.0, (1.0 - cb) / max(cs, 0.000001)), 0.0, cs <= 0.0), 1.0, cb >= 1.0)',
  'hard-light': 'select(cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0), cb * 2.0 * cs, cs <= 0.5)',
  'soft-light': 'select(cb + (2.0 * cs - 1.0) * (select(sqrt(cb), ((16.0 * cb - 12.0) * cb + 4.0) * cb, cb <= 0.25) - cb), cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb), cs <= 0.5)',
  difference: 'abs(cb - cs)',
  exclusion: 'cb + cs - 2.0 * cb * cs',
};

export const NON_SEPARABLE = ['hue', 'saturation', 'color', 'luminosity'];

/** Shader-side mode index for each blend id, in BLEND_MODES order. Unknown ids composite as Normal. */
export const MODE_INDEX = Object.fromEntries(BLEND_MODES.map(([id], i) => [id, i]));
export const modeIndex = (id) => MODE_INDEX[id] ?? 0;

const select = (f, t, c) => (c ? t : f);
const { min, max, abs, sqrt } = Math;
/** Plain-JS twins of SEPARABLE (same order, same operations). */
export const CHANNEL = {
  'source-over': (cb, cs) => cs,
  multiply: (cb, cs) => cb * cs,
  screen: (cb, cs) => cb + cs - cb * cs,
  overlay: (cb, cs) => select(cs + (2.0 * cb - 1.0) - cs * (2.0 * cb - 1.0), 2.0 * cs * cb, cb <= 0.5),
  darken: (cb, cs) => min(cb, cs),
  lighten: (cb, cs) => max(cb, cs),
  'color-dodge': (cb, cs) => select(select(min(1.0, cb / max(1.0 - cs, 0.000001)), 1.0, cs >= 1.0), 0.0, cb <= 0.0),
  'color-burn': (cb, cs) => select(select(1.0 - min(1.0, (1.0 - cb) / max(cs, 0.000001)), 0.0, cs <= 0.0), 1.0, cb >= 1.0),
  'hard-light': (cb, cs) => select(cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0), cb * 2.0 * cs, cs <= 0.5),
  'soft-light': (cb, cs) => select(cb + (2.0 * cs - 1.0) * (select(sqrt(cb), ((16.0 * cb - 12.0) * cb + 4.0) * cb, cb <= 0.25) - cb), cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb), cs <= 0.5),
  difference: (cb, cs) => abs(cb - cs),
  exclusion: (cb, cs) => cb + cs - 2.0 * cb * cs,
};

// ---- non-separable helpers (mirrors of the WGSL in shaders.js)
const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
function clipColor(c) {
  const l = lum(c), n = Math.min(c[0], c[1], c[2]), x = Math.max(c[0], c[1], c[2]);
  let o = c;
  if (n < 0) o = o.map((v) => l + ((v - l) * l) / Math.max(l - n, 1e-6));
  if (x > 1) o = o.map((v) => l + ((v - l) * (1 - l)) / Math.max(x - l, 1e-6));
  return o;
}
const setLum = (c, l) => { const d = l - lum(c); return clipColor([c[0] + d, c[1] + d, c[2] + d]); };
const sat = (c) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]);
function setSat(c, s) {
  const x = Math.max(c[0], c[1], c[2]), n = Math.min(c[0], c[1], c[2]);
  return x > n ? c.map((v) => ((v - n) * s) / (x - n)) : [0, 0, 0];
}

/** B(cb, cs) for a blend id, on straight RGB triples in 0..1. */
export function blendRGB(id, cb, cs) {
  switch (id) {
    case 'hue': return setLum(setSat(cs, sat(cb)), lum(cb));
    case 'saturation': return setLum(setSat(cb, sat(cs)), lum(cb));
    case 'color': return setLum(cs, lum(cb));
    case 'luminosity': return setLum(cb, lum(cs));
    default: {
      const f = CHANNEL[id] || CHANNEL['source-over'];
      return [f(cb[0], cs[0]), f(cb[1], cs[1]), f(cb[2], cs[2])];
    }
  }
}

/**
 * One layer over the accumulated image, exactly as the compositor shader does it.
 * dst: premultiplied [r,g,b,a] 0..1 (the backdrop so far). src: straight [r,g,b,a] 0..1.
 * Returns premultiplied [r,g,b,a]. (W3C: Cs' = (1 - ab)·Cs + ab·B(Cb, Cs), then source-over.)
 */
export function compositePixel(id, dst, src, opacity = 1) {
  const as = src[3] * opacity, ab = dst[3];
  const cb = ab > 0 ? [dst[0] / ab, dst[1] / ab, dst[2] / ab] : [0, 0, 0];
  const cs = [src[0], src[1], src[2]];
  const b = blendRGB(id, cb, cs);
  const mixed = [0, 1, 2].map((k) => (1 - ab) * cs[k] + ab * Math.min(1, Math.max(0, b[k])));
  return [
    as * mixed[0] + (1 - as) * dst[0],
    as * mixed[1] + (1 - as) * dst[1],
    as * mixed[2] + (1 - as) * dst[2],
    as + ab * (1 - as),
  ];
}

/** Composite straight-alpha 8-bit layers ({img, opacity, blend, visible}) on the CPU. Test reference. */
export function compositeLayersCPU(width, height, layers) {
  const out = new Uint8ClampedArray(width * height * 4);
  const acc = [0, 0, 0, 0];
  for (let i = 0; i < width * height; i++) {
    acc[0] = acc[1] = acc[2] = acc[3] = 0;
    let a = acc;
    for (const l of layers) {
      if (!l.visible || !(l.opacity > 0)) continue;
      const d = l.img.data, j = i * 4;
      a = compositePixel(l.blend, a, [d[j] / 255, d[j + 1] / 255, d[j + 2] / 255, d[j + 3] / 255], l.opacity);
    }
    const j = i * 4, al = a[3];
    out[j] = al > 0 ? Math.round((a[0] / al) * 255) : 0;
    out[j + 1] = al > 0 ? Math.round((a[1] / al) * 255) : 0;
    out[j + 2] = al > 0 ? Math.round((a[2] / al) * 255) : 0;
    out[j + 3] = Math.round(al * 255);
  }
  return { width, height, data: out };
}
