import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGLB } from '../src/js/core/gltf.js';
import { parseMeshBytes } from '../src/js/core/mesh.js';

const enc = new TextEncoder();

test('GLB triangle keeps its node translation and its UVs', async () => {
  const pos = f32([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uv = f32([0, 0, 1, 0, 0, 1]);
  const idx = u16([0, 1, 2]);
  const bin = concat([pos, uv, idx]);
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'panel', mesh: 0, translation: [10, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length },
      { buffer: 0, byteOffset: pos.length, byteLength: uv.length },
      { buffer: 0, byteOffset: pos.length + uv.length, byteLength: idx.length },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const mesh = await parseMeshBytes('panel.glb', glbOf(json, bin));
  assert.equal(mesh.indices.length, 3);
  assert.equal(mesh.groups[0].name, 'panel');
  assert.equal(mesh.positions[0], 10);
  assert.equal(mesh.positions[3], 11);
  assert.equal(mesh.hasUV, true);
  assert.equal(mesh.cornerUV[2], 1);
  assert.equal(mesh.cornerUV[5], 1);
});

test('a child node is placed relative to its parent', () => {
  const pos = f32([0, 0, 0]);
  const idx = u16([0, 0, 0]);
  const bin = concat([pos, idx]);
  const json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [
      { translation: [10, 0, 0], children: [1] },
      { mesh: 0, translation: [1, 2, 3] },
    ],
    meshes: [{ name: 'dot', primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length },
      { buffer: 0, byteOffset: pos.length, byteLength: idx.length },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const mesh = parseGLB(glbOf(json, bin), 'dot.glb');
  assert.equal(mesh.positions[0], 11);
  assert.equal(mesh.positions[1], 2);
  assert.equal(mesh.positions[2], 3);
  assert.equal(mesh.uvs, null);
});

test('a 90 degree spin and a triangle strip both come out right', () => {
  const s = Math.SQRT1_2;
  const pos = f32([1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 2, 0]);
  const idx = u16([0, 1, 2, 3]);
  const bin = concat([pos, idx]);
  const json = {
    asset: { version: '2.0' },
    nodes: [{ mesh: 0, rotation: [0, 0, s, s] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 5 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3' },
      { bufferView: 1, componentType: 5123, count: 4, type: 'SCALAR' },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.length },
      { buffer: 0, byteOffset: pos.length, byteLength: idx.length },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const mesh = parseGLB(glbOf(json, bin), 'strip.glb');
  assert.equal(mesh.indices.length / 3, 2);
  assert.ok(Math.abs(mesh.positions[0]) < 1e-5);
  assert.ok(Math.abs(mesh.positions[1] - 1) < 1e-5);
});

test('an unindexed primitive and a separate .bin glTF are handled', () => {
  const pos = f32([0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const json = {
    asset: { version: '2.0' },
    meshes: [{ name: 'solo', primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: pos.length }],
    buffers: [{ byteLength: pos.length, uri: `data:application/octet-stream;base64,${b64(pos)}` }],
  };
  const mesh = parseGLB(enc.encode(JSON.stringify(json)), 'solo.gltf');
  assert.equal(mesh.indices.length / 3, 1);
  assert.equal(mesh.groups[0].name, 'solo');
  assert.throws(() => parseGLB(enc.encode(JSON.stringify({
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ uri: 'mesh.bin', byteLength: 12 }],
  })), 'ext.gltf'), /Export a \.glb/);
});

function glbOf(json, bin) {
  const j = pad(enc.encode(JSON.stringify(json)), 0x20);
  const b = pad(bin, 0);
  const total = 12 + 8 + j.length + 8 + b.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546C67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, j.length, true);
  view.setUint32(16, 0x4E4F534A, true);
  out.set(j, 20);
  const o = 20 + j.length;
  view.setUint32(o, b.length, true);
  view.setUint32(o + 4, 0x004E4942, true);
  out.set(b, o + 8);
  return out;
}

function pad(u8, fill) {
  const n = (4 - (u8.length % 4)) % 4;
  if (!n) return u8;
  const out = new Uint8Array(u8.length + n);
  out.set(u8);
  out.fill(fill, u8.length);
  return out;
}

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function f32(arr) {
  const a = new Float32Array(arr);
  return new Uint8Array(a.buffer.slice(0));
}

function u16(arr) {
  const a = new Uint16Array(arr);
  return new Uint8Array(a.buffer.slice(0));
}

function b64(u8) {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s);
}
