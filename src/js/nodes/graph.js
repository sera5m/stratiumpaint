// The node graph lives on the document. Undo here is a snapshot stack and is not the paint history.
import { NODE_TYPES, defaultParams, socketKind, socketsOf } from './types.js';

const MAX_UNDO = 50;
export const NODE_W = 196;

export function defaultGraph() {
  const g = {
    nodes: [], links: [], seq: 1, time: 0, path: [], selected: [], undo: [], redo: [],
  };
  const chk = addNode(g, 'checker', { id: 'chk', x: 40, y: 80 });
  const comp = addNode(g, 'composite', { id: 'comp', x: 340, y: 60 });
  const view = addNode(g, 'viewer', { id: 'view', x: 340, y: 220 });
  linkSockets(g, chk.id, 'color', comp.id, 'image');
  linkSockets(g, chk.id, 'color', view.id, 'image');
  g.undo = [];
  g.redo = [];
  g.selected = [];
  return g;
}

export function ensureGraph(doc) {
  if (!doc) return null;
  if (!doc.nodeGraph) doc.nodeGraph = defaultGraph();
  const g = doc.nodeGraph;
  g.nodes ||= [];
  g.links ||= [];
  g.path ||= [];
  g.selected ||= [];
  g.undo ||= [];
  g.redo ||= [];
  g.seq ||= 1;
  g.time ||= 0;
  return g;
}

export function graphForSave(g) {
  if (!g) return null;
  return { nodes: g.nodes, links: g.links, seq: g.seq || 1, time: g.time || 0 };
}

export function graphFromSave(raw) {
  if (!raw || !Array.isArray(raw.nodes)) return null;
  return {
    nodes: raw.nodes, links: raw.links || [], seq: raw.seq || 1, time: raw.time || 0,
    path: [], selected: [], undo: [], redo: [],
  };
}

export function markGraph(doc) {
  if (!doc) return;
  doc._graphDirty = true;
  doc.emit?.('meta');
}

function capture(g) {
  return JSON.stringify({ nodes: g.nodes, links: g.links, seq: g.seq, time: g.time || 0 });
}

function applyCapture(g, json) {
  const data = JSON.parse(json);
  g.nodes = data.nodes;
  g.links = data.links;
  g.seq = data.seq || 1;
  g.time = data.time || 0;
  if ((g.path || []).some((id) => !findNode(g, id))) g.path = [];
  g.selected = (g.selected || []).filter((id) => findNode(g, id));
  g.rev = (g.rev || 0) + 1;
}

/** Call around a drag so the whole gesture is one undo step. Nested edits join it. */
export function beginEdit(g) {
  if (!g || g._editing) return;
  g._editing = capture(g);
}

export function endEdit(g) {
  if (!g?._editing) return false;
  const before = g._editing;
  g._editing = null;
  const after = capture(g);
  if (before === after) return false;
  g.undo.push(before);
  if (g.undo.length > MAX_UNDO) g.undo.shift();
  g.redo = [];
  g.rev = (g.rev || 0) + 1;
  return true;
}

function edit(g, fn) {
  const outer = !!g._editing;
  if (!outer) beginEdit(g);
  try {
    return fn();
  } finally {
    if (!outer) endEdit(g);
  }
}

export function canUndoGraph(g) { return !!g?.undo?.length; }
export function canRedoGraph(g) { return !!g?.redo?.length; }

export function undoGraph(g) {
  if (!canUndoGraph(g)) return false;
  g.redo.push(capture(g));
  applyCapture(g, g.undo.pop());
  return true;
}

export function redoGraph(g) {
  if (!canRedoGraph(g)) return false;
  g.undo.push(capture(g));
  applyCapture(g, g.redo.pop());
  return true;
}

function alloc(g) {
  const id = `n${g.seq || 1}`;
  g.seq = (g.seq || 1) + 1;
  return id;
}

export function currentScope(g) {
  let scope = g;
  for (const id of g.path || []) {
    const n = (scope.nodes || []).find((node) => node.id === id);
    if (!n?.params?.graph) return scope;
    scope = n.params.graph;
  }
  return scope;
}

export function findNode(g, id) {
  const walk = (scope) => {
    for (const n of scope.nodes || []) {
      if (n.id === id) return { node: n, scope };
      if (n.type === 'group' && n.params?.graph) {
        const hit = walk(n.params.graph);
        if (hit) return hit;
      }
    }
    return null;
  };
  return g ? walk(g) : null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function blankNode(id, type, x, y, params) {
  return {
    id, type, x, y, label: '', muted: false, collapsed: false, color: '', parent: null,
    params: { ...defaultParams(type), ...params },
  };
}

export function addNode(g, type, { id, x = 80, y = 80, params, label } = {}) {
  return edit(g, () => {
    const scope = currentScope(g);
    if (id && findNode(g, id)) throw new Error(`Node “${id}” already exists.`);
    const node = blankNode(id || alloc(g), type, x, y, params);
    if (label) node.label = label;
    if (type === 'group' && !node.params.graph) {
      const gin = alloc(g);
      const gout = alloc(g);
      node.params.graph = {
        nodes: [
          blankNode(gin, 'group_in', 40, 80, { sockets: [] }),
          blankNode(gout, 'group_out', 360, 80, { sockets: [] }),
        ],
        links: [],
      };
    }
    scope.nodes.push(node);
    g.selected = [node.id];
    return node;
  });
}

function reaches(scope, start, target) {
  const adj = new Map();
  for (const l of scope.links || []) {
    if (!adj.has(l.from)) adj.set(l.from, []);
    adj.get(l.from).push(l.to);
  }
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const n = stack.pop();
    if (n === target) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of adj.get(n) || []) stack.push(m);
  }
  return false;
}

export function linkSockets(g, from, out, to, inn) {
  return edit(g, () => {
    const a = findNode(g, from);
    const b = findNode(g, to);
    if (!a || !b) throw new Error('Unknown node.');
    if (a.scope !== b.scope) throw new Error('Those nodes are not in the same group.');
    if (from === to) throw new Error('A node cannot link to itself.');
    if (reaches(a.scope, to, from)) throw new Error('That link would make a cycle.');
    if (!socketsOf(a.node).outputs.some((s) => s.id === out)) {
      const ids = socketsOf(a.node).outputs.map((s) => s.id).join(', ') || 'none';
      throw new Error(`No output “${out}” on ${from} (${a.node.type}). Outputs: ${ids}.`);
    }
    if (!socketsOf(b.node).inputs.some((s) => s.id === inn)) {
      const ids = socketsOf(b.node).inputs.map((s) => s.id).join(', ') || 'none';
      throw new Error(`No input “${inn}” on ${to} (${b.node.type}). Inputs: ${ids}.`);
    }
    a.scope.links = a.scope.links.filter((l) => !(l.to === to && l.in === inn));
    if (b.node.type === 'reroute') b.node.params.kind = socketKind(a.node, 'out', out);
    const link = { id: alloc(g), from, out, to, in: inn };
    a.scope.links.push(link);
    return link;
  });
}

export function unlinkSockets(g, from, out, to, inn) {
  return edit(g, () => {
    const a = findNode(g, from);
    if (!a) return false;
    const before = a.scope.links.length;
    a.scope.links = a.scope.links.filter((l) => !(l.from === from && l.out === out && l.to === to && l.in === inn));
    return a.scope.links.length !== before;
  });
}

export function setParam(g, id, name, value) {
  return edit(g, () => {
    const hit = findNode(g, id);
    if (!hit) throw new Error(`No node ${id}.`);
    hit.node.params = { ...hit.node.params, [name]: value };
    return hit.node;
  });
}

/** Change a param without its own undo step (the caller opened beginEdit). */
export function setParamLive(g, id, name, value) {
  const hit = findNode(g, id);
  if (!hit) return;
  hit.node.params[name] = value;
}

export function setMuted(g, ids, muted) {
  return edit(g, () => {
    for (const id of ids) {
      const hit = findNode(g, id);
      if (hit) hit.node.muted = muted;
    }
  });
}

export function setCollapsed(g, ids, collapsed) {
  return edit(g, () => {
    for (const id of ids) {
      const hit = findNode(g, id);
      if (hit) hit.node.collapsed = collapsed;
    }
  });
}

export function setColor(g, ids, color) {
  return edit(g, () => {
    for (const id of ids) {
      const hit = findNode(g, id);
      if (hit) hit.node.color = color;
    }
  });
}

export function deleteNodes(g, ids, { reconnect = false } = {}) {
  return edit(g, () => {
    const drop = new Set(ids);
    const scopes = new Set();
    for (const id of ids) {
      const hit = findNode(g, id);
      if (hit) scopes.add(hit.scope);
    }
    for (const scope of scopes) {
      const extra = [];
      if (reconnect) {
        for (const id of ids) {
          if (!scope.nodes.some((n) => n.id === id)) continue;
          const incoming = scope.links.filter((l) => l.to === id);
          const outgoing = scope.links.filter((l) => l.from === id);
          if (incoming.length !== 1) continue;
          const src = incoming[0];
          for (const o of outgoing) {
            if (drop.has(o.to)) continue;
            extra.push({ id: alloc(g), from: src.from, out: src.out, to: o.to, in: o.in });
          }
        }
      }
      for (const n of scope.nodes) if (n.parent && drop.has(n.parent)) n.parent = null;
      scope.nodes = scope.nodes.filter((n) => !drop.has(n.id));
      scope.links = scope.links.filter((l) => !drop.has(l.from) && !drop.has(l.to));
      for (const l of extra) {
        scope.links = scope.links.filter((x) => !(x.to === l.to && x.in === l.in));
        scope.links.push(l);
      }
    }
    g.selected = (g.selected || []).filter((id) => !drop.has(id));
    if ((g.path || []).some((id) => drop.has(id))) g.path = [];
  });
}

export function duplicateNodes(g, ids, dx = 28, dy = 28) {
  return edit(g, () => pasteInto(g, copyOf(g, ids), dx, dy, true));
}

function copyOf(g, ids) {
  const scope = currentScope(g);
  const set = new Set(ids);
  const nodes = scope.nodes.filter((n) => set.has(n.id)).map((n) => clone(n));
  const links = scope.links.filter((l) => set.has(l.from) && set.has(l.to)).map((l) => clone(l));
  return { nodes, links };
}

export function copySelection(g) {
  const clip = copyOf(g, g.selected || []);
  g.clipboard = clip;
  return clip;
}

function pasteInto(g, clip, dx, dy, keepRelative) {
  if (!clip?.nodes?.length) return [];
  const scope = currentScope(g);
  const map = new Map();
  const created = [];
  for (const n of clip.nodes) {
    if ((n.type === 'group_in' || n.type === 'group_out') && scope.nodes.some((x) => x.type === n.type)) continue;
    const id = alloc(g);
    map.set(n.id, id);
    const node = clone(n);
    node.id = id;
    node.x = keepRelative ? n.x + dx : dx + n.x;
    node.y = keepRelative ? n.y + dy : dy + n.y;
    node.parent = null;
    scope.nodes.push(node);
    created.push(node);
  }
  for (const l of clip.links || []) {
    if (!map.has(l.from) || !map.has(l.to)) continue;
    scope.links.push({ id: alloc(g), from: map.get(l.from), out: l.out, to: map.get(l.to), in: l.in });
  }
  g.selected = created.map((n) => n.id);
  return created;
}

export function pasteClipboard(g, x, y) {
  return edit(g, () => {
    const clip = g.clipboard;
    if (!clip?.nodes?.length) return [];
    const minX = Math.min(...clip.nodes.map((n) => n.x));
    const minY = Math.min(...clip.nodes.map((n) => n.y));
    const shifted = {
      nodes: clip.nodes.map((n) => ({ ...n, x: n.x - minX, y: n.y - minY })),
      links: clip.links,
    };
    return pasteInto(g, shifted, x, y, true);
  });
}

export function frameNodes(g, ids) {
  return edit(g, () => {
    const scope = currentScope(g);
    const nodes = scope.nodes.filter((n) => ids.includes(n.id) && n.type !== 'frame');
    if (!nodes.length) throw new Error('Nothing to frame.');
    const x0 = Math.min(...nodes.map((n) => n.x)) - 24;
    const y0 = Math.min(...nodes.map((n) => n.y)) - 36;
    const x1 = Math.max(...nodes.map((n) => n.x + nodeBox(n).w)) + 24;
    const y1 = Math.max(...nodes.map((n) => n.y + nodeBox(n).h)) + 24;
    const frame = addNode(g, 'frame', { x: x0, y: y0, params: { w: x1 - x0, h: y1 - y0, title: 'Frame' } });
    for (const n of nodes) n.parent = frame.id;
    g.selected = [frame.id, ...nodes.map((n) => n.id)];
    return frame;
  });
}

export function groupNodes(g, ids) {
  return edit(g, () => {
    const scope = currentScope(g);
    const set = new Set(ids);
    const moving = scope.nodes.filter((n) => set.has(n.id) && n.type !== 'group_in' && n.type !== 'group_out' && n.type !== 'frame');
    if (!moving.length) throw new Error('Nothing to group.');
    const gid = alloc(g);
    const gin = alloc(g);
    const gout = alloc(g);
    const inSocks = [];
    const outSocks = [];
    const innerLinks = [];
    const incoming = [];
    const outgoing = [];
    for (const l of scope.links) {
      const a = set.has(l.from);
      const b = set.has(l.to);
      if (a && b) innerLinks.push({ id: alloc(g), from: l.from, out: l.out, to: l.to, in: l.in });
      else if (!a && b) {
        let sock = inSocks.find((s) => s.from === l.from && s.out === l.out);
        if (!sock) {
          const src = scope.nodes.find((n) => n.id === l.from);
          sock = { id: `in${inSocks.length}`, name: l.out, kind: src ? socketKind(src, 'out', l.out) : 'value', from: l.from, out: l.out };
          inSocks.push(sock);
          incoming.push({ id: alloc(g), from: l.from, out: l.out, to: gid, in: sock.id });
        }
        innerLinks.push({ id: alloc(g), from: gin, out: sock.id, to: l.to, in: l.in });
      } else if (a && !b) {
        let sock = outSocks.find((s) => s.from === l.from && s.out === l.out);
        if (!sock) {
          const src = scope.nodes.find((n) => n.id === l.from);
          sock = { id: `out${outSocks.length}`, name: l.out, kind: src ? socketKind(src, 'out', l.out) : 'value', from: l.from, out: l.out };
          outSocks.push(sock);
        }
        outgoing.push({ id: alloc(g), from: gid, out: sock.id, to: l.to, in: l.in });
        innerLinks.push({ id: alloc(g), from: l.from, out: l.out, to: gout, in: sock.id });
      }
    }
    const minX = Math.min(...moving.map((n) => n.x));
    const minY = Math.min(...moving.map((n) => n.y));
    const innerNodes = [
      blankNode(gin, 'group_in', 40, 40, { sockets: inSocks.map(({ id, name, kind }) => ({ id, name, kind })) }),
      ...moving.map((n) => ({ ...clone(n), x: n.x - minX + 220, y: n.y - minY + 40, parent: null })),
      blankNode(gout, 'group_out', 520, 40, { sockets: outSocks.map(({ id, name, kind }) => ({ id, name, kind })) }),
    ];
    scope.nodes = scope.nodes.filter((n) => !set.has(n.id) || n.type === 'frame');
    scope.links = scope.links.filter((l) => !set.has(l.from) && !set.has(l.to)).concat(incoming, outgoing);
    const group = blankNode(gid, 'group', minX, minY, {
      title: 'Group',
      graph: { nodes: innerNodes, links: innerLinks },
    });
    group.label = 'Group';
    scope.nodes.push(group);
    g.selected = [gid];
    return group;
  });
}

export function ungroupNode(g, id) {
  return edit(g, () => {
    const hit = findNode(g, id);
    if (!hit || hit.node.type !== 'group') throw new Error('Not a group.');
    const node = hit.node;
    const scope = hit.scope;
    const inner = node.params.graph || { nodes: [], links: [] };
    const gin = inner.nodes.find((n) => n.type === 'group_in');
    const gout = inner.nodes.find((n) => n.type === 'group_out');
    const moved = inner.nodes.filter((n) => n !== gin && n !== gout).map((n) => ({
      ...clone(n), x: node.x + (n.x - 220), y: node.y + (n.y - 40), parent: null,
    }));
    const links = [];
    for (const l of scope.links) {
      if (l.to === id && gin) {
        const innerLink = inner.links.find((x) => x.from === gin.id && x.out === l.in);
        if (innerLink) links.push({ id: alloc(g), from: l.from, out: l.out, to: innerLink.to, in: innerLink.in });
      } else if (l.from === id && gout) {
        const innerLink = inner.links.find((x) => x.to === gout.id && x.in === l.out);
        if (innerLink) links.push({ id: alloc(g), from: innerLink.from, out: innerLink.out, to: l.to, in: l.in });
      } else links.push(l);
    }
    for (const l of inner.links) {
      if (gin && (l.from === gin.id || l.to === gin.id)) continue;
      if (gout && (l.from === gout.id || l.to === gout.id)) continue;
      links.push({ id: alloc(g), from: l.from, out: l.out, to: l.to, in: l.in });
    }
    scope.nodes = scope.nodes.filter((n) => n.id !== id).concat(moved);
    scope.links = links;
    g.selected = moved.map((n) => n.id);
    return moved;
  });
}

export function enterGroup(g, id) {
  const scope = currentScope(g);
  const n = scope.nodes.find((node) => node.id === id);
  if (!n || n.type !== 'group') throw new Error('Not a group.');
  g.path = [...(g.path || []), id];
  g.selected = [];
}

export function exitGroup(g) {
  if (!g.path?.length) return false;
  const left = g.path[g.path.length - 1];
  g.path = g.path.slice(0, -1);
  g.selected = left ? [left] : [];
  return true;
}

export function moveNodes(g, ids, dx, dy, { snap = false } = {}) {
  const scope = currentScope(g);
  const moving = new Set(ids);
  for (const id of ids) {
    const n = scope.nodes.find((node) => node.id === id);
    if (n?.type === 'frame') {
      for (const child of scope.nodes) if (child.parent === n.id) moving.add(child.id);
    }
  }
  for (const n of scope.nodes) {
    if (!moving.has(n.id)) continue;
    n.x += dx;
    n.y += dy;
    if (snap) { n.x = Math.round(n.x / 20) * 20; n.y = Math.round(n.y / 20) * 20; }
  }
}

/** Drop links whose straight run crosses the cutter segment. */
export function cutLinks(g, x0, y0, x1, y1) {
  return edit(g, () => {
    const scope = currentScope(g);
    const before = scope.links.length;
    scope.links = scope.links.filter((l) => {
      const a = findNode(g, l.from)?.node;
      const b = findNode(g, l.to)?.node;
      if (!a || !b) return false;
      const p = socketXY(a, 'out', l.out);
      const q = socketXY(b, 'in', l.in);
      return !segmentsCross(x0, y0, x1, y1, p.x, p.y, q.x, q.y);
    });
    return before !== scope.links.length;
  });
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d = (x, y, x2, y2) => x * y2 - y * x2;
  const r = d(bx - ax, by - ay, dx - cx, dy - cy);
  if (Math.abs(r) < 1e-8) return false;
  const t = d(cx - ax, cy - ay, dx - cx, dy - cy) / r;
  const u = d(cx - ax, cy - ay, bx - ax, by - ay) / r;
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98;
}

export function nodeBox(node) {
  if (node.type === 'reroute') return { w: 16, h: 16 };
  if (node.type === 'frame') return { w: Math.max(40, node.params?.w || 280), h: Math.max(40, node.params?.h || 180) };
  const socks = socketsOf(node);
  const rows = Math.max(socks.inputs.length, socks.outputs.length, 1);
  if (node.collapsed) return { w: NODE_W, h: 26 };
  const preview = node.type === 'viewer' || node.type === 'composite' ? 68 : 0;
  const swatch = !node.collapsed && node.type === 'rgb' ? 78 : 0;
  return { w: NODE_W, h: 26 + 8 + rows * 18 + preview + swatch };
}

export function socketXY(node, dir, id) {
  const box = nodeBox(node);
  if (node.type === 'reroute') return { x: node.x + 8, y: node.y + 8 };
  const list = dir === 'in' ? socketsOf(node).inputs : socketsOf(node).outputs;
  let i = Math.max(0, list.findIndex((s) => s.id === id));
  if (node.collapsed) return { x: dir === 'in' ? node.x : node.x + box.w, y: node.y + 13 };
  return { x: dir === 'in' ? node.x : node.x + box.w, y: node.y + 26 + 12 + i * 18 };
}

export function nodeLabel(node) {
  if (node.label) return node.label;
  if (node.type === 'frame') return node.params?.title || 'Frame';
  if (node.type === 'group') return node.params?.title || 'Group';
  return NODE_TYPES[node.type]?.label || node.type;
}

/** Pick the socket a model meant. Exact id wins; otherwise a close name, or the only socket. */
export function matchSocket(node, dir, name) {
  const list = (dir === 'out' ? socketsOf(node).outputs : socketsOf(node).inputs) || [];
  if (!list.length) return String(name || '');
  const want = String(name ?? '').trim();
  if (!want) return list[0].id;
  if (list.some((s) => s.id === want)) return want;
  const key = want.toLowerCase().replace(/[\s_-]+/g, '');
  const byText = list.find((s) => s.id.toLowerCase().replace(/[\s_-]+/g, '') === key
    || String(s.name || '').toLowerCase().replace(/[\s_-]+/g, '') === key);
  if (byText) return byText.id;
  let pool = [];
  if (['image', 'img', 'picture', 'tex', 'texture'].includes(key)) {
    pool = list.filter((s) => s.kind === 'image' || s.kind === 'color' || s.id === 'image' || s.id === 'color');
  } else if (['colour', 'color', 'rgb', 'rgba'].includes(key)) {
    pool = list.filter((s) => s.kind === 'color' || s.id === 'color' || s.id === 'color1');
  } else if (['value', 'float', 'number', 'fac', 'factor', 'mask'].includes(key)) {
    pool = list.filter((s) => s.kind === 'value' || s.id === 'fac' || s.id === 'value' || s.id === 'mask');
  } else if (['vector', 'vec', 'uv', 'coord', 'coords'].includes(key)) {
    pool = list.filter((s) => s.kind === 'vector' || s.id === 'vector' || s.id === 'start');
  } else if (['out', 'output', 'result', 'in', 'input'].includes(key)) pool = list;
  const uniq = [...new Map(pool.map((s) => [s.id, s])).values()];
  if (uniq.length === 1) return uniq[0].id;
  if (list.length === 1) return list[0].id;
  return want;
}
