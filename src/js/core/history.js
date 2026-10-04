// Undo tree. The active path behaves like a normal stack (undo, redo, jump).
// A new edit after undoing keeps the old branch, so the History panel can show it.
// A command is {name, undo(), redo(), bytes?, dispose?()}.
import { Emitter } from './util.js';

export class History extends Emitter {
  #nodes = [this.#root()];
  #cur = 0;
  #bytes = 0;

  constructor({ limitBytes = 400 * 1024 * 1024, limitCount = 300 } = {}) {
    super();
    this.limitBytes = limitBytes;
    this.limitCount = limitCount;
  }

  get canUndo() { return this.#nodes[this.#cur]?.parent != null; }
  get canRedo() { return this.#nodes[this.#cur]?.preferred != null; }
  /** Index of the current state in entries(): -1 = before the first command on this path. */
  get index() { return this.#path(this.#cur).length - 2; }

  /** Commands on the active path, oldest → newest, including the undone future. */
  entries() {
    const applied = this.#path(this.#cur).filter((id) => id !== 0);
    const future = this.#futureFrom(this.#cur);
    return [
      ...applied.map((id) => ({ name: this.#nodes[id].name, applied: true, id })),
      ...future.map((n) => ({ name: n.name, applied: false, id: n.id })),
    ];
  }

  /**
   * Every edit, including branches that were left behind.
   * { id, name, depth, current, future, side, children }
   */
  tree() {
    const future = new Set(this.#futureFrom(this.#cur).map((n) => n.id));
    const onPath = new Set(this.#path(this.#cur));
    const walk = (id, depth) => {
      const n = this.#nodes[id];
      return {
        id,
        name: n.cmd ? n.name : 'Initial state',
        depth,
        current: id === this.#cur,
        future: future.has(id),
        side: !!(n.cmd && !onPath.has(id) && !future.has(id)),
        children: n.children.filter((c) => this.#nodes[c]).map((c) => walk(c, depth + 1)),
      };
    };
    return walk(0, 0);
  }

  /** Record a command that has ALREADY been applied. Other children of this state are kept. */
  push(cmd) {
    const parent = this.#nodes[this.#cur];
    const id = this.#nodes.length;
    this.#nodes.push({ id, parent: this.#cur, name: cmd.name, cmd, children: [], preferred: null });
    parent.children.push(id);
    parent.preferred = id;
    this.#cur = id;
    this.#bytes += cmd.bytes ?? 0;
    this.#trim();
    this.emit('change');
  }

  undo() {
    if (!this.#undoOne()) return false;
    this.emit('change');
    return true;
  }

  redo() {
    const next = this.#nodes[this.#cur]?.preferred;
    if (next == null || !this.#redoOne(next)) return false;
    this.emit('change');
    return true;
  }

  /** Move along the active path. -1 is the initial state. */
  jumpTo(i) {
    const list = this.entries();
    i = Math.max(-1, Math.min(list.length - 1, i | 0));
    return this.goTo(i < 0 ? 0 : list[i].id);
  }

  /** Jump to any node in the tree, including a side branch. */
  goTo(id) {
    if (id == null || !this.#nodes[id] || id === this.#cur) return false;
    const target = this.#path(id);
    const cur = this.#path(this.#cur);
    let i = 0;
    while (i < target.length && i < cur.length && target[i] === cur[i]) i++;
    const backTo = target[i - 1];
    while (this.#cur !== backTo) {
      if (!this.#undoOne()) break;
    }
    for (let k = i; k < target.length; k++) {
      if (!this.#redoOne(target[k])) break;
    }
    this.emit('change');
    return true;
  }

  clear() {
    for (const n of this.#nodes) if (n?.cmd) this.#release(n.cmd);
    this.#nodes = [this.#root()];
    this.#cur = 0;
    this.#bytes = 0;
    this.emit('change');
  }

  #root() {
    return { id: 0, parent: null, name: null, cmd: null, children: [], preferred: null };
  }

  #path(id) {
    const out = [];
    const seen = new Set();
    while (id != null && this.#nodes[id] && !seen.has(id)) {
      seen.add(id);
      out.push(id);
      id = this.#nodes[id].parent;
    }
    return out.reverse();
  }

  #futureFrom(id) {
    const out = [];
    const seen = new Set();
    let n = this.#nodes[id];
    while (n?.preferred != null && !seen.has(n.preferred)) {
      const child = this.#nodes[n.preferred];
      if (!child) break;
      seen.add(child.id);
      out.push(child);
      n = child;
    }
    return out;
  }

  #undoOne() {
    const node = this.#nodes[this.#cur];
    if (!node || node.parent == null) return false;
    node.cmd.undo();
    this.#nodes[node.parent].preferred = node.id;
    this.#cur = node.parent;
    return true;
  }

  #redoOne(id) {
    const node = this.#nodes[id];
    if (!node?.cmd || node.parent !== this.#cur) return false;
    node.cmd.redo();
    this.#nodes[node.parent].preferred = id;
    this.#cur = id;
    return true;
  }

  #cmdCount() {
    let n = 0;
    for (const node of this.#nodes) if (node?.cmd) n++;
    return n;
  }

  #trim() {
    const over = () => this.#cmdCount() > this.limitCount || this.#bytes > this.limitBytes;
    while (over()) {
      if (this.#dropOffPath()) continue;
      if (this.#path(this.#cur).length <= 2) break;
      if (!this.#dropOldestAncestor()) break;
    }
  }

  #dropOffPath() {
    const on = new Set(this.#path(this.#cur));
    let victim = null;
    for (const node of this.#nodes) {
      if (!node?.cmd || on.has(node.id)) continue;
      if (node.children.some((id) => this.#nodes[id])) continue;
      if (!victim || node.id < victim.id) victim = node;
    }
    if (!victim) return false;
    this.#detach(victim.id);
    return true;
  }

  #dropOldestAncestor() {
    const root = this.#nodes[0];
    const oldest = this.#path(this.#cur)[1];
    const node = oldest == null ? null : this.#nodes[oldest];
    if (!node?.cmd) return false;
    this.#release(node.cmd);
    const keep = node.children.filter((id) => this.#nodes[id]);
    root.children = [...keep, ...root.children.filter((id) => id !== oldest && this.#nodes[id])];
    for (const id of keep) this.#nodes[id].parent = 0;
    if (root.preferred === oldest) root.preferred = node.preferred ?? keep.at(-1) ?? null;
    if (this.#cur === oldest) this.#cur = 0;
    this.#nodes[oldest] = null;
    return true;
  }

  #detach(id) {
    const node = this.#nodes[id];
    const parent = this.#nodes[node.parent];
    if (parent) {
      parent.children = parent.children.filter((c) => c !== id);
      if (parent.preferred === id) parent.preferred = parent.children.at(-1) ?? null;
    }
    this.#release(node.cmd);
    this.#nodes[id] = null;
  }

  #release(cmd) {
    if (!cmd) return;
    this.#bytes -= cmd.bytes ?? 0;
    cmd.dispose?.();
  }
}
