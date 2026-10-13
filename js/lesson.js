// 黑板腳本（AI 回覆的 JSON）：修補、邊收邊解析、正規化。瀏覽器和 server.mjs 共用，不碰 DOM。

import { contentKind } from './learning.js';
const str = (v, max = 500) => (v == null || typeof v === 'object' ? '' : String(v)).trim().slice(0, max);
const isLetter = ch => ch !== undefined && /[a-zA-Z]/.test(ch);

// 修補 AI 常見的 JSON 錯誤：LaTeX 的反斜線只寫一個（\frac 會被當成換頁字元、\times 變成 tab、\{ 直接讓 JSON 壞掉）、
// 字串裡直接換行、陣列最後多一個逗號、// 註解。
export function repairJson(text) {
  let out = '';
  let inStr = false;
  let dollars = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!inStr) {
      if (ch === '"') { inStr = true; dollars = 0; out += ch; continue; }
      if (ch === '/' && text[i + 1] === '/') {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl - 1;
        continue;
      }
      if (ch === ',') {
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        if (text[j] === ']' || text[j] === '}') continue;
      }
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) { out += ch; continue; }
      if (next === 'u') {
        if (/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { out += text.slice(i, i + 6); i += 5; }
        else out += '\\\\';
        continue;
      }
      // \times \frac \beta \right：反斜線後面接字母，是 LaTeX 指令，不是 JSON 跳脫字元
      if ('btfr'.includes(next) && isLetter(text[i + 2])) { out += '\\\\'; continue; }
      // 數學式（$ 裡面）的 \neq \ne
      if (next === 'n' && dollars % 2 === 1 && isLetter(text[i + 2])) { out += '\\\\'; continue; }
      if ('"\\/bfnrt'.includes(next)) { out += ch + next; i++; continue; }
      out += '\\\\';
      continue;
    }
    if (ch === '"') { inStr = false; out += ch; continue; }
    if (ch === '$') dollars++;
    if (ch === '\n') { out += '\\n'; continue; }
    if (ch === '\r') continue;
    if (ch === '\t') { out += '\\t'; continue; }
    out += ch;
  }
  return out;
}

// 邊收邊解析：回覆還沒寫完時，先拿出已經完整的欄位（head）和步驟（steps），動畫就能先開始播。
// 解析失敗的步驟放 null，讓步驟編號對得上。
export function scanPartial(text) {
  const res = { head: {}, steps: [], complete: false, value: null };
  const start = text.indexOf('{');
  if (start < 0) return res;
  const s = repairJson(text.slice(start));
  let depth = 0, inStr = false, esc = false;
  let key = null, keyStart = -1, valStart = -1, stepStart = -1;
  const take = (a, b) => {
    try { res.head[key] = JSON.parse(s.slice(a, b)); } catch { /* 這個欄位壞了就略過 */ }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') {
        inStr = false;
        if (depth === 1) {
          if (keyStart >= 0) {
            try { key = JSON.parse(s.slice(keyStart, i + 1)); } catch { key = ''; }
            keyStart = -1;
          } else if (valStart >= 0) {
            take(valStart, i + 1);
            valStart = -1;
            key = null;
          }
        }
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      if (depth === 1) {
        if (key === null) keyStart = i;
        else if (valStart < 0) valStart = i;
      }
      continue;
    }
    if (ch === '{' || ch === '[') {
      depth++;
      if (depth === 2 && key !== null && valStart < 0) valStart = i;
      if (depth === 3 && key === 'steps' && ch === '{') stepStart = i;
      continue;
    }
    if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 2 && key === 'steps' && stepStart >= 0) {
        try { res.steps.push(JSON.parse(s.slice(stepStart, i + 1))); } catch { res.steps.push(null); }
        stepStart = -1;
      }
      if (depth === 1 && valStart >= 0) {
        if (key !== 'steps') take(valStart, i + 1);
        valStart = -1;
        key = null;
      }
      if (depth === 0) {
        res.complete = true;
        try { res.value = JSON.parse(s.slice(0, i + 1)); } catch { /* 用 head 和 steps */ }
        break;
      }
      continue;
    }
    if (depth === 1 && key !== null) {
      if (valStart < 0 && /[-0-9tfn]/.test(ch)) valStart = i;
      else if (valStart >= 0 && ch === ',') {
        take(valStart, i);
        valStart = -1;
        key = null;
      }
    }
  }
  return res;
}

// 一行黑板算式：字串、{id, text} 或 {id, table}
function normalizeLine(line) {
  if (typeof line === 'string' || typeof line === 'number') {
    const text = str(line, 400);
    return text ? { id: '', text } : null;
  }
  if (!line || typeof line !== 'object') return null;
  const id = str(line.id, 40);
  if (Array.isArray(line.table)) {
    const rows = line.table.filter(Array.isArray).slice(0, 12).map(r => r.slice(0, 8).map(c => str(c, 80)));
    return rows.length ? { id, table: rows } : null;
  }
  const text = str(line.text ?? line.tex ?? line.line, 400);
  return text ? { id, text } : null;
}

const asList = v => (Array.isArray(v) ? v : v != null && v !== '' ? [v] : []);

export function normalizeStep(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const say = str(raw.say ?? raw.narration ?? raw.speech, 400);
  const draw = [];
  const write = [];
  for (const a of asList(raw.draw)) {
    if (!a || typeof a !== 'object') continue;
    // AI 偶爾把 write 寫進 draw 裡
    if ('write' in a && !('add' in a)) write.push(...asList(a.write));
    else draw.push(a);
  }
  write.unshift(...asList(raw.write));
  const lines = write.map(normalizeLine).filter(Boolean).slice(0, 20);
  const erase = ['notes', 'figure', 'all'].includes(raw.erase) ? raw.erase : raw.erase === true ? 'notes' : '';
  if (!say && !draw.length && !lines.length) return null;
  const lang = typeof raw.lang === 'string' && /^[a-z]{2,3}(?:-[a-zA-Z]{2,8}){0,2}$/.test(raw.lang) ? raw.lang : '';
  return { say, draw: draw.slice(0, 60), write: lines, erase, ...(lang ? { lang } : {}) };
}

export function normalizeFigure(figure, steps = []) {
  if (figure && typeof figure === 'object') {
    const h = Number(figure.h ?? figure.height);
    return { h: Number.isFinite(h) ? Math.min(120, Math.max(30, h)) : 60 };
  }
  return steps.some(s => s?.draw?.length) ? { h: 60 } : null;
}

// 標題、題目這些欄位（head）也是用這個整理
export function normalizeHead(raw = {}) {
  return {
    kind: contentKind(raw.kind),
    title: str(raw.title, 40),
    subject: str(raw.subject, 12),
    grade: str(raw.grade, 20),
    problem: str(raw.problem, 2400),
    answer: str(raw.answer, 400),
    error: str(raw.error, 300),
  };
}

export function normalizeLesson(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const head = normalizeHead(raw);
  const steps = asList(raw.steps).map(normalizeStep).filter(Boolean).slice(0, 16);
  if (head.error && !steps.length) return { error: head.error };
  if (!steps.length) return null;
  return { ...head, title: head.title || '這一題', error: '', figure: normalizeFigure(raw.figure, steps), steps };
}

// AI 回覆的全文 → 黑板腳本；回覆被截斷時，用已經完整的部分。
export function lessonFromText(text) {
  const r = scanPartial(String(text ?? ''));
  if (r.value) return normalizeLesson(r.value);
  return normalizeLesson({ ...r.head, steps: r.steps.filter(Boolean) });
}
