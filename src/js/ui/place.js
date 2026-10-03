// Source images are drawn forward onto the object's texture. Moving or editing
// a source rebuilds its layer there. Nothing is written back to the source.
import { projectOnto } from '../core/project.js';
import { Layer } from '../doc/layer.js';

export function atlasOf(doc) {
  return doc?.session?.members.find((d) => d.atlas) ?? (doc?.atlas ? doc : null);
}

export function defaultPlace(doc, mount) {
  const aw = mount?.width || doc.width || 1;
  const ah = mount?.height || doc.height || 1;
  const aspect = (doc.width || 1) / (doc.height || 1);
  const canvasAspect = aw / ah;
  let w = 0.34;
  let h = w * canvasAspect / aspect;
  if (h > 0.34) { h = 0.34; w = h * aspect / canvasAspect; }
  return { u: (1 - w) / 2, v: (1 - h) / 2, w, h };
}

function projectionLayer(atlas, source) {
  let layer = atlas.layers.find((l) => l.sourceKey === source.backupKey);
  if (layer) {
    if (layer.name !== source.name) { layer.name = source.name; atlas.emit('layers'); }
    return layer;
  }
  layer = new Layer(atlas.width, atlas.height, source.name);
  layer.sourceKey = source.backupKey;
  layer.projected = true;
  const paint = atlas.layers.findIndex((l) => l.modelPaint);
  const index = paint >= 0 ? paint : atlas.layers.length;
  atlas.addLayer({ layer, index, historyName: 'Place Image' });
  return layer;
}

export function modelPaintLayer(atlas) {
  let layer = atlas.layers.find((l) => l.modelPaint);
  if (layer) return layer;
  layer = new Layer(atlas.width, atlas.height, 'Model paint');
  layer.modelPaint = true;
  atlas.addLayer({ layer, historyName: 'Model Paint Layer' });
  return layer;
}

/** Rebuild one source's layer on the object texture. */
export function reproject(source, ed) {
  const atlas = atlasOf(source);
  const mount = source.session?.mount;
  if (!atlas || !mount?.uvs || source.atlas) return;
  const layer = projectionLayer(atlas, source);
  const src = source.compositeImage();
  projectOnto(layer.img, src, source.place, mount.uvs, mount.groups, source.faces);
  layer.touch();
  ed?.emit('model-texture');
}

export function reprojectAll(doc, ed) {
  const session = doc?.session;
  if (!session) return;
  for (const member of session.members) if (!member.atlas) reproject(member, ed);
}

export function dropProjection(doc) {
  const atlas = atlasOf(doc);
  if (!atlas || doc.atlas) return;
  const i = atlas.layers.findIndex((l) => l.sourceKey === doc.backupKey);
  if (i > 0) atlas.deleteLayer(i);
}

let queued = false;
export function watchPlacement(ed) {
  ed.on('doc:render', () => {
    const d = ed.doc;
    if (!d?.session || d.atlas || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (d.session && !d.atlas) reproject(d, ed);
    });
  });
}
