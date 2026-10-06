// Formula nodes speak a small slice of LaTeX maths. The same tree is evaluated per pixel
// and drawn in the sidebar. Nothing here touches the DOM.

const FUN1 = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sqrt', 'abs', 'log', 'exp', 'floor', 'ceil', 'sign', 'fract']);
const FUN2 = new Set(['atan2', 'min', 'max', 'pow', 'mod', 'hypot']);
const NAMES = new Set(['u', 'v', 'x', 'y', 'r', 'g', 'b', 'a', 'A', 'B', 'C', 't', 'W', 'H', 'pi', 'e', 'tau']);

const ALIAS = { ln: 'log', frac: 'frac', cdot: '*', times: '*', div: '/', pi: 'pi', tau: 'tau', left: 'left', right: 'right' };

export function parseFormula(input) {
  const s = String(input ?? '0').trim().replace(/^\$+|\$+$/g, '');
  let i = 0;
  const err = (m) => { throw new Error(`${m} in “${s || '0'}”`); };
  const skip = () => { while (s[i] === ' ' || s[i] === '\n' || s[i] === '\t') i++; };
  const eat = (c) => { if (s[i] === c) { i++; return true; } return false; };

  function command() {
    let name = '';
    while (/[a-zA-Z]/.test(s[i] || '')) name += s[i++];
    return ALIAS[name] || name;
  }

  function parseExpr() { return parseAdd(); }

  function parseAdd() {
    let n = parseMul();
    for (;;) {
      skip();
      if (s[i] === '+' ) { i++; n = { t: 'op', op: '+', a: n, b: parseMul() }; }
    else if (s[i] === '-') { i++; n = { t: 'op', op: '-', a: n, b: parseMul() }; }
      else break;
    }
    return n;
  }

  function isAtomStart(c) {
    return !!c && (/[0-9.({\\]/.test(c) || /[A-Za-z]/.test(c));
  }

  function parseMul() {
    let n = parseUnary();
    for (;;) {
      skip();
      if (eat('*')) { n = { t: 'op', op: '*', a: n, b: parseUnary() }; continue; }
      if (eat('/')) { n = { t: 'op', op: '/', a: n, b: parseUnary() }; continue; }
      if (s.startsWith('\\cdot', i) || s.startsWith('\\times', i)) {
        i++;
        command();
        n = { t: 'op', op: '*', a: n, b: parseUnary() };
        continue;
      }
      if (isAtomStart(s[i])) { n = { t: 'op', op: '*', a: n, b: parseUnary() }; continue; }
      break;
    }
    return n;
  }

  function parseUnary() {
    skip();
    if (eat('+')) return parseUnary();
    if (eat('-')) return { t: 'op', op: '-', a: { t: 'num', v: 0 }, b: parseUnary() };
    return parsePow();
  }

  function parsePow() {
    let n = parseAtom();
    skip();
    if (eat('^')) n = { t: 'pow', a: n, b: parseUnary() };
    return n;
  }

  function parseAtom() {
    skip();
    if (!s[i]) err('Formula ended early');
    if (eat('(')) { const n = parseExpr(); if (!eat(')')) err('Missing )'); return n; }
    if (eat('{')) { const n = parseExpr(); if (!eat('}')) err('Missing }'); return n; }
    if (s[i] === '\\') {
      i++;
      const cmd = command();
      if (cmd === 'left' || cmd === 'right') { if (s[i] === '(' || s[i] === ')' || s[i] === '[' || s[i] === ']' || s[i] === '.') i++; return parseAtom(); }
      if (cmd === 'pi' || cmd === 'tau') return { t: 'name', v: cmd };
      if (cmd === 'frac') return { t: 'frac', a: parseAtom(), b: parseAtom() };
      if (cmd === 'sqrt') return { t: 'call', op: 'sqrt', args: [parseAtom()] };
      if (FUN1.has(cmd) || cmd === 'log') return { t: 'call', op: cmd, args: [parseAtom()] };
      if (FUN2.has(cmd)) {
        skip();
        if (eat('(')) {
          const a = parseExpr();
          eat(',');
          const b = parseExpr();
          if (!eat(')')) err('Missing )');
          return { t: 'call', op: cmd, args: [a, b] };
        }
        return { t: 'call', op: cmd, args: [parseAtom(), parseAtom()] };
      }
      if (cmd === '*') return parseAtom();
      err(`Unknown \\${cmd}`);
    }
    if (/[0-9.]/.test(s[i])) {
      let num = '';
      while (/[0-9.]/.test(s[i] || '')) num += s[i++];
      const v = Number(num);
      if (!Number.isFinite(v)) err(`Bad number ${num}`);
      return { t: 'num', v };
    }
    if (/[A-Za-z]/.test(s[i])) {
      let name = '';
      while (/[A-Za-z]/.test(s[i] || '')) name += s[i++];
      const op = name === 'ln' ? 'log' : name;
      if (FUN1.has(op) || FUN2.has(op)) {
        skip();
        if (s[i] === '(' || s[i] === '{') {
          if (FUN2.has(op)) {
            if (eat('(')) {
              const a = parseExpr();
              eat(',');
              const b = parseExpr();
              if (!eat(')')) err('Missing )');
              return { t: 'call', op, args: [a, b] };
            }
            return { t: 'call', op, args: [parseAtom(), parseAtom()] };
          }
          return { t: 'call', op, args: [parseAtom()] };
        }
      }
      if (!NAMES.has(name)) err(`Unknown name ${name}`);
      return { t: 'name', v: name };
    }
    err(`Unexpected “${s[i]}”`);
    return { t: 'num', v: 0 };
  }

  const ast = parseExpr();
  skip();
  if (i < s.length) err(`Unexpected “${s.slice(i, i + 12)}”`);
  return ast;
}

const CALLS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow, exp: Math.exp, log: Math.log,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, hypot: Math.hypot,
  fract: (a) => a - Math.floor(a),
  mod: (a, b) => (b ? a - b * Math.floor(a / b) : 0),
};

/** Walk the tree. No `Function` constructor: the desktop page forbids eval. */
function walk(ast, env) {
  if (!ast) return 0;
  if (ast.t === 'num') return ast.v;
  if (ast.t === 'name') {
    const v = env?.[ast.v];
    return typeof v === 'number' ? v : 0;
  }
  if (ast.t === 'frac') {
    const d = walk(ast.b, env);
    return d ? walk(ast.a, env) / d : 0;
  }
  if (ast.t === 'pow') return Math.pow(walk(ast.a, env), walk(ast.b, env));
  if (ast.t === 'call') {
    const fn = CALLS[ast.op];
    return fn ? fn(...(ast.args || []).map((arg) => walk(arg, env))) : 0;
  }
  if (ast.t === 'op') {
    const a = walk(ast.a, env);
    const b = walk(ast.b, env);
    if (ast.op === '+') return a + b;
    if (ast.op === '-') return a - b;
    if (ast.op === '*') return a * b;
    if (ast.op === '/') return b ? a / b : 0;
  }
  return 0;
}

/** Compile once. `env` carries the pixel and the Math helpers. */
export function compileFormula(input) {
  const ast = parseFormula(input);
  const fn = (env) => {
    const n = walk(ast, env);
    return Number.isFinite(n) ? n : 0;
  };
  return { ast, fn };
}

export function evalFormula(compiled, env) {
  const n = compiled.fn(env);
  return Number.isFinite(n) ? n : 0;
}

const ENV_BASE = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max, pow: Math.pow, exp: Math.exp, log: Math.log,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, hypot: Math.hypot,
  pi: Math.PI, e: Math.E, tau: Math.PI * 2,
  mod: (a, b) => b ? a - b * Math.floor(a / b) : 0,
};

export function formulaEnv(extra) {
  return Object.assign(Object.create(null), ENV_BASE, extra);
}

/** Draw the tree. Returns the box width and height in pixels. */
export function drawFormula(ctx, ast, x, y, size, color = '#e8eaef') {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.font = `${size}px "DejaVu Sans", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.lineWidth = Math.max(1, size / 16);
  return draw(ctx, ast, x, y, size).w;
}

function textWidth(ctx, text, size) {
  ctx.font = `${size}px "DejaVu Sans", sans-serif`;
  return ctx.measureText(text).width;
}

function draw(ctx, ast, x, y, size) {
  if (!ast || ast.t === 'num' || ast.t === 'name') {
    const label = !ast ? '0' : ast.t === 'num' ? String(ast.v) : ast.v;
    const w = textWidth(ctx, label, size);
    ctx.fillText(label, x, y);
    return { w, h: size };
  }
  if (ast.t === 'op' && (ast.op === '*' || ast.op === '/')) {
    if (ast.op === '/') return drawFrac(ctx, ast.a, ast.b, x, y, size);
    const A = draw(ctx, ast.a, x, y, size);
    const dot = textWidth(ctx, '·', size);
    ctx.fillText('·', x + A.w, y);
    const B = draw(ctx, ast.b, x + A.w + dot, y, size);
    return { w: A.w + dot + B.w, h: size };
  }
  if (ast.t === 'op') {
    const A = draw(ctx, ast.a, x, y, size);
    const op = ` ${ast.op} `;
    const ow = textWidth(ctx, op, size);
    ctx.fillText(op, x + A.w, y);
    const B = draw(ctx, ast.b, x + A.w + ow, y, size);
    return { w: A.w + ow + B.w, h: Math.max(A.h, B.h) };
  }
  if (ast.t === 'frac') return drawFrac(ctx, ast.a, ast.b, x, y, size);
  if (ast.t === 'pow') {
    const A = draw(ctx, ast.a, x, y, size);
    const small = Math.max(8, size * 0.65);
    const B = draw(ctx, ast.b, x + A.w + 1, y - size * 0.35, small);
    return { w: A.w + B.w + 1, h: size + small * 0.4 };
  }
  if (ast.t === 'call' && ast.op === 'sqrt') {
    const inner = measureOnly(ctx, ast.args[0], size);
    const pad = size * 0.45;
    ctx.beginPath();
    ctx.moveTo(x, y + size * 0.05);
    ctx.lineTo(x + pad * 0.45, y + size * 0.35);
    ctx.lineTo(x + pad * 0.7, y - size * 0.35);
    ctx.lineTo(x + pad + inner.w + 2, y - size * 0.35);
    ctx.stroke();
    draw(ctx, ast.args[0], x + pad, y, size);
    return { w: pad + inner.w + 2, h: size };
  }
  const name = ast.op || '';
  const nw = textWidth(ctx, name, size);
  ctx.fillText(name, x, y);
  ctx.fillText('(', x + nw, y);
  let cx = x + nw + textWidth(ctx, '(', size);
  ast.args.forEach((arg, idx) => {
    if (idx) { ctx.fillText(',', cx, y); cx += textWidth(ctx, ',', size); }
    const box = draw(ctx, arg, cx, y, size);
    cx += box.w;
  });
  ctx.fillText(')', cx, y);
  return { w: cx + textWidth(ctx, ')', size) - x, h: size };
}

function drawFrac(ctx, a, b, x, y, size) {
  const small = Math.max(8, size * 0.8);
  const aw = measureOnly(ctx, a, small).w;
  const bw = measureOnly(ctx, b, small).w;
  const w = Math.max(aw, bw) + 4;
  draw(ctx, a, x + (w - aw) / 2, y - small * 0.55, small);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + w, y);
  ctx.stroke();
  draw(ctx, b, x + (w - bw) / 2, y + small * 0.55, small);
  return { w, h: small * 2 };
}

function measureOnly(ctx, ast, size) {
  // Draw into a detached measurement by reusing draw's widths without a second canvas:
  // call draw far offscreen is unnecessary; duplicate the width walk.
  return widthOf(ctx, ast, size);
}

function widthOf(ctx, ast, size) {
  if (!ast || ast.t === 'num' || ast.t === 'name') return { w: textWidth(ctx, !ast ? '0' : ast.t === 'num' ? String(ast.v) : ast.v, size), h: size };
  if (ast.t === 'frac' || (ast.t === 'op' && ast.op === '/')) {
    const small = Math.max(8, size * 0.8);
    return { w: Math.max(widthOf(ctx, ast.a, small).w, widthOf(ctx, ast.b, small).w) + 4, h: small * 2 };
  }
  if (ast.t === 'pow') return { w: widthOf(ctx, ast.a, size).w + widthOf(ctx, ast.b, size * 0.65).w + 1, h: size };
  if (ast.t === 'call' && ast.op === 'sqrt') return { w: widthOf(ctx, ast.args[0], size).w + size * 0.5, h: size };
  if (ast.t === 'call') {
    let w = textWidth(ctx, `${ast.op}(`, size) + textWidth(ctx, ')', size);
    ast.args.forEach((arg, idx) => { w += widthOf(ctx, arg, size).w + (idx ? textWidth(ctx, ',', size) : 0); });
    return { w, h: size };
  }
  if (ast.t === 'op' && ast.op === '*') return { w: widthOf(ctx, ast.a, size).w + textWidth(ctx, '·', size) + widthOf(ctx, ast.b, size).w, h: size };
  if (ast.t === 'op') return { w: widthOf(ctx, ast.a, size).w + textWidth(ctx, ` ${ast.op} `, size) + widthOf(ctx, ast.b, size).w, h: size };
  return { w: size, h: size };
}
