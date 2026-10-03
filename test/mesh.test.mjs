import assert from 'node:assert/strict';
import test from 'node:test';
import { demoMesh, parseOBJ, unwrapMesh, buildBVH, raycastMesh } from '../src/js/core/mesh.js';

const CUBE = `
o cube
v -1 -1  1
v  1 -1  1
v  1  1  1
v -1  1  1
v -1 -1 -1
v  1 -1 -1
v  1  1 -1
v -1  1 -1
f 1 2 3 4
f 5 8 7 6
f 1 5 6 2
f 2 6 7 3
f 3 7 8 4
f 5 1 4 8
`;

const SQUARE = `
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
f 1 2 3
f 1 3 4
`;

function overlapArea(rects) {
  let area = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > 0.75 && h > 0.75) area += w * h;
    }
  }
  return area;
}

test('cube cuts into six charts and packs without overlap', () => {
  const mesh = parseOBJ(CUBE, 'cube.obj');
  assert.equal(mesh.groups[0].name, 'cube');
  assert.equal(mesh.indices.length / 3, 12);
  const atlas = unwrapMesh(mesh, { angle: 66, padding: 4, resolution: 512, pxPerM: 0 });
  assert.equal(atlas.charts, 6);
  const long = Math.max(atlas.width, atlas.height);
  assert.ok(long >= 480 && long <= 512, `${atlas.width}×${atlas.height}`);
  for (let i = 0; i < atlas.uvs.length; i++) assert.ok(atlas.uvs[i] >= -1e-4 && atlas.uvs[i] <= 1 + 1e-4);
  assert.ok(overlapArea(atlas.islandRects) < 1);
});

test('a flat square stays one chart and keeps its shape', () => {
  const atlas = unwrapMesh(parseOBJ(SQUARE), { angle: 66, padding: 0, resolution: 256 });
  assert.equal(atlas.charts, 1);
  const r = atlas.islandRects[0];
  const aspect = r.w / r.h;
  assert.ok(aspect > 0.85 && aspect < 1.15, `aspect ${aspect}`);
});

test('existing UVs are kept and flipped into image space', () => {
  const obj = `
v 0 0 0
v 1 0 0
v 0 1 0
vt 0 0
vt 1 0
vt 0 1
f 1/1 2/2 3/3
`;
  const mesh = parseOBJ(obj);
  assert.equal(mesh.hasUV, true);
  const atlas = unwrapMesh(mesh, { useExisting: true, resolution: 128 });
  assert.equal(atlas.keptUVs, true);
  assert.equal(atlas.uvs[0], 0);
  assert.equal(atlas.uvs[1], 1);
  assert.equal(atlas.uvs[4], 0);
  assert.equal(atlas.uvs[5], 0);
});

test('demo mine unwraps and a ray hits the body', () => {
  const mesh = demoMesh();
  assert.ok(mesh.groups.some((g) => g.name === 'pull tab'));
  const atlas = unwrapMesh(mesh, { angle: 66, padding: 2, resolution: 256 });
  assert.ok(atlas.charts >= 3);
  assert.ok(atlas.uvs.length === mesh.indices.length * 2);
  const bvh = buildBVH(mesh.positions, mesh.indices);
  const hit = raycastMesh(bvh, [0, 0.03, 1], [0, 0, -1]);
  assert.ok(hit && hit.t > 0 && hit.t < 2);
});
