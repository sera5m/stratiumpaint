// Command-stack history (like Paint.NET's History window: click any step to jump there).
// A command is {name, undo(), redo(), bytes?, dispose?()}.
import { Emitter } from './util.js';

export class History extends Emitter {
  #undo = [];
  #redo = [];
  #bytes = 0;

  constructor({ limitBytes = 400 * 1024 * 1024, limitCount = 300 } = {}) {
    super();
    this.limitBytes = limitBytes;
    this.limitCount = limitCount;
  }

  get canUndo() { return this.#undo.length > 0; }
  get canRedo() { return this.#redo.length > 0; }
  /** Index of the current state in entries(): -1 = before the first command. */
  get index() { return this.#undo.length - 1; }

  /** Commands oldest → newest, whether applied or undone. */
  entries() {
    return [...this.#undo.map((c) => ({ name: c.name, applied: true })),
      ...[...this.#redo].reverse().map((c) => ({ name: c.name, applied: false }))];
  }

  /** Record a command that has ALREADY been applied. */
  push(cmd) {
    for (const c of this.#redo) this.#release(c);
    this.#redo = [];
    this.#undo.push(cmd);
    this.#bytes += cmd.bytes ?? 0;
    while (this.#undo.length > 1 && (this.#undo.length > this.limitCount || this.#bytes > this.limitBytes)) {
      this.#release(this.#undo.shift());
    }
    this.emit('change');
  }

  undo() {
    const c = this.#undo.pop();
    if (!c) return false;
    c.undo();
    this.#redo.push(c);
    this.emit('change');
    return true;
  }

  redo() {
    const c = this.#redo.pop();
    if (!c) return false;
    c.redo();
    this.#undo.push(c);
    this.emit('change');
    return true;
  }

  /** Move to entries()[i] (or -1 for the initial state). */
  jumpTo(i) {
    const cap = this.#undo.length + this.#redo.length - 1;
    i = Math.max(-1, Math.min(cap, i));
    while (this.index > i) { const c = this.#undo.pop(); c.undo(); this.#redo.push(c); }
    while (this.index < i) { const c = this.#redo.pop(); c.redo(); this.#undo.push(c); }
    this.emit('change');
  }

  clear() {
    for (const c of [...this.#undo, ...this.#redo]) this.#release(c);
    this.#undo = [];
    this.#redo = [];
    this.#bytes = 0;
    this.emit('change');
  }

  #release(c) {
    this.#bytes -= c.bytes ?? 0;
    c.dispose?.();
  }
}
