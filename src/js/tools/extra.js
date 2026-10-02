// Background removal and the colour-range sampler.
import { FilterSession } from '../doc/ops.js';
import { removeBackground } from '../core/bgremove.js';
import { colorRangeDialog } from '../ui/dialogs.js';

function bgRemove() {
  return {
    id: 'bg-remove', name: 'Remove Background', key: 'U', group: 'utility', cursor: 'crosshair',
    options: ['tolerance', 'flood'],
    down(_e, ed) {
      const layer = ed.editableLayer();
      if (!layer) return;
      const tolerance = ed.opts.tolerance;
      const global = ed.opts.flood === 'global';
      const spec = {
        name: 'Remove Background',
        count: 0,
        apply(img) {
          const r = removeBackground(img, { tolerance, global });
          spec.count = r.count;
          return r.img;
        },
      };
      const session = new FilterSession(ed.doc, layer, spec, { ignoreSelection: ed.opts.wholeImage });
      if (!session.preview({})) {
        ed.toast('The selection is empty.');
        return;
      }
      if (!spec.count) {
        session.cancel();
        ed.toast('No edge colour matched. Raise tolerance, or the border is already clear.');
        return;
      }
      session.commit();
      ed.toast(global
        ? `Cleared ${spec.count} pixels near the border colour.`
        : `Cleared ${spec.count} pixels inward from the edges.`);
    },
  };
}

function colorRange() {
  let a = null;
  return {
    id: 'color-range', name: 'Color Range', key: 'C', group: 'utility', cursor: 'crosshair',
    options: ['sampling'],
    async down(e, ed) {
      const c = ed.doc.pixelAt(Math.floor(e.x), Math.floor(e.y), ed.opts.sampling === 'image');
      if (!c) return;
      if (e.button === 2) {
        ed.setSecondary(c);
        ed.noteRecentColor(c);
        const result = await colorRangeDialog(ed, { a: a ?? ed.primary, b: c });
        if (result) ed.toast(result.mode === 'delete' ? `Deleted ${result.count} pixels.` : `Replaced ${result.count} pixels.`);
        return;
      }
      a = c;
      ed.setPrimary(c);
      ed.noteRecentColor(c);
      ed.toast('Colour A set. Right-click a second colour to set B and edit the range.');
    },
  };
}

export const extraTools = () => [bgRemove(), colorRange()];
