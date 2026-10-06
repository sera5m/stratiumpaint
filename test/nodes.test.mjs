import assert from 'node:assert/strict';
import test from 'node:test';
import { Editor } from '../src/js/ui/editor.js';
import { Doc } from '../src/js/doc/document.js';
import { compileFormula, evalFormula, formulaEnv, parseFormula } from '../src/js/nodes/formula.js';
import { ensureGraph, linkSockets, groupNodes, graphForSave } from '../src/js/nodes/graph.js';
import { evaluateGraph, makeContext, primaryOutput, summarize } from '../src/js/nodes/eval.js';
import { executeLine } from '../src/js/nodes/script.js';
import { encodeJob, decodeJob } from '../src/js/core/job.js';
import { extractCommands, ollamaEndpoint, runCommands, taskPrompt, checkModelName, agentReadout } from '../src/js/nodes/agent.js';

test('latex formulas compile and evaluate', () => {
  const env = formulaEnv({ u: 1, v: 0, x: 0, y: 0, r: 0, g: 0, b: 0, a: 1, A: 0, B: 0, C: 0, t: 0, W: 1, H: 1 });
  const run = (src, extra) => evalFormula(compileFormula(src), formulaEnv({ ...env, ...extra }));
  assert.equal(run('\\frac{u}{2}'), 0.5);
  assert.ok(Math.abs(run('\\sin(u \\cdot \\pi)') - Math.sin(Math.PI)) < 1e-9);
  assert.equal(run('u^2+v^2', { u: 3, v: 4 }), 25);
  assert.equal(run('2u'), 2);
  assert.ok(Math.abs(run('sin(u)', { u: Math.PI / 2 }) - 1) < 1e-9);
  assert.equal(parseFormula('\\min{1}{2}').op, 'min');
});

test('the default graph is a checker, not a flat colour', () => {
  const doc = new Doc(32, 16);
  const g = ensureGraph(doc);
  const { values } = evaluateGraph(g, makeContext(doc, 32, 16));
  const comp = g.nodes.find((n) => n.type === 'composite');
  const summary = summarize(primaryOutput(values, comp), 32, 16, [[0.05, 0.05], [0.2, 0.05]]);
  assert.ok(Math.abs(summary.samples[0].r - summary.samples[1].r) > 0.2);
});

test('a formula node follows u and v', () => {
  const ed = new Editor();
  executeLine(ed, { cmd: 'new', width: 8, height: 4, name: 'F' });
  executeLine(ed, { cmd: 'add', type: 'formula', id: 'fx', params: { latex: 'u' } });
  executeLine(ed, { cmd: 'link', from: 'fx', out: 'value', to: 'comp', in: 'image' });
  const out = executeLine(ed, { cmd: 'eval', node: 'comp', sample: [[0.1, 0.5], [0.9, 0.5]] });
  assert.equal(out.ok, true, out.error);
  assert.ok(out.samples[1].r > out.samples[0].r);
});

test('mute passes the first input through and delete can reconnect', () => {
  const ed = new Editor();
  executeLine(ed, { cmd: 'new', width: 4, height: 4 });
  executeLine(ed, { cmd: 'add', type: 'value', id: 'src', params: { value: 0.25 } });
  executeLine(ed, { cmd: 'add', type: 'math', id: 'add', params: { op: 'add' } });
  executeLine(ed, { cmd: 'link', from: 'src', out: 'value', to: 'add', in: 'a' });
  executeLine(ed, { cmd: 'link', from: 'add', out: 'value', to: 'view', in: 'image' });
  executeLine(ed, { cmd: 'mute', id: 'add', muted: true });
  let out = executeLine(ed, { cmd: 'eval', node: 'view', sample: [[0.5, 0.5]] });
  assert.ok(Math.abs(out.samples[0].r - 0.25) < 0.02, JSON.stringify(out));
  executeLine(ed, { cmd: 'delete', id: 'add', reconnect: true });
  const graph = executeLine(ed, { cmd: 'graph' });
  assert.ok(graph.links.some((l) => l.from === 'src' && l.to === 'view'));
  out = executeLine(ed, { cmd: 'eval', node: 'view', sample: [[0.5, 0.5]] });
  assert.ok(Math.abs(out.samples[0].r - 0.25) < 0.02);
});

test('grouping a math node keeps the value flowing', () => {
  const doc = new Doc(4, 4);
  const g = ensureGraph(doc);
  const src = g.nodes.find((n) => n.id === 'chk');
  // Replace the default checker path with an explicit value so the group is easy to read.
  const ed = new Editor();
  ed.addDoc(doc);
  executeLine(ed, { cmd: 'add', type: 'value', id: 'src', params: { value: 0.4 } });
  executeLine(ed, { cmd: 'add', type: 'math', id: 'plus', params: { op: 'add' } });
  executeLine(ed, { cmd: 'link', from: 'src', out: 'value', to: 'plus', in: 'a' });
  executeLine(ed, { cmd: 'link', from: 'plus', out: 'value', to: 'comp', in: 'image' });
  const grouped = groupNodes(g, ['plus']);
  assert.equal(grouped.type, 'group');
  assert.ok(grouped && src);
  const { values, errors } = evaluateGraph(g, makeContext(doc, 4, 4));
  assert.equal(errors.length, 0, JSON.stringify(errors));
  const summary = summarize(primaryOutput(values, g.nodes.find((n) => n.id === 'comp')), 4, 4);
  assert.ok(Math.abs(summary.mean.r - 0.4) < 0.02, JSON.stringify(summary.mean));
});

test('apply writes the composite and undo restores the layer', () => {
  const ed = new Editor();
  executeLine(ed, { cmd: 'new', width: 6, height: 4, name: 'Apply' });
  executeLine(ed, { cmd: 'add', type: 'rgb', id: 'red', params: { color: { r: 1, g: 0, b: 0, a: 1 } } });
  executeLine(ed, { cmd: 'link', from: 'red', out: 'color', to: 'comp', in: 'image' });
  const applied = executeLine(ed, { cmd: 'apply', node: 'comp' });
  assert.equal(applied.ok, true, applied.error);
  const px = ed.doc.layer.img.data;
  assert.ok(px[0] > 200 && px[1] < 20);
  ed.doc.undo();
  assert.equal(ed.doc.layer.img.data[0], 0);
});

test('a cycle is refused and help describes the pipe', () => {
  const ed = new Editor();
  executeLine(ed, { cmd: 'new', width: 2, height: 2 });
  executeLine(ed, { cmd: 'add', type: 'math', id: 'a' });
  executeLine(ed, { cmd: 'add', type: 'math', id: 'b' });
  executeLine(ed, { cmd: 'link', from: 'a', out: 'value', to: 'b', in: 'a' });
  const cyc = executeLine(ed, { cmd: 'link', from: 'b', out: 'value', to: 'a', in: 'a' });
  assert.equal(cyc.ok, false);
  const help = executeLine(ed, { cmd: 'help' });
  assert.match(help.pipe, /--script/);
  assert.ok(help.commands.formula);
});

test('a job keeps the node graph', async () => {
  const doc = new Doc(4, 4, { name: 'Job' });
  const g = ensureGraph(doc);
  linkSockets(g, 'chk', 'color', 'comp', 'image');
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
  const bytes = encodeJob({
    id: 'n-1', name: 'Job', width: 4, height: 4, active: 0, savepoint: 't',
    layers: [{ id: 1, name: 'Background', png }],
    nodeGraph: graphForSave(g),
  });
  const job = await decodeJob(bytes);
  assert.equal(job.nodeGraph.nodes.some((n) => n.type === 'formula' || n.type === 'checker'), true);
  assert.ok(job.nodeGraph.links.length >= 1);
});

test('a model completion becomes commands, and thinking text is ignored', () => {
  const text = [
    '<think>link the checker first</think>',
    'Here you go:',
    '```',
    '{"cmd":"delete","id":"chk"}',
    '{"cmd":"add","type":"wave","id":"wv"}',
    '```',
    'done',
  ].join('\n');
  const cmds = extractCommands(text);
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].id, 'chk');
  assert.deepEqual(extractCommands('[{"cmd":"apply"},{"cmd":"info"}]').map((c) => c.cmd), ['apply', 'info']);
  assert.equal(extractCommands('no json here').length, 0);
  const ed = new Editor();
  ed.addDoc(new Doc(8, 8));
  const results = runCommands(ed, [{ cmd: 'add', type: 'rgb', id: 'red', params: { r: 1, g: 0, b: 0, a: 1 } }]);
  assert.equal(results[0].ok, true);
  assert.ok(ed.doc.nodeGraph.nodes.some((n) => n.id === 'red'));
  assert.match(taskPrompt('red waves', ed.doc), /red waves/);
  assert.match(taskPrompt('red waves', ed.doc), /"id":"comp"/);
  assert.equal(checkModelName('qwen2.5-coder:7b'), 'qwen2.5-coder:7b');
  assert.throws(() => checkModelName(''));
  assert.equal(ollamaEndpoint('http://127.0.0.1:11434'), 'http://127.0.0.1:11434/api/generate');
  assert.throws(() => ollamaEndpoint('http://example.com/api'));
});

test('gradient colours follow two vectors, and booleans combine pictures', () => {
  const ed = new Editor();
  executeLine(ed, { cmd: 'new', width: 8, height: 4, name: 'G' });
  executeLine(ed, { cmd: 'add', type: 'rgb', id: 'black', params: { color: { r: 0, g: 0, b: 0, a: 1 } } });
  executeLine(ed, { cmd: 'add', type: 'rgb', id: 'red', params: { color: { r: 1, g: 0, b: 0, a: 1 } } });
  executeLine(ed, { cmd: 'add', type: 'gradient', id: 'grad' });
  executeLine(ed, { cmd: 'link', from: 'black', out: 'color', to: 'grad', in: 'color1' });
  executeLine(ed, { cmd: 'link', from: 'red', out: 'color', to: 'grad', in: 'color2' });
  let out = executeLine(ed, { cmd: 'eval', node: 'grad', sample: [[0.05, 0.5], [0.95, 0.5]] });
  assert.equal(out.ok, true, out.error);
  assert.ok(out.samples[1].r > out.samples[0].r + 0.5, JSON.stringify(out.samples));
  executeLine(ed, { cmd: 'add', type: 'combinexyz', id: 's', params: { x: 1, y: 0.5, z: 0 } });
  executeLine(ed, { cmd: 'add', type: 'combinexyz', id: 'e', params: { x: 0, y: 0.5, z: 0 } });
  executeLine(ed, { cmd: 'link', from: 's', out: 'vector', to: 'grad', in: 'start' });
  executeLine(ed, { cmd: 'link', from: 'e', out: 'vector', to: 'grad', in: 'end' });
  out = executeLine(ed, { cmd: 'eval', node: 'grad', sample: [[0.05, 0.5], [0.95, 0.5]] });
  assert.ok(out.samples[0].r > out.samples[1].r + 0.5, JSON.stringify(out.samples));

  executeLine(ed, { cmd: 'add', type: 'rgb', id: 'green', params: { color: { r: 0, g: 1, b: 0, a: 1 } } });
  executeLine(ed, { cmd: 'add', type: 'add', id: 'sum' });
  executeLine(ed, { cmd: 'link', from: 'red', out: 'color', to: 'sum', in: 'a' });
  executeLine(ed, { cmd: 'link', from: 'green', out: 'color', to: 'sum', in: 'b' });
  out = executeLine(ed, { cmd: 'eval', node: 'sum', sample: [[0.5, 0.5]] });
  assert.ok(out.samples[0].r > 0.9 && out.samples[0].g > 0.9, JSON.stringify(out.samples));

  executeLine(ed, { cmd: 'add', type: 'sub', id: 'diff' });
  executeLine(ed, { cmd: 'link', from: 'sum', out: 'color', to: 'diff', in: 'a' });
  executeLine(ed, { cmd: 'link', from: 'red', out: 'color', to: 'diff', in: 'b' });
  out = executeLine(ed, { cmd: 'eval', node: 'diff', sample: [[0.5, 0.5]] });
  assert.ok(out.samples[0].r < 0.05 && out.samples[0].g > 0.9, JSON.stringify(out.samples));

  executeLine(ed, { cmd: 'add', type: 'xor', id: 'xx' });
  executeLine(ed, { cmd: 'link', from: 'red', out: 'color', to: 'xx', in: 'a' });
  executeLine(ed, { cmd: 'link', from: 'green', out: 'color', to: 'xx', in: 'b' });
  out = executeLine(ed, { cmd: 'eval', node: 'xx', sample: [[0.5, 0.5]] });
  assert.ok(Math.abs(out.samples[0].r - 1) < 0.05 && Math.abs(out.samples[0].g - 1) < 0.05);

  executeLine(ed, { cmd: 'add', type: 'intersect', id: 'both' });
  executeLine(ed, { cmd: 'add', type: 'rgb', id: 'half', params: { color: { r: 0.5, g: 1, b: 0, a: 1 } } });
  executeLine(ed, { cmd: 'link', from: 'red', out: 'color', to: 'both', in: 'a' });
  executeLine(ed, { cmd: 'link', from: 'half', out: 'color', to: 'both', in: 'b' });
  out = executeLine(ed, { cmd: 'eval', node: 'both', sample: [[0.5, 0.5]] });
  assert.ok(Math.abs(out.samples[0].r - 0.5) < 0.05 && out.samples[0].g < 0.05, JSON.stringify(out.samples));
});

test('shapes cover their interior and a formula can count pixels', () => {
  const ed = new Editor();
  executeLine(ed, { cmd: 'new', width: 32, height: 32, name: 'S' });
  for (const type of ['circle', 'oval', 'triangle', 'ngon', 'line', 'curve']) {
    executeLine(ed, { cmd: 'add', type, id: type, params: type === 'curve' ? { width: 0.3 } : undefined });
    const out = executeLine(ed, { cmd: 'eval', node: type, sample: [[0.5, 0.5], [0.02, 0.02]] });
    assert.equal(out.ok, true, out.error);
    assert.ok(out.samples[0].a > 0.5, `${type} centre ${JSON.stringify(out.samples[0])}`);
    assert.ok(out.samples[1].a < 0.2, `${type} corner ${JSON.stringify(out.samples[1])}`);
  }
  executeLine(ed, { cmd: 'add', type: 'formula', id: 'px', params: { latex: 'u', pixels: true } });
  const out = executeLine(ed, { cmd: 'eval', node: 'px', sample: [[0.02, 0.5], [0.9, 0.5]] });
  assert.ok(out.samples[1].r > 10, JSON.stringify(out.samples));
  assert.ok(out.samples[0].r < 2, JSON.stringify(out.samples));
});

test('the agent readout names the model, the token rate, and the harness', () => {
  const text = agentReadout({ model: 'bonsai', token: 'add', tokens: 12, tps: 9.13, commands: 2, source: 'Ollama' });
  assert.equal(text, '[agent: bonsai [12 add][9.1 tok/s] [2 commands]]\n[Ollama]');
});
