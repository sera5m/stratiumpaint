import assert from 'node:assert/strict';
import test from 'node:test';
import { parseFBX, parseSTL } from '../src/js/core/meshio.js';
import { parseMeshBytes } from '../src/js/core/mesh.js';

const enc = new TextEncoder();

test('ASCII and binary STL both yield the triangle', async () => {
  const ascii = `solid tri
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid tri
`;
  const a = parseSTL(enc.encode(ascii), 'tri.stl');
  assert.equal(a.indices.length, 3);
  assert.equal(a.positions.length, 9);
  assert.equal(a.groups[0].name, 'tri');

  const bin = new Uint8Array(84 + 50);
  const view = new DataView(bin.buffer);
  view.setUint32(80, 1, true);
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  verts.forEach((v, i) => view.setFloat32(84 + 12 + i * 4, v, true));
  const b = await parseMeshBytes('tri.stl', bin);
  assert.equal(b.indices.length, 3);
  assert.equal(b.positions[3], 1);
  assert.equal(b.hasUV, false);
});

test('binary STL with a solid header and a trailer still has its triangle', () => {
  const bin = new Uint8Array(84 + 50 + 8);
  const view = new DataView(bin.buffer);
  const hdr = enc.encode('solid named-export');
  bin.set(hdr);
  view.setUint32(80, 1, true);
  const verts = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  verts.forEach((v, i) => view.setFloat32(84 + 12 + i * 4, v, true));
  const mesh = parseSTL(bin, 'tri.stl');
  assert.equal(mesh.indices.length, 3);
  assert.equal(mesh.positions[3], 1);
});

test('uppercase and comma-separated ASCII STL', () => {
  const text = `SOLID TRI
FACET NORMAL 0 0 1
  OUTER LOOP
    VERTEX 0, 0, 0
    VERTEX 1, 0, 0
    VERTEX 0, 1, 0
  ENDLOOP
ENDFACET
ENDSOLID TRI
`;
  const mesh = parseSTL(enc.encode(text), 'tri.stl');
  assert.equal(mesh.indices.length, 3);
  assert.equal(mesh.groups[0].name, 'TRI');
});

test('ASCII FBX polygon end-marker becomes one triangle', async () => {
  const text = `FBXHeaderExtension:  {\n}
Geometry: 1, "Geometry::head", "Mesh" {
  Vertices: *9 {
    a: 0,0,0, 2,0,0, 0,3,0
  }
  PolygonVertexIndex: *3 {
    a: 0,1,-3
  }
}
`;
  const mesh = await parseMeshBytes('head.fbx', enc.encode(text));
  assert.deepEqual(Array.from(mesh.indices), [0, 1, 2]);
  assert.equal(mesh.groups[0].name, 'head');
  assert.equal(mesh.positions[7], 3);
});

test('ASCII FBX ignores the properties that follow the index list', async () => {
  const text = `Geometry: 1, "Geometry::head", "Mesh" {
Vertices: 0,0,0,1,0,0
,0,1,0
PolygonVertexIndex: 0,1,-3
Edges:
GeometryVersion: 124
LayerElementNormal: 0 {
Normals: 0,0,1, 0,1,0, 1,0,0, -1,0,0
}
}
`;
  const mesh = await parseFBX(enc.encode(text), 'head.fbx');
  assert.equal(mesh.indices.length / 3, 1);
  assert.equal(mesh.positions.length / 3, 3);
  assert.equal(mesh.groups[0].name, 'head');
});

test('FBX triangles written without the negative end marker', async () => {
  const text = `Geometry: 9, "Geometry::panel", "Mesh" {
Vertices: *9 { a: 0,0,0, 2,0,0, 0,3,0 }
PolygonVertexIndex: *3 { a: 0,1,2 }
}
`;
  const mesh = await parseFBX(enc.encode(text), 'panel.fbx');
  assert.deepEqual(Array.from(mesh.indices), [0, 1, 2]);
});

test('binary FBX geometry, including a compressed array, triangulates', async () => {
  for (const version of [7400, 7700]) {
    const raw = await fbxBinary(version);
    const mesh = await parseFBX(raw, 'box.fbx');
    assert.equal(mesh.indices.length, 3, `version ${version}`);
    assert.equal(mesh.groups[0].name, 'box');
    assert.equal(mesh.positions[0], 1);
  }
});

async function fbxBinary(version = 7400) {
  const large = version >= 7500;
  const word = (n) => {
    const b = new Uint8Array(large ? 8 : 4);
    const view = new DataView(b.buffer);
    if (large) view.setBigUint64(0, BigInt(n), true);
    else view.setUint32(0, n, true);
    return b;
  };
  const u32 = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const parts = [];
  const push = (...xs) => parts.push(...xs);
  const size = () => parts.reduce((n, p) => n + p.length, 0);
  const vertBytes = new Uint8Array(new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]).buffer);
  const compressed = await deflate(new Uint8Array(new Int32Array([0, 1, ~2]).buffer.slice(0)));
  const propD = concat([enc.encode('d'), u32(9), u32(0), u32(vertBytes.length), vertBytes]);
  const propI = concat([enc.encode('i'), u32(3), u32(1), u32(compressed.length), compressed]);
  const box = enc.encode('Geometry::box\0\u0001Geometry');
  const mesh = enc.encode('Mesh');
  const propS = (b) => concat([enc.encode('S'), u32(b.length), b]);
  const id = new Uint8Array(8);
  new DataView(id.buffer).setBigInt64(0, 1n, true);
  const geoProps = concat([enc.encode('L'), id, propS(box), propS(mesh)]);
  const name = enc.encode('Geometry');
  const vName = enc.encode('Vertices');
  const iName = enc.encode('PolygonVertexIndex');
  const head = (large ? 25 : 13);
  const node = (end, count, prop, nm) => concat([
    word(end), word(count), word(prop.length), new Uint8Array([nm.length]), nm, prop,
  ]);
  push(enc.encode('Kaydara FBX Binary  \x00\x1a\x00'), u32(version));
  const geoAt = size();
  const vAt = geoAt + head + name.length + geoProps.length;
  const vEnd = vAt + head + vName.length + propD.length;
  const iEnd = vEnd + head + iName.length + propI.length;
  const geoEnd = iEnd + head;
  push(node(geoEnd, 3, geoProps, name));
  push(node(vEnd, 1, propD, vName));
  push(node(iEnd, 1, propI, iName));
  push(new Uint8Array(head), new Uint8Array(head));
  return concat(parts);
}

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function deflate(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
