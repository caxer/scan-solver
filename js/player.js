// 黑板播放器：照腳本一步一步畫圖、寫算式、念旁白，可以暫停、上一步、下一步、跳到任一步。
// 腳本可以邊收邊播：AI 還在寫後面的步驟時，先播已經寫好的。
import { Figure } from './figure.js';
import { renderRich } from './rich.js';
import { speech } from './speech.js';
import { Ctl, tween, wait, readMs } from './timing.js';

const NS = 'http://www.w3.org/2000/svg';
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function chalkTable(rows) {
  const t = document.createElement('table');
  t.className = 'chalk-table';
  rows.forEach((r, i) => {
    const tr = t.insertRow();
    for (const c of r) {
      const cell = document.createElement(i ? 'td' : 'th');
      renderRich(cell, c);
      tr.append(cell);
    }
  });
  return t;
}

// 黑板右邊的算式區
class Notes {
  constructor(el) {
    this.el = el;
    this.lines = new Map();
  }

  reset() {
    this.el.replaceChildren();
    this.lines.clear();
  }

  has(id) { return this.lines.has(String(id)); }

  async erase(dur, ctl) {
    const nodes = [...this.el.children];
    await tween(dur, ctl, t => nodes.forEach(n => { n.style.opacity = 1 - t; }));
    this.reset();
  }

  clearMarks(instant) {
    for (const ring of this.el.querySelectorAll('.ring')) {
      if (instant) ring.remove();
      else {
        ring.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' });
        setTimeout(() => ring.remove(), 320);
      }
    }
  }

  async write(line, dur, ctl, stepIndex) {
    const div = document.createElement('div');
    div.dataset.step = String(stepIndex);
    if (this.el.dataset.step !== undefined) div.hidden = div.dataset.step !== this.el.dataset.step;
    div.className = line.table ? 'line table' : 'line';
    if (line.table) div.append(chalkTable(line.table));
    else renderRich(div, line.text);
    if (line.id) {
      div.dataset.id = line.id;
      this.lines.set(line.id, div);
    }
    this.el.append(div);
    const bottom = this.el.scrollHeight - this.el.clientHeight;
    if (bottom > 0) this.el.scrollTo?.({ top: bottom, behavior: dur > 0 ? 'smooth' : 'auto' });
    if (!(dur > 0)) return;
    if (line.table) {
      const rows = [...div.querySelectorAll('tr')];
      rows.forEach(r => { r.style.opacity = 0; });
      for (const r of rows) await tween(dur / rows.length, ctl, t => { r.style.opacity = t; });
      rows.forEach(r => { r.style.opacity = ''; });
      return;
    }
    await tween(dur, ctl, t => { div.style.clipPath = `inset(-0.4em ${((1 - t) * 100).toFixed(1)}% -0.4em -0.3em)`; }, t => t);
    div.style.clipPath = '';
  }

  // 用黃粉筆把那一行圈起來
  async hl(id, dur, ctl) {
    const div = this.lines.get(String(id));
    if (!div) return;
    div.hidden = false;
    const pad = 9;
    const w = div.offsetWidth + pad * 2, h = div.offsetHeight + pad * 2;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'ring');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.style.cssText = `left:${-pad}px;top:${-pad}px;width:${w}px;height:${h}px`;
    const cx = w / 2, cy = h / 2, rx = w / 2 - 3, ry = h / 2 - 3;
    const pts = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48, a = -2.1 + t * Math.PI * 2.16, k = 1 + 0.05 * t;
      pts.push(`${(cx + Math.cos(a) * rx * k).toFixed(1)} ${(cy + Math.sin(a) * ry * (2 - k)).toFixed(1)}`);
    }
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M' + pts.join(' L'));
    svg.append(path);
    div.append(svg);
    const L = path.getTotalLength();
    path.style.strokeDasharray = `${L} ${L + 1}`;
    await tween(dur, ctl, t => { path.style.strokeDashoffset = L * (1 - t); });
    path.style.strokeDasharray = '';
  }
}

function groups(actions) {
  const out = [];
  for (const a of actions) {
    if (a?.with && out.length) out[out.length - 1].push(a);
    else out.push([a]);
  }
  return out;
}

export class Player extends EventTarget {
  constructor({ svg, notes, caption, body }) {
    super();
    this.figure = new Figure(svg);
    this.notes = new Notes(notes);
    this.captionEl = caption;
    this.body = body;
    this.lesson = null;
    this.steps = [];
    this.complete = false;
    this.index = 0;       // 已經播完幾步
    this.current = -1;    // 正在播第幾步
    this.playing = false;
    this.waiting = false; // 等 AI 寫下一步
    this.ended = false;
    this.speed = 1;
    this.voice = true;
    this.ctl = null;
    this.loop = Promise.resolve();
    this.queue = Promise.resolve();
    this.stopReq = false;
    this.wake = null;
  }

  get total() { return this.steps.length; }
  get viewing() { return this.current >= 0 ? this.current : this.index - 1; }

  emit() {
    this.dispatchEvent(new CustomEvent('change', {
      detail: {
        index: this.index, current: this.current, viewing: this.viewing, total: this.total,
        playing: this.playing, waiting: this.waiting, complete: this.complete, ended: this.ended,
      },
    }));
  }

  // 所有操作排隊依序做，連按按鈕也不會互相打架
  run(fn) {
    this.queue = this.queue.then(fn).catch(e => console.error(e));
    return this.queue;
  }

  layout() {
    const fig = Boolean(this.lesson?.figure) || this.steps.some(s => s.draw.length);
    const notes = this.steps.some(s => s.write.length);
    this.body.dataset.layout = !fig ? 'notes' : notes || !this.complete ? 'split' : 'figure';
  }

  caption(text) {
    this.captionEl.textContent = text || '';
    this.captionEl.hidden = !text;
  }

  // lesson.steps 可以是空的，之後用 addStep 一步一步加
  load(lesson, { complete = true } = {}) {
    return this.run(async () => {
      await this.stop(true);
      this.lesson = lesson;
      this.steps = [...(lesson.steps || [])];
      this.complete = complete;
      this.playing = false;
      this.ended = false;
      await this.rebuild(0);
      this.layout();
      this.emit();
    });
  }

  setFigure(figure) {
    if (!this.lesson) return;
    this.lesson.figure = figure;
    if (this.index === 0 && this.current < 0) this.figure.reset(figure?.h ?? 60);
    this.layout();
  }

  addStep(step) {
    this.steps.push(step);
    this.layout();
    this.wake?.();
    this.emit();
  }

  finish() {
    this.complete = true;
    this.layout();
    this.wake?.();
    this.emit();
  }

  /* ----- 控制 ----- */

  play() {
    return this.run(async () => {
      await this.stop();
      if (this.ended || (this.complete && this.index >= this.total)) await this.rebuild(0);
      this.playing = true;
      this.start();
    });
  }

  pause() {
    return this.run(async () => {
      this.playing = false;
      await this.stop();
      this.emit();
    });
  }

  toggle() { return this.playing ? this.pause() : this.play(); }

  next() {
    return this.run(async () => {
      const was = this.playing;
      await this.stop();
      if (was) { this.playing = true; this.start(); }
      else if (this.index < this.total) this.start({ once: true });
      else this.emit();
    });
  }

  prev() {
    return this.run(async () => {
      const target = Math.max(0, this.viewing - 1);
      await this.goto(target);
    });
  }

  seek(i) { return this.run(() => this.goto(i)); }

  // 停在第 i 步之前，然後把第 i 步播一次（原本在播就繼續播下去）
  async goto(i) {
    const was = this.playing;
    await this.stop(true);
    await this.rebuild(Math.max(0, Math.min(i, this.total)));
    this.playing = was;
    this.start({ once: !was });
  }

  // 字型或 MathJax 晚到時重畫一次（沒在播的時候）
  refresh() {
    return this.run(async () => {
      if (this.playing || this.current >= 0 || !this.lesson) return;
      await this.rebuild(this.index);
    });
  }

  // 直接顯示全部畫完的樣子
  showAll() {
    return this.run(async () => {
      await this.stop(true);
      await this.rebuild(this.total);
      this.ended = this.complete;
      this.playing = false;
      this.emit();
    });
  }

  /* ----- 內部 ----- */

  async stop(abandon = false) {
    this.stopReq = true;
    if (this.ctl) abandon ? this.ctl.abandon() : this.ctl.cancel();
    speech.cancel();
    this.wake?.();
    await this.loop;
    this.stopReq = false;
  }

  start(opts = {}) {
    this.ended = false;
    this.loop = this.runner(opts);
  }

  async runner({ once = false } = {}) {
    while (!this.stopReq) {
      if (this.index >= this.total) {
        if (this.complete) {
          if (this.playing || once) { this.ended = true; this.playing = false; }
          break;
        }
        this.waiting = true;
        this.emit();
        await new Promise(r => { this.wake = r; });
        this.wake = null;
        this.waiting = false;
        continue;
      }
      const i = this.index;
      const ctl = (this.ctl = new Ctl());
      this.current = i;
      this.emit();
      await this.runStep(this.steps[i], ctl);
      this.ctl = null;
      this.current = -1;
      if (ctl.dead) break;
      this.index = i + 1;
      if (this.complete && this.index >= this.total && (this.playing || once)) { this.ended = true; this.playing = false; }
      this.emit();
      if (once || !this.playing) break;
    }
    this.waiting = false;
    this.emit();
  }

  async act(a, opts) {
    const target = a?.hl ?? a?.highlight;
    if (target != null) {
      const ids = (Array.isArray(target) ? target : [target]).map(String);
      if (opts.instant) return;
      const dur = 750 / opts.speed;
      await Promise.all(ids.map(id => (this.notes.has(id) && !this.figure.els.has(id) ? this.notes.hl(id, dur, opts.ctl) : this.figure.hl(id, dur, opts.ctl))));
      return;
    }
    await this.figure.apply(a, opts);
  }

  async erase(what, dur, ctl) {
    const jobs = [];
    if (what === 'notes' || what === 'all') jobs.push(this.notes.erase(dur, ctl));
    if (what === 'figure' || what === 'all') jobs.push(this.figure.erase(dur, ctl));
    await Promise.all(jobs);
  }

  // 腳本完整時，先把每一步畫一遍量出圖的範圍，讓視野剛好框住整張圖（放大一點，但最多兩倍）
  async computeView() {
    const h = this.lesson?.figure?.h ?? 60;
    this.figure.reset(h);
    let box = null;
    for (const s of this.steps) {
      if (s.erase === 'figure' || s.erase === 'all') await this.figure.erase(0);
      for (const a of s.draw) await this.act(a, { instant: true, speed: 1 });
      const b = this.figure.contentBox();
      if (b) {
        box = box
          ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), x1: Math.max(box.x1, b.x + b.w), y1: Math.max(box.y1, b.y + b.h) }
          : { x: b.x, y: b.y, x1: b.x + b.w, y1: b.y + b.h };
      }
    }
    if (!box) return null;
    const pad = 4;
    let x = box.x - pad, y = box.y - pad, w = box.x1 - box.x + pad * 2, hh = box.y1 - box.y + pad * 2;
    if (w < 50) { x -= (50 - w) / 2; w = 50; }
    if (hh < 28) { y -= (28 - hh) / 2; hh = 28; }
    return [x, y, w, hh];
  }

  async rebuild(k) {
    if (this.complete && this.viewFor !== this.steps) {
      this.viewFor = this.steps;
      this.view0 = await this.computeView();
    }
    this.figure.reset(this.lesson?.figure?.h ?? 60, this.complete ? this.view0 : null);
    this.notes.reset();
    for (let i = 0; i < k && i < this.total; i++) {
      const s = this.steps[i];
      if (s.erase) await this.erase(s.erase, 0);
      for (const a of s.draw) await this.act(a, { instant: true, speed: 1 });
      for (const l of s.write) await this.notes.write(l, 0, null, i);
    }
    await this.figure.fit(0);
    this.index = Math.min(k, this.total);
    this.current = -1;
    this.caption(this.index > 0 ? this.steps[this.index - 1].say : '');
  }

  async runStep(step, ctl) {
    const speed = this.speed * (reduceMotion() ? 4 : 1);
    this.figure.clearMarks(false);
    this.notes.clearMarks(false);
    this.caption(step.say);
    const talk = this.voice && speech.ok && step.say
      ? speech.say(step.say, { rate: this.speed * 0.95, lang: step.lang, ctl })
      : wait(readMs(step.say) / this.speed, ctl);
    if (step.erase) await this.erase(step.erase, 500 / speed, ctl);
    for (const group of groups(step.draw)) {
      if (ctl.dead) return;
      await Promise.all(group.map(a => this.act(a, { speed, ctl })));
    }
    for (const line of step.write) {
      if (ctl.dead) return;
      const n = line.text ? line.text.length : 30;
      await this.notes.write(line, Math.min(1800, 450 + n * 28) / speed, ctl, this.current);
    }
    if (ctl.dead) return;
    await this.figure.fit(600 / speed, ctl);
    await talk;
    if (!ctl.cancelled) await wait(500 / this.speed, ctl);
  }
}
