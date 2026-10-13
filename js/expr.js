// plot 的函數式（例如 "2x+1"、"x^2-3x"、"sqrt(x)"）轉成 JS 函式；自己解析，不用 eval。

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  log: Math.log10, ln: Math.log, exp: Math.exp,
};
const CONSTS = { pi: Math.PI, e: Math.E };
const NAMES = [...Object.keys(FUNCS), ...Object.keys(CONSTS), 'x'].sort((a, b) => b.length - a.length);

function tokenize(src) {
  const s = String(src).toLowerCase()
    .replace(/^\s*(y|f\s*\(\s*x\s*\))\s*=/, '')
    .replace(/[×·∙]/g, '*').replace(/÷/g, '/').replace(/[−–]/g, '-').replace(/π/g, 'pi').replace(/\*\*/g, '^')
    .replace(/²/g, '^2').replace(/³/g, '^3');
  const out = [];
  for (let i = 0; i < s.length;) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (num) { out.push({ t: 'num', v: Number(num[1]) }); i += num[1].length; continue; }
    if ('+-*/^(),'.includes(ch)) { out.push({ t: ch }); i++; continue; }
    const name = NAMES.find(n => s.startsWith(n, i));
    if (!name) throw new Error(`看不懂的符號：${s.slice(i, i + 6)}`);
    out.push(name in FUNCS ? { t: 'fn', v: name } : { t: 'id', v: name });
    i += name.length;
  }
  return out;
}

export function compile(src) {
  const toks = tokenize(src);
  let pos = 0;
  const peek = () => toks[pos];
  const eat = t => (toks[pos]?.t === t ? toks[pos++] : null);
  const startsAtom = tok => tok && (tok.t === 'num' || tok.t === 'id' || tok.t === 'fn' || tok.t === '(');

  function expr() {
    let f = term();
    for (;;) {
      if (eat('+')) { const a = f, b = term(); f = x => a(x) + b(x); }
      else if (eat('-')) { const a = f, b = term(); f = x => a(x) - b(x); }
      else return f;
    }
  }
  function term() {
    let f = unary();
    for (;;) {
      if (eat('*')) { const a = f, b = unary(); f = x => a(x) * b(x); }
      else if (eat('/')) { const a = f, b = unary(); f = x => a(x) / b(x); }
      else if (startsAtom(peek())) { const a = f, b = power(); f = x => a(x) * b(x); } // 2x、3(x+1)
      else return f;
    }
  }
  function unary() {
    if (eat('-')) { const a = unary(); return x => -a(x); }
    if (eat('+')) return unary();
    return power();
  }
  function power() {
    const base = atom();
    if (eat('^')) { const e = unary(); return x => Math.pow(base(x), e(x)); }
    return base;
  }
  function atom() {
    const tok = toks[pos++];
    if (!tok) throw new Error('函數式不完整');
    if (tok.t === 'num') { const v = tok.v; return () => v; }
    if (tok.t === 'id') { if (tok.v === 'x') return x => x; const v = CONSTS[tok.v]; return () => v; }
    if (tok.t === 'fn') {
      const fn = FUNCS[tok.v];
      if (eat('(')) { const a = expr(); if (!eat(')')) throw new Error('少了右括號'); return x => fn(a(x)); }
      const a = power(); // sqrt x
      return x => fn(a(x));
    }
    if (tok.t === '(') { const a = expr(); if (!eat(')')) throw new Error('少了右括號'); return a; }
    throw new Error(`這裡不該出現 ${tok.t}`);
  }

  const f = expr();
  if (pos < toks.length) throw new Error('函數式後面有多餘的東西');
  return f;
}
