import assert from 'node:assert/strict';
import test from 'node:test';
import { demoMesh, unwrapMesh } from '../src/js/core/mesh.js';
import { seamStep, uvCharts, wrapCovers } from '../src/js/core/seam.js';

// One triangle. +X is +0.10 in u, +Y is +0.20 in v. The weld is not in this triangle;
// the next sample just arrives with the other lip's UV.
function lipGeom() {
  return {
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
    indices: Uint32Array.of(0, 1, 2),
    uvs: Float32Array.of(0.70, 0.40, 0.80, 0.40, 0.70, 0.60),
  };
}

test('stepping across the weld continues past the lip instead of jumping backward', () => {
  const geom = lipGeom();
  const prev = { u: 0.78, v: 0.42, offU: 0, offV: 0, p3: [0.8, 0.1, 0], face: 0 };
  const next = { u: 0.20, v: 0.43, p3: [0.95, 0.15, 0] };
  const step = seamStep(prev, next, 0.5, geom);
  assert.equal(step.wrapped, true);
  const contU = next.u + step.offU;
  assert.ok(contU > prev.u && contU < prev.u + 0.05, `continuous u ${contU} stays with the drag`);
  const further = { u: 0.24, v: 0.43, p3: [1.35, 0.15, 0] };
  const prev2 = { u: next.u, v: next.v, offU: step.offU, offV: step.offV, p3: next.p3, face: 0 };
  const step2 = seamStep(prev2, further, 0.5, geom);
  assert.equal(step2.wrapped, false, 'walking along the other lip is not another weld');
  assert.ok(further.u + step2.offU > contU, 'continuous u keeps moving forward');
});

test('a long hop across the model is not a weld', () => {
  const step = seamStep(
    { u: 0.2, v: 0.4, offU: 0, offV: 0, p3: [0, 0, 0], face: 0 },
    { u: 0.8, v: 0.4, p3: [5, 0, 0] },
    0.4,
    lipGeom(),
  );
  assert.equal(step.wrapped, false);
});

test('the flat sheet does not wrap: a UV jump there is a real jump', () => {
  const step = seamStep(
    { u: 0.8, v: 0.4, offU: 0, offV: 0, p3: [0.6, 0, -0.2], face: 0 },
    { u: 0.2, v: 0.4, p3: [-0.6, 0, -0.2] },
    0,
    null,
  );
  assert.equal(step.wrapped, false);
});

test('a shape that crossed the weld is drawn on both lips, not across the middle', () => {
  const geom = lipGeom();
  const prev = { u: 0.78, v: 0.42, offU: 0, offV: 0, p3: [0.8, 0.1, 0], face: 0 };
  const hopped = seamStep(prev, { u: 0.20, v: 0.43, p3: [0.95, 0.15, 0] }, 0.5, geom);
  const end = { u: 0.24, v: 0.43 };
  const off = seamStep(
    { u: 0.20, v: 0.43, offU: hopped.offU, offV: hopped.offV, p3: [0.95, 0.15, 0], face: 0 },
    { ...end, p3: [1.35, 0.15, 0] },
    0.5,
    geom,
  );
  const W = 1000;
  const x0 = prev.u * W, y0 = prev.v * W;
  const x1 = (end.u + off.offU) * W, y1 = (end.v + off.offV) * W;
  const clip = { x: 0.15 * W, y: 0.25 * W, w: 0.70 * W, h: 0.50 * W };
  const pieces = [
    { dx: 0, dy: 0, clip },
    { dx: off.offU * W, dy: off.offV * W, clip },
  ];
  assert.equal(wrapCovers(0.78 * W, 0.42 * W, x0, y0, x1, y1, pieces), true, 'the lip the drag started on');
  assert.equal(wrapCovers(0.24 * W, 0.43 * W, x0, y0, x1, y1, pieces), true, 'the other lip, where the drag landed');
  assert.equal(wrapCovers(0.50 * W, 0.425 * W, x0, y0, x1, y1, pieces), false, 'the long way across the unwrap');
});

test('a chart stops at a UV cut, so the two lips are not one smeared island', () => {
  // Two quads share no UV. Same 3D edge would be the weld; here they are separate islands.
  const indices = Uint32Array.of(0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6);
  const uvs = Float32Array.of(
    0.1, 0.2, 0.4, 0.2, 0.1, 0.6, 0.4, 0.6,
    0.6, 0.2, 0.9, 0.2, 0.6, 0.6, 0.9, 0.6,
  );
  const boxes = uvCharts(indices, uvs);
  assert.ok(boxes[0].umax < 0.5);
  assert.ok(boxes[2].umin > 0.5);
  assert.notEqual(boxes[0], boxes[2]);
});

test('the demo mine has a weld a short drag can cross', () => {
  const atlas = unwrapMesh(demoMesh(), { angle: 66, padding: 4, resolution: 256 });
  const { indices, uvs, positions } = atlas;
  const nF = indices.length / 3;
  let found = null;
  for (let f = 0; f < nF && !found; f++) {
    for (let k = 0; k < 3; k++) {
      const i0 = indices[f * 3 + k], i1 = indices[f * 3 + ((k + 1) % 3)];
      for (let g = f + 1; g < nF; g++) {
        let match = -1;
        for (let t = 0; t < 3; t++) {
          const j0 = indices[g * 3 + t], j1 = indices[g * 3 + ((t + 1) % 3)];
          if ((j0 === i0 && j1 === i1) || (j0 === i1 && j1 === i0)) match = t;
        }
        if (match < 0) continue;
        const uvAt = (face, corner) => [uvs[(face * 3 + corner) * 2], uvs[(face * 3 + corner) * 2 + 1]];
        const a = uvAt(f, k), b = uvAt(g, match);
        if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.15) continue;
        const mid = (ia, ib) => [
          (positions[ia * 3] + positions[ib * 3]) / 2,
          (positions[ia * 3 + 1] + positions[ib * 3 + 1]) / 2,
          (positions[ia * 3 + 2] + positions[ib * 3 + 2]) / 2,
        ];
        const p = mid(i0, i1);
        const prev = { u: a[0], v: a[1], offU: 0, offV: 0, p3: p, face: f };
        const next = { u: b[0], v: b[1], p3: [p[0] + 1e-4, p[1], p[2]] };
        const step = seamStep(prev, next, 1, atlas);
        if (!step.wrapped) continue;
        const jumped = Math.hypot((next.u + step.offU) - prev.u, (next.v + step.offV) - prev.v);
        found = jumped;
        break;
      }
    }
  }
  assert.ok(found != null, 'expected a UV cut on the demo');
  assert.ok(found < 0.05, `continuous jump ${found} should stay on the surface`);
});
