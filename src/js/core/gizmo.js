// The projector's transform gizmo (Blender-style), as pure geometry so it can be tested without a
// DOM: translate arrows along the projector's local axes (right / up / forward, red / green / blue)
// and rotation rings for the three Euler angles, plus an optional view-facing free-rotate ring.
// toScreen(p) → [x, y] in CSS pixels (or null behind the camera); pxWorld = world units per pixel
// at the projector, so the gizmo keeps a constant on-screen size.
import { eulerAxis, projectorAxes, rollAbout } from './projection.js';

export const AXIS_COLORS = ['#e8414f', '#7fcf3a', '#3d8af2', '#f4f1e8']; // X red, Y green, Z blue, view ring
const ARROW_PX = 72, RING_PX = 52, FREE_PX = 84, RING_STEPS = 48;
const E = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Screen geometry of the gizmo. Arrows follow the projector's local axes (right, up, forward),
 *  not the world axes. `viewDir` (camera forward) adds a free-rotate ring that faces the view. */
export function gizmoHandles(loc, rot, toScreen, pxWorld, viewDir = null) {
  const centre = toScreen(loc);
  if (!centre) return null;
  const ax = projectorAxes(rot || [0, 0, 0]);
  const dirs = [ax.right, ax.up, ax.forward];
  const arrows = [], rings = [];
  for (let k = 0; k < 3; k++) {
    const b = toScreen(add(loc, mul(dirs[k], ARROW_PX * pxWorld)));
    if (b) arrows.push({ k, a: centre, b, axis: dirs[k] });
    const axis = norm(eulerAxis(rot || [0, 0, 0], k));
    const t = norm(Math.abs(axis[1]) < 0.9 ? cross(axis, [0, 1, 0]) : cross(axis, [1, 0, 0])), u = cross(axis, t);
    const pts = [];
    for (let i = 0; i <= RING_STEPS; i++) {
      const a = (i / RING_STEPS) * Math.PI * 2, r = RING_PX * pxWorld;
      const q = toScreen(add(loc, add(mul(t, Math.cos(a) * r), mul(u, Math.sin(a) * r))));
      if (q) pts.push(q);
    }
    if (pts.length > 2) rings.push({ k, axis, pts });
  }
  if (viewDir && (viewDir[0] || viewDir[1] || viewDir[2])) {
    const axis = norm(viewDir);
    const t = norm(Math.abs(axis[1]) < 0.9 ? cross(axis, [0, 1, 0]) : cross(axis, [1, 0, 0])), u = cross(axis, t);
    const pts = [];
    for (let i = 0; i <= RING_STEPS; i++) {
      const a = (i / RING_STEPS) * Math.PI * 2, r = FREE_PX * pxWorld;
      const q = toScreen(add(loc, add(mul(t, Math.cos(a) * r), mul(u, Math.sin(a) * r))));
      if (q) pts.push(q);
    }
    if (pts.length > 2) rings.push({ k: 3, axis, pts, free: true });
  }
  return { centre, arrows, rings };
}

function segDist(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy || 1;
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2));
  return Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vy * t);
}

/** What is under screen point p: { type: 'move' | 'rotate', k } or null. Arrows win over rings. */
export function hitGizmo(h, p, tol = 7) {
  if (!h) return null;
  let best = null, bd = tol;
  for (const ar of h.arrows) {
    const d = segDist(p, ar.a, ar.b);
    // skip the shared centre: near it every arrow is "close"
    if (d < bd && Math.hypot(p[0] - h.centre[0], p[1] - h.centre[1]) > 10) { bd = d; best = { type: 'move', k: ar.k }; }
  }
  if (best) return best;
  for (const r of h.rings) for (let i = 1; i < r.pts.length; i++) {
    const d = segDist(p, r.pts[i - 1], r.pts[i]);
    if (d < bd) { bd = d; best = { type: 'rotate', k: r.k }; }
  }
  return best;
}

/**
 * Location after dragging arrow k from screen point s0 to s1 (drag started with location loc0):
 * the pointer's motion along the arrow's screen direction, in world units. snap: round that
 * coordinate to 0.1. `axis`, when given, is the arrow's direction in world space (a local axis);
 * omitted, the drag stays on the world axis k (the original tests).
 */
export function dragMove(loc0, k, s0, s1, toScreen, snap = false, axis = null) {
  const dir = axis || E[k];
  const c = toScreen(loc0), e = toScreen(add(loc0, dir));
  const out = loc0.slice();
  if (!c || !e) return out;
  const vx = e[0] - c[0], vy = e[1] - c[1], l2 = vx * vx + vy * vy;
  if (l2 < 1e-9) return out;
  let along = ((s1[0] - s0[0]) * vx + (s1[1] - s0[1]) * vy) / l2;
  if (!axis) {
    out[k] = loc0[k] + along;
    if (snap) out[k] = Math.round(out[k] * 10) / 10;
    return out;
  }
  if (snap) along = Math.round(along * 10) / 10;
  return [loc0[0] + dir[0] * along, loc0[1] + dir[1] * along, loc0[2] + dir[2] * along];
}

const wrapDeg = (a) => { let d = ((a % 360) + 540) % 360 - 180; if (d === -180) d = 180; return Math.abs(d) < 1e-9 ? 0 : d; };

/**
 * Rotation after dragging ring k around screen point `centre` from s0 to s1. viewDir: the camera's
 * forward (world); a ring whose axis faces the camera turns counter-clockwise on screen for a
 * positive angle (right-hand rule). snap: 15° steps.
 */
export function dragRotate(rot0, k, centre, s0, s1, viewDir, snap = false) {
  const a0 = Math.atan2(s0[1] - centre[1], s0[0] - centre[0]), a1 = Math.atan2(s1[1] - centre[1], s1[0] - centre[0]);
  let d = ((a1 - a0) * 180) / Math.PI;
  d = wrapDeg(d);
  const axis = k === 3 ? viewDir : eulerAxis(rot0, k);
  const towards = axis[0] * viewDir[0] + axis[1] * viewDir[1] + axis[2] * viewDir[2] < 0;
  if (k === 3) {
    const signed = towards ? -d : d;
    return rollAbout(rot0, viewDir, snap ? wrapDeg(Math.round(signed / 15) * 15) : signed);
  }
  const out = rot0.slice();
  out[k] = wrapDeg(rot0[k] + (towards ? -d : d));
  if (snap) out[k] = wrapDeg(Math.round(out[k] / 15) * 15);
  return out;
}
