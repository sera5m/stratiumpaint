// GLB and self-contained glTF → triangles.
// Node transforms are applied, so parts stay where the scene put them.
// UVs are glTF TEXCOORD_0 (v = 0 at the bottom), one pair per vertex.
// Draco and meshopt blobs are refused; those files have to be exported plain.

const dec = new TextDecoder();

const COMP_SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

export function parseGLB(bytes, name = 'Model') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 12 && u8[0] === 0x67 && u8[1] === 0x6c && u8[2] === 0x54 && u8[3] === 0x46) {
    return gltfToMesh(readChunks(u8), name);
  }
  let json;
  try { json = JSON.parse(dec.decode(u8).replace(/^\uFEFF/, '')); }
  catch { throw new Error('That file is not a GLB or glTF.'); }
  if (!json || typeof json !== 'object' || (!json.meshes && !json.nodes && !json.buffers)) {
    throw new Error('That file is not a GLB or glTF.');
  }
  return gltfToMesh({ json, bin: null }, name);
}

function readChunks(u8) {
  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB version ${version} is not supported. Export glTF 2.0.`);
  const declared = view.getUint32(8, true);
  const end = Math.min(u8.length, declared || u8.length);
  let json = null;
  let bin = null;
  let p = 12;
  while (p + 8 <= end) {
    const len = view.getUint32(p, true);
    const type = view.getUint32(p + 4, true);
    const data = u8.subarray(p + 8, Math.min(end, p + 8 + len));
    if (type === 0x4E4F534A) json = JSON.parse(dec.decode(data));
    else if (type === 0x004E4942 && !bin) bin = data;
    p += 8 + len;
  }
  if (!json) throw new Error('That GLB has no JSON chunk.');
  return { json, bin };
}

function gltfToMesh({ json, bin }, name) {
  const required = json.extensionsRequired || [];
  if (required.includes('KHR_draco_mesh_compression') || required.includes('EXT_meshopt_compression')) {
    throw new Error('That GLB is compressed. Export it as a plain GLB, without Draco or meshopt.');
  }
  const buffers = (json.buffers || []).map((b, i) => bufferBytes(b, i, bin));
  if (!buffers.length && bin) buffers.push(bin.subarray(0, bin.length));
  const positions = [];
  const indices = [];
  const uvs = [];
  const groups = [];
  let missingUV = false;
  let sawUV = false;
  const usedMeshes = new Set();

  const emit = (meshIndex, world, label) => {
    const mesh = json.meshes?.[meshIndex];
    if (!mesh) return;
    usedMeshes.add(meshIndex);
    const groupName = label || mesh.name || `mesh ${meshIndex}`;
    for (const prim of mesh.primitives || []) {
      const draco = prim.extensions?.KHR_draco_mesh_compression;
      if (draco && prim.attributes?.POSITION == null) {
        throw new Error('That GLB is Draco-compressed. Export it as a plain GLB.');
      }
      const mode = prim.mode ?? 4;
      if (mode < 4 || mode > 6) continue;
      if (prim.attributes?.POSITION == null) continue;
      const pos = readAccessor(json, buffers, prim.attributes.POSITION);
      const vcount = pos.length / 3;
      let uv = null;
      if (prim.attributes.TEXCOORD_0 == null) missingUV = true;
      else {
        uv = readAccessor(json, buffers, prim.attributes.TEXCOORD_0);
        if (uv.length < vcount * 2) missingUV = true;
        else sawUV = true;
      }
      const raw = prim.indices != null
        ? readAccessor(json, buffers, prim.indices)
        : indexRange(vcount);
      const tris = triangulate(raw, mode);
      if (!tris.length) continue;
      const base = positions.length / 3;
      const start = indices.length / 3;
      for (let i = 0; i < vcount; i++) {
        const p = transformPoint(world, pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
        positions.push(p[0], p[1], p[2]);
        if (uv && !missingUV) uvs.push(uv[i * 2] || 0, uv[i * 2 + 1] || 0);
      }
      for (let i = 0; i < tris.length; i++) indices.push(base + tris[i]);
      const count = indices.length / 3 - start;
      if (count > 0) groups.push({ name: groupName, start, count });
    }
  };

  const nodes = json.nodes || [];
  const scene = json.scenes?.[json.scene ?? 0];
  let roots = scene?.nodes;
  if (!roots) {
    const child = new Set();
    for (const node of nodes) for (const c of node.children || []) child.add(c);
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
  }
  const visit = (index, parent, stack) => {
    if (stack.has(index) || !nodes[index]) return;
    stack.add(index);
    const node = nodes[index];
    const world = mulMat(parent, nodeMatrix(node));
    if (node.mesh != null) emit(node.mesh, world, node.name || json.meshes?.[node.mesh]?.name);
    for (const c of node.children || []) visit(c, world, stack);
    stack.delete(index);
  };
  const stack = new Set();
  for (const r of roots || []) visit(r, IDENT, stack);

  if (!usedMeshes.size && json.meshes) {
    json.meshes.forEach((mesh, i) => emit(i, IDENT, mesh.name));
  }

  let vertUV = null;
  if (sawUV && !missingUV && uvs.length === positions.length / 3 * 2) vertUV = uvs;
  return {
    positions,
    indices,
    groups: groups.filter((g) => g.count > 0),
    uvs: vertUV,
    name: strip(name),
  };
}

function bufferBytes(buf, index, bin) {
  if (buf?.uri) {
    const uri = String(buf.uri);
    if (uri.startsWith('data:')) {
      const comma = uri.indexOf(',');
      const body = uri.slice(comma + 1);
      if (/;base64/i.test(uri.slice(0, comma + 1)) || uri.includes(';base64,')) {
        const raw = atob(body);
        const out = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
      }
      return encBytes(decodeURIComponent(body));
    }
    throw new Error('That glTF points at a separate file. Export a .glb instead.');
  }
  if (index === 0 && bin) return bin.subarray(0, buf?.byteLength || bin.length);
  if (bin && (index === 0 || buf == null)) return bin;
  throw new Error('That GLB is missing its binary buffer.');
}

const encBytes = (s) => new TextEncoder().encode(s);

function readAccessor(json, buffers, index) {
  const acc = json.accessors?.[index];
  if (!acc) throw new Error('That GLB has a broken mesh accessor.');
  const n = NCOMP[acc.type] || 1;
  const out = new Float64Array(acc.count * n);
  if (acc.bufferView != null) {
    const view = json.bufferViews[acc.bufferView];
    if (!view) throw new Error('That GLB has a broken mesh accessor.');
    if (view.extensions?.EXT_meshopt_compression) {
      throw new Error('That GLB is meshopt-compressed. Export it as a plain GLB.');
    }
    readInto(out, buffers[view.buffer ?? 0], (view.byteOffset || 0) + (acc.byteOffset || 0), view.byteStride || 0, acc.count, acc.componentType, n, !!acc.normalized);
  }
  const sparse = acc.sparse;
  if (sparse?.count) {
    const idx = new Float64Array(sparse.count);
    const iv = json.bufferViews[sparse.indices.bufferView];
    readInto(idx, buffers[iv.buffer ?? 0], (iv.byteOffset || 0) + (sparse.indices.byteOffset || 0), iv.byteStride || 0, sparse.count, sparse.indices.componentType, 1, false);
    const vals = new Float64Array(sparse.count * n);
    const vv = json.bufferViews[sparse.values.bufferView];
    readInto(vals, buffers[vv.buffer ?? 0], (vv.byteOffset || 0) + (sparse.values.byteOffset || 0), vv.byteStride || 0, sparse.count, acc.componentType, n, !!acc.normalized);
    for (let i = 0; i < sparse.count; i++) {
      const at = idx[i] * n;
      for (let k = 0; k < n; k++) out[at + k] = vals[i * n + k];
    }
  }
  return out;
}

function readInto(out, buf, offset, stride, count, componentType, n, normalized) {
  if (!buf) throw new Error('That GLB is missing its binary buffer.');
  const size = COMP_SIZE[componentType];
  if (!size) throw new Error('That GLB uses an unsupported number type.');
  const step = stride || size * n;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < count; i++) {
    let p = offset + i * step;
    for (let k = 0; k < n; k++) {
      out[i * n + k] = normalized ? norm(componentType, readComp(view, p, componentType)) : readComp(view, p, componentType);
      p += size;
    }
  }
}

function readComp(view, p, type) {
  if (type === 5120) return view.getInt8(p);
  if (type === 5121) return view.getUint8(p);
  if (type === 5122) return view.getInt16(p, true);
  if (type === 5123) return view.getUint16(p, true);
  if (type === 5125) return view.getUint32(p, true);
  if (type === 5126) return view.getFloat32(p, true);
  throw new Error('That GLB uses an unsupported number type.');
}

function norm(type, v) {
  if (type === 5120) return Math.max(v / 127, -1);
  if (type === 5121) return v / 255;
  if (type === 5122) return Math.max(v / 32767, -1);
  if (type === 5123) return v / 65535;
  return v;
}

function indexRange(n) {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = i;
  return out;
}

function triangulate(idx, mode) {
  const out = [];
  if (mode === 4) {
    for (let i = 0; i + 2 < idx.length; i += 3) out.push(idx[i], idx[i + 1], idx[i + 2]);
  } else if (mode === 5) {
    for (let i = 0; i + 2 < idx.length; i++) {
      if (i & 1) out.push(idx[i], idx[i + 2], idx[i + 1]);
      else out.push(idx[i], idx[i + 1], idx[i + 2]);
    }
  } else if (mode === 6) {
    for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
  }
  return out;
}

const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function nodeMatrix(node) {
  if (node.matrix?.length === 16) return node.matrix;
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return mulMat(mulMat(translation(t), rotation(r)), scale(s));
}

function translation([x, y, z]) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function scale([x, y, z]) {
  return [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1];
}

function rotation([x, y, z, w]) {
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    0, 0, 0, 1,
  ];
}

function mulMat(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function transformPoint(m, x, y, z) {
  const X = m[0] * x + m[4] * y + m[8] * z + m[12];
  const Y = m[1] * x + m[5] * y + m[9] * z + m[13];
  const Z = m[2] * x + m[6] * y + m[10] * z + m[14];
  const W = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (W && W !== 1) return [X / W, Y / W, Z / W];
  return [X, Y, Z];
}

const strip = (name) => String(name || 'Model').replace(/\.[^.]+$/, '');
