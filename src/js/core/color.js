// Colour helpers. A colour is {r,g,b} in 0..255 plus optional a in 0..1.
import { clamp } from './util.js';

export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export const rgbToHex = ({ r, g, b }) =>
  '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');

export const cssRgba = (c, alphaScale = 1) =>
  `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${(c.a ?? 1) * alphaScale})`;

/** h in 0..360, s and v in 0..1 */
export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/** h in 0..360, s and l in 0..1 */
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s, l };
}

export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

const STEP_PARTS = { whole: 1, half: 2, quarter: 4 };

/**
 * A doubling ramp of channel values from 0 to `max` (inclusive): 0, 2, 4, 8, 16, 32, 64, 128, ...,
 * max. This is closer to how the eye actually resolves brightness/colour differences than an
 * evenly-spaced ramp would be — each step is a similarly-*perceptible* jump, not a similarly-sized
 * number (the human eye responds roughly logarithmically, i.e. each doubling reads as "one step").
 * mode 'half' or 'quarter' inserts 1 or 3 extra steps into each octave, at the geometric mean of
 * its endpoints (so between 64 and 128: half adds ~91 (2^6.5); quarter also adds ~76 and ~108).
 */
export function powerSteps(max = 255, mode = 'whole') {
  const whole = [0];
  for (let v = 2; v < max; v *= 2) whole.push(v);
  whole.push(max);
  const parts = STEP_PARTS[mode] ?? 1;
  if (parts === 1) return whole;
  const out = [];
  for (let i = 0; i < whole.length - 1; i++) {
    const a = whole[i], b = whole[i + 1];
    out.push(a);
    for (let k = 1; k < parts; k++) out.push(Math.round(a === 0 ? (b * k) / parts : a * (b / a) ** (k / parts)));
  }
  out.push(max);
  return [...new Set(out)].sort((x, y) => x - y);
}

/** Fractional (interpolated) value `idx` steps into an ascending array, e.g. for a smooth radius. */
export function stepValueAt(arr, idx) {
  idx = Math.max(0, Math.min(arr.length - 1, idx));
  const i0 = Math.floor(idx), t = idx - i0, i1 = Math.min(i0 + 1, arr.length - 1);
  return arr[i0] + (arr[i1] - arr[i0]) * t;
}

/** Fractional index at which `value` falls in an ascending array (inverse of stepValueAt). */
export function indexOfStep(arr, value) {
  if (value <= arr[0]) return 0;
  const last = arr.length - 1;
  if (value >= arr[last]) return last;
  for (let i = 0; i < last; i++) {
    if (value <= arr[i + 1]) return i + (value - arr[i]) / (arr[i + 1] - arr[i] || 1);
  }
  return last;
}
