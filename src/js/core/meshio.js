// STL (ASCII and binary) and FBX (ASCII and Kaydara binary) → triangles.
// FBX polygons use the usual end marker: a negative index stores ~(real index).

const dec = new TextDecoder();

async function inflateZlib(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function viewOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

export function parseSTL(bytes, name = 'Model') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const binary = isBinarySTL(u8);
  const mesh = binary ? parseSTLBinary(u8, name) : parseSTLAscii(dec.decode(u8), name);
  if (mesh.indices.length || !binary) return mesh;
  // A binary header that was really text (rare) still gets a second look.
  const ascii = parseSTLAscii(dec.decode(u8), name);
  return ascii.indices.length ? ascii : mesh;
}

function isBinarySTL(u8) {
  if (u8.length < 84) return false;
  const count = viewOf(u8).getUint32(80, true);
  const expected = 84 + count * 50;
  const slack = u8.length - expected;
  // Exporters often append a comment or a colour block. A few kilobytes of
  // trailing bytes used to make the whole file look empty.
  const countOk = count > 0 && count < 5e7 && slack >= 0 && slack <= 65536;
  const sample = dec.decode(u8.subarray(0, Math.min(u8.length, 8192)));
  const asciiBody = /facet\s+normal/i.test(sample) && /vertex/i.test(sample);
  if (asciiBody && slack !== 0) return false;
  if (countOk && !asciiBody) return true;
  if (countOk && slack === 0) return true;
  return false;
}

function parseSTLAscii(text, name) {
  const positions = [];
  const indices = [];
  let solid = '';
  const solidLine = /^solid\s+(.*)$/im.exec(text);
  if (solidLine) solid = solidLine[1].trim();
  const num = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;
  const re = new RegExp(String.raw`vertex\s+(${num})[\s,]+(${num})[\s,]+(${num})`, 'gi');
  const verts = [];
  let m;
  while ((m = re.exec(text))) verts.push(+m[1], +m[2], +m[3]);
  for (let i = 0; i + 8 < verts.length; i += 9) {
    const base = positions.length / 3;
    positions.push(verts[i], verts[i + 1], verts[i + 2], verts[i + 3], verts[i + 4], verts[i + 5], verts[i + 6], verts[i + 7], verts[i + 8]);
    indices.push(base, base + 1, base + 2);
  }
  return packed(positions, indices, solid || 'solid', name);
}

function parseSTLBinary(u8, name) {
  const view = viewOf(u8);
  const count = Math.min(view.getUint32(80, true), Math.max(0, Math.floor((u8.length - 84) / 50)));
  const positions = [];
  const indices = [];
  let p = 84;
  for (let t = 0; t < count; t++) {
    p += 12; // normal
    const base = positions.length / 3;
    for (let v = 0; v < 9; v++) positions.push(view.getFloat32(p + v * 4, true));
    p += 36 + 2;
    indices.push(base, base + 1, base + 2);
  }
  let solid = '';
  for (let i = 0; i < 80 && u8[i] >= 32 && u8[i] < 127; i++) solid += String.fromCharCode(u8[i]);
  solid = solid.replace(/^solid\s*/i, '').trim();
  return packed(positions, indices, solid || 'solid', name);
}

export async function parseFBX(bytes, name = 'Model') {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (dec.decode(u8.subarray(0, 20)) === 'Kaydara FBX Binary  ') return parseFBXBinary(u8, name);
  return parseFBXAscii(dec.decode(u8), name);
}

function parseFBXAscii(text, name) {
  const positions = [];
  const indices = [];
  const groups = [];
  const lines = text.split(/\r?\n/);
  let geom = 'mesh';
  let mode = null;
  let nums = [];
  let geomIndex = 0;
  let pendingVerts = null;

  const flush = () => {
    if (mode === 'v') pendingVerts = nums.slice();
    else if (mode === 'i' && pendingVerts) {
      addGeometry(positions, indices, groups, pendingVerts, nums, geom || `mesh ${++geomIndex}`);
      pendingVerts = null;
    }
    mode = null;
    nums = [];
  };
  // A new property (Normals:, Edges:, …) ends the array. `a:` is the data line, not a property.
  const keyword = (line) => /^[A-Za-z_][\w]*\s*:/.test(line) && !/^a\s*:/.test(line);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line || line.startsWith(';')) continue;
    if (/^Geometry:/.test(line)) {
      flush();
      const quoted = /"([^"]*)"/.exec(line);
      geom = cleanName(quoted?.[1] || '') || geom;
      continue;
    }
    if (/^Vertices:/.test(line)) {
      flush();
      mode = 'v';
      nums = numbers(line);
      if (line.includes('}')) flush();
      continue;
    }
    if (/^PolygonVertexIndex:/.test(line)) {
      flush();
      mode = 'i';
      nums = numbers(line);
      if (line.includes('}')) flush();
      continue;
    }
    if (!mode) continue;
    if (keyword(line)) { flush(); li -= 1; continue; }
    nums.push(...numbers(line));
    if (line.includes('}')) flush();
  }
  flush();
  return { positions, indices, groups: groups.filter((g) => g.count > 0), name: strip(name) };
}

function numbers(line) {
  const out = [];
  for (const m of line.matchAll(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)) {
    if (m.index > 0 && line[m.index - 1] === '*') continue; // the "*count" marker, not a coordinate
    out.push(+m[0]);
  }
  return out;
}

async function parseFBXBinary(u8, name) {
  const view = viewOf(u8);
  const version = view.getUint32(23, true);
  const large = version >= 7500;
  let p = 27;
  const roots = [];
  while (p < u8.length) {
    const node = await readNode(u8, view, p, large);
    if (!node) break;
    roots.push(node);
    p = node.end;
  }
  const positions = [];
  const indices = [];
  const groups = [];
  let n = 0;
  const walk = (node) => {
    if (node.name === 'Geometry') {
      const verts = node.children.find((c) => c.name === 'Vertices');
      const polys = node.children.find((c) => c.name === 'PolygonVertexIndex');
      if (verts?.props[0] && polys?.props[0]) {
        const label = cleanName(node.props[1] || '') || `mesh ${++n}`;
        addGeometry(positions, indices, groups, verts.props[0], polys.props[0], label);
      }
    }
    for (const child of node.children) walk(child);
  };
  for (const root of roots) walk(root);
  return { positions, indices, groups: groups.filter((g) => g.count > 0), name: strip(name) };
}

async function readNode(u8, view, offset, large) {
  const word = large ? 8 : 4;
  const sentinel = large ? 25 : 13;
  if (offset + word * 3 + 1 > u8.length) return null;
  const readWord = (o) => large ? Number(view.getBigUint64(o, true)) : view.getUint32(o, true);
  const end = readWord(offset);
  if (!end) return null;
  const numProps = readWord(offset + word);
  const propListLen = readWord(offset + word * 2);
  const nameLen = u8[offset + word * 3];
  let p = offset + word * 3 + 1;
  const name = dec.decode(u8.subarray(p, p + nameLen));
  p += nameLen;
  const props = [];
  const propsStart = p;
  try {
    for (let i = 0; i < numProps; i++) {
      const type = String.fromCharCode(u8[p]);
      p += 1;
      const got = await readProp(u8, view, type, p);
      props.push(got.value);
      p = got.next;
    }
  } catch {
    // An unfamiliar property used to abort the whole file, including the mesh
    // that sits next to it. Skip the rest of this property list and keep going.
    p = Math.min(end, propsStart + propListLen);
  }
  const children = [];
  while (p + word <= end) {
    const mark = readWord(p);
    if (mark === 0) { p += sentinel; break; }
    const child = await readNode(u8, view, p, large);
    if (!child) break;
    children.push(child);
    p = child.end;
  }
  return { name, props, children, end };
}

async function readProp(u8, view, type, p) {
  const scalar = (size, read) => ({ value: read(), next: p + size });
  if (type === 'Y') return scalar(2, () => view.getInt16(p, true));
  if (type === 'C') return scalar(1, () => u8[p] !== 0);
  if (type === 'I') return scalar(4, () => view.getInt32(p, true));
  if (type === 'F') return scalar(4, () => view.getFloat32(p, true));
  if (type === 'D') return scalar(8, () => view.getFloat64(p, true));
  if (type === 'L') return scalar(8, () => Number(view.getBigInt64(p, true)));
  if (type === 'S' || type === 'R') {
    const len = view.getUint32(p, true);
    const raw = u8.subarray(p + 4, p + 4 + len);
    return { value: type === 'S' ? dec.decode(raw) : raw, next: p + 4 + len };
  }
  const arrays = { f: [4, Float32Array], d: [8, Float64Array], i: [4, Int32Array], l: [8, BigInt64Array], b: [1, Uint8Array] };
  if (arrays[type]) {
    const [size, Ctor] = arrays[type];
    const length = view.getUint32(p, true);
    const encoding = view.getUint32(p + 4, true);
    const compLen = view.getUint32(p + 8, true);
    const dataStart = p + 12;
    let raw = encoding === 1
      ? await inflateZlib(u8.subarray(dataStart, dataStart + compLen))
      : u8.subarray(dataStart, dataStart + length * size);
    if (raw.byteLength < length * size) raw = raw.subarray(0, raw.byteLength);
    const copy = raw.buffer.slice(raw.byteOffset, raw.byteOffset + length * size);
    return { value: new Ctor(copy), next: dataStart + (encoding === 1 ? compLen : length * size) };
  }
  throw new Error(`Unknown FBX property type ${type}`);
}

function addGeometry(positions, indices, groups, verts, polys, groupName) {
  const base = positions.length / 3;
  const start = indices.length / 3;
  const num = (n) => typeof n === 'bigint' ? Number(n) : +n;
  for (let i = 0; i < verts.length; i++) positions.push(num(verts[i]));
  const list = [];
  for (let i = 0; i < polys.length; i++) list.push(num(polys[i]));
  const ended = list.some((n) => n < 0);
  const fan = (poly) => {
    for (let k = 1; k < poly.length - 1; k++) indices.push(base + poly[0], base + poly[k], base + poly[k + 1]);
  };
  if (!ended && list.length >= 3 && list.length % 3 === 0) {
    for (let i = 0; i < list.length; i += 3) indices.push(base + list[i], base + list[i + 1], base + list[i + 2]);
  } else {
    let poly = [];
    for (const raw of list) {
      if (raw < 0) { poly.push(~raw); fan(poly); poly = []; }
      else poly.push(raw);
    }
    if (poly.length >= 3) fan(poly);
  }
  const count = indices.length / 3 - start;
  if (count > 0) groups.push({ name: cleanName(groupName) || 'mesh', start, count });
}

function cleanName(s) {
  return String(s || '').replace(/^Geometry::/, '').replace(/\0[\s\S]*$/, '').trim();
}

function packed(positions, indices, group, name) {
  return {
    positions, indices,
    groups: indices.length ? [{ name: group, start: 0, count: indices.length / 3 }] : [],
    name: strip(name),
  };
}

const strip = (name) => String(name || 'Model').replace(/\.[^.]+$/, '');
