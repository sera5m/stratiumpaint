// Mesh load + UV unwrap. No DOM.
//
// Charts are face groups that stay joined while the angle between them is under the
// threshold (a sharp edge is a seam). Each chart is flattened with LSCM, or projected
// onto a plane when the chart is too big or the solve collapses. Islands are then
// packed into one atlas. UVs are image-space: (0,0) is the top-left of the texture.

import { clamp } from './util.js';
import { parseFBX, parseSTL } from './meshio.js';
import { parseGLB } from './gltf.js';

const MAX_TRIS = 200000;
const LSCM_MAX_VERTS = 2500;

/** A generated hard-surface prop: body, sensor head, pull tab. Units are metres. */
export function demoMesh() {
  const positions = [];
  const indices = [];
  const groups = [];
  const add = (x, y, z) => { positions.push(x, y, z); return positions.length / 3 - 1; };
  const tri = (a, b, c) => indices.push(a, b, c);
  const begin = (name) => groups.push({ name, start: indices.length / 3, count: 0 });
  const end = () => { const g = groups[groups.length - 1]; g.count = indices.length / 3 - g.start; };

  const cylinder = (name, cx, cy, cz, radius, height, sides) => {
    begin(name);
    const bot = [], top = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const x = cx + Math.cos(a) * radius, z = cz + Math.sin(a) * radius;
      bot.push(add(x, cy, z));
      top.push(add(x, cy + height, z));
    }
    const cb = add(cx, cy, cz), ct = add(cx, cy + height, cz);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      tri(bot[i], top[i], top[j]);
      tri(bot[i], top[j], bot[j]);
      tri(cb, bot[j], bot[i]);
      tri(ct, top[i], top[j]);
    }
    end();
  };

  cylinder('body', 0, 0, 0, 0.12, 0.07, 16);
  cylinder('sensor', 0, 0.07, 0, 0.045, 0.05, 12);

  begin('pull tab');
  const box = (x0, y0, z0, x1, y1, z1) => {
    const v = [
      add(x0, y0, z0), add(x1, y0, z0), add(x1, y1, z0), add(x0, y1, z0),
      add(x0, y0, z1), add(x1, y0, z1), add(x1, y1, z1), add(x0, y1, z1),
    ];
    const quads = [[0, 1, 2, 3], [4, 6, 5, 7], [0, 4, 5, 1], [3, 2, 6, 7], [0, 3, 7, 4], [1, 5, 6, 2]];
    for (const q of quads) { tri(v[q[0]], v[q[1]], v[q[2]]); tri(v[q[0]], v[q[2]], v[q[3]]); }
  };
  box(0.12, 0.02, -0.012, 0.19, 0.05, 0.012);
  end();

  return finish(positions, indices, groups, null, 'Demo mine');
}

/** OBJ, JSON, STL, FBX or GLB bytes → a mesh. Files without UVs are unwrapped. */
export async function parseMeshBytes(name, bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const lower = String(name || '').toLowerCase();
  if (lower.endsWith('.stl')) return fromPlain(await Promise.resolve(parseSTL(u8, name)));
  if (lower.endsWith('.fbx')) return fromPlain(await parseFBX(u8, name));
  if (lower.endsWith('.glb') || lower.endsWith('.gltf')) return fromPlain(parseGLB(u8, name));
  const text = new TextDecoder().decode(u8);
  return parseMeshText(name, text);
}

function fromPlain(mesh) {
  if (!mesh.indices.length) throw new Error('That file has no triangles. Curves and NURBS are skipped — export a polygon mesh.');
  if (mesh.indices.length / 3 > MAX_TRIS) throw new Error(`That mesh has ${mesh.indices.length / 3} triangles. Export a reduced one (under ${MAX_TRIS}).`);
  const groups = mesh.groups.length ? mesh.groups : [{ name: 'default', start: 0, count: mesh.indices.length / 3 }];
  return finish(mesh.positions, mesh.indices, groups, cornerUVOf(mesh), mesh.name);
}

function cornerUVOf(mesh) {
  if (mesh.cornerUV && mesh.cornerUV.length === mesh.indices.length * 2) {
    return mesh.cornerUV instanceof Float32Array ? mesh.cornerUV : Float32Array.from(mesh.cornerUV);
  }
  const uvs = mesh.uvs;
  if (!uvs || uvs.length !== mesh.positions.length / 3 * 2) return null;
  const corner = new Float32Array(mesh.indices.length * 2);
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
    corner[i * 2] = uvs[v * 2];
    corner[i * 2 + 1] = uvs[v * 2 + 1];
  }
  return corner;
}

/** OBJ text, or JSON `{ positions, indices, uvs? }`. `uvs` are per corner (or per vertex), v = 0 at the bottom. */
export function parseMeshText(name, text) {
  if (/\.json$/i.test(name)) return parseMeshJSON(text, name);
  return parseOBJ(text, name);
}

export function parseOBJ(text, name = 'Model') {
  const verts = [];
  const vt = [];
  const indices = [];
  const cornerUV = [];
  const groups = [];
  let group = 'default';
  let open = null;
  let missingUV = false;

  const begin = (n) => {
    const name = n || 'default';
    if (open && indices.length / 3 === open.start) { open.name = name; group = name; return; }
    if (open) open.count = indices.length / 3 - open.start;
    open = { name, start: indices.length / 3, count: 0 };
    groups.push(open);
    group = name;
  };
  begin(group);

  const vertAt = (tok) => {
    let i = parseInt(tok, 10);
    if (!Number.isFinite(i) || i === 0) return -1;
    if (i < 0) i = verts.length / 3 + i + 1;
    return i - 1;
  };
  const uvAt = (tok) => {
    if (!tok) return null;
    let i = parseInt(tok, 10);
    if (!Number.isFinite(i) || i === 0) return null;
    if (i < 0) i = vt.length / 2 + i + 1;
    i -= 1;
    if (i < 0 || i >= vt.length / 2) return null;
    return i;
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split(/\s+/);
    const tag = p[0];
    if (tag === 'v' && p.length >= 4) verts.push(+p[1], +p[2], +p[3]);
    else if (tag === 'vt' && p.length >= 3) vt.push(+p[1], +p[2]);
    else if (tag === 'o' || tag === 'g') begin(p.slice(1).join(' ') || group);
    else if (tag === 'f' && p.length >= 4) {
      const poly = [];
      const uvs = [];
      for (let k = 1; k < p.length; k++) {
        const bits = p[k].split('/');
        const vi = vertAt(bits[0]);
        if (vi < 0 || vi >= verts.length / 3) { poly.length = 0; break; }
        poly.push(vi);
        const ui = uvAt(bits[1]);
        uvs.push(ui);
        if (ui == null) missingUV = true;
      }
      if (poly.length < 3) continue;
      for (let k = 1; k < poly.length - 1; k++) {
        indices.push(poly[0], poly[k], poly[k + 1]);
        const pushUV = (ui) => {
          if (ui == null) cornerUV.push(0, 0);
          else cornerUV.push(vt[ui * 2], vt[ui * 2 + 1]);
        };
        pushUV(uvs[0]); pushUV(uvs[k]); pushUV(uvs[k + 1]);
      }
    }
  }
  if (open) open.count = indices.length / 3 - open.start;
  const kept = groups.filter((g) => g.count > 0);
  if (!indices.length) throw new Error('That file has no triangles.');
  if (indices.length / 3 > MAX_TRIS) throw new Error(`That mesh has ${indices.length / 3} triangles. Export a reduced one (under ${MAX_TRIS}).`);
  return finish(verts, indices, kept, missingUV ? null : Float32Array.from(cornerUV), name.replace(/\.[^.]+$/, ''));
}

function parseMeshJSON(text, name) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('That JSON is not a mesh.'); }
  const pos = data.positions || data.verts;
  const idx = data.indices || data.faces;
  if (!pos || !idx) throw new Error('JSON mesh needs "positions" and "indices".');
  if (idx.length % 3) throw new Error('indices must be triangles.');
  if (idx.length / 3 > MAX_TRIS) throw new Error(`That mesh has ${idx.length / 3} triangles. Export a reduced one (under ${MAX_TRIS}).`);
  let corner = null;
  if (data.uvs && data.uvs.length === idx.length * 2) corner = Float32Array.from(data.uvs);
  else if (data.uvs && data.uvs.length === pos.length / 3 * 2) {
    corner = new Float32Array(idx.length * 2);
    for (let i = 0; i < idx.length; i++) {
      const v = idx[i];
      corner[i * 2] = data.uvs[v * 2];
      corner[i * 2 + 1] = data.uvs[v * 2 + 1];
    }
  }
  const groups = Array.isArray(data.groups) ? data.groups : [{ name: 'default', start: 0, count: idx.length / 3 }];
  return finish(pos, idx, groups, corner, (data.name || name || 'Model').replace(/\.[^.]+$/, ''));
}

function finish(positions, indices, groups, cornerUV, name) {
  return {
    name,
    positions: positions instanceof Float32Array ? positions : Float32Array.from(positions),
    indices: indices instanceof Uint32Array ? indices : Uint32Array.from(indices),
    groups,
    cornerUV,
    hasUV: !!cornerUV,
  };
}

/**
 * Build an atlas for `mesh`.
 * opts: { angle=66, padding=64, resolution=1024, pxPerM=0, useExisting=false }
 * UVs on the result are per corner, image-space (v down). Charts are turned so
 * the top of the texture is up on the model.
 */
export function unwrapMesh(mesh, opts = {}) {
  const resolution = clamp(Math.round(+opts.resolution || 1024), 64, 4096);
  let padding = opts.padding == null || opts.padding === '' ? 64 : +opts.padding;
  if (!Number.isFinite(padding)) padding = 64;
  padding = clamp(Math.round(padding), 0, 512);
  const pxPerM = Math.max(0, +opts.pxPerM || 0);
  if (opts.useExisting && mesh.hasUV) return adoptUVs(mesh, resolution, padding);

  const angle = clamp(+opts.angle || 66, 1, 180) * Math.PI / 180;
  const { charts, seams } = segment(mesh.positions, mesh.indices, angle, mesh.groups);
  const islands = [];
  let projected = 0;
  for (const faces of charts) {
    const flat = flattenChart(mesh.positions, mesh.indices, faces);
    if (flat.projected) projected++;
    islands.push(flat);
  }
  const atlas = packIslands(islands, { resolution, padding, pxPerM });
  const uvs = new Float32Array(mesh.indices.length * 2);
  const islandRects = [];
  islands.forEach((island, i) => {
    const place = atlas.places[i];
    islandRects.push({
      x: place.x * atlas.scale, y: place.y * atlas.scale,
      w: island.w * atlas.scale, h: island.h * atlas.scale,
    });
    for (let t = 0; t < island.faces.length; t++) {
      const f = island.faces[t];
      for (let k = 0; k < 3; k++) {
        const li = island.faceLocal[t][k];
        const o = (f * 3 + k) * 2;
        uvs[o] = ((place.x + island.uv[li * 2]) * atlas.scale) / atlas.width;
        uvs[o + 1] = ((place.y + island.uv[li * 2 + 1]) * atlas.scale) / atlas.height;
      }
    }
  });
  return {
    mesh,
    positions: mesh.positions,
    indices: mesh.indices,
    groups: mesh.groups,
    uvs,
    wires: chartWires(mesh.indices, uvs, islands),
    charts: charts.length,
    seams,
    projected,
    width: atlas.width,
    height: atlas.height,
    islandRects,
    showWires: true,
    separated: 0,
  };
}

function adoptUVs(mesh, resolution, padding) {
  const n = mesh.indices.length;
  const raw = mesh.cornerUV;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  const img = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const u = raw[i * 2], v = 1 - raw[i * 2 + 1];
    img[i * 2] = u; img[i * 2 + 1] = v;
    if (u < minU) minU = u; if (v < minV) minV = v;
    if (u > maxU) maxU = u; if (v > maxV) maxV = v;
  }
  const outside = minU < -1e-4 || minV < -1e-4 || maxU > 1 + 1e-4 || maxV > 1 + 1e-4;
  const uvs = new Float32Array(n * 2);
  if (outside && maxU > minU && maxV > minV) {
    for (let i = 0; i < n; i++) {
      uvs[i * 2] = (img[i * 2] - minU) / (maxU - minU);
      uvs[i * 2 + 1] = (img[i * 2 + 1] - minV) / (maxV - minV);
    }
  } else {
    uvs.set(img);
  }
  const separated = separateObjects(uvs, mesh.groups, resolution, padding);
  return {
    mesh, positions: mesh.positions, indices: mesh.indices, groups: mesh.groups,
    uvs, wires: allWires(mesh.indices, uvs), charts: 0, seams: 0, projected: 0,
    width: resolution, height: resolution, islandRects: [], showWires: true, keptUVs: true,
    separated,
  };
}

// Objects in a glTF each bring their own 0–1 UV square on one shared image.
// Where those squares overlap, give every object its own cell so a stroke
// cannot land on the others. Layout inside an object is kept. Already-separate
// UVs (and a single object) are left exactly where they are.
function separateObjects(uvs, groups, resolution, padding) {
  const nF = uvs.length / 6;
  const owner = faceOwner(nF, groups);
  if (!owner) return 0;
  const boxes = new Map();
  for (let f = 0; f < nF; f++) {
    const id = owner[f];
    let b = boxes.get(id);
    if (!b) boxes.set(id, b = { id, minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity });
    for (let k = 0; k < 3; k++) {
      const o = (f * 3 + k) * 2;
      const u = uvs[o], v = uvs[o + 1];
      if (u < b.minU) b.minU = u; if (v < b.minV) b.minV = v;
      if (u > b.maxU) b.maxU = u; if (v > b.maxV) b.maxV = v;
    }
  }
  const list = [...boxes.values()];
  if (list.length < 2) return 0;
  const overlaps = (a, b) => a.minU < b.maxU - 1e-4 && b.minU < a.maxU - 1e-4
    && a.minV < b.maxV - 1e-4 && b.minV < a.maxV - 1e-4;
  let stacked = false;
  for (let i = 0; i < list.length && !stacked; i++) {
    for (let j = i + 1; j < list.length; j++) if (overlaps(list[i], list[j])) { stacked = true; break; }
  }
  if (!stacked) return 0;
  const cols = Math.ceil(Math.sqrt(list.length));
  const rows = Math.ceil(list.length / cols);
  list.forEach((b, i) => {
    const col = i % cols, row = (i / cols) | 0;
    const cellW = 1 / cols, cellH = 1 / rows;
    const du = Math.max(b.maxU - b.minU, 1e-6);
    const dv = Math.max(b.maxV - b.minV, 1e-6);
    const sep = Math.min((padding > 0 ? padding : 0) / Math.max(resolution, 1), Math.min(cellW, cellH) * 0.45);
    const s = Math.min((cellW - sep) / du, (cellH - sep) / dv);
    const w = du * s, h = dv * s;
    b.ox = col * cellW + (cellW - w) / 2;
    b.oy = row * cellH + (cellH - h) / 2;
    b.s = s;
  });
  for (let f = 0; f < nF; f++) {
    const b = boxes.get(owner[f]);
    if (!b) continue;
    for (let k = 0; k < 3; k++) {
      const o = (f * 3 + k) * 2;
      uvs[o] = b.ox + (uvs[o] - b.minU) * b.s;
      uvs[o + 1] = b.oy + (uvs[o + 1] - b.minV) * b.s;
    }
  }
  return list.length;
}

function faceOwner(nF, groups) {
  if (!groups || groups.length < 2) return null;
  const ids = new Int32Array(nF);
  ids.fill(-1);
  let n = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const end = Math.min(nF, (g.start | 0) + (g.count | 0));
    const start = Math.max(0, g.start | 0);
    if (end <= start) continue;
    n++;
    for (let f = start; f < end; f++) ids[f] = gi;
  }
  return n >= 2 ? ids : null;
}

// ---------------------------------------------------------------- charts

function segment(positions, indices, angle, groups) {
  const nF = indices.length / 3;
  const owner = faceOwner(nF, groups);
  const normals = new Float32Array(nF * 3);
  const edges = new Map();
  for (let f = 0; f < nF; f++) {
    const a = indices[f * 3], b = indices[f * 3 + 1], c = indices[f * 3 + 2];
    const n = faceNormal(positions, a, b, c);
    normals[f * 3] = n[0]; normals[f * 3 + 1] = n[1]; normals[f * 3 + 2] = n[2];
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      let list = edges.get(key);
      if (!list) edges.set(key, list = []);
      list.push(f);
    }
  }
  const adj = Array.from({ length: nF }, () => []);
  let seams = 0;
  for (const list of edges.values()) {
    if (list.length !== 2) { seams++; continue; }
    const f0 = list[0], f1 = list[1];
    if (owner && owner[f0] !== owner[f1]) { seams++; continue; }
    const d = normals[f0 * 3] * normals[f1 * 3] + normals[f0 * 3 + 1] * normals[f1 * 3 + 1] + normals[f0 * 3 + 2] * normals[f1 * 3 + 2];
    if (Math.acos(clamp(d, -1, 1)) > angle) { seams++; continue; }
    adj[f0].push(f1); adj[f1].push(f0);
  }
  const seen = new Uint8Array(nF);
  const charts = [];
  for (let f = 0; f < nF; f++) {
    if (seen[f]) continue;
    const stack = [f];
    const faces = [];
    seen[f] = 1;
    while (stack.length) {
      const cur = stack.pop();
      faces.push(cur);
      for (const n of adj[cur]) if (!seen[n]) { seen[n] = 1; stack.push(n); }
    }
    charts.push(faces);
  }
  return { charts, seams };
}

function faceNormal(p, a, b, c) {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
  let x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

// ---------------------------------------------------------------- flatten

function flattenChart(positions, indices, faces) {
  const localOf = new Map();
  const locals = [];
  const faceLocal = [];
  for (const f of faces) {
    const tri = [];
    for (let k = 0; k < 3; k++) {
      const g = indices[f * 3 + k];
      let l = localOf.get(g);
      if (l === undefined) { l = locals.length; localOf.set(g, l); locals.push(g); }
      tri.push(l);
    }
    faceLocal.push(tri);
  }
  let uv = locals.length >= 3 && faces.length > 1 && locals.length <= LSCM_MAX_VERTS
    ? lscm(positions, locals, faceLocal) : null;
  let projected = false;
  if (!uv) { uv = project(positions, locals, faceLocal); projected = true; }
  fitIsland(uv, faceLocal, positions, locals);
  alignChartUp(uv, positions, locals, faceLocal);
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let i = 0; i < locals.length; i++) {
    const u = uv[i * 2], v = uv[i * 2 + 1];
    if (u < minU) minU = u; if (v < minV) minV = v;
    if (u > maxU) maxU = u; if (v > maxV) maxV = v;
  }
  for (let i = 0; i < locals.length; i++) { uv[i * 2] -= minU; uv[i * 2 + 1] -= minV; }
  return {
    faces, faceLocal, uv,
    w: Math.max(maxU - minU, 1e-6),
    h: Math.max(maxV - minV, 1e-6),
    projected,
  };
}

function fitIsland(uv, faceLocal, positions, locals) {
  let signed = 0, a2 = 0, a3 = 0;
  for (const tri of faceLocal) {
    const [i, j, k] = tri;
    signed += (uv[j * 2] - uv[i * 2]) * (uv[k * 2 + 1] - uv[i * 2 + 1]) - (uv[k * 2] - uv[i * 2]) * (uv[j * 2 + 1] - uv[i * 2 + 1]);
    a2 += Math.abs((uv[j * 2] - uv[i * 2]) * (uv[k * 2 + 1] - uv[i * 2 + 1]) - (uv[k * 2] - uv[i * 2]) * (uv[j * 2 + 1] - uv[i * 2 + 1])) * 0.5;
    a3 += triArea3(positions, locals[i], locals[j], locals[k]);
  }
  if (!(a2 > 1e-16) || !(a3 > 0)) return;
  if (signed < 0) {
    for (let i = 0; i < uv.length; i += 2) uv[i + 1] = -uv[i + 1];
  }
  const s = Math.sqrt(a3 / a2);
  for (let i = 0; i < uv.length; i++) uv[i] *= s;
}

// Turn the chart so world-up runs toward the top of the texture. A flat floor
// has no in-plane up, and is left as the solve produced it. Rotation keeps
// the winding, so a letter stays a letter instead of a mirror image.
function alignChartUp(uv, positions, locals, faceLocal) {
  const delta = (wx, wy, wz) => {
    let du = 0, dv = 0, wsum = 0;
    for (const [i, j, k] of faceLocal) {
      const pi = locals[i] * 3, pj = locals[j] * 3, pk = locals[k] * 3;
      const e1x = positions[pj] - positions[pi];
      const e1y = positions[pj + 1] - positions[pi + 1];
      const e1z = positions[pj + 2] - positions[pi + 2];
      const e2x = positions[pk] - positions[pi];
      const e2y = positions[pk + 1] - positions[pi + 1];
      const e2z = positions[pk + 2] - positions[pi + 2];
      const a11 = e1x * e1x + e1y * e1y + e1z * e1z;
      const a12 = e1x * e2x + e1y * e2y + e1z * e2z;
      const a22 = e2x * e2x + e2y * e2y + e2z * e2z;
      const det = a11 * a22 - a12 * a12;
      if (Math.abs(det) < 1e-18) continue;
      const b1 = e1x * wx + e1y * wy + e1z * wz;
      const b2 = e2x * wx + e2y * wy + e2z * wz;
      const a = (b1 * a22 - b2 * a12) / det;
      const b = (b2 * a11 - b1 * a12) / det;
      const area = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
      du += (a * (uv[j * 2] - uv[i * 2]) + b * (uv[k * 2] - uv[i * 2])) * area;
      dv += (a * (uv[j * 2 + 1] - uv[i * 2 + 1]) + b * (uv[k * 2 + 1] - uv[i * 2 + 1])) * area;
      wsum += area;
    }
    return { du, dv, wsum };
  };
  const up = delta(0, 1, 0);
  const len = Math.hypot(up.du, up.dv);
  if (!(len > 1e-8) || !(up.wsum > 0)) return;
  const ux = up.du / len, uy = up.dv / len;
  const cos = -uy, sin = -ux;
  for (let i = 0; i < uv.length; i += 2) {
    const u = uv[i], v = uv[i + 1];
    uv[i] = cos * u - sin * v;
    uv[i + 1] = sin * u + cos * v;
  }
  let nx = 0, ny = 0, nz = 0;
  for (const [i, j, k] of faceLocal) {
    const n = faceNormal(positions, locals[i], locals[j], locals[k]);
    const area = triArea3(positions, locals[i], locals[j], locals[k]);
    nx += n[0] * area; ny += n[1] * area; nz += n[2] * area;
  }
  // Right-hand side when looking at the outside of the face. If the texture
  // runs the other way, mirror it so a letter is not backwards.
  const right = delta(nz, 0, -nx);
  if (right.du < 0) {
    for (let i = 0; i < uv.length; i += 2) uv[i] = -uv[i];
  }
}

function triArea3(p, a, b, c) {
  const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
  const ux = p[b * 3] - ax, uy = p[b * 3 + 1] - ay, uz = p[b * 3 + 2] - az;
  const vx = p[c * 3] - ax, vy = p[c * 3 + 1] - ay, vz = p[c * 3 + 2] - az;
  const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
  return 0.5 * Math.hypot(x, y, z);
}

function project(positions, locals, faceLocal) {
  let nx = 0, ny = 0, nz = 0;
  for (const [i, j, k] of faceLocal) {
    const n = faceNormal(positions, locals[i], locals[j], locals[k]);
    const a = triArea3(positions, locals[i], locals[j], locals[k]);
    nx += n[0] * a; ny += n[1] * a; nz += n[2] * a;
  }
  let len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) { nx = 0; ny = 1; nz = 0; len = 1; }
  nx /= len; ny /= len; nz /= len;
  let tx, ty, tz;
  if (Math.abs(nx) < 0.9) { tx = 0; ty = nz; tz = -ny; }
  else { tx = nz; ty = 0; tz = -nx; }
  len = Math.hypot(tx, ty, tz) || 1;
  tx /= len; ty /= len; tz /= len;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
  const o = locals[0] * 3;
  const ox = positions[o], oy = positions[o + 1], oz = positions[o + 2];
  const uv = new Float64Array(locals.length * 2);
  for (let i = 0; i < locals.length; i++) {
    const p = locals[i] * 3;
    const dx = positions[p] - ox, dy = positions[p + 1] - oy, dz = positions[p + 2] - oz;
    uv[i * 2] = dx * tx + dy * ty + dz * tz;
    uv[i * 2 + 1] = dx * bx + dy * by + dz * bz;
  }
  return uv;
}

function lscm(positions, locals, faceLocal) {
  const n = locals.length;
  let ia = 0, ib = 1, best = -1;
  const limit = n > 800 ? 800 : n;
  const step = Math.max(1, Math.floor(n / limit));
  for (let i = 0; i < n; i += step) {
    for (let j = i + step; j < n; j += step) {
      const d = dist3(positions, locals[i], locals[j]);
      if (d > best) { best = d; ia = i; ib = j; }
    }
  }
  if (!(best > 1e-8)) return null;
  const pinU = new Float64Array(n), pinV = new Float64Array(n);
  pinU[ib] = best;
  const freeOf = new Int32Array(n).fill(-1);
  let nf = 0;
  for (let i = 0; i < n; i++) if (i !== ia && i !== ib) freeOf[i] = nf++;
  const nCols = nf * 2;
  if (!nCols) return null;

  const rows = [];
  for (const ids of faceLocal) {
    const p0 = at(positions, locals[ids[0]]);
    const p1 = at(positions, locals[ids[1]]);
    const p2 = at(positions, locals[ids[2]]);
    const loc = tri2d(p0, p1, p2);
    if (!loc) continue;
    const [x0, x1, x2] = loc.x, [y0, y1, y2] = loc.y;
    const denom = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const area = Math.abs(denom) * 0.5;
    if (area < 1e-14) continue;
    const w = Math.sqrt(area);
    const dNdx = [(y1 - y2) / denom, (y2 - y0) / denom, (y0 - y1) / denom];
    const dNdy = [(x2 - x1) / denom, (x0 - x2) / denom, (x1 - x0) / denom];
    for (let real = 0; real < 2; real++) {
      const cols = [];
      const vals = [];
      let rhs = 0;
      for (let k = 0; k < 3; k++) {
        const cu = w * (real === 0 ? dNdx[k] : dNdy[k]);
        const cv = w * (real === 0 ? -dNdy[k] : dNdx[k]);
        const li = ids[k];
        if (li === ia || li === ib) rhs -= cu * pinU[li] + cv * pinV[li];
        else { const f = freeOf[li]; cols.push(f * 2, f * 2 + 1); vals.push(cu, cv); }
      }
      rows.push({ cols, vals, rhs });
    }
  }
  if (!rows.length) return null;

  const nRows = rows.length;
  let nnz = 0;
  for (const r of rows) nnz += r.cols.length;
  const rowPtr = new Int32Array(nRows + 1);
  const colA = new Int32Array(nnz);
  const valA = new Float64Array(nnz);
  const rhs = new Float64Array(nRows);
  let p = 0;
  for (let i = 0; i < nRows; i++) {
    rowPtr[i] = p;
    const r = rows[i];
    rhs[i] = r.rhs;
    for (let k = 0; k < r.cols.length; k++) { colA[p] = r.cols[k]; valA[p] = r.vals[k]; p++; }
  }
  rowPtr[nRows] = p;

  const y = new Float64Array(nRows);
  const Atb = new Float64Array(nCols);
  applyAt(rowPtr, colA, valA, rhs, Atb);
  const Ax = new Float64Array(nCols);
  const matvec = (x, out) => {
    applyA(rowPtr, colA, valA, x, y);
    applyAt(rowPtr, colA, valA, y, out);
  };
  const sol = cg(matvec, Atb, Ax, Math.min(nCols, 400));
  const uv = new Float64Array(n * 2);
  uv[ia * 2] = pinU[ia]; uv[ia * 2 + 1] = pinV[ia];
  uv[ib * 2] = pinU[ib]; uv[ib * 2 + 1] = pinV[ib];
  for (let i = 0; i < n; i++) {
    if (freeOf[i] < 0) continue;
    const u = sol[freeOf[i] * 2], v = sol[freeOf[i] * 2 + 1];
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    uv[i * 2] = u; uv[i * 2 + 1] = v;
  }
  let a2 = 0;
  for (const [i, j, k] of faceLocal) {
    a2 += Math.abs((uv[j * 2] - uv[i * 2]) * (uv[k * 2 + 1] - uv[i * 2 + 1]) - (uv[k * 2] - uv[i * 2]) * (uv[j * 2 + 1] - uv[i * 2 + 1]));
  }
  if (!(a2 > 1e-10)) return null;
  return uv;
}

function at(p, i) { return [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]]; }

function dist3(p, a, b) {
  const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
  return Math.hypot(dx, dy, dz);
}

function tri2d(p0, p1, p2) {
  const e1x = p1[0] - p0[0], e1y = p1[1] - p0[1], e1z = p1[2] - p0[2];
  const e2x = p2[0] - p0[0], e2y = p2[1] - p0[1], e2z = p2[2] - p0[2];
  const len1 = Math.hypot(e1x, e1y, e1z);
  if (len1 < 1e-12) return null;
  const ux = e1x / len1, uy = e1y / len1, uz = e1z / len1;
  const dot = e2x * ux + e2y * uy + e2z * uz;
  let vx = e2x - dot * ux, vy = e2y - dot * uy, vz = e2z - dot * uz;
  const vl = Math.hypot(vx, vy, vz);
  if (vl < 1e-12) return null;
  vx /= vl; vy /= vl; vz /= vl;
  return { x: [0, len1, e2x * ux + e2y * uy + e2z * uz], y: [0, 0, e2x * vx + e2y * vy + e2z * vz] };
}

function applyA(rowPtr, colA, valA, x, y) {
  for (let i = 0; i < y.length; i++) {
    let s = 0;
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) s += valA[k] * x[colA[k]];
    y[i] = s;
  }
}

function applyAt(rowPtr, colA, valA, y, out) {
  out.fill(0);
  for (let i = 0; i < y.length; i++) {
    const yi = y[i];
    if (yi === 0) continue;
    for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) out[colA[k]] += valA[k] * yi;
  }
}

function cg(matvec, b, tmp, iters) {
  const n = b.length;
  const x = new Float64Array(n);
  const r = Float64Array.from(b);
  const p = Float64Array.from(b);
  let rs = 0;
  for (let i = 0; i < n; i++) rs += r[i] * r[i];
  const tol = rs * 1e-16 + 1e-18;
  for (let it = 0; it < iters && rs > tol; it++) {
    matvec(p, tmp);
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i] * tmp[i];
    if (Math.abs(pAp) < 1e-20) break;
    const alpha = rs / pAp;
    let rsNew = 0;
    for (let i = 0; i < n; i++) {
      x[i] += alpha * p[i];
      r[i] -= alpha * tmp[i];
      rsNew += r[i] * r[i];
    }
    const beta = rsNew / rs;
    for (let i = 0; i < n; i++) p[i] = r[i] + beta * p[i];
    rs = rsNew;
  }
  return x;
}

// ---------------------------------------------------------------- pack

function packIslands(islands, { resolution, padding, pxPerM }) {
  const sizes = islands.map((d) => ({ w: d.w, h: d.h }));
  const cap = 4096;
  let packed = shelf(sizes, 0);
  let scale = pxPerM > 0 ? pxPerM : resolution / Math.max(packed.binW, packed.binH, 1e-6);
  if (!(scale > 0)) scale = 1;
  const repack = () => {
    packed = shelf(sizes, padding / scale);
    if (!(pxPerM > 0)) scale = resolution / Math.max(packed.binW, packed.binH, 1e-6);
  };
  repack();
  repack();
  let width = Math.max(1, Math.ceil(packed.binW * scale - 1e-9));
  let height = Math.max(1, Math.ceil(packed.binH * scale - 1e-9));
  if (width > cap || height > cap || (!(pxPerM > 0) && Math.max(width, height) > resolution)) {
    const limit = pxPerM > 0 ? cap : Math.min(cap, resolution);
    const f = limit / Math.max(width, height);
    scale *= f;
    width = Math.max(1, Math.ceil(packed.binW * scale - 1e-9));
    height = Math.max(1, Math.ceil(packed.binH * scale - 1e-9));
  }
  width = clamp(width, 16, cap);
  height = clamp(height, 16, cap);
  return { places: packed.places, scale, width, height };
}

function shelf(rects, pad) {
  const items = rects.map((r, i) => ({ i, w: r.w + pad, h: r.h + pad }));
  items.sort((a, b) => b.h - a.h || b.w - a.w);
  if (!items.length) return { places: [], binW: 1, binH: 1 };
  const area = items.reduce((s, it) => s + it.w * it.h, 0) || 1;
  const widest = items.reduce((m, it) => Math.max(m, it.w), 0);
  const attempt = (width) => {
    if (widest > width + 1e-9) return null;
    const places = new Array(rects.length);
    let x = 0, y = 0, rowH = 0, maxW = 0;
    for (const it of items) {
      if (x > 0 && x + it.w > width + 1e-8) { y += rowH; x = 0; rowH = 0; }
      places[it.i] = { x, y };
      x += it.w;
      if (it.h > rowH) rowH = it.h;
      if (x > maxW) maxW = x;
    }
    return { places, binW: Math.max(maxW, 1e-6), binH: Math.max(y + rowH, 1e-6) };
  };
  let best = null;
  for (const s of [0.75, 1, 1.25, 1.6, Math.max(1, widest / Math.sqrt(area))]) {
    const packed = attempt(Math.max(widest, Math.sqrt(area) * s));
    if (!packed) continue;
    const aspect = Math.max(packed.binW, packed.binH) / Math.min(packed.binW, packed.binH);
    const waste = (packed.binW * packed.binH) / area;
    const score = aspect + waste * 0.2;
    if (!best || score < best.score) best = { ...packed, score };
  }
  return best || attempt(widest);
}

function chartWires(indices, uvs, islands) {
  const lines = [];
  const seen = new Set();
  const add = (a, b) => {
    const u0 = uvs[a * 2], v0 = uvs[a * 2 + 1], u1 = uvs[b * 2], v1 = uvs[b * 2 + 1];
    const q = (n) => Math.round(n * 1e5);
    const k1 = `${q(u0)},${q(v0)}|${q(u1)},${q(v1)}`;
    const k2 = `${q(u1)},${q(v1)}|${q(u0)},${q(v0)}`;
    if (seen.has(k1) || seen.has(k2)) return;
    seen.add(k1);
    lines.push(u0, v0, u1, v1);
  };
  const budget = islands.reduce((s, d) => s + d.faces.length, 0) <= 8000;
  for (const island of islands) {
    for (const f of island.faces) {
      const a = f * 3, b = a + 1, c = a + 2;
      add(a, b); add(b, c); add(c, a);
      if (!budget && lines.length > 20000 * 4) return Float32Array.from(lines);
    }
  }
  return Float32Array.from(lines);
}

function allWires(indices, uvs) {
  const fake = [{ faces: Array.from({ length: indices.length / 3 }, (_, i) => i) }];
  return chartWires(indices, uvs, fake);
}

/** Ray acceleration structure for a mounted mesh. */
export function buildBVH(positions, indices) {
  const n = indices.length / 3;
  const tris = new Array(n);
  for (let t = 0; t < n; t++) {
    const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const i of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        const v = positions[i * 3 + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    tris[t] = { t, min, max, mid: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2] };
  }
  const rec = (list, depth) => {
    const box = emptyBox();
    for (const tri of list) grow(box, tri.min, tri.max);
    if (list.length <= 8 || depth > 28) return { box, tris: list };
    let axis = 0;
    const ext = [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
    if (ext[1] > ext[axis]) axis = 1;
    if (ext[2] > ext[axis]) axis = 2;
    list.sort((a, b) => a.mid[axis] - b.mid[axis]);
    const mid = list.length >> 1;
    if (mid === 0 || mid === list.length) return { box, tris: list };
    return { box, left: rec(list.slice(0, mid), depth + 1), right: rec(list.slice(mid), depth + 1) };
  };
  return { root: rec(tris, 0), positions, indices };
}

function emptyBox() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}
function grow(box, min, max) {
  for (let k = 0; k < 3; k++) {
    if (min[k] < box.min[k]) box.min[k] = min[k];
    if (max[k] > box.max[k]) box.max[k] = max[k];
  }
}

/** → { tri, u, v, t } barycentric (u on edge to vert 1, v on edge to vert 2) or null. */
export function raycastMesh(bvh, origin, dir) {
  let best = null;
  const visit = (node) => {
    if (!node || !hitBox(node.box, origin, dir, best ? best.t : Infinity)) return;
    if (node.tris) {
      for (const tri of node.tris) {
        const hit = rayTri(bvh.positions, bvh.indices, tri.t, origin, dir);
        if (hit && (!best || hit.t < best.t)) best = hit;
      }
      return;
    }
    visit(node.left); visit(node.right);
  };
  visit(bvh.root);
  return best;
}

function hitBox(box, origin, dir, tmax) {
  let t0 = 0, t1 = tmax;
  for (let k = 0; k < 3; k++) {
    const d = dir[k];
    if (Math.abs(d) < 1e-12) {
      if (origin[k] < box.min[k] || origin[k] > box.max[k]) return false;
      continue;
    }
    let a = (box.min[k] - origin[k]) / d, b = (box.max[k] - origin[k]) / d;
    if (a > b) { const s = a; a = b; b = s; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }
  return t1 >= 0;
}

function rayTri(positions, indices, tri, origin, dir) {
  const ia = indices[tri * 3], ib = indices[tri * 3 + 1], ic = indices[tri * 3 + 2];
  const ax = positions[ia * 3], ay = positions[ia * 3 + 1], az = positions[ia * 3 + 2];
  const e1x = positions[ib * 3] - ax, e1y = positions[ib * 3 + 1] - ay, e1z = positions[ib * 3 + 2] - az;
  const e2x = positions[ic * 3] - ax, e2y = positions[ic * 3 + 1] - ay, e2z = positions[ic * 3 + 2] - az;
  const px = dir[1] * e2z - dir[2] * e2y, py = dir[2] * e2x - dir[0] * e2z, pz = dir[0] * e2y - dir[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = origin[0] - ax, ty = origin[1] - ay, tz = origin[2] - az;
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return null;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (dir[0] * qx + dir[1] * qy + dir[2] * qz) * inv;
  if (v < 0 || u + v > 1) return null;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  if (t < 1e-5) return null;
  return { tri, u, v, t };
}
