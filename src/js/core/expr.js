// Numeric fields accept a sum, not only a literal: 1+2, (3*4)/2, -5+1.5. No names, no calls.
// Returns a finite number, or null when the text is not an expression.

export function evalExpr(input) {
  const s = String(input ?? '').trim().replace(/\s+/g, '');
  if (!s || !/^[-+*/().0-9eE]+$/.test(s)) return null;
  let i = 0;
  const peek = () => s[i];
  const parseExpr = () => {
    let v = parseTerm();
    if (v == null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = s[i++];
      const r = parseTerm();
      if (r == null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const parseTerm = () => {
    let v = parseUnary();
    if (v == null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = s[i++];
      const r = parseUnary();
      if (r == null || (op === '/' && r === 0)) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const parseUnary = () => {
    if (peek() === '+') { i++; return parseUnary(); }
    if (peek() === '-') { i++; const v = parseUnary(); return v == null ? null : -v; }
    return parsePrimary();
  };
  const parsePrimary = () => {
    if (peek() === '(') {
      i++;
      const v = parseExpr();
      if (v == null || peek() !== ')') return null;
      i++;
      return v;
    }
    const m = s.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/i);
    if (!m) return null;
    i += m[0].length;
    const n = Number(m[0]);
    return Number.isFinite(n) ? n : null;
  };
  const v = parseExpr();
  if (v == null || i !== s.length || !Number.isFinite(v)) return null;
  return v;
}
