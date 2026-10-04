import assert from 'node:assert/strict';
import test from 'node:test';
import { demoMesh, parseOBJ, parseMeshText, unwrapMesh, buildBVH, raycastMesh } from '../src/js/core/mesh.js';

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
  assert.equal(atlas.separated, 0);
});

test('objects that share one UV square are given their own patch', () => {
  const mesh = parseMeshText('parts.json', JSON.stringify({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0],
    indices: [0, 1, 2, 3, 4, 5],
    uvs: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    groups: [
      { name: 'body', start: 0, count: 1 },
      { name: 'fuse', start: 1, count: 1 },
    ],
  }));
  const atlas = unwrapMesh(mesh, { useExisting: true, resolution: 256 });
  assert.equal(atlas.separated, 2);
  const box = (face) => {
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (let k = 0; k < 3; k++) {
      const o = (face * 3 + k) * 2;
      minU = Math.min(minU, atlas.uvs[o]); maxU = Math.max(maxU, atlas.uvs[o]);
      minV = Math.min(minV, atlas.uvs[o + 1]); maxV = Math.max(maxV, atlas.uvs[o + 1]);
    }
    return { minU, minV, maxU, maxV };
  };
  const a = box(0), b = box(1);
  const overlapW = Math.min(a.maxU, b.maxU) - Math.max(a.minU, b.minU);
  const overlapH = Math.min(a.maxV, b.maxV) - Math.max(a.minV, b.minV);
  assert.ok(overlapW < 1e-4 || overlapH < 1e-4, `still stacked ${overlapW}×${overlapH}`);
  for (let i = 0; i < atlas.uvs.length; i++) assert.ok(atlas.uvs[i] >= -1e-4 && atlas.uvs[i] <= 1 + 1e-4);
  const legs = (face) => {
    const u = (k) => atlas.uvs[(face * 3 + k) * 2];
    const v = (k) => atlas.uvs[(face * 3 + k) * 2 + 1];
    return [0, 1, 2].map((i) => {
      const j = (i + 1) % 3;
      return Math.hypot(u(j) - u(i), v(j) - v(i));
    }).sort((x, y) => x - y);
  };
  for (const face of [0, 1]) {
    const [s, m, hyp] = legs(face);
    assert.ok(Math.abs(s - m) < 1e-4, `legs ${s} ${m}`);
    assert.ok(Math.abs(hyp - s * Math.SQRT2) < 1e-3, `hyp ${hyp} vs ${s}`);
  }
});

test('UVs that already sit on different parts of the texture stay put', () => {
  const mesh = parseMeshText('apart.json', JSON.stringify({
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0],
    indices: [0, 1, 2, 3, 4, 5],
    uvs: [0, 0, 0.4, 0, 0, 0.4, 0.6, 0, 1, 0, 0.6, 0.4],
    groups: [
      { name: 'a', start: 0, count: 1 },
      { name: 'b', start: 1, count: 1 },
    ],
  }));
  const atlas = unwrapMesh(mesh, { useExisting: true, resolution: 128 });
  assert.equal(atlas.separated, 0);
  assert.equal(atlas.uvs[0], 0);
  assert.equal(atlas.uvs[1], 1);
  assert.ok(Math.abs(atlas.uvs[6] - 0.6) < 1e-5);
  assert.equal(atlas.uvs[7], 1);
});

test('a seam is forced where two objects share an edge', () => {
  const obj = `
v 0 0 0
v 1 0 0
v 0 1 0
v 1 1 0
g left
f 1 2 3
g right
f 2 4 3
`;
  const atlas = unwrapMesh(parseOBJ(obj), { angle: 180, padding: 0, resolution: 128 });
  assert.equal(atlas.charts, 2);
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
