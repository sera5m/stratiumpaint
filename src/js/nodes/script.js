// JSON-line scripting for the node compositor. One JSON object in, one JSON object out.
// The desktop app reads the same language on stdin (`stratum --script`), and a running
// copy accepts the pipe so a local model can drive a compiled build without a debugger.
import { Doc } from '../doc/document.js';
import { NODE_TYPES, socketsOf } from './types.js';
import {
  addNode, currentScope, deleteNodes, duplicateNodes, ensureGraph, enterGroup, exitGroup, findNode,
  frameNodes, groupNodes, linkSockets, markGraph, matchSocket, setCollapsed, setColor, setMuted, setParam,
  unlinkSockets, ungroupNode,
} from './graph.js';
import { applyToLayer, evaluateGraph, makeContext, previewSize, primaryOutput, summarize } from './eval.js';
import { parseFormula } from './formula.js';

export const SCRIPT_HELP = {
  protocol: 'One JSON object per line. Each line returns one JSON object with ok:true or ok:false and error.',
  pipe: 'Desktop: stratum --script   (stdin/stdout). If Stratum is already open, the pipe is handed to that copy.',
  browser: 'View → Node Editor, then Nodes → Run Script. Or node src/js/nodes/cli.js',
  commands: {
    help: {},
    types: {},
    new: { width: 512, height: 512, name: 'Untitled' },
    info: {},
    mode: { mode: 'nodes|canvas' },
    graph: {},
    add: { type: 'checker', id: 'optional', x: 0, y: 0, params: {}, label: '' },
    link: { from: 'id', out: 'socket', to: 'id', in: 'socket' },
    unlink: { from: 'id', out: 'socket', to: 'id', in: 'socket' },
    param: { id: 'id', name: 'scale', value: 4 },
    formula: { id: 'id', latex: '\\sin(u \\cdot \\pi)' },
    mute: { id: 'id', muted: true },
    collapse: { id: 'id', collapsed: true },
    color: { id: 'id', tag: '#6aa2ff' },
    delete: { id: 'id', ids: [], reconnect: false },
    duplicate: { id: 'id' },
    frame: { ids: ['a', 'b'] },
    group: { ids: ['a', 'b'] },
    ungroup: { id: 'groupId' },
    enter: { id: 'groupId' },
    exit: {},
    select: { ids: ['a'] },
    selectLayer: { index: 0 },
    apply: { node: 'comp' },
    eval: { node: 'comp', sample: [[0.5, 0.5]] },
  },
};

function needDoc(ed) {
  if (!ed.doc) throw new Error('No document. Send {"cmd":"new","width":256,"height":256} first.');
  return ensureGraph(ed.doc);
}

function changed(ed) {
  markGraph(ed.doc);
  ed.emit?.('nodes');
}

function pubNode(n) {
  const socks = socketsOf(n);
  return {
    id: n.id, type: n.type, x: n.x, y: n.y, label: n.label || '', muted: !!n.muted,
    collapsed: !!n.collapsed, color: n.color || '', parent: n.parent,
    params: { ...n.params, graph: n.params?.graph ? '[group]' : undefined },
    inputs: socks.inputs.map((s) => s.id), outputs: socks.outputs.map((s) => s.id),
  };
}

function pubGraph(g) {
  const scope = currentScope(g);
  return {
    path: [...(g.path || [])],
    time: g.time || 0,
    nodes: (scope.nodes || []).map(pubNode),
    links: (scope.links || []).map((l) => ({ from: l.from, out: l.out, to: l.to, in: l.in })),
  };
}

export function executeLine(ed, line) {
  let msg;
  try { msg = typeof line === 'string' ? JSON.parse(line) : line; }
  catch { return { ok: false, error: 'Expected one JSON object per line.' }; }
  if (!msg || typeof msg !== 'object') return { ok: false, error: 'Expected a JSON object.' };
  try { return run(ed, msg); }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
}

const firstOf = (obj, keys) => keys.map((k) => obj[k]).find((v) => v != null && v !== '');

/** Models rarely use the same field names. Fold the common ones onto cmd/from/out/to/in. */
export function normalizeCommand(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
  const out = { ...msg };
  const cmd = out.cmd || out.command || out.action || out.op;
  if (cmd) out.cmd = cmd === 'connect' || cmd === 'edge' ? 'link' : (cmd === 'create' || cmd === 'node' ? 'add' : cmd);
  if (out.cmd === 'link') {
    out.from = firstOf(out, ['from', 'fromId', 'from_id', 'src', 'source', 'sourceId', 'a']);
    out.to = firstOf(out, ['to', 'toId', 'to_id', 'dst', 'dest', 'target', 'b']);
    out.out = firstOf(out, ['out', 'output', 'fromSocket', 'from_socket', 'socketOut', 'srcSocket']);
    out.in = firstOf(out, ['in', 'input', 'toSocket', 'to_socket', 'socketIn', 'dstSocket']);
  }
  if (out.cmd === 'add' && !out.type) out.type = firstOf(out, ['type', 'node', 'kind']);
  return out;
}

function run(ed, msg) {
  msg = normalizeCommand(msg);
  const cmd = msg.cmd || msg.op;
  if (!cmd || cmd === 'help') return { ok: true, ...SCRIPT_HELP };
  if (cmd === 'types') {
    return {
      ok: true,
      types: Object.entries(NODE_TYPES).filter(([id]) => id !== 'group_in' && id !== 'group_out').map(([id, t]) => ({
        id, label: t.label, category: t.category,
        inputs: t.inputs.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
        outputs: t.outputs.map((s) => ({ id: s.id, name: s.name, kind: s.kind })),
        params: (t.params || []).map((p) => ({ id: p.id, label: p.label, type: p.type, default: p.default, min: p.min, max: p.max, options: p.options })),
      })),
    };
  }
  if (cmd === 'new') {
    const doc = new Doc(Math.max(1, msg.width | 0 || 512), Math.max(1, msg.height | 0 || 512), { name: msg.name || 'Untitled' });
    ensureGraph(doc);
    ed.addDoc(doc);
    ed.surfaceMode = 'nodes';
    ed.emit?.('surface', 'nodes');
    return { ok: true, name: doc.name, width: doc.width, height: doc.height };
  }
  if (cmd === 'info') {
    const doc = ed.doc;
    if (!doc) return { ok: true, document: null, mode: ed.surfaceMode || 'canvas' };
    const g = ensureGraph(doc);
    return {
      ok: true, mode: ed.surfaceMode || 'canvas',
      name: doc.name, width: doc.width, height: doc.height, active: doc.active,
      layers: doc.layers.map((l, i) => ({ index: i, name: l.name, visible: l.visible })),
      nodes: g.nodes.length, path: [...(g.path || [])],
    };
  }
  if (cmd === 'mode') {
    const mode = msg.mode === 'nodes' ? 'nodes' : 'canvas';
    if (mode === 'nodes') needDoc(ed);
    ed.surfaceMode = mode;
    ed.emit?.('surface', mode);
    return { ok: true, mode };
  }
  if (cmd === 'graph') return { ok: true, ...pubGraph(needDoc(ed)) };
  if (cmd === 'add') {
    const g = needDoc(ed);
    if (!NODE_TYPES[msg.type]) throw new Error(`Unknown node type “${msg.type}”. Send {"cmd":"types"}.`);
    const node = addNode(g, msg.type, { id: msg.id, x: msg.x ?? 80, y: msg.y ?? 80, params: msg.params, label: msg.label });
    changed(ed);
    return { ok: true, node: pubNode(node) };
  }
  if (cmd === 'link') {
    const g = needDoc(ed);
    const from = findNode(g, msg.from);
    const to = findNode(g, msg.to);
    if (!from || !to) throw new Error('Unknown node.');
    const out = matchSocket(from.node, 'out', msg.out);
    const inn = matchSocket(to.node, 'in', msg.in);
    const link = linkSockets(g, msg.from, out, msg.to, inn);
    changed(ed);
    return {
      ok: true,
      link: { from: link.from, out: link.out, to: link.to, in: link.in },
      coerced: out !== msg.out || inn !== msg.in ? { out, in: inn } : undefined,
    };
  }
  if (cmd === 'unlink') {
    needDoc(ed);
    unlinkSockets(ed.doc.nodeGraph, msg.from, msg.out, msg.to, msg.in);
    changed(ed);
    return { ok: true };
  }
  if (cmd === 'param') {
    const g = needDoc(ed);
    setParam(g, msg.id, msg.name, msg.value);
    changed(ed);
    return { ok: true };
  }
  if (cmd === 'formula') {
    const g = needDoc(ed);
    parseFormula(msg.latex ?? '0');
    setParam(g, msg.id, 'latex', String(msg.latex ?? '0'));
    changed(ed);
    return { ok: true };
  }
  if (cmd === 'mute') {
    const g = needDoc(ed);
    const ids = msg.ids || [msg.id];
    setMuted(g, ids, msg.muted !== false);
    changed(ed);
    return { ok: true };
  }
  if (cmd === 'collapse') {
    const g = needDoc(ed);
    setCollapsed(g, msg.ids || [msg.id], !!msg.collapsed);
    changed(ed);
    return { ok: true };
  }
  if (cmd === 'color') {
    const g = needDoc(ed);
    setColor(g, msg.ids || [msg.id], msg.tag || msg.color || '');
    changed(ed);
    return { ok: true };
  }
  if (cmd === 'delete') {
    const g = needDoc(ed);
    deleteNodes(g, msg.ids || [msg.id], { reconnect: !!msg.reconnect });
    changed(ed);
    return { ok: true };
  }
  if (cmd === 'duplicate') {
    const g = needDoc(ed);
    const nodes = duplicateNodes(g, msg.ids || [msg.id]);
    changed(ed);
    return { ok: true, ids: nodes.map((n) => n.id) };
  }
  if (cmd === 'frame') {
    const g = needDoc(ed);
    const frame = frameNodes(g, msg.ids || g.selected || []);
    changed(ed);
    return { ok: true, id: frame.id };
  }
  if (cmd === 'group') {
    const g = needDoc(ed);
    const group = groupNodes(g, msg.ids || []);
    changed(ed);
    return { ok: true, id: group.id, inputs: socketsOf(group).inputs, outputs: socketsOf(group).outputs };
  }
  if (cmd === 'ungroup') {
    const g = needDoc(ed);
    const nodes = ungroupNode(g, msg.id);
    changed(ed);
    return { ok: true, ids: nodes.map((n) => n.id) };
  }
  if (cmd === 'enter') {
    enterGroup(needDoc(ed), msg.id);
    changed(ed);
    return { ok: true, path: [...ed.doc.nodeGraph.path] };
  }
  if (cmd === 'exit') {
    exitGroup(needDoc(ed));
    changed(ed);
    return { ok: true, path: [...ed.doc.nodeGraph.path] };
  }
  if (cmd === 'select') {
    const g = needDoc(ed);
    g.selected = msg.ids || [];
    ed.emit?.('nodes');
    return { ok: true, selected: g.selected };
  }
  if (cmd === 'selectLayer') {
    const doc = ed.doc;
    if (!doc) throw new Error('No document.');
    doc.selectLayer?.(msg.index | 0);
    return { ok: true, active: doc.active };
  }
  if (cmd === 'apply') {
    const doc = ed.doc;
    if (!doc) throw new Error('No document.');
    ensureGraph(doc);
    const result = applyToLayer(doc, msg.node);
    ed.emit?.('doc:render');
    return { ok: true, node: result.node, errors: result.errors };
  }
  if (cmd === 'eval') {
    const doc = ed.doc;
    if (!doc) throw new Error('No document.');
    const g = ensureGraph(doc);
    const size = previewSize(doc, 96);
    const { values, errors } = evaluateGraph(g, makeContext(doc, size.width, size.height));
    const id = msg.node || g.nodes.find((n) => n.type === 'composite')?.id;
    const node = g.nodes.find((n) => n.id === id) || findNested(g, id);
    if (!node) throw new Error(`No node ${id}.`);
    const value = primaryOutput(values, node);
    if (value == null) return { ok: false, error: errors[0]?.error || 'No output.', errors };
    const summary = summarize(value, size.width, size.height, msg.sample || [[0.5, 0.5]]);
    return { ok: true, node: id, errors, ...roundSummary(summary) };
  }
  throw new Error(`Unknown command “${cmd}”. Send {"cmd":"help"}.`);
}

function findNested(scope, id) {
  for (const n of scope.nodes || []) {
    if (n.id === id) return n;
    if (n.params?.graph) {
      const hit = findNested(n.params.graph, id);
      if (hit) return hit;
    }
  }
  return null;
}

function roundSummary(s) {
  const r4 = (n) => Math.round(n * 10000) / 10000;
  const px = (p) => ({ u: p.u, v: p.v, r: r4(p.r), g: r4(p.g), b: r4(p.b), a: r4(p.a) });
  return { width: s.width, height: s.height, mean: px({ u: 0, v: 0, ...s.mean }), samples: s.samples.map(px) };
}
