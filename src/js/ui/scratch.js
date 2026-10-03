// Working copies live under the program, not next to the picture:
//   internal / <name-id> / <savepoint> / structure.2dlayered|3dlayered
// Each savepoint is one zip. After it is written, inactive layers drop their
// extra screen copy, and a very large job keeps a shorter undo history so the
// old strokes are not all held in memory. The tree is deleted on close unless
// the user saves it out.
import { encodeJob, decodeJob, jobExt, safeSegment } from '../core/job.js';
import { imageToPng, decodeImage } from '../doc/io.js';
import { Doc } from '../doc/document.js';
import { Layer, claimLayerId } from '../doc/layer.js';
import { clamp } from '../core/util.js';
import * as platform from './platform.js';

const timers = new WeakMap();

/** Debounced working-copy after edits. The first one tells the user where it went. */
export function watchScratch(ed) {
  const note = () => {
    const doc = ed.doc;
    if (!doc?.modified || doc._scratchFrozen) return;
    clearTimeout(timers.get(doc));
    timers.set(doc, setTimeout(async () => {
      if (doc._scratchFrozen || !doc.modified) return;
      try {
        const packed = await checkpoint(doc);
        if (packed && doc._scratchNoted === packed.savepoint) {
          ed.toast(`Working copy cached at ${scratchWhere(doc)}. Deleted on close unless you save it.`);
        }
      } catch (err) {
        console.warn('Working copy failed:', err);
      }
    }, 8000));
  };
  ed.on('doc:render', note);
  ed.on('doc:layers', note);
}

export function freezeScratch(doc) {
  if (!doc) return;
  doc._scratchFrozen = true;
  clearTimeout(timers.get(doc));
}
const PARK_ABOVE = 48 * 1024 * 1024;

export function jobFolder(doc) {
  if (!doc.jobFolder) {
    const name = safeSegment(doc.name.replace(/\.[^.]+$/, ''), 'image');
    doc.jobFolder = `${name}-${safeSegment(doc.backupKey, 'id')}`;
  }
  return doc.jobFolder;
}

async function pngsOf(doc) {
  const layers = [];
  for (const l of doc.layers) {
    layers.push({
      id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend,
      png: await imageToPng(l.img),
    });
  }
  return layers;
}

function meshOf(doc) {
  const m = doc.mount;
  if (!m) return null;
  return {
    positions: m.positions, indices: m.indices, uvs: m.uvs, wires: m.wires,
    groups: m.groups, charts: m.charts, showWires: m.showWires !== false,
  };
}

/** The current document as a job zip. */
export async function jobBytes(doc) {
  const kind = jobExt(doc);
  const savepoint = new Date().toISOString().replace(/[:.]/g, '-');
  const bytes = encodeJob({
    kind, id: jobFolder(doc), name: doc.name, width: doc.width, height: doc.height,
    active: doc.active, savepoint, layers: await pngsOf(doc), mesh: meshOf(doc),
  });
  return { kind, bytes, savepoint };
}

/** Write one savepoint. Returns { kind, bytes, savepoint } or null if a write is already running. */
export async function checkpoint(doc) {
  if (!doc || doc._scratchBusy) { if (doc) doc._scratchAgain = true; return null; }
  doc._scratchBusy = true;
  try {
    const packed = await jobBytes(doc);
    await platform.scratchWrite(jobFolder(doc), packed.savepoint, packed.kind, packed.bytes);
    doc.scratchPoint = packed.savepoint;
    doc.scratchKind = packed.kind;
    if (!doc._scratchNoted) doc._scratchNoted = packed.savepoint;
    relieve(doc);
    return packed;
  } finally {
    doc._scratchBusy = false;
    if (doc._scratchAgain) { doc._scratchAgain = false; checkpoint(doc); }
  }
}

function relieve(doc) {
  let bytes = 0;
  for (const l of doc.layers) if (l.img?.data) bytes += l.img.data.byteLength;
  for (const l of doc.layers) {
    if (l !== doc.layer) { l._canvas = null; l._dirty = null; }
  }
  // A large job must not also keep hundreds of megabytes of undo copies.
  if (bytes >= PARK_ABOVE) doc.history.limitBytes = Math.min(doc.history.limitBytes, 96 * 1024 * 1024);
}

export function dropScratch(doc) {
  if (!doc?.jobFolder) return Promise.resolve();
  return platform.scratchDrop(doc.jobFolder);
}

/** A saved-out job back into a document. */
export async function openJob(bytes, name) {
  const job = await decodeJob(bytes);
  const doc = new Doc(job.width, job.height, { name: stripJobName(name, job.name) });
  const layers = [];
  for (const l of job.layers) {
    const layer = new Layer(job.width, job.height, l.name);
    layer.replaceImage(await decodeImage(l.png));
    claimLayerId(layer, l.id);
    Object.assign(layer, { visible: l.visible !== false, opacity: l.opacity ?? 1, blend: l.blend || 'source-over' });
    layers.push(layer);
  }
  if (!layers.length) throw new Error('That job has no layers.');
  doc.setLayers(layers);
  doc.selectLayer(clamp(job.active ?? layers.length - 1, 0, layers.length - 1));
  if (job.mesh) {
    doc.mount = {
      mesh: {
        name: job.name, positions: job.mesh.positions, indices: job.mesh.indices,
        groups: job.mesh.groups, cornerUV: null, hasUV: false,
      },
      positions: job.mesh.positions,
      indices: job.mesh.indices,
      uvs: job.mesh.uvs,
      wires: job.mesh.wires,
      groups: job.mesh.groups,
      charts: job.mesh.charts,
      width: job.width,
      height: job.height,
      showWires: job.mesh.showWires !== false,
    };
    doc.layoutHint = 'split';
  }
  return doc;
}

function stripJobName(filename, fallback) {
  const base = (filename || fallback || 'Job').split(/[\\/]/).pop();
  return base.replace(/\.([23]dlayered)$/i, '') || fallback || 'Job';
}

export function scratchWhere(doc) {
  const kind = jobExt(doc);
  return `internal / ${jobFolder(doc)} / ${doc.scratchPoint || 'savepoint'} / structure.${kind}`;
}
