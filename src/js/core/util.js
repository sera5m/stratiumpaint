// Small shared helpers. Nothing in js/core touches the DOM.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Integer rectangle {x, y, w, h}. */
export const rect = (x, y, w, h) => ({ x, y, w, h });

export function rectIntersect(a, b) {
  if (!a || !b) return null;
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

export function rectUnion(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Smallest integer rect containing the two (float) points. */
export function rectFromPoints(x0, y0, x1, y1) {
  const ax = Math.floor(Math.min(x0, x1)), ay = Math.floor(Math.min(y0, y1));
  const bx = Math.ceil(Math.max(x0, x1)), by = Math.ceil(Math.max(y0, y1));
  return { x: ax, y: ay, w: bx - ax, h: by - ay };
}

export function rectGrow(r, n) {
  return { x: r.x - n, y: r.y - n, w: r.w + n * 2, h: r.h + n * 2 };
}

export class Emitter {
  #handlers = new Map();
  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.#handlers.get(type)?.delete(fn);
  }
  emit(type, ...args) {
    for (const fn of [...(this.#handlers.get(type) ?? [])]) fn(...args);
  }
}

/** Deterministic PRNG so effect previews don't flicker. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
