// Turns a local model's completion into node-script commands. The model runs
// outside Stratum (Ollama or anything else on this computer). Nothing here talks
// to the network; the desktop shell or the page does that.
import { executeLine } from './script.js';

const CHEAT = [
  'Reply with JSON lines only. No markdown and no commentary.',
  'Each line is one object with a cmd field. Do not wrap them in an array.',
  'A new document already has checker id chk, composite id comp, and viewer id view.',
  'Link the finished picture into comp input image and view input image, then {"cmd":"apply"}.',
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
    nodes: (g.nodes || []).filter((n) => n.type !== 'frame').map((n) => ({
      id: n.id,
      type: n.type,
      params: slim(n.params),
    })),
    links: (g.links || []).map((l) => ({ from: l.from, out: l.out, to: l.to, in: l.in })),
  };
}

function slim(params) {
  if (!params) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (k === 'graph' || v == null || typeof v === 'object') continue;
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

/** Pull command objects out of a completion, including a thinking model's <think> block. */
export function extractCommands(text) {
  const stripped = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const found = [];
  const push = (obj) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    if (obj.cmd || obj.op) found.push(obj);
  };
  const trimmed = stripped.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const whole = JSON.parse(trimmed);
      if (Array.isArray(whole)) {
        for (const item of whole) push(item);
        if (found.length) return found;
      } else push(whole);
      if (found.length) return found;
    } catch { /* fall through to lines */ }
  }
  for (const raw of stripped.split(/\n/)) {
    let line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try { push(JSON.parse(line.slice(start, end + 1))); } catch { /* not a command */ }
  }
  return found;
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
