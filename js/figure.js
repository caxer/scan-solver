// 黑板左邊的畫布：照腳本新增、改變圖形，做出粉筆畫上去的動畫。
// 座標：寬固定 100、高 h，左上角 (0,0)，y 往下。
import { svgLabel } from './rich.js';
import { compile } from './expr.js';
import { tween } from './timing.js';

const NS = 'http://www.w3.org/2000/svg';
const COLORS = new Set(['white', 'yellow', 'red', 'blue', 'green', 'orange', 'gray']);
const COLOR_ALIAS = {
  ink: 'white', default: 'white', black: 'white', chalk: 'white', pink: 'red', purple: 'blue', cyan: 'blue', grey: 'gray',
  白: 'white', 白色: 'white', 黃: 'yellow', 黃色: 'yellow', 紅: 'red', 紅色: 'red', 粉紅: 'red', 藍: 'blue', 藍色: 'blue',
  綠: 'green', 綠色: 'green', 橘: 'orange', 橘色: 'orange', 灰: 'gray', 灰色: 'gray',
};
const TYPE_ALIAS = {
  line: 'seg', segment: 'seg', polygon: 'poly', triangle: 'poly', polyline: 'poly', rectangle: 'rect', box: 'rect',
  label: 'text', number_line: 'numberline', numberLine: 'numberline', coord: 'axes', coordinates: 'axes', graph: 'plot',
  function: 'plot', func: 'plot', emoji: 'icons', icon: 'icons', tape: 'bar', curve: 'path', dot: 'point',
  arc: 'angle', fraction: 'pie', squares: 'grid',
};
const POS_ALIAS = {
  上: 'up', 下: 'down', 左: 'left', 右: 'right', 左上: 'up-left', 右上: 'up-right', 左下: 'down-left', 右下: 'down-right', 中: 'center',
  above: 'up', top: 'up', below: 'down', bottom: 'down', 'above-left': 'up-left', 'above-right': 'up-right',
  'below-left': 'down-left', 'below-right': 'down-right', 'top-left': 'up-left', 'top-right': 'up-right',
  'bottom-left': 'down-left', 'bottom-right': 'down-right', middle: 'center', inside: 'center',
};
// set 的時候不做平滑變化、直接換掉的參數
const DISCRETE = new Set(['parts', 'cols', 'rows', 'names', 'sides', 'labels', 'icon', 'text', 'label', 'fn', 'on', 'color',
  'fill', 'dash', 'bold', 'side', 'pos', 'arrow', 'closed', 'right', 'grid', 'minor', 'step', 'align', 'd', 'ticks']);
const BASE_DUR = { add: 900, hl: 750, move: 900, rotate: 1000, set: 700, copy: 500, remove: 450 };

/* ---------- 小工具 ---------- */

const clampN = v => Math.max(-400, Math.min(500, v));
const num = (v, d) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? clampN(n) : d; };
const int = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Math.round(num(v, d))));
const fmt = v => (Math.abs(v) < 1e-9 ? '0' : String(Number(v.toFixed(4))).replace('-', '−'));
const f2 = v => Number(v.toFixed(2));
export function colorName(c, fallback = 'white') {
  if (c === true || c == null || c === '') return fallback;
  const k = String(c).trim();
  if (COLORS.has(k)) return k;
  return COLOR_ALIAS[k] ?? COLOR_ALIAS[k.toLowerCase()] ?? fallback;
}
function pt(v) {
  if (Array.isArray(v) && v.length >= 2) {
    const x = num(v[0], NaN), y = num(v[1], NaN);
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
  }
  if (v && typeof v === 'object' && 'x' in v) return pt([v.x, v.y]);
  if (typeof v === 'string' && v.includes(',')) return pt(v.split(','));
  return null;
}
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mulS = (a, k) => [a[0] * k, a[1] * k];
const len = a => Math.hypot(a[0], a[1]);
const unit = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
const P = p => `${f2(p[0])} ${f2(p[1])}`;

function el(tag, attrs = {}, parent) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v);
  parent?.append(node);
  return node;
}

// 2D 仿射矩陣 [a b c d e f]
const ID = [1, 0, 0, 1, 0, 0];
const mmul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const mtrans = (dx, dy) => [1, 0, 0, 1, dx, dy];
const mrot = (deg, cx, cy) => {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return mmul(mtrans(cx, cy), mmul([c, s, -s, c, 0, 0], mtrans(-cx, -cy)));
};
const mapply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

function lerpVal(a, b, t, key) {
  if (DISCRETE.has(key)) return t < 0.5 ? a : b;
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) return a.map((v, i) => lerpVal(v, b[i], t, ''));
  return t < 0.5 ? a : b;
}

function nice(range, target = 10) {
  const raw = Math.abs(range) / target || 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function ticks(lo, hi, step) {
  const out = [];
  const start = Math.ceil(lo / step - 1e-9) * step;
  for (let v = start, i = 0; v <= hi + step * 1e-6 && i < 200; v += step, i++) out.push(Number(v.toFixed(8)));
  return out;
}

/* ---------- 正規化每種圖形的參數 ---------- */

function normType(t) {
  const k = String(t ?? '').trim();
  return TYPE_ALIAS[k] ?? TYPE_ALIAS[k.toLowerCase()] ?? k.toLowerCase();
}

export const TYPES = new Set(['text', 'seg', 'arrow', 'rect', 'bar', 'brace', 'poly', 'circle', 'angle', 'point',
  'numberline', 'axes', 'plot', 'grid', 'pie', 'icons', 'path']);

/* ---------- Figure ---------- */

export class Figure {
  constructor(svg) {
    this.svg = svg;
    this.defs = el('defs', {}, svg);
    this.defs.innerHTML = `<filter id="chalk" x="-2%" y="-2%" width="104%" height="104%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="2.2" numOctaves="2" seed="7" result="n"/>
      <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.3 1.5" result="grain"/>
      <feComposite in="SourceGraphic" in2="grain" operator="in"/>
    </filter>`;
    this.layer = el('g', { class: 'layer', filter: 'url(#chalk)' }, svg);
    this.marks = el('g', { class: 'marks', filter: 'url(#chalk)' }, svg);
    this.els = new Map();
    this.auto = 0;
    this.clipN = 0;
    this.reset(60);
  }

  // view：一開始的視野，預設是整張畫布 [0, 0, 100, h]
  reset(h = 60, view = null) {
    this.h = h;
    this.layer.replaceChildren();
    this.marks.replaceChildren();
    this.els.clear();
    this.setView(view ?? [0, 0, 100, h]);
  }

  // 目前畫上去的東西的範圍
  contentBox() {
    let b;
    try { b = this.layer.getBBox(); } catch { return null; }
    return b && (b.width || b.height) ? { x: b.x, y: b.y, w: b.width, h: b.height } : null;
  }

  setView(v) {
    this.view = v;
    this.svg.setAttribute('viewBox', v.map(f2).join(' '));
  }

  // 圖形超出畫布時，慢慢把視野拉大（不縮小，避免一直跳）
  async fit(dur, ctl) {
    let box;
    try { box = this.layer.getBBox(); } catch { return; }
    if (!box || (!box.width && !box.height)) return;
    const pad = 3;
    const [vx, vy, vw, vh] = this.view;
    const x0 = Math.min(vx, box.x - pad), y0 = Math.min(vy, box.y - pad);
    const x1 = Math.max(vx + vw, box.x + box.width + pad), y1 = Math.max(vy + vh, box.y + box.height + pad);
    const next = [x0, y0, x1 - x0, y1 - y0];
    if (next.every((v, i) => Math.abs(v - this.view[i]) < 0.5)) return;
    const from = this.view;
    await tween(dur, ctl, t => this.setView(from.map((v, i) => v + (next[i] - v) * t)));
  }

  clearMarks(instant) {
    const old = [...this.marks.children];
    if (instant) { old.forEach(n => n.remove()); return; }
    for (const n of old) {
      n.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
      setTimeout(() => n.remove(), 320);
    }
  }

  async erase(dur, ctl) {
    const nodes = [...this.layer.children];
    await tween(dur, ctl, t => nodes.forEach(n => n.setAttribute('opacity', 1 - t)));
    this.layer.replaceChildren();
    this.els.clear();
  }

  /* ----- 執行一個動作 ----- */

  // speed：播放速度；instant：直接跳到結果（倒帶、跳步驟時）
  async apply(action, { speed = 1, instant = false, ctl } = {}) {
    if (!action || typeof action !== 'object') return;
    const dur = op => (instant ? 0 : (BASE_DUR[op] * num(action.dur, 1)) / speed);
    try {
      if ('add' in action) return await this.add(action, dur('add'), ctl);
      const target = action.hl ?? action.highlight;
      if (target != null) return instant ? undefined : await this.hl(target, dur('hl'), ctl);
      if ('move' in action) return await this.move(action.move, pt(action.by) ?? [0, 0], dur('move'), ctl);
      if ('rotate' in action) return await this.rotate(action, dur('rotate'), ctl);
      if ('set' in action || 'update' in action) return await this.set(action.set ?? action.update, action, dur('set'), ctl);
      if ('copy' in action) return await this.copy(action, dur('copy'), ctl);
      const rm = action.remove ?? action.delete ?? action.erase;
      if (rm != null) return await this.remove(rm, dur('remove'), ctl);
    } catch (e) {
      console.warn('畫圖動作失敗', action, e);
    }
  }

  ids(v) { return (Array.isArray(v) ? v : [v]).map(String).filter(id => this.els.has(id)); }

  async add(a, dur, ctl) {
    const type = normType(a.add);
    if (!TYPES.has(type)) return;
    const id = a.id != null && a.id !== '' ? String(a.id) : `_${++this.auto}`;
    if (this.els.has(id)) this.els.get(id).g.remove();
    const props = { ...a };
    delete props.add; delete props.id; delete props.with; delete props.dur;
    const item = { id, type, props, m: ID, g: el('g', { 'data-id': id }, this.layer) };
    this.els.set(id, item);
    this.draw(item);
    if (dur > 0) await this.enter(item, dur, ctl);
  }

  async set(idv, a, dur, ctl) {
    const changes = { ...a };
    for (const k of ['set', 'update', 'with', 'dur', 'id']) delete changes[k];
    for (const id of this.ids(idv)) {
      const item = this.els.get(id);
      const from = item.props, to = { ...from, ...changes };
      if (dur <= 0) { item.props = to; this.draw(item); continue; }
      const onlyDiscrete = Object.keys(changes).every(k => DISCRETE.has(k) || typeof changes[k] !== 'number' && !Array.isArray(changes[k]));
      if (onlyDiscrete) {
        await tween(dur * 0.4, ctl, t => item.g.setAttribute('opacity', 1 - 0.6 * t));
        item.props = to;
        this.draw(item);
        await tween(dur * 0.6, ctl, t => item.g.setAttribute('opacity', 0.4 + 0.6 * t));
        item.g.removeAttribute('opacity');
      } else {
        const keys = Object.keys(changes);
        const start = k => from[k] ?? (k === 'shade' || k === 'count' ? 0 : changes[k]);
        await tween(dur, ctl, t => {
          const cur = { ...from };
          for (const k of keys) cur[k] = lerpVal(start(k), changes[k], t, k);
          item.props = cur;
          this.draw(item);
        });
        item.props = to;
        this.draw(item);
      }
    }
  }

  async move(idv, by, dur, ctl) {
    const items = this.ids(idv).map(id => this.els.get(id));
    const start = items.map(i => i.m);
    await tween(dur, ctl, t => items.forEach((it, k) => {
      it.m = mmul(mtrans(by[0] * t, by[1] * t), start[k]);
      this.applyM(it);
    }));
  }

  async rotate(a, dur, ctl) {
    const items = this.ids(a.rotate).map(id => this.els.get(id));
    const deg = num(a.deg ?? a.angle, 90);
    const start = items.map(i => i.m);
    const about = pt(a.about) ?? (items[0] ? this.center(items[0]) : [50, this.h / 2]);
    await tween(dur, ctl, t => items.forEach((it, k) => {
      it.m = mmul(mrot(deg * t, about[0], about[1]), start[k]);
      this.applyM(it);
    }));
  }

  async copy(a, dur, ctl) {
    const src = this.els.get(String(a.copy));
    if (!src) return;
    const id = a.as != null ? String(a.as) : `_${++this.auto}`;
    if (this.els.has(id)) this.els.get(id).g.remove();
    const item = { id, type: src.type, props: structuredClone(src.props), m: src.m, g: el('g', { 'data-id': id }, this.layer) };
    if (a.color) item.props.color = a.color;
    this.els.set(id, item);
    this.draw(item);
    const by = pt(a.by);
    if (by) await this.move(id, by, dur, ctl);
  }

  async remove(idv, dur, ctl) {
    const items = (idv === '*' || idv === 'all') ? [...this.els.values()] : this.ids(idv).map(id => this.els.get(id));
    if (!items.length) return;
    await tween(dur, ctl, t => items.forEach(it => it.g.setAttribute('opacity', 1 - t)));
    for (const it of items) { it.g.remove(); this.els.delete(it.id); }
  }

  bbox(item) {
    let b;
    try { b = item.g.getBBox(); } catch { return null; }
    if (!b || (!b.width && !b.height)) return null;
    const pts = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]].map(p => mapply(item.m, p));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }

  center(item) {
    const b = this.bbox(item);
    return b ? [b.x + b.w / 2, b.y + b.h / 2] : [50, this.h / 2];
  }

  // 黃粉筆圈起來：手畫感的橢圓，多繞一點點
  async hl(idv, dur, ctl) {
    const items = this.ids(idv).map(id => this.els.get(id));
    for (const it of items) {
      const b = this.bbox(it);
      if (!b) continue;
      const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      const rx = Math.max(3, b.w / 2 * 1.18 + 1.6), ry = Math.max(2.6, b.h / 2 * 1.25 + 1.4);
      const pts = [];
      const a0 = -2.1;
      for (let i = 0; i <= 48; i++) {
        const t = i / 48, a = a0 + t * Math.PI * 2.18, k = 1 + 0.07 * t;
        pts.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * (2 - k)]);
      }
      const path = el('path', { d: 'M' + pts.map(P).join(' L'), class: 'st mark' }, el('g', { class: 'el c-yellow' }, this.marks));
      await this.drawStrokes([path], dur, ctl);
    }
  }

  applyM(item) {
    if (item.m === ID || item.m.every((v, i) => Math.abs(v - ID[i]) < 1e-9)) item.g.removeAttribute('transform');
    else item.g.setAttribute('transform', `matrix(${item.m.map(v => f2(v * 1000) / 1000).join(' ')})`);
  }

  /* ----- 進場動畫 ----- */

  async drawStrokes(paths, dur, ctl) {
    const lens = paths.map(p => { try { return p.getTotalLength() || 0; } catch { return 0; } });
    paths.forEach((p, i) => {
      p.style.strokeDasharray = `${lens[i]} ${lens[i] + 1}`;
      p.style.strokeDashoffset = lens[i];
    });
    await tween(dur, ctl, t => paths.forEach((p, i) => { p.style.strokeDashoffset = lens[i] * (1 - t); }));
    paths.forEach(p => { p.style.strokeDasharray = ''; p.style.strokeDashoffset = ''; });
  }

  async enter(item, dur, ctl) {
    const g = item.g;
    if (item.type === 'bar') {
      const w = num(item.props.w, 60);
      await tween(dur, ctl, t => { item.props = { ...item.props, w: Math.max(0.01, w * t) }; this.draw(item); });
      item.props = { ...item.props, w };
      this.draw(item);
      return;
    }
    if (item.type === 'icons' || item.type === 'pie') {
      const parts = [...g.querySelectorAll('[data-stagger]')];
      const rest = [...g.children].filter(n => !n.hasAttribute('data-stagger'));
      parts.forEach(n => n.setAttribute('opacity', 0));
      if (rest.length) await this.drawGroup(rest, dur * 0.5, ctl);
      const each = Math.min(220, (dur * (rest.length ? 0.5 : 1)) / Math.max(1, parts.length) * 1.6);
      for (const n of parts) {
        if (ctl?.cancelled) break;
        tween(each * 1.6, ctl, t => n.setAttribute('opacity', t));
        await tween(each, ctl, () => {});
      }
      parts.forEach(n => n.removeAttribute('opacity'));
      return;
    }
    if (item.type === 'text') {
      await this.wipe(g, dur * 0.8, ctl);
      return;
    }
    await this.drawGroup([...g.children], dur, ctl);
  }

  // 一組元素：先畫線，再淡入塗色和文字
  async drawGroup(nodes, dur, ctl) {
    const strokes = [], fades = [];
    for (const n of nodes) {
      if (n.matches('.st') && !n.closest('.dash')) strokes.push(n);
      else fades.push(n);
    }
    fades.forEach(n => n.setAttribute('opacity', 0));
    if (strokes.length) await this.drawStrokes(strokes, dur * (fades.length ? 0.7 : 1), ctl);
    if (fades.length) await tween(dur * (strokes.length ? 0.3 : 1), ctl, t => fades.forEach(n => n.setAttribute('opacity', t)));
    fades.forEach(n => n.removeAttribute('opacity'));
  }

  // 寫字：由左到右露出來
  async wipe(g, dur, ctl) {
    let b;
    try { b = g.getBBox(); } catch { b = null; }
    if (!b || !b.width) { await this.drawGroup([...g.children], dur, ctl); return; }
    const id = `wipe${++this.clipN}`;
    const cp = el('clipPath', { id, clipPathUnits: 'userSpaceOnUse' }, this.defs);
    const r = el('rect', { x: b.x - 1, y: b.y - 1, width: 0, height: b.height + 2 }, cp);
    g.setAttribute('clip-path', `url(#${id})`);
    await tween(dur, ctl, t => r.setAttribute('width', (b.width + 2) * t));
    g.removeAttribute('clip-path');
    cp.remove();
  }

  /* ----- 畫出一個圖形（每次都從 props 重畫） ----- */

  draw(item) {
    const g = item.g;
    g.replaceChildren();
    const p = item.props;
    const color = colorName(p.color);
    g.setAttribute('class', ['el', `c-${color}`, p.bold ? 'bold' : '', p.dash ? 'dash' : ''].filter(Boolean).join(' '));
    try { this[`r_${item.type}`]?.(p, g, item); } catch (e) { console.warn('畫不出來', item, e); }
    this.applyM(item);
  }

  // 依 on 換算座標：數線上的數、座標平面上的點
  mapper(p) {
    const ref = p.on != null ? this.els.get(String(p.on)) : null;
    if (ref?.type === 'numberline') {
      const r = ref.props, A = pt(r.from) ?? [10, 30], B = pt(r.to) ?? [90, 30];
      const lo = num(r.min, 0), hi = num(r.max, 10), span = hi - lo || 1;
      return v => {
        const n = Array.isArray(v) ? num(v[0], NaN) : num(v, NaN);
        if (!Number.isFinite(n)) return null;
        const dy = Array.isArray(v) ? num(v[1], 0) : 0;
        return [A[0] + (n - lo) / span * (B[0] - A[0]), A[1] + dy];
      };
    }
    if (ref?.type === 'axes') {
      const m = axesMap(ref.props, this.h);
      return v => { const q = pt(v); return q ? m.map(q[0], q[1]) : null; };
    }
    return pt;
  }

  scaleOf(p) {
    const ref = p.on != null ? this.els.get(String(p.on)) : null;
    if (ref?.type === 'axes') return axesMap(ref.props, this.h).sx;
    return 1;
  }

  label(g, text, x, y, size = 3.8, cls = '') {
    if (text == null || text === '') return null;
    const L = svgLabel(String(text), size);
    const wrap = el('g', { class: `lblwrap ${cls}`.trim(), transform: `translate(${f2(x)} ${f2(y)})` }, g);
    wrap.append(L.node);
    return { wrap, w: L.w, h: L.h };
  }

  // 把標籤放在點 at 的某一邊
  labelAt(g, text, at, pos = 'up', size = 3.8, gap = 1.2) {
    if (text == null || text === '') return;
    const L = svgLabel(String(text), size);
    const dir = POS_ALIAS[pos] ?? pos;
    const dx = dir.includes('left') ? -1 : dir.includes('right') ? 1 : 0;
    const dy = dir.startsWith('up') ? -1 : dir.startsWith('down') ? 1 : 0;
    const k = dx && dy ? 0.75 : 1;
    const x = at[0] + dx * (gap * k + L.w / 2), y = at[1] + dy * (gap * k + L.h / 2);
    const wrap = el('g', { class: 'lblwrap', transform: `translate(${f2(x)} ${f2(y)})` }, g);
    wrap.append(L.node);
  }

  // 沿著法向量 n 把標籤推開，讓標籤的框剛好不碰到線
  labelOff(g, text, at, n, size = 3.8, gap = 0.9) {
    if (text == null || text === '') return;
    const L = svgLabel(String(text), size);
    const d = gap + Math.abs(n[0]) * L.w / 2 + Math.abs(n[1]) * L.h / 2;
    const wrap = el('g', { class: 'lblwrap', transform: `translate(${f2(at[0] + n[0] * d)} ${f2(at[1] + n[1] * d)})` }, g);
    wrap.append(L.node);
  }

  arrowHead(g, tip, dir, size = 2) {
    const d = unit(dir), n = [-d[1], d[0]];
    const a = add(sub(tip, mulS(d, size)), mulS(n, size * 0.5));
    const b = sub(sub(tip, mulS(d, size)), mulS(n, size * 0.5));
    el('path', { d: `M${P(tip)} L${P(a)} L${P(b)} Z`, class: 'ah' }, g);
  }

  /* ----- 各種圖形 ----- */

  r_text(p, g) {
    const at = this.mapper(p)(p.at ?? p.pos ?? [p.x, p.y]) ?? [50, 8];
    const size = num(p.size, 4.5);
    const L = svgLabel(String(p.text ?? p.label ?? ''), size);
    const align = String(p.align ?? 'center');
    const x = align === 'left' ? at[0] + L.w / 2 : align === 'right' ? at[0] - L.w / 2 : at[0];
    const wrap = el('g', { class: 'lblwrap', transform: `translate(${f2(x)} ${f2(at[1])})` }, g);
    wrap.append(L.node);
  }

  r_seg(p, g) {
    const map = this.mapper(p);
    const A = map(p.from), B = map(p.to);
    if (!A || !B) return;
    el('path', { d: `M${P(A)} L${P(B)}`, class: 'st' }, g);
    const d = sub(B, A), L = len(d);
    if (!L) return;
    const u = unit(d);
    const arrow = p.arrow === true ? 'end' : String(p.arrow ?? '');
    if (arrow === 'end' || arrow === 'both') this.arrowHead(g, B, u);
    if (arrow === 'start' || arrow === 'both') this.arrowHead(g, A, mulS(u, -1));
    const tk = int(p.ticks, 0, 0, 3);
    const mid = mulS(add(A, B), 0.5), n = [-u[1], u[0]];
    for (let i = 0; i < tk; i++) {
      const c = add(mid, mulS(u, (i - (tk - 1) / 2) * 0.9));
      el('path', { d: `M${P(add(c, mulS(n, 1.3)))} L${P(sub(c, mulS(n, 1.3)))}`, class: 'st thin' }, g);
    }
    if (p.label != null) this.labelOff(g, p.label, mid, sideNormal(u, p.pos), num(p.size, 3.8));
  }

  r_arrow(p, g) {
    const map = this.mapper(p);
    const A = map(p.from), B = map(p.to);
    if (!A || !B) return;
    const onLine = this.els.get(String(p.on))?.type === 'numberline';
    const bend = Math.max(-1.5, Math.min(1.5, num(p.bend ?? p.curve, onLine ? 0.6 : 0)));
    const d = sub(B, A), L = len(d);
    if (!L) return;
    if (!bend) {
      el('path', { d: `M${P(A)} L${P(sub(B, mulS(unit(d), 0.6)))}`, class: 'st' }, g);
      this.arrowHead(g, B, d);
      if (p.label != null) this.labelOff(g, p.label, mulS(add(A, B), 0.5), sideNormal(unit(d), p.pos), num(p.size, 3.8));
      return;
    }
    let n = [d[1] / L, -d[0] / L];
    if (Math.abs(n[1]) > 0.3 && n[1] > 0) n = mulS(n, -1); // 正數往上彎
    const C = add(mulS(add(A, B), 0.5), mulS(n, bend * L * 0.6));
    el('path', { d: `M${P(A)} Q${P(C)} ${P(B)}`, class: 'st' }, g);
    this.arrowHead(g, B, sub(B, C));
    const apex = add(add(mulS(A, 0.25), mulS(C, 0.5)), mulS(B, 0.25));
    if (p.label != null) this.labelOff(g, p.label, apex, mulS(n, Math.sign(bend)), num(p.size, 3.6));
  }

  r_rect(p, g) {
    const x = num(p.x, 10), y = num(p.y, 10), w = num(p.w ?? p.width, 30), h = num(p.h ?? p.height, 20);
    const fc = fillColor(p);
    if (fc) el('rect', { x: f2(x), y: f2(y), width: f2(Math.abs(w)), height: f2(Math.abs(h)), class: 'fl', style: `--fc:var(--chalk-${fc})` }, g);
    el('path', { d: `M${P([x, y])} H${f2(x + w)} V${f2(y + h)} H${f2(x)} Z`, class: 'st' }, g);
    if (p.label != null) this.label(g, p.label, x + w / 2, y + h / 2, num(p.size, 3.8));
  }

  r_bar(p, g) {
    const x = num(p.x, 10), y = num(p.y, 20), w = num(p.w ?? p.width, 60), h = num(p.h ?? p.height, 8);
    const parts = int(p.parts, 1, 1, 60), pw = w / parts;
    const fc = colorName(p.fill === true || p.fill == null ? p.color : p.fill);
    const shade = shadeSet(p.shade, parts);
    for (const i of shade) el('rect', { x: f2(x + i * pw), y: f2(y), width: f2(pw), height: f2(h), class: 'fl strong', style: `--fc:var(--chalk-${fc})` }, g);
    el('path', { d: `M${P([x, y])} H${f2(x + w)} V${f2(y + h)} H${f2(x)} Z`, class: 'st' }, g);
    if (parts > 1) {
      const dv = [];
      for (let i = 1; i < parts; i++) dv.push(`M${f2(x + i * pw)} ${f2(y)} V${f2(y + h)}`);
      el('path', { d: dv.join(' '), class: 'st thin' }, g);
    }
    const labels = Array.isArray(p.labels) ? p.labels : [];
    const size = num(p.size, Math.min(3.8, h * 0.55));
    labels.slice(0, parts).forEach((t, i) => {
      if (t != null && t !== '') this.label(g, t, x + (i + 0.5) * pw, y + h / 2, Math.min(size, pw * 0.5));
    });
    if (p.label != null) this.label(g, p.label, x + w / 2, y + h / 2, size);
  }

  r_brace(p, g) {
    const A = pt(p.from), B = pt(p.to);
    if (!A || !B) return;
    const d = sub(B, A), L = len(d);
    if (!L) return;
    const u = unit(d);
    let n = sideNormal(u, p.side ?? p.pos);
    const depth = num(p.depth, Math.min(3.2, Math.max(1.6, L * 0.12)));
    const hook = Math.min(L * 0.15, depth);
    const q = depth / 2;
    const at = (s, k) => add(add(A, mulS(u, s)), mulS(n, k));
    const dpath = [
      `M${P(at(0, 0))}`, `Q${P(at(0, q))} ${P(at(hook, q))}`, `L${P(at(L / 2 - hook, q))}`,
      `Q${P(at(L / 2, q))} ${P(at(L / 2, depth))}`, `Q${P(at(L / 2, q))} ${P(at(L / 2 + hook, q))}`,
      `L${P(at(L - hook, q))}`, `Q${P(at(L, q))} ${P(at(L, 0))}`,
    ].join(' ');
    el('path', { d: dpath, class: 'st' }, g);
    if (p.label != null) this.labelOff(g, p.label, at(L / 2, depth), n, num(p.size, 3.8), 0.8);
  }

  r_poly(p, g) {
    const map = this.mapper(p);
    const pts = (Array.isArray(p.points) ? p.points : []).map(map).filter(Boolean).slice(0, 40);
    if (pts.length < 2) return;
    const closed = p.closed !== false && pts.length > 2;
    const d = `M${pts.map(P).join(' L')}${closed ? ' Z' : ''}`;
    const fc = fillColor(p);
    if (fc && closed) el('path', { d, class: 'fl', style: `--fc:var(--chalk-${fc})` }, g);
    el('path', { d, class: 'st' }, g);
    const c = mulS(pts.reduce(add, [0, 0]), 1 / pts.length);
    const size = num(p.size, 3.8);
    const names = Array.isArray(p.names) ? p.names : [];
    pts.forEach((q, i) => {
      if (names[i] == null || names[i] === '') return;
      const dir = unit(sub(q, c));
      const L = svgLabel(String(names[i]), size);
      const dist = 1.1 + Math.max(L.w, L.h) / 2;
      this.label(g, names[i], q[0] + dir[0] * dist, q[1] + dir[1] * dist, size);
    });
    const sides = Array.isArray(p.sides) ? p.sides : [];
    const edges = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < edges; i++) {
      const t = sides[i];
      if (t == null || t === '') continue;
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const mid = mulS(add(a, b), 0.5), u = unit(sub(b, a));
      let n = [-u[1], u[0]];
      if ((mid[0] - c[0]) * n[0] + (mid[1] - c[1]) * n[1] < 0) n = mulS(n, -1);
      this.labelOff(g, t, mid, n, size);
    }
    if (p.label != null) this.label(g, p.label, c[0], c[1], size);
  }

  r_circle(p, g) {
    const c = this.mapper(p)(p.c ?? p.center ?? p.at) ?? [50, 30];
    const r = Math.abs(num(p.r ?? p.radius, 10)) * this.scaleOf(p);
    const fc = fillColor(p);
    if (fc) el('circle', { cx: f2(c[0]), cy: f2(c[1]), r: f2(r), class: 'fl', style: `--fc:var(--chalk-${fc})` }, g);
    el('path', { d: `M${P([c[0], c[1] - r])} A${f2(r)} ${f2(r)} 0 1 1 ${P([c[0] - 0.001, c[1] - r])}`, class: 'st' }, g);
    if (p.label != null) this.label(g, p.label, c[0], c[1], num(p.size, 3.8));
  }

  r_angle(p, g) {
    const map = this.mapper(p);
    const V = map(p.at ?? p.vertex), A = map(p.from), B = map(p.to);
    if (!V || !A || !B) return;
    const u1 = unit(sub(A, V)), u2 = unit(sub(B, V));
    const r = num(p.r, 4);
    const size = num(p.size, 3.4);
    if (p.right) {
      const s = r * 0.7;
      el('path', { d: `M${P(add(V, mulS(u1, s)))} L${P(add(add(V, mulS(u1, s)), mulS(u2, s)))} L${P(add(V, mulS(u2, s)))}`, class: 'st' }, g);
    } else {
      const a1 = Math.atan2(u1[1], u1[0]), a2 = Math.atan2(u2[1], u2[0]);
      let delta = a2 - a1;
      while (delta <= -Math.PI) delta += 2 * Math.PI;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      const P1 = add(V, mulS(u1, r)), P2 = add(V, mulS(u2, r));
      const arc = `A${f2(r)} ${f2(r)} 0 0 ${delta > 0 ? 1 : 0} ${P(P2)}`;
      const fc = fillColor(p);
      if (fc) el('path', { d: `M${P(V)} L${P(P1)} ${arc} Z`, class: 'fl', style: `--fc:var(--chalk-${fc})` }, g);
      el('path', { d: `M${P(P1)} ${arc}`, class: 'st' }, g);
    }
    if (p.label != null) {
      let b = add(u1, u2);
      b = len(b) < 1e-3 ? [-u1[1], u1[0]] : unit(b);
      const L = svgLabel(String(p.label), size);
      const dist = r + 0.8 + Math.max(L.w, L.h) / 2 * 0.9;
      this.label(g, p.label, V[0] + b[0] * dist, V[1] + b[1] * dist, size);
    }
  }

  r_point(p, g) {
    const at = this.mapper(p)(p.at ?? [p.x, p.y]);
    if (!at) return;
    el('circle', { cx: f2(at[0]), cy: f2(at[1]), r: f2(num(p.r, 0.9)), class: 'dot' }, g);
    if (p.label != null) this.labelAt(g, p.label, at, String(p.pos ?? 'up'), num(p.size, 3.6));
  }

  r_numberline(p, g) {
    const A = pt(p.from) ?? [10, 30], B0 = pt(p.to) ?? [90, 30];
    const B = [B0[0], A[1]];
    const lo = num(p.min, 0), hi = num(p.max, 10);
    if (!(hi > lo)) return;
    const step = Math.abs(num(p.step, 0)) || nice(hi - lo, 10);
    const minor = int(p.minor, 0, 0, 12);
    const X = v => A[0] + (v - lo) / (hi - lo) * (B[0] - A[0]);
    const y = A[1];
    el('path', { d: `M${f2(A[0] - 1.5)} ${f2(y)} H${f2(B[0] + 3)}`, class: 'st' }, g);
    if (p.arrow !== false) this.arrowHead(g, [B[0] + 4, y], [1, 0], 1.8);
    const major = ticks(lo, hi, step);
    const tk = [];
    for (const v of major) tk.push(`M${f2(X(v))} ${f2(y - 1.3)} V${f2(y + 1.3)}`);
    if (minor > 1) {
      for (const v of ticks(lo, hi, step / minor)) {
        if (major.some(m => Math.abs(m - v) < step * 1e-6)) continue;
        tk.push(`M${f2(X(v))} ${f2(y - 0.7)} V${f2(y + 0.7)}`);
      }
    }
    el('path', { d: tk.join(' '), class: 'st thin' }, g);
    const size = num(p.size, 3.3);
    if (p.labels === false) return;
    const every = Math.ceil(major.length / 21);
    const list = Array.isArray(p.labels) ? p.labels : major.filter((_, i) => i % every === 0);
    for (const item of list) {
      const v = typeof item === 'object' && item ? num(item.at ?? item.v, NaN) : num(item, NaN);
      if (!Number.isFinite(v)) continue;
      const text = typeof item === 'object' && item?.text != null ? item.text : fmt(v);
      const L = svgLabel(String(text), size);
      this.label(g, text, X(v), y + 1.6 + L.h / 2, size);
    }
  }

  r_axes(p, g) {
    const m = axesMap(p, this.h);
    const { x, y, w, h, x0, x1, y0, y1 } = m;
    const xs = Math.abs(num(Array.isArray(p.step) ? p.step[0] : p.xstep ?? p.step, 0)) || nice(x1 - x0, 10);
    const ys = Math.abs(num(Array.isArray(p.step) ? p.step[1] : p.ystep ?? p.step, 0)) || nice(y1 - y0, 10);
    const ox = x0 <= 0 && 0 <= x1 ? m.map(0, 0)[0] : x;
    const oy = y0 <= 0 && 0 <= y1 ? m.map(0, 0)[1] : y + h;
    const xt = ticks(x0, x1, xs), yt = ticks(y0, y1, ys);
    if (p.grid !== false) {
      const gl = [];
      for (const v of xt) gl.push(`M${f2(m.map(v, 0)[0])} ${f2(y)} V${f2(y + h)}`);
      for (const v of yt) gl.push(`M${f2(x)} ${f2(m.map(0, v)[1])} H${f2(x + w)}`);
      el('path', { d: gl.join(' '), class: 'st gridline' }, g);
    }
    el('path', { d: `M${f2(x - 1)} ${f2(oy)} H${f2(x + w + 2.5)}`, class: 'st' }, g);
    el('path', { d: `M${f2(ox)} ${f2(y + h + 1)} V${f2(y - 2.5)}`, class: 'st' }, g);
    this.arrowHead(g, [x + w + 3.5, oy], [1, 0], 1.7);
    this.arrowHead(g, [ox, y - 3.5], [0, -1], 1.7);
    const size = num(p.size, 2.8);
    const tk = [];
    if (p.labels !== false) {
      const every = Math.max(1, Math.ceil(xt.length / 12));
      xt.forEach((v, i) => {
        if (Math.abs(v) < 1e-9 || i % every) return;
        const X = m.map(v, 0)[0];
        tk.push(`M${f2(X)} ${f2(oy - 0.7)} V${f2(oy + 0.7)}`);
        this.label(g, fmt(v), X, oy + 1.2 + size * 0.55, size);
      });
      const everyY = Math.max(1, Math.ceil(yt.length / 10));
      yt.forEach((v, i) => {
        if (Math.abs(v) < 1e-9 || i % everyY) return;
        const Y = m.map(0, v)[1];
        tk.push(`M${f2(ox - 0.7)} ${f2(Y)} H${f2(ox + 0.7)}`);
        const L = svgLabel(fmt(v), size);
        this.label(g, fmt(v), ox - 1.2 - L.w / 2, Y, size);
      });
      if (tk.length) el('path', { d: tk.join(' '), class: 'st thin' }, g);
      if (ox !== x || oy !== y + h) this.label(g, 'O', ox - 1.8, oy + 2, size);
    }
    this.label(g, p.xlabel ?? 'x', x + w + 3.5, oy + 3, size + 0.4);
    this.label(g, p.ylabel ?? 'y', ox - 2.8, y - 3.5, size + 0.4);
  }

  r_plot(p, g) {
    let ax = p.on != null ? this.els.get(String(p.on)) : null;
    if (ax?.type !== 'axes') ax = [...this.els.values()].find(e => e.type === 'axes');
    if (!ax) return;
    let fn;
    try { fn = compile(p.fn ?? p.f ?? p.expr ?? ''); } catch (e) { console.warn('函數式看不懂', p.fn, e.message); return; }
    const m = axesMap(ax.props, this.h);
    const dom = Array.isArray(p.domain) ? [num(p.domain[0], m.x0), num(p.domain[1], m.x1)] : [m.x0, m.x1];
    const lo = Math.max(m.x0, Math.min(dom[0], dom[1])), hi = Math.min(m.x1, Math.max(dom[0], dom[1]));
    const N = 200, pad = (m.y1 - m.y0) * 0.02;
    const ylo = m.y0 - pad, yhi = m.y1 + pad;
    const segs = [];
    let cur = [], prev = null, last = null;
    const inside = q => q && q[1] >= ylo && q[1] <= yhi;
    for (let i = 0; i <= N; i++) {
      const xv = lo + (hi - lo) * i / N;
      let yv;
      try { yv = fn(xv); } catch { yv = NaN; }
      const q = Number.isFinite(yv) ? [xv, yv] : null;
      if (q && inside(q)) {
        if (!cur.length && prev && Number.isFinite(prev[1])) cur.push(cross(prev, q, ylo, yhi));
        cur.push(q);
        last = q;
      } else if (cur.length) {
        if (q) cur.push(cross(cur[cur.length - 1], q, ylo, yhi));
        segs.push(cur);
        cur = [];
      }
      prev = q;
    }
    if (cur.length) segs.push(cur);
    const d = segs.filter(s => s.length > 1).map(s => 'M' + s.map(q => P(m.map(q[0], q[1]))).join(' L')).join(' ');
    if (!d) return;
    el('path', { d, class: 'st' }, g);
    if (p.label != null && last) this.labelAt(g, p.label, m.map(last[0], last[1]), String(p.pos ?? 'up-left'), num(p.size, 3.4));
  }

  r_grid(p, g) {
    const x = num(p.x, 10), y = num(p.y, 10), cols = int(p.cols, 6, 1, 40), rows = int(p.rows, 4, 1, 40);
    const s = num(p.size ?? p.cell, 5);
    const fc = colorName(p.fill === true || p.fill == null ? 'yellow' : p.fill, 'yellow');
    const shaded = Array.isArray(p.shade) ? p.shade.map(pt).filter(Boolean) : [];
    for (const [c, r] of shaded) {
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      el('rect', { x: f2(x + c * s), y: f2(y + r * s), width: f2(s), height: f2(s), class: 'fl strong', style: `--fc:var(--chalk-${fc})` }, g);
    }
    const d = [];
    for (let i = 0; i <= cols; i++) d.push(`M${f2(x + i * s)} ${f2(y)} V${f2(y + rows * s)}`);
    for (let j = 0; j <= rows; j++) d.push(`M${f2(x)} ${f2(y + j * s)} H${f2(x + cols * s)}`);
    el('path', { d: d.join(' '), class: 'st thin' }, g);
    if (p.label != null) this.label(g, p.label, x + cols * s / 2, y + rows * s + 3, num(p.size2 ?? 3.6, 3.6));
  }

  r_pie(p, g) {
    const c = pt(p.c ?? p.center ?? p.at) ?? [50, 30];
    const r = Math.abs(num(p.r, 12));
    const parts = int(p.parts, 4, 1, 36);
    const fc = colorName(p.fill === true || p.fill == null ? p.color : p.fill);
    const shade = shadeSet(p.shade, parts);
    const ang = i => -Math.PI / 2 + i * 2 * Math.PI / parts;
    const at = a => [c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r];
    for (const i of shade) {
      const a1 = ang(i), a2 = ang(i + 1);
      const d = parts === 1
        ? `M${P([c[0], c[1] - r])} A${f2(r)} ${f2(r)} 0 1 1 ${P([c[0] - 0.001, c[1] - r])} Z`
        : `M${P(c)} L${P(at(a1))} A${f2(r)} ${f2(r)} 0 ${a2 - a1 > Math.PI ? 1 : 0} 1 ${P(at(a2))} Z`;
      el('path', { d, class: 'fl strong', style: `--fc:var(--chalk-${fc})`, 'data-stagger': '' }, g);
    }
    el('path', { d: `M${P([c[0], c[1] - r])} A${f2(r)} ${f2(r)} 0 1 1 ${P([c[0] - 0.001, c[1] - r])}`, class: 'st' }, g);
    if (parts > 1) el('path', { d: Array.from({ length: parts }, (_, i) => `M${P(c)} L${P(at(ang(i)))}`).join(' '), class: 'st thin' }, g);
    if (p.label != null) this.label(g, p.label, c[0], c[1] + r + 3.2, num(p.size, 3.8));
  }

  r_icons(p, g) {
    const at = pt(p.at ?? [p.x, p.y]) ?? [10, 10];
    const count = int(p.count ?? p.n, 1, 0, 60);
    const icons = Array.isArray(p.icon) ? p.icon : [p.icon ?? '●'];
    const cols = int(p.cols, Math.min(count || 1, 10), 1, 30);
    const gap = num(p.gap, 7), size = num(p.size, 6);
    for (let i = 0; i < count; i++) {
      const t = el('text', {
        x: f2(at[0] + (i % cols) * gap), y: f2(at[1] + Math.floor(i / cols) * gap), 'font-size': f2(size),
        class: 'ic', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'data-stagger': '',
      }, g);
      t.textContent = String(icons[i % icons.length] ?? '●').slice(0, 8);
    }
    if (p.label != null) {
      const rows = Math.ceil(count / cols) || 1;
      this.label(g, p.label, at[0] + (Math.min(count, cols) - 1) * gap / 2, at[1] + (rows - 1) * gap + size * 0.55 + 3, num(p.labelSize, 3.6));
    }
  }

  r_path(p, g) {
    const d = String(p.d ?? '');
    if (!/^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s+-]+$/.test(d) || d.length > 4000) return;
    const fc = fillColor(p);
    if (fc) el('path', { d, class: 'fl', style: `--fc:var(--chalk-${fc})` }, g);
    el('path', { d, class: 'st' }, g);
    if (p.label != null && pt(p.at)) this.label(g, p.label, ...pt(p.at), num(p.size, 3.8));
  }
}

/* ---------- 共用的計算 ---------- */

function fillColor(p) {
  if (!p.fill) return null;
  return colorName(p.fill === true ? p.color : p.fill, colorName(p.color));
}

function shadeSet(shade, parts) {
  if (Array.isArray(shade)) return [...new Set(shade.map(v => Math.round(num(v, -1))).filter(i => i >= 0 && i < parts))];
  if (shade === true) return Array.from({ length: parts }, (_, i) => i);
  const k = Math.max(0, Math.min(parts, Math.round(num(shade, 0))));
  return Array.from({ length: k }, (_, i) => i);
}

// 線段的標籤放哪一邊：預設水平線放上面、直線放左邊，可以用 up/down/left/right 指定
function sideNormal(u, pos) {
  let n = [-u[1], u[0]];
  const want = POS_ALIAS[pos] ?? pos;
  const horiz = Math.abs(u[0]) >= Math.abs(u[1]);
  if (want === 'down' ? n[1] < 0 : want === 'right' ? n[0] < 0 : want === 'left' ? n[0] > 0 : want === 'up' ? n[1] > 0 : horiz ? n[1] > 0 : n[0] > 0) n = mulS(n, -1);
  return n;
}

export function axesMap(p, figH = 60) {
  const x = num(p.x, 10), y = num(p.y, 5), w = Math.max(5, num(p.w ?? p.width, 80)), h = Math.max(5, num(p.h ?? p.height, figH - 12));
  let [x0, x1] = Array.isArray(p.xr ?? p.xrange) ? (p.xr ?? p.xrange).map(v => num(v, 0)) : [-5, 5];
  let [y0, y1] = Array.isArray(p.yr ?? p.yrange) ? (p.yr ?? p.yrange).map(v => num(v, 0)) : [-5, 5];
  if (!(x1 > x0)) [x0, x1] = [-5, 5];
  if (!(y1 > y0)) [y0, y1] = [-5, 5];
  const sx = w / (x1 - x0), sy = h / (y1 - y0);
  return { x, y, w, h, x0, x1, y0, y1, sx, sy, map: (mx, my) => [x + (mx - x0) * sx, y + h - (my - y0) * sy] };
}

// a 在範圍內、b 在範圍外：找出跨過上下界的那一點
function cross(a, b, lo, hi) {
  const edge = b[1] > hi || a[1] > hi ? hi : lo;
  const t = (edge - a[1]) / (b[1] - a[1] || 1);
  return [a[0] + (b[0] - a[0]) * Math.max(0, Math.min(1, t)), edge];
}
