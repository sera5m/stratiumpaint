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

/** Split each group into connected components (shared vertices). Unconnected geometry becomes separate objects. */
function splitConnected(positions, indices, groups) {
  const nF = indices.length / 3;
  if (!nF) return groups;
  const refined = [];
  const vertFaces = new Map();
  for (let f = 0; f < nF; f++) {
    for (let k = 0; k < 3; k++) {
      const v = indices[f * 3 + k];
      let list = vertFaces.get(v);
      if (!list) vertFaces.set(v, list = []);
      list.push(f);
    }
  }
  const seen = new Uint8Array(nF);
  const processRange = (start, count, baseName) => {
    const end = Math.min(nF, start + count);
    const inRange = new Uint8Array(nF);
    for (let f = start; f < end; f++) inRange[f] = 1;
    const comps = [];
    for (let f = start; f < end; f++) {
      if (seen[f]) continue;
      const faces = [];
      const stack = [f];
      seen[f] = 1;
      while (stack.length) {
        const cur = stack.pop();
        faces.push(cur);
        for (let k = 0; k < 3; k++) {
          const v = indices[cur * 3 + k];
          for (const nf of vertFaces.get(v) || []) {
            if (inRange[nf] && !seen[nf]) { seen[nf] = 1; stack.push(nf); }
          }
        }
      }
      if (faces.length) comps.push(faces);
    }
    comps.sort((a, b) => a[0] - b[0]);
    comps.forEach((faces, i) => {
      const name = comps.length === 1 ? baseName : `${baseName} #${i + 1}`;
      faces.sort((a, b) => a - b);
      let s = faces[0], c = 1;
      for (let j = 1; j < faces.length; j++) {
        if (faces[j] === faces[j - 1] + 1) c++;
        else { refined.push({ name, start: s, count: c }); s = faces[j]; c = 1; }
      }
      refined.push({ name, start: s, count: c });
    });
  };
  if (!groups || !groups.length) processRange(0, nF, 'object');
  else groups.forEach((g) => processRange(g.start | 0, g.count | 0, g.name || 'object'));
  return refined.filter((g) => g.count > 0);
}

function finish(positions, indices, groups, cornerUV, name) {
  const pos = positions instanceof Float32Array ? positions : Float32Array.from(positions);
  const idx = indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
  const split = splitConnected(pos, idx, groups);
  return {
    name,
    positions: pos,
    indices: idx,
    groups: split,
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
