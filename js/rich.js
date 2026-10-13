// 文字排版：$…$ 是數學式（MathJax 轉成 SVG），**…** 是黃色重點，其他照原樣。
// 黑板右邊的算式區用 HTML，左邊的畫布標籤用 SVG。MathJax 載不到時改用純文字近似。

const MATHJAX_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/3.2.2/es5/tex-svg.min.js';
const NS = 'http://www.w3.org/2000/svg';
const CJK = /[⺀-鿿豈-﫿＀-￯　-〿]/;

let mathjax = null; // 載入成功後是 window.MathJax

export const mathReady = new Promise(resolve => {
  if (typeof window === 'undefined') return resolve(false);
  window.MathJax = {
    loader: { load: ['[tex]/color', '[tex]/cancel'] },
    tex: {
      packages: { '[+]': ['color', 'cancel'] },
      inlineMath: [], displayMath: [],
      macros: {
        hl: ['{\\color[RGB]{255,213,74}{#1}}', 1],
        red: ['{\\color[RGB]{255,154,143}{#1}}', 1],
        blue: ['{\\color[RGB]{140,203,255}{#1}}', 1],
        green: ['{\\color[RGB]{179,236,159}{#1}}', 1],
        orange: ['{\\color[RGB]{255,176,103}{#1}}', 1],
        degree: '^{\\circ}',
      },
    },
    svg: { fontCache: 'local' },
    options: { enableMenu: false },
    startup: {
      typeset: false,
      ready() {
        window.MathJax.startup.defaultReady();
        window.MathJax.startup.promise.then(() => {
          mathjax = window.MathJax;
          document.head.append(mathjax.svgStylesheet());
          labelCache.clear();
          resolve(true);
        }, () => resolve(false));
      },
    },
  };
  const s = document.createElement('script');
  s.src = MATHJAX_SRC;
  s.async = true;
  s.onerror = () => resolve(false);
  document.head.append(s);
  setTimeout(() => resolve(false), 12000);
});

/* ---------- 切段 ---------- */

// "一份：$24 \div 8 = 3$ 公分" → [{math:false,s:'一份：'},{math:true,s:'24 \div 8 = 3'},{math:false,s:' 公分'}]
export function splitMath(text) {
  const s = String(text ?? '');
  const parts = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$]+?)\$|\\\(([\s\S]+?)\\\)/g;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push({ math: false, s: s.slice(last, m.index) });
    parts.push({ math: true, s: (m[1] ?? m[2] ?? m[3]).trim() });
    last = re.lastIndex;
  }
  if (last < s.length) parts.push({ math: false, s: s.slice(last) });
  // 忘了加 $ 的 LaTeX：沒有中文的那幾段裡有 \指令，就當成數學式
  if (!parts.some(p => p.math) && /\\[a-zA-Z]+/.test(s)) {
    return s.split(/([⺀-鿿豈-﫿＀-￯　-〿]+)/).filter(Boolean)
      .map(seg => ({ math: !CJK.test(seg) && /\\[a-zA-Z]+|[\^_]/.test(seg), s: seg }));
  }
  return parts.filter(p => p.s !== '');
}

// MathJax 不在時的純文字近似
export function texToText(tex) {
  let s = String(tex);
  for (let i = 0; i < 4; i++) {
    s = s.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '$1/$2')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
      .replace(/\\(?:boxed|text|mathrm|textbf|mathbf|hl|red|blue|green|orange|overline|cancel)\s*\{([^{}]*)\}/g, '$1');
  }
  const SYM = {
    times: '×', div: '÷', cdot: '·', pm: '±', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
    approx: '≈', pi: 'π', angle: '∠', triangle: '△', circ: '°', degree: '°', therefore: '∴', because: '∵',
    perp: '⊥', parallel: '∥', cong: '≅', sim: '∼', rightarrow: '→', to: '→', Rightarrow: '⇒', infty: '∞',
    alpha: 'α', beta: 'β', theta: 'θ', quad: ' ', qquad: '  ',
  };
  return s.replace(/\^\{?\\circ\}?/g, '°').replace(/\^\{?2\}?/g, '²').replace(/\^\{?3\}?/g, '³')
    .replace(/\\left|\\right/g, '').replace(/\\[,;:! ]/g, ' ')
    .replace(/\\([a-zA-Z]+)/g, (_, c) => SYM[c] ?? c)
    .replace(/[{}]/g, '');
}

/* ---------- MathJax ---------- */

const mathCache = new Map();

// AI 寫的 \color{red} 這類顏色名稱，換成黑板上的粉筆色
const CHALK_RGB = { red: '255,154,143', blue: '140,203,255', green: '179,236,159', yellow: '255,213,74', orange: '255,176,103' };
const chalkColors = tex => tex.replace(/\\(color|textcolor)\{(red|blue|green|yellow|orange)\}/g, (_, cmd, c) => `\\${cmd}[RGB]{${CHALK_RGB[c]}}`);

// 一段 LaTeX → MathJax 的 <mjx-container>（每次給一份複本）；失敗回傳 null
function mathContainer(tex) {
  if (!mathjax) return null;
  tex = chalkColors(tex);
  let node = mathCache.get(tex);
  if (node === undefined) {
    try {
      node = mathjax.tex2svg(tex, { display: false });
      if (node.querySelector('[data-mjx-error], merror, [data-mml-node="merror"]')) node = null;
    } catch { node = null; }
    mathCache.set(tex, node);
  }
  return node ? node.cloneNode(true) : null;
}

/* ---------- HTML ---------- */

function textNodes(s, hlClass = 'hl') {
  const out = [];
  s.split(/\*\*/).forEach((seg, i) => {
    if (!seg) return;
    const lines = seg.split('\n');
    const frag = [];
    lines.forEach((line, j) => {
      if (j) frag.push(document.createElement('br'));
      if (line) frag.push(document.createTextNode(line));
    });
    if (i % 2) {
      const b = document.createElement('b');
      b.className = hlClass;
      b.append(...frag);
      out.push(b);
    } else out.push(...frag);
  });
  return out;
}

export function renderRich(el, text) {
  const nodes = [];
  for (const p of splitMath(text)) {
    if (!p.math) { nodes.push(...textNodes(p.s)); continue; }
    const m = mathContainer(p.s);
    if (m) nodes.push(m);
    else {
      const span = document.createElement('span');
      span.className = 'tex-fallback';
      span.textContent = texToText(p.s);
      nodes.push(span);
    }
  }
  el.replaceChildren(...nodes);
  return el;
}

/* ---------- SVG 標籤 ---------- */

let measurer = null;
const labelCache = new Map();

function getMeasurer() {
  if (measurer?.isConnected) return measurer;
  measurer = document.createElementNS(NS, 'svg');
  measurer.setAttribute('class', 'fig measure');
  measurer.setAttribute('aria-hidden', 'true');
  measurer.style.cssText = 'position:absolute;left:-9999px;top:0;width:200px;height:200px;visibility:hidden;pointer-events:none';
  document.body.append(measurer);
  return measurer;
}

if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.addEventListener?.('loadingdone', () => labelCache.clear());
}

// 文字 → { node, w, h }：node 是一個 <g>，內容的中心在 (0,0)；單位跟畫布一樣
export function svgLabel(text, size = 4) {
  const key = `${size}|${text}`;
  let hit = labelCache.get(key);
  if (!hit) {
    hit = buildLabel(String(text ?? ''), size);
    labelCache.set(key, hit);
  }
  return { node: hit.node.cloneNode(true), w: hit.w, h: hit.h };
}

function buildLabel(text, size) {
  const host = getMeasurer();
  const outer = document.createElementNS(NS, 'g');
  outer.setAttribute('class', 'lbl');
  const inner = document.createElementNS(NS, 'g');
  outer.append(inner);
  host.append(outer);
  const ex = size * 0.47;
  let x = 0, top = -size * 0.82, bottom = size * 0.28;
  for (const p of splitMath(text)) {
    if (p.math) {
      const c = mathContainer(p.s);
      const svg = c?.querySelector('svg');
      if (svg) {
        const wEx = parseFloat(svg.getAttribute('width')) || 0;
        const hEx = parseFloat(svg.getAttribute('height')) || 0;
        const va = parseFloat((svg.getAttribute('style') || '').match(/vertical-align:\s*(-?[\d.]+)ex/)?.[1] || '0');
        const y = -va * ex - hEx * ex;
        svg.removeAttribute('style');
        svg.setAttribute('x', x);
        svg.setAttribute('y', y);
        svg.setAttribute('width', wEx * ex);
        svg.setAttribute('height', hEx * ex);
        svg.setAttribute('class', 'math');
        inner.append(svg);
        x += wEx * ex;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y + hEx * ex);
        continue;
      }
    }
    const raw = p.math ? texToText(p.s) : p.s;
    raw.replace(/\n/g, ' ').split(/\*\*/).forEach((seg, i) => {
      if (!seg) return;
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('x', x);
      t.setAttribute('y', 0);
      t.setAttribute('font-size', size);
      t.setAttribute('class', i % 2 ? 'tx hl' : 'tx');
      t.textContent = seg;
      inner.append(t);
      let w = 0;
      try { w = t.getComputedTextLength(); } catch { /* 量不到就估 */ }
      if (!w) w = [...seg].reduce((n, ch) => n + (CJK.test(ch) ? size : size * 0.55), 0);
      x += w;
    });
  }
  inner.setAttribute('transform', `translate(${(-x / 2).toFixed(3)} ${(-(top + bottom) / 2).toFixed(3)})`);
  outer.remove();
  return { node: outer, w: x, h: bottom - top };
}
