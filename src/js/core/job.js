// Session job files. A .2dlayered or .3dlayered file is a zip the OS can open:
// job.json, one PNG per layer, and (for a mounted model) the mesh buffers.
import { zipStore, unzip } from './zip.js';

const MIME = {
  '2dlayered': 'application/x-stratum-2dlayered',
  '3dlayered': 'application/x-stratum-3dlayered',
};

const enc = new TextEncoder();
const dec = new TextDecoder();

function copyBytes(typed) {
  const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  return u8.slice();
}

function typedFrom(u8, Ctor) {
  if (!u8) return new Ctor(0);
  const buf = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  return new Ctor(buf);
}

/**
 * job: { id, name, width, height, active, savepoint, kind?: '2dlayered'|'3dlayered',
 *        layers: [{ id, name, visible, opacity, blend, png: Uint8Array }],
 *        mesh?: { positions, indices, uvs, wires, groups, charts, showWires } }
 * → Uint8Array
 */
export function encodeJob(job) {
  const kind = job.kind || (job.mesh ? '3dlayered' : '2dlayered');
  const meta = {
    format: kind,
    id: job.id,
    name: job.name,
    width: job.width,
    height: job.height,
    active: job.active ?? 0,
    savepoint: job.savepoint ?? null,
    nodeGraph: job.nodeGraph ?? null,
    layers: job.layers.map((l) => ({
      id: l.id, name: l.name, visible: l.visible !== false,
      opacity: l.opacity ?? 1, blend: l.blend || 'source-over',
      file: `layers/${l.id}.png`,
    })),
  };
  const files = [
    { name: 'mimetype', data: enc.encode(MIME[kind]) },
    { name: 'job.json', data: enc.encode(JSON.stringify(meta)) },
    ...job.layers.map((l) => ({ name: `layers/${l.id}.png`, data: l.png })),
  ];
  if (kind === '3dlayered') {
    if (!job.mesh) throw new Error('A 3D job needs a mesh.');
    meta.mesh = {
      groups: job.mesh.groups ?? [],
      charts: job.mesh.charts ?? 0,
      showWires: job.mesh.showWires !== false,
      files: { positions: 'mesh/positions.f32', indices: 'mesh/indices.u32', uvs: 'mesh/uvs.f32', wires: 'mesh/wires.f32' },
    };
    files[1] = { name: 'job.json', data: enc.encode(JSON.stringify(meta)) };
    files.push(
      { name: 'mesh/positions.f32', data: copyBytes(job.mesh.positions) },
      { name: 'mesh/indices.u32', data: copyBytes(job.mesh.indices) },
      { name: 'mesh/uvs.f32', data: copyBytes(job.mesh.uvs) },
      { name: 'mesh/wires.f32', data: copyBytes(job.mesh.wires ?? new Float32Array()) },
    );
  }
  return zipStore(files);
}

/** → the job record. Layer pixels stay as PNG bytes. */
export async function decodeJob(bytes) {
  const files = await unzip(bytes);
  const raw = files.get('job.json');
  if (!raw) throw new Error('Not a Stratum job (job.json missing).');
  const meta = JSON.parse(dec.decode(raw));
  if (meta.format !== '2dlayered' && meta.format !== '3dlayered') throw new Error('Unknown job format.');
  const layers = (meta.layers ?? []).map((l) => {
    const png = files.get(l.file);
    if (!png) throw new Error(`Job is missing ${l.file}.`);
    return { ...l, png };
  });
  let mesh = null;
  if (meta.format === '3dlayered' && meta.mesh) {
    const f = meta.mesh.files ?? {};
    mesh = {
      groups: meta.mesh.groups ?? [],
      charts: meta.mesh.charts ?? 0,
      showWires: meta.mesh.showWires !== false,
      positions: typedFrom(files.get(f.positions || 'mesh/positions.f32'), Float32Array),
      indices: typedFrom(files.get(f.indices || 'mesh/indices.u32'), Uint32Array),
      uvs: typedFrom(files.get(f.uvs || 'mesh/uvs.f32'), Float32Array),
      wires: typedFrom(files.get(f.wires || 'mesh/wires.f32'), Float32Array),
    };
  }
  return { ...meta, layers, mesh };
}

export const jobExt = (doc) => (doc?.mount ? '3dlayered' : '2dlayered');

/** One path segment. Never empty, never a dot path. */
export function safeSegment(value, fallback = 'job') {
  const t = String(value ?? '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return t || fallback;
}
