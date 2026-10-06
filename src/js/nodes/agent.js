// Turns a local model's completion into node-script commands. The model runs
// outside Stratum (Ollama or anything else on this computer). Nothing here talks
// to the network; the desktop shell or the page does that.
import { executeLine, normalizeCommand } from './script.js';
import { socketsOf } from './types.js';

const CHEAT = [
  'Reply with JSON lines only. No markdown and no commentary.',
  'Each line is one object with a cmd field. Do not wrap them in an array.',
  'A new document already has checker id chk, composite id comp, and viewer id view.',
  'Link the finished picture into comp input image and view input image, then {"cmd":"apply"}.',
  'Each node below lists its "in" and "out" socket ids. link must use those ids.',
  'Commands: add {type,id,params}, link {from,out,to,in}, param {id,name,value}, formula {id,latex}, delete {id}, apply.',
  'Types: checker, noise, voronoi, wave, gradient, brick, white, mix, add, sub, xor, intersect, blur, formula, rgb, circle, oval, triangle, ngon, line, curve.',
  'gradient inputs are start and end (vectors) plus color1 and color2. formula params.pixels true makes u and v pixel coordinates; otherwise they are 0 to 1.',
  'Formula latex may use \\\\frac{u}{2}, \\\\sin(u \\\\cdot \\\\pi), or u^2+v^2. Variables are u, v, r, g, b, a.',
  'mix params.mode is one of mix, multiply, screen, overlay, add. wave params.kind is bands or rings.',
].join('\n');

export function graphBrief(doc) {
  const g = doc?.nodeGraph;
  if (!g) return { nodes: [], links: [] };
  return {
    width: doc.width,
    height: doc.height,
    nodes: (g.nodes || []).filter((n) => n.type !== 'frame').map((n) => {
      const socks = socketsOf(n);
      return {
        id: n.id,
        type: n.type,
        in: socks.inputs.map((s) => s.id),
        out: socks.outputs.map((s) => s.id),
        params: slim(n.params),
      };
    }),
    links: (g.links || []).map((l) => ({ from: l.from, out: l.out, to: l.to, in: l.in })),
  };
}

function slim(params) {
  if (!params) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'graph' || v == null) continue;
    if (typeof v === 'object') {
      if (Number.isFinite(+v.r) && Number.isFinite(+v.g) && Number.isFinite(+v.b)) out[k] = hexColor(v);
      continue;
    }
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export function taskPrompt(task, doc) {
  return `${CHEAT}\nTask: ${String(task || '').trim()}\nCurrent graph:\n${JSON.stringify(graphBrief(doc))}`;
}

export function repairPrompt(task, doc, results) {
  const failed = (results || []).filter((r) => r && r.ok === false).map((r) => r.error).join('\n');
  return `${taskPrompt(task, doc)}\nThese commands failed. Reply with only the replacement lines:\n${failed}`;
}

function hexColor(c) {
  const n = (x) => Math.round(Math.max(0, Math.min(1, +x)) * 255).toString(16).padStart(2, '0');
  return `#${n(c.r)}${n(c.g)}${n(c.b)}${n(c.a ?? 1)}`;
}

/** Pull command objects out of a completion, including a thinking model's <think> block.
 *  Several objects may share a line. A cut-off tail does not throw away the objects before it. */
export function extractCommands(text) {
  const raw = String(text || '');
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, '');
  let found = collectCommands(scanJson(stripped));
  if (!found.length && stripped !== raw) found = collectCommands(scanJson(raw));
  return found;
}

function collectCommands(values) {
  const found = [];
  const consider = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { for (const item of obj) consider(item); return; }
    const cmd = normalizeCommand(obj);
    if (cmd.cmd || cmd.op) { found.push(cmd); return; }
    for (const key of ['commands', 'ops', 'lines', 'script']) consider(obj[key]);
  };
  for (const value of values) consider(value);
  return found;
}

function scanJson(text) {
  const found = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== '{' && c !== '[') { i++; continue; }
    const end = matchJson(text, i);
    if (end < 0) { i++; continue; }
    const slice = text.slice(i, end);
    const parsed = parseLoose(slice);
    if (parsed !== undefined) { found.push(parsed); i = end; }
    else i++;
  }
  return found;
}

function matchJson(text, start) {
  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseLoose(slice) {
  try { return JSON.parse(slice); }
  catch { /* trailing commas are common */ }
  try { return JSON.parse(slice.replace(/,\s*([}\]])/g, '$1')); }
  catch { return undefined; }
}

export function runCommands(ed, commands) {
  return (commands || []).map((cmd) => executeLine(ed, JSON.stringify(cmd)));
}

/** Only a loopback Ollama. Returns the generate URL. */
export function ollamaEndpoint(url = 'http://127.0.0.1:11434') {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('That address is not a URL.'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only a local http address is allowed.');
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') throw new Error('Only a model on this computer is allowed.');
  parsed.pathname = '/api/generate';
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

export function checkModelName(model) {
  const name = String(model || '').trim();
  if (!name || name.length > 80 || !/^[\w.:/-]+$/.test(name)) throw new Error('Type the Ollama model name, such as qwen2.5-coder:7b.');
  return name;
}

/** Two-line readout while a local model or another harness is working. */
export function agentReadout({ model, token, tokens, tps, commands, source }) {
  const name = String(model || 'model');
  const piece = token ? `${tokens ?? 0} ${String(token).replace(/\s+/g, ' ').trim().slice(0, 24)}` : String(tokens ?? 0);
  const rate = (Number.isFinite(+tps) ? +tps : 0).toFixed(1);
  const from = String(source || 'Ollama');
  return `[agent: ${name} [${piece}][${rate} tok/s] [${commands | 0} commands]]\n[${from}]`;
}

function clip(text, head = 16000, tail = 80000) {
  const s = String(text ?? '');
  if (s.length <= head + tail) return s;
  return `${s.slice(0, head)}\n\n… ${s.length - head - tail} characters cut …\n\n${s.slice(-tail)}`;
}

/** Plain text stored as agent.txt inside the job, so a bad reply can be copied out of the save. */
export function formatAgentDebug(info) {
  const lines = [
    'Stratum agent debug',
    `time: ${info?.time || ''}`,
    `model: ${info?.model || ''}`,
    `source: ${info?.source || ''}`,
    `tokens: ${info?.tokens ?? ''}`,
    `tok/s: ${info?.tps ?? ''}`,
    `stop: ${info?.doneReason || 'end'}`,
    '',
    '--- prompt ---',
    clip(info?.prompt, 20000, 20000),
    '',
    '--- raw output ---',
    clip(info?.output),
    '',
    '--- commands ---',
    (info?.commands || []).map((c) => JSON.stringify(c)).join('\n') || '(none)',
    '',
    '--- results ---',
    (info?.results || []).map((r) => JSON.stringify(r)).join('\n') || '(none)',
    '',
    '--- graph ---',
    JSON.stringify(info?.graph || {}, null, 2),
    '',
  ];
  return lines.join('\n');
}
