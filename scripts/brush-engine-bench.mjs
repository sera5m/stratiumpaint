// Brush engine alone (node, no rendering): the tiled engine vs the old one kept in test/fixtures.
// npm run bench:brush-engine
import { Editor } from '../src/js/ui/editor.js';
import { Doc } from '../src/js/doc/document.js';
import { brushTools } from '../src/js/tools/brush.js';
import { brushTools as ref } from '../test/fixtures/brush-reference.js';
const ev = (x, y) => ({ x, y, sx: x, sy: y, button: 0, shift: false, ctrl: false, alt: false });
for (const [W, H] of [[720, 720], [4000, 3000]]) for (const size of [12, 60]) for (const [label, set] of [['old', ref], ['new', brushTools]]) {
  const ed = new Editor(); const doc = new Doc(W, H); ed.addDoc(doc); Object.assign(ed.opts, { size, hardness: 50, opacity: 80 });
  const t = set().find((x) => x.id === 'brush');
  const times = { down: [], move: [], up: [] };
  for (let rep = 0; rep < 6; rep++) {
    let t0 = performance.now(); t.down(ev(50, 50), ed); times.down.push(performance.now() - t0);
    t0 = performance.now(); for (let i = 1; i <= 160; i++) t.move(ev(50 + i * (W - 100) / 160, 50 + (H - 100) * (0.5 + 0.4 * Math.sin(i / 20))), ed); times.move.push((performance.now() - t0) / 160);
    t0 = performance.now(); t.up(ev(W - 50, H / 2), ed); times.up.push(performance.now() - t0);
  }
  const med = (a) => a.slice(1).sort((x, y) => x - y)[2].toFixed(2);
  console.log(`${W}x${H} size ${size} ${label}: down ${med(times.down)} ms, per event ${med(times.move)} ms, up ${med(times.up)} ms`);
}
