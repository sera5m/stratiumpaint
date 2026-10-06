// Dev pipe: `node src/js/nodes/cli.js` then one JSON command per line.
// The compiled app speaks the same language with `stratum --script`.
import readline from 'node:readline';
import { Editor } from '../ui/editor.js';
import { executeLine } from './script.js';

const ed = new Editor();
ed.surfaceMode = 'canvas';
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  process.stdout.write(`${JSON.stringify(executeLine(ed, line))}\n`);
}
