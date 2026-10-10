// 隨身小老師：拍照、選題，Claude 解完以後用黑板動畫一步一步講解，還可以追問。
import { loggedIn, login, currentSecrets, listProblems, solve, followUp, MODELS, DEFAULT_MODEL, EFFORT, modelName, initializeLocalSession, isLocalSession, saveLocalKey } from './ai.js';
import { logEvent, flushLogWrites, resumeLogEvents } from './logger.js';
import { lessonFromText, normalizeFigure, normalizeHead, normalizeLesson, normalizeStep, scanPartial } from './lesson.js';
import { Player } from './player.js';
import { mathReady, renderRich, splitMath, texToText } from './rich.js';
import { speech } from './speech.js';
import { preparePhoto } from './photo.js';
import { createPhotoEditor } from './photo-editor.js';
import { library } from './library.js';
import { studyProfile, initStudyUI } from './study-ui.js';
import { currentSettings, refreshSettings } from './settings.js';
import { CONTENT_KINDS, contentKind } from './learning.js';
import { initLearningEntry } from './learning-entry.js';
import { initWishes } from './wishes.js';
import './help.js';
import { initSiteUpdate } from './site-update.js';
import { initPasswordToggle } from './password-toggle.js';

initSiteUpdate({ beforeRefresh: flushLogWrites });

const $ = id => document.getElementById(id);
const passwordToggle = initPasswordToggle();
const PREF_KEY = 'scan-solver.prefs';
const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; } })();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* 沒有儲存空間 */ } };

const player = new Player({ svg: $('b-fig'), notes: $('b-notes'), caption: $('b-caption'), body: $('b-body') });

// session：ok 已用密碼解開 API key；login 要輸入密碼
let session = loggedIn() ? { ok: true, login: false } : { ok: false, login: true };
let choice = currentSettings().model;
addEventListener('scan-solver-settings', () => { choice = currentSettings().model; });
const modelInfo = id => MODELS.find(m => m.id === id) || MODELS.find(m => m.id === DEFAULT_MODEL);
let current = null; // 黑板上的題目：{ lesson, source }
let job = null;     // 正在解的題目：{ ac, source }
let answerOnly = false;
let hiddenLesson = false;
// 追問：lesson 是哪一份講解的對話；turns 是 [{ q, a, status, error }]
const ask = { open: false, lesson: null, turns: [], ac: null, recog: null };
player.voice = prefs.voice ?? currentSettings().voice.enabled;
speech.configure(currentSettings().voice);
addEventListener('scan-solver-settings', () => {
  speech.configure(currentSettings().voice);
  player.voice = prefs.voice ?? currentSettings().voice.enabled;
  if (!player.voice) speech.cancel();
  renderVoice();
});

/* ---------- 黑板標頭與訊息 ---------- */

function showHead({ title = '', subject = '', tag = '', problem = '', photo = null }) {
  $('b-title').textContent = title || '隨身小老師';
  $('b-subject').textContent = subject;
  $('b-tag').textContent = tag;
  renderRich($('b-problem'), problem);
  $('b-photo').hidden = !photo;
  if (photo) $('b-photo-img').src = photo;
}

function setStatus(text, center = false) {
  $('b-status').hidden = !text;
  $('b-status').classList.toggle('center', center);
  if (text) $('b-status-text').textContent = text;
}

function showError(title, text, { retry = false } = {}) {
  $('b-error').hidden = false;
  $('b-error-title').textContent = title;
  $('b-error-text').textContent = text || '';
  $('b-retry').hidden = !retry;
  $('b-answer').hidden = true;
}
const hideError = () => { $('b-error').hidden = true; };

// 字幕那一列換成答案和播放鍵（播完、或還沒開始播的時候）
function showAnswer(playLabel) {
  if (hiddenLesson) return;
  if (answerOnly) renderAnswerSteps();
  const answer = current?.lesson?.answer || '';
  $('b-answer-label').textContent = contentKind(current?.lesson?.kind) === 'problem' ? '答案' : '學習重點';
  renderRich($('b-answer-text'), answer);
  $('b-answer-label').hidden = !answer;
  $('b-answer-text').hidden = !answer;
  $('b-again-text').textContent = playLabel;
  $('b-resolve').hidden = !current?.source;
  $('b-other').hidden = !(photos.get(current?.source?.photoId)?.problems?.length > 1);
  $('b-answer').hidden = false;
  $('b-caption').hidden = true;
}
const hideOverlays = () => { $('b-answer').hidden = true; };
function setAnswerOnly(value) {
  answerOnly = value; $('board').dataset.answerOnly = String(value);
  $('app').dataset.answerView = document.documentElement.dataset.answerView = String(value);
  if (!value) window.scrollTo(0, 0);
  $('b-answer-steps').hidden = true;
  $('b-answer-steps').replaceChildren();
  scheduleFit();
}
function renderAnswerSteps() {
  const list = $('b-answer-steps');
  list.replaceChildren();
  for (const [i, step] of (current?.lesson?.steps || []).entries()) {
    const item = document.createElement('li');
    const title = document.createElement('h3');
    title.className = 'answer-step-title'; title.textContent = `第 ${i + 1} 步`;
    item.append(title);
    if (step.say) {
      const text = document.createElement('p'); text.className = 'answer-step-text';
      renderRich(text, step.say); item.append(text);
    }
    for (const line of step.write || []) {
      const block = document.createElement('div'); block.className = 'answer-step-line';
      if (line.table) {
        block.classList.add('answer-step-table');
        const table = document.createElement('table'); table.className = 'chalk-table';
        for (const [rowIndex, row] of line.table.entries()) {
          const tr = table.insertRow();
          for (const value of row) {
            const cell = document.createElement(rowIndex ? 'td' : 'th');
            renderRich(cell, value); tr.append(cell);
          }
        }
        block.append(table);
      } else renderRich(block, line.text);
      item.append(block);
    }
    list.append(item);
  }
  list.hidden = !list.children.length;
}
function preparePlayback() { setAnswerOnly(false); hideOverlays(); }
function renderFloatingControls() {
  $('open-tools').hidden = !current?.lesson || pickFor !== null;
  $('open-tools').disabled = Boolean(job);
  $('app').dataset.controls = String(pickFor === null && !ask.open && Boolean(current || speech.issue || speech.testing));
}

/* ---------- 播放控制 ---------- */

let dotsKey = '';
function renderTray(d) {
  const notes = $('b-notes');
  notes.dataset.step = String(d.viewing);
  for (const line of notes.querySelectorAll('.line')) line.hidden = line.dataset.step !== notes.dataset.step;
  $('t-play-icon').setAttribute('href', d.playing ? '#i-pause' : '#i-play');
  $('t-play').setAttribute('aria-label', d.playing ? '暫停' : '播放');
  $('t-prev').disabled = d.total === 0;
  $('t-play-label').textContent = d.playing ? '暫停' : '播放';
  $('t-play').disabled = !d.total && !job;
  $('t-answer').disabled = !current?.lesson && !job;
  $('t-ask').disabled = !current?.lesson || !current?.source || Boolean(job);
  $('t-next').disabled = d.complete && d.index >= d.total && d.current < 0;
  const key = `${d.total}|${d.complete}`;
  const dots = $('t-dots');
  if (key !== dotsKey) {
    dotsKey = key;
    dots.replaceChildren();
    for (let i = 0; i < d.total; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'dot-btn';
      b.setAttribute('aria-label', `第 ${i + 1} 步`);
      b.addEventListener('click', () => { preparePlayback(); player.seek(i); });
      dots.append(b);
    }
    if (!d.complete && job) {
      const p = document.createElement('span');
      p.className = 'dot-btn pending';
      p.setAttribute('aria-hidden', 'true');
      dots.append(p);
    }
  }
  [...dots.querySelectorAll('button.dot-btn')].forEach((b, i) => {
    b.classList.toggle('done', i < d.index && i !== d.viewing);
    b.classList.toggle('now', i === d.viewing);
    b.setAttribute('aria-current', i === d.viewing ? 'step' : 'false');
  });
  $('t-count').textContent = d.total ? `${Math.max(0, d.viewing) + 1} / ${d.total}${d.complete ? '' : '…'}` : '';
  renderQuestionReturn();
}

player.addEventListener('change', e => {
  const d = e.detail;
  renderTray(d);
  renderVoice();
  scheduleFit();
  if (d.playing || d.current >= 0) hideOverlays();
  if (d.ended && current?.lesson && $('b-error').hidden) showAnswer('再看一次');
  if (job && d.waiting && d.total > 0) setStatus(`${job.name} 還在寫第 ${d.total + 1} 步`);
});

$('t-play').addEventListener('click', () => { preparePlayback(); player.toggle(); });
$('t-prev').addEventListener('click', () => { preparePlayback(); player.prev(); });
$('t-next').addEventListener('click', () => { preparePlayback(); player.next(); });
$('b-again').addEventListener('click', () => { preparePlayback(); player.play(); });
$('t-answer').addEventListener('click', async () => {
  setAnswerOnly(true);
  await player.pause();
  if (current?.lesson) { await player.showAll(); showAnswer('播放講解'); }
  else setStatus('正在取得完整教學內容…', true);
});


function renderVoice() {
  $('t-voice').setAttribute('aria-pressed', String(player.voice));
  $('t-voice-icon').setAttribute('href', player.voice ? '#i-sound' : '#i-mute');
  const list = speech.voices;
  $('t-voice').disabled = !speech.ok;
  $('t-voice').title = speech.ok ? '語音旁白' : '這個瀏覽器沒有中文語音，只顯示字幕';
  const feedback = !speech.ok ? '這個瀏覽器不支援語音朗讀，請用 Safari 或 Chrome 開啟。'
    : speech.issue || (player.voice && !list.length ? '中文語音尚未載入，可點「聲音」關掉再打開重試。' : '');
  $('voice-feedback').textContent = feedback;
  $('voice-feedback').hidden = !feedback;
}
// 打開聲音時在點擊的當下念一句：iPhone 要這樣才允許之後自動朗讀，也順便確認聽得到
$('t-voice').addEventListener('click', () => {
  player.voice = !player.voice;
  prefs.voice = player.voice;
  savePrefs();
  if (!player.voice) speech.cancel();
  else if (!player.playing) speech.test('聲音開啟了。');
  else speech.unlock();
  renderVoice();
});
speech.onChange(renderVoice);
renderVoice();

/* ---------- 顯示一份腳本（測試也用這個） ---------- */

async function showLesson(lesson, { tag = '', autoplay = true } = {}) {
  hiddenLesson = false;
  listJob?.abort(); listJob = null; hidePick();
  closeAsk();
  setAnswerOnly(false);
  job?.ac.abort();
  job = null;
  setStatus('');
  hideError();
  hideOverlays();
  current = { lesson, source: null };
  showHead({ title: lesson.title, subject: lesson.subject, tag, problem: lesson.problem });
  await player.load(lesson);
  if (autoplay) player.play();
  else {
    await player.showAll();
    showAnswer('播放動畫');
  }
}

/* ---------- 解題 ---------- */

const notReady = () => requireLogin();

// 密碼過期或還沒登入：顯示密碼欄
function requireLogin(message = '') {
  session = { ok: false, login: true };
  renderSession();
  $('login-error').hidden = !message;
  $('login-error').textContent = message;
  $('password').focus({ preventScroll: true });
}

// 模型與強度由管理員設定，解題頁不顯示；實際用量與備援模型寫入管理紀錄。
function renderBoardAI(asked, used) {
  const name = modelInfo(asked).label, real = used ? modelName(used) : name;
  $('board-ai').hidden = true;
  $('board-ai').textContent = `Claude ${real} · effort ${EFFORT}${used && real !== name ? `（${name} 婉拒，改由 ${real} 接手）` : ''}`;
}

// source：{ blob, thumb, note, photoId }
async function startSolve(source) {
  if (!session.ok) { notReady(); return; }
  listJob?.abort(); listJob = null; hidePick();
  closeAsk();
  hiddenLesson = false;
  setAnswerOnly(false);
  job?.ac.abort();
  const ac = new AbortController();
  const profile = studyProfile();
  const hints = profile.mode === 'hints' && contentKind(source.kind) === 'problem';
  const me = (job = { ac, source, name: 'Claude', model: choice, eventId: crypto.randomUUID() });
  current = { lesson: null, source };
  renderBoardAI(me.model);
  hideError();
  hideOverlays();
  showHead({ title: `${me.name} 正在看學習內容`, tag: source.note, photo: source.thumb });
  await player.load({ title: '', figure: null, steps: [] }, { complete: false });
  if (job !== me) return;
  if (!answerOnly && !hints) player.play();
  const looking = () => `${me.name} 正在看${source.note || '學習內容'}`;
  setStatus(looking(), true);
  scrollToBoard();

  let used = 0, figureDone = false;
  const shown = {};
  const onText = full => {
    if (job !== me) return;
    if (hints) return;
    const r = scanPartial(full);
    const h = normalizeHead(r.head);
    if (h.title && h.title !== shown.title) $('b-title').textContent = shown.title = h.title;
    if (h.subject && h.subject !== shown.subject) $('b-subject').textContent = shown.subject = h.subject;
    if (h.problem && h.problem !== shown.problem) renderRich($('b-problem'), (shown.problem = h.problem));
    if (!figureDone && ('figure' in r.head || r.steps.length)) {
      figureDone = true;
      if ('figure' in r.head) player.setFigure(normalizeFigure(r.head.figure));
    }
    while (used < r.steps.length) {
      const s = normalizeStep(r.steps[used++]);
      if (s) player.addStep(s);
    }
    if (answerOnly) { setStatus('正在取得完整教學內容…', true); return; }
    if (!player.total) setStatus(h.problem ? `${me.name} 正在整理教學重點` : looking(), true);
    else setStatus(`${me.name} 還在寫第 ${player.total + 1} 步`);
  };
  const onStage = stage => {
    if (job === me && !player.total && stage === 'thinking') setStatus(shown.problem ? `${me.name} 正在整理教學重點` : looking(), true);
  };
  // 使用紀錄：結束（完成、失敗、停止）時寫一筆，不收集位置。
  const started = Date.now();
  let streamed = '', outcome = { status: 'cancelled' };
  try {
    const note = [source.note, source.correction && `學生修正／補充（以此為準）：${source.correction}`].filter(Boolean).join('\n');
    const res = await solve({ image: source.blob, text: source.text, note, kind: source.kind, model: me.model, profile, signal: ac.signal, onText: t => { streamed = t; onText(t); }, onStage });
    outcome = { status: 'done', usedModel: res.model, truncated: res.truncated, usage: res.usage, profile };
    if (job !== me) return;
    renderBoardAI(me.model, res.model);
    onText(res.text);
    const lesson = lessonFromText(res.text);
    if (!lesson) throw new Error(res.truncated ? `${me.name} 寫太長被截斷了。請按「重新講解」，或改用 Opus 5.5。` : `${me.name} 的回覆格式不對。請按「重新講解」再試一次。`);
    Object.assign(outcome, { title: lesson.title || '', answer: lesson.answer || '', error: lesson.error || '' });
    if (lesson.error) {
      outcome.status = 'error';
      await player.pause();
      player.finish();
      setStatus('');
      showHead({ title: source.text ? '需要補充學習內容' : '看不清楚內容', photo: source.thumb });
      showError(source.text ? '需要補充學習內容' : '看不清楚內容', lesson.error, { retry: true });
      return;
    }
    if (hints && res.truncated) throw new Error('講解未完整產生，請重新講解後再取得提示。');
    const owner = current;
    source.kind = lesson.kind;
    owner.lesson = lesson; owner.profile = profile;
    if (!res.truncated) {
      const now = new Date().toISOString(), id = crypto.randomUUID();
      try {
        await library.put({ id, lesson, source, profile, created: now, updated: now, favorite: false, review: false, turns: [], usedModel: res.model, solveEventId: me.eventId });
        owner.id = id; owner.usedModel = res.model;
        if (job === me) studyUI.notice('已儲存到本機學習庫');
      } catch (e) { studyUI.notice(e.message); }
    }
    if (job !== me) return;
    if (hints && lesson.kind === 'problem') {
      hiddenLesson = true; player.finish(); setStatus('');
      showHead({ title: lesson.title, subject: lesson.subject, tag: source.note, problem: lesson.problem, photo: source.thumb });
      studyUI.showHints(owner);
      return;
    }
    for (let k = player.total; k < lesson.steps.length; k++) player.addStep(lesson.steps[k]);
    Object.assign(player.lesson, { ...lesson, figure: player.lesson.figure ?? lesson.figure, steps: player.steps });
    current.lesson = lesson;
    showHead({ title: lesson.title, subject: lesson.subject, tag: source.note, problem: lesson.problem, photo: source.thumb });
    player.finish();
    if (hints && !answerOnly) player.play();
    setStatus(res.truncated ? `${me.name} 寫太長被截斷了，最後幾步可能不完整。` : '');
    if (res.truncated) setTimeout(() => { if (!job) setStatus(''); }, 8000);
    if (answerOnly) { await player.showAll(); showAnswer('播放講解'); }
  } catch (e) {
    if (e.name !== 'AbortError') outcome = { ...outcome, status: 'error', error: e.message, code: e.code || '', usage: e.usage || outcome.usage, usedModel: e.model || outcome.usedModel };
    if (job !== me || e.name === 'AbortError') return;
    setStatus('');
    if (e.code === 'login') requireLogin(e.message);
    // refused：Claude 收回了已經寫的內容，黑板也要清掉
    if (player.total > 0 && !answerOnly && e.code !== 'refused') {
      player.finish();
      setStatus(`${me.name} 中途停了：${e.message}`);
      setTimeout(() => { if (!job) setStatus(''); }, 8000);
    } else {
      await player.pause();
      if (e.code === 'refused') {
        await player.load({ title: '', figure: null, steps: [] });
        showHead({ title: '講解失敗', tag: source.note, photo: source.thumb });
      }
      player.finish();
      showError('講解失敗', e.message, { retry: e.code !== 'login' });
    }
  } finally {
    if (job === me) job = null;
    logEvent(currentSecrets(), { kind: 'solve', eventId: me.eventId, photoId: source.photoId, note: source.note || '', model: modelInfo(me.model).label, effort: EFFORT,
      ...outcome, problem: source.text || '', correction: source.correction || '', text: streamed, ms: Date.now() - started });
  }
}

const resolveCurrent = () => { if (current?.source) startSolve(current.source); };
$('b-retry').addEventListener('click', resolveCurrent);
$('b-resolve').addEventListener('click', resolveCurrent);
$('b-stop').addEventListener('click', () => {
  if (!job) return;
  job.ac.abort();
  job = null;
  setStatus('');
  player.finish();
  if (!player.total) showError('已經停止', '要繼續學習的話，重新拍一次就可以了。');
});

function scrollToBoard() {
  if (answerOnly) $('board').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- 拍照 ---------- */

// 手機照片可能很大：縮到長邊 2000 再傳
async function loadPhoto(file) {
  if (!file) return;
  let photo;
  try { photo = await preparePhoto(file); }
  catch (error) { showError('照片打不開', error.message); return; }
  try { closeAsk(); await player.pause(); photo = await editPhoto(photo); }
  catch (error) { showError('照片預覽失敗', error.message); return; }
  if (photo) listAndPick(photo.blob, photo.thumb);
}
for (const id of ['file', 'file-pick']) $(id).addEventListener('change', e => { loadPhoto(e.target.files?.[0]); e.target.value = ''; });
$('shoot').addEventListener('click', () => $('file').click());
$('album').addEventListener('click', () => $('file-pick').click());

/* ---------- 照片裡有哪幾題 ---------- */

const photos = new Map(); // 照片 id → { blob, thumb, listing, problems, error }
let pickFor = null;
let pickPage = 0, pickCount = 3;
let pickRow = 96; // 一列題目按鈕的高度（含間距）；只會變大，換頁時才不會來回跳
let listJob = null;

// 先請 Claude 列出照片裡的題目，在黑板上讓人點；只有一題就直接解
async function listAndPick(blob, thumb) {
  if (!session.ok) { notReady(); return; }
  listJob?.abort();
  const ac = (listJob = new AbortController());
  const id = `p${Date.now()}`;
  const p = { blob, thumb, name: 'Claude', listing: true, problems: null, error: '' };
  photos.set(id, p);
  showPick(id);
  scrollToBoard();
  const started = Date.now(), model = choice;
  let status = 'cancelled';
  try {
    Object.assign(p, await listProblems({ image: blob, model, signal: ac.signal }));
    status = 'done';
    if (p.error) status = 'error';
  } catch (e) {
    if (e.name === 'AbortError') return;
    status = 'error';
    if (e.code === 'login') requireLogin(e.message);
    p.problems = [];
    p.error = e.message;
    p.usage = e.usage; p.model = e.model;
  } finally {
    p.listing = false;
    if (listJob === ac) listJob = null;
    // 使用紀錄：照片只在列題時存一次，解題紀錄用 photoId 對回來
    logEvent(currentSecrets(), { kind: 'list', photoId: id, photo: blob, model: modelInfo(model).label, effort: EFFORT, status,
      usedModel: p.model || '', usage: p.usage, problems: p.problems || [], error: p.error, ms: Date.now() - started });
  }
  if (pickFor !== id) return;
  if (p.problems.length === 1) choose(id, p.problems[0].label);
  else renderPick();
}

function choose(id, note) {
  const p = photos.get(id);
  if (!p) return;
  hidePick();
  startSolve({ blob: p.blob, thumb: p.thumb, note, kind: p.problems.find(q => q.label === note)?.kind, photoId: id });
}

function showPick(id) {
  closeAsk();
  setAnswerOnly(false);
  pickFor = id;
  pickPage = 0;
  pickRow = 96;
  const interrupted = Boolean(job);
  job?.ac.abort();
  job = null;
  setStatus('');
  hideError();
  player.pause();
  if (interrupted) player.finish();
  renderPick();
  $('b-pick').hidden = false;
  renderQuestionReturn();
}

function hidePick() {
  pickFor = null;
  $('b-pick').hidden = true;
  renderQuestionReturn();
}

function renderQuestionReturn() {
  const photo = photos.get(current?.source?.photoId);
  $('t-questions').hidden = !photo?.problems?.length || pickFor !== null;
  renderFloatingControls();
}

function returnToQuestions() {
  const id = current?.source?.photoId;
  if (!photos.get(id)?.problems?.length) return;
  showPick(id);
  scrollToBoard();
  $('b-pick-list').querySelector('button')?.focus({ preventScroll: true });
}

function renderPick() {
  const p = photos.get(pickFor);
  if (!p) return;
  $('b-pick-img').src = p.thumb || '';
  const list = $('b-pick-list');
  if (p.listing || !p.problems) {
    $('pick-pages').hidden = true;
    $('b-pick-title').textContent = '收到照片了';
    const wait = document.createElement('li');
    wait.className = 'b-pick-wait';
    wait.innerHTML = '<span class="chalk-dots" aria-hidden="true"><i></i><i></i><i></i></span>';
    wait.append(`${p.name} 正在辨識題目、文章、單字與知識內容`);
    list.replaceChildren(wait);
    return;
  }
  if (!p.problems.length) {
    hidePick();
    showHead({ title: '需要更清楚的照片', photo: p.thumb });
    showError('無法辨識學習內容', p.error);
    return;
  }
  $('b-pick-title').textContent = `照片裡有 ${p.problems.length} 項內容，想學哪一項？`;
  const pages = Math.ceil(p.problems.length / pickCount);
  pickPage = Math.min(pickPage, pages - 1);
  $('pick-pages').hidden = pages <= 1;
  $('pick-prev').disabled = pickPage === 0;
  $('pick-next').disabled = pickPage >= pages - 1;
  $('pick-page').textContent = `${pickPage + 1} / ${pages}`;
  list.replaceChildren(...p.problems.slice(pickPage * pickCount, (pickPage + 1) * pickCount).map(q => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const label = document.createElement('b');
    label.textContent = q.label;
    const pre = document.createElement('span');
    pre.textContent = `${CONTENT_KINDS[contentKind(q.kind)]} · ${q.preview}`;
    b.append(label, pre);
    b.addEventListener('click', () => choose(pickFor, q.label));
    li.append(b);
    return li;
  }));
}

for (const [id, direction] of [['pick-prev', -1], ['pick-next', 1]]) $(id).addEventListener('click', () => {
  pickPage += direction; renderPick();
});

$('b-pick-close').addEventListener('click', hidePick);
$('b-other').addEventListener('click', returnToQuestions);
$('t-questions').addEventListener('click', returnToQuestions);

/* ---------- 追問 ---------- */

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
$('ask-mic').hidden = !Recognition;
const askHint = text => { $('ask-hint').textContent = text; };

function openAsk() {
  if (!current?.lesson || !current.source) return;
  if (ask.lesson !== current.lesson) { ask.lesson = current.lesson; ask.turns = []; }
  player.pause();
  speech.cancel();
  ask.open = true;
  $('b-ask-title').textContent = `追問：${current.lesson.title || '這一題'}`;
  $('b-ask').hidden = false;
  askHint('');
  renderAsk();
  renderAskForm();
  renderFloatingControls();
  // 手機上自動叫出鍵盤會擋住黑板，只在電腦上先把游標放進輸入欄
  if (!matchMedia('(pointer: coarse)').matches) $('ask-input').focus();
}

function closeAsk() {
  if (!ask.open) return;
  ask.ac?.abort();
  ask.recog?.abort();
  speech.cancel();
  ask.open = false;
  $('b-ask').hidden = true;
  renderFloatingControls();
}

// 句子裡殘留的算式改成念得出來的中文
function speakable(text) {
  return splitMath(text).map(p => (p.math ? texToText(p.s) : p.s)).join('')
    .replace(/(\d+)\s*\/\s*(\d+)/g, '$2分之$1').replace(/×/g, '乘以').replace(/÷/g, '除以').replace(/=/g, '等於')
    .replace(/\+/g, '加').replace(/(\d)\s*[-−]\s*(\d)/g, '$1減$2');
}

function renderAnswer(el, text) {
  el.replaceChildren(...text.split(/\n+/).filter(line => line.trim()).map(line => { const p = document.createElement('p'); renderRich(p, line); return p; }));
}

function renderAsk() {
  const list = $('b-ask-list');
  if (!ask.turns.length) {
    const li = document.createElement('li');
    li.className = 'ask-empty';
    li.textContent = Recognition ? '哪裡不懂？打字或按麥克風用說的，問 Claude。' : '哪裡不懂？打字問 Claude，也可以用鍵盤上的麥克風說。';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(...ask.turns.map(t => {
    const li = document.createElement('li');
    const q = document.createElement('p');
    q.className = 'ask-q';
    q.textContent = t.q;
    const a = document.createElement('div');
    a.className = `ask-a${t.status === 'pending' ? ' pending' : ''}${t.error ? ' error' : ''}`;
    if (t.error) a.textContent = t.error;
    else if (t.status === 'pending') a.textContent = t.a || 'Claude 正在想…';
    else renderAnswer(a, t.a);
    t.el = a;
    li.append(q, a);
    return li;
  }));
  list.scrollTop = list.scrollHeight;
}

function renderAskForm() {
  const busy = Boolean(ask.ac);
  $('ask-send').setAttribute('aria-label', busy ? '停止' : '送出');
  $('ask-send').querySelector('use').setAttribute('href', busy ? '#i-stop' : '#i-send');
  $('ask-mic').disabled = busy;
  $('ask-mic').setAttribute('aria-pressed', String(Boolean(ask.recog)));
}

async function sendAsk(text) {
  const question = text.trim();
  if (!question || ask.ac || !current?.lesson || !current.source) return;
  if (!session.ok) { closeAsk(); requireLogin(); return; }
  const { source, lesson } = current;
  const history = ask.turns.filter(t => t.status === 'done').map(t => ({ q: t.q, a: t.a }));
  const turn = { q: question, a: '', status: 'pending' };
  ask.turns.push(turn);
  $('ask-input').value = '';
  askHint('');
  const ac = (ask.ac = new AbortController());
  renderAsk();
  renderAskForm();
  const started = Date.now(), model = choice, step = player.viewing;
  let used = '', usage;
  try {
    const r = await followUp({ image: source.blob, sourceText: source.text, lesson, history, question, model, profile: studyProfile(), step, signal: ac.signal,
      onText: t => { turn.a = t; if (turn.el) { turn.el.textContent = t; $('b-ask-list').scrollTop = $('b-ask-list').scrollHeight; } } });
    turn.a = r.text;
    turn.status = 'done';
    used = r.model;
    usage = r.usage;
    if (r.truncated) { turn.error = '回覆被截斷，請縮小問題再問一次。'; turn.status = 'error'; }
    if (ask.turns.includes(turn)) renderAsk();
    if (ask.open && player.voice && speech.ok) {
      speech.say(turn.a.split(/\n+/).filter(line => !/^\s*\$[^$]*\$\s*$/.test(line)).map(speakable).join('。'));
    }
  } catch (e) {
    usage = e.usage; used = e.model || used;
    turn.status = e.name === 'AbortError' ? 'cancelled' : 'error';
    turn.error = e.name === 'AbortError' ? '已停止。' : e.message;
    if (e.code === 'refused') turn.a = '';
    if (ask.turns.includes(turn)) renderAsk();
    if (e.code === 'login') { closeAsk(); requireLogin(e.message); }
  } finally {
    if (ask.ac === ac) ask.ac = null;
    renderAskForm();
    if (current?.id && current.lesson === lesson) {
      const turns = ask.turns.map(({ q, a, status, error }) => ({ q, a, status, error }));
      library.update(current.id, { turns }).catch(e => studyUI.notice(e.message));
    }
    logEvent(currentSecrets(), { kind: 'ask', photoId: source.photoId, note: source.note || '', title: lesson.title || '', question, text: turn.a,
      model: modelInfo(model).label, effort: EFFORT, usedModel: used, usage, step, status: turn.status, error: turn.error || '', ms: Date.now() - started });
  }
}

// 語音輸入：說完自動送出；辨識到的字先填進輸入欄，看得到聽成什麼
function listen() {
  if (!Recognition || ask.ac) return;
  if (ask.recog) { ask.recog.stop(); return; }
  speech.cancel();
  const r = new Recognition();
  r.lang = 'zh-TW';
  r.interimResults = true;
  r.continuous = false;
  let heard = '';
  r.onresult = e => {
    let interim = '';
    heard = '';
    for (const result of e.results) {
      if (result.isFinal) heard += result[0].transcript;
      else interim += result[0].transcript;
    }
    $('ask-input').value = heard + interim;
  };
  r.onerror = e => {
    askHint(e.error === 'not-allowed' || e.error === 'service-not-allowed' ? '麥克風沒有開放。請在瀏覽器設定允許使用麥克風，或改用打字。'
      : e.error === 'no-speech' ? '沒有聽到聲音，再按一次麥克風試試。' : e.error === 'aborted' ? '' : '語音辨識失敗，請再試一次或改用打字。');
  };
  r.onend = () => {
    if (ask.recog === r) ask.recog = null;
    renderAskForm();
    if ($('ask-hint').textContent === '請說出你的問題…') askHint('');
    if (heard.trim() && ask.open) sendAsk($('ask-input').value);
  };
  ask.recog = r;
  try { r.start(); askHint('請說出你的問題…'); }
  catch { ask.recog = null; askHint('語音辨識無法啟動，請改用打字。'); }
  renderAskForm();
}

$('t-ask').addEventListener('click', openAsk);
$('b-ask-close').addEventListener('click', closeAsk);
$('ask-mic').addEventListener('click', listen);
$('b-ask-form').addEventListener('submit', e => {
  e.preventDefault();
  if (ask.ac) ask.ac.abort();
  else sendAsk($('ask-input').value);
});
for (const button of document.querySelectorAll('[data-ask]')) button.addEventListener('click', () => {
  const step = player.viewing >= 0 ? `第 ${player.viewing + 1} 步：` : '';
  $('ask-input').value = step + button.dataset.ask;
  $('ask-input').focus();
});

/* ---------- 照片放大、鍵盤 ---------- */

$('b-photo').addEventListener('click', () => {
  $('photo-view-img').src = $('b-photo-img').src;
  $('photo-view').hidden = false;
  $('photo-close').focus();
});
$('photo-close').addEventListener('click', () => { $('photo-view').hidden = true; });

document.addEventListener('keydown', e => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.('input, select, textarea') || document.querySelector('dialog[open]')) return;
  if (hiddenLesson) return;
  if (e.key === 'ArrowLeft') { preparePlayback(); player.prev(); }
  else if (e.key === 'ArrowRight') { preparePlayback(); player.next(); }
  else if (e.key === 'p' || e.key === 'P' || e.key === 'k') { preparePlayback(); player.toggle(); }
  else if (e.key === 'Escape') { $('photo-view').hidden = true; closeAsk(); }
});
document.addEventListener('click', () => { if (player.voice && !document.querySelector('dialog[open]')) speech.unlock(); });

/* ---------- 登入與模型 ---------- */

function renderSession() {
  $('login').hidden = !session.login;
  $('login').querySelector('label').textContent = isLocalSession() ? '本機 Claude API key（首次設定）' : '輸入密碼解鎖 Claude';
  $('password').autocomplete = isLocalSession() ? 'off' : 'current-password';
  $('password').placeholder = isLocalSession() ? 'sk-ant-…' : '';
  $('login-submit').textContent = isLocalSession() ? '儲存並開始' : '登入';
  $('login').querySelector('.login-note').textContent = isLocalSession() ? '只需設定一次，之後本機啟動會自動載入。' : '使用時會記錄手機型號、學習內容和老師回覆，只有管理員看得到。不收集手機位置，也不要求定位授權。';
  for (const id of ['shoot', 'album', 'voice-entry']) $(id).disabled = !session.ok;
}

$('login').addEventListener('submit', async e => {
  e.preventDefault();
  $('login-submit').disabled = true;
  $('login-submit').textContent = '解鎖中…';
  try {
    if (isLocalSession()) await saveLocalKey($('password').value.trim());
    else await login($('password').value);
    await refreshSettings({ local: isLocalSession(), secrets: currentSecrets() });
    $('password').value = '';
    passwordToggle.hide();
    session = { ok: true, login: false };
    void resumeLogEvents();
    logEvent(currentSecrets(), { kind: 'login' });
    $('login-error').hidden = true;
    renderSession();
    hideError();
  } catch (error) {
    $('login-error').hidden = false;
    $('login-error').textContent = error.message;
  } finally { $('login-submit').disabled = false; $('login-submit').textContent = isLocalSession() ? '儲存並開始' : '登入'; }
});


/* ---------- 題庫與學習工具 ---------- */
const editPhoto = createPhotoEditor();
const studyUI = initStudyUI({
  current: () => current, busy: () => Boolean(job), model: () => choice, modelId: id => modelInfo(id).model,
  pause: () => { closeAsk(); player.pause(); }, solve: startSolve,
  async restore(record) {
    await showLesson(normalizeLesson(record.lesson), { autoplay: false });
    current = { ...record, lesson: player.lesson };
    if (record.source) {
      current.source = { ...record.source, kind: current.lesson.kind };
      if (record.source.blob && record.source.photoId) photos.set(record.source.photoId, { blob: record.source.blob, thumb: record.source.thumb, problems: [{ label: record.source.note || '這份內容', preview: record.lesson.problem, kind: current.lesson.kind }], listing: false });
    }
    ask.lesson = current.lesson; ask.turns = record.turns || [];
    showHead({ title: current.lesson.title, subject: current.lesson.subject, problem: current.lesson.problem, photo: current.source?.thumb });
    renderBoardAI(choice, record.usedModel); player.emit(); showAnswer('播放講解');
  },
  async reveal(owner) {
    if (current !== owner) return;
    hiddenLesson = false;
    await player.load(owner.lesson);
    await player.showAll(); showAnswer('播放講解');
  },
});
initWishes({ pause: () => { closeAsk(); player.pause(); }, login: requireLogin });
const learningEntry = initLearningEntry({
  ready: () => { if (session.ok) return true; requireLogin(); return false; },
  login: requireLogin, model: () => choice, modelId: id => modelInfo(id).model,
  pause: () => {
    closeAsk(); listJob?.abort(); listJob = null; hidePick();
    const interrupted = Boolean(job); job?.ac.abort(); job = null;
    setStatus(''); player.pause(); if (interrupted) player.finish();
  },
  teach: text => startSolve({ text, note: '語音／文字', kind: 'auto' }),
  restore: record => studyUI.restore(record),
});
// 提示模式關閉對話窗後，仍不能透過播放器提前揭露解答。
for (const id of ['t-play', 't-prev', 't-next', 't-answer', 'b-again', 't-ask']) $(id).addEventListener('click', e => {
  if (!hiddenLesson) return;
  e.stopImmediatePropagation(); studyUI.showHints();
}, { capture: true });

/* ---------- 開始 ---------- */

async function init() {
  $('shoot').disabled = $('album').disabled = $('voice-entry').disabled = true;
  await initializeLocalSession();
  await resumeLogEvents();
  await refreshSettings({ local: isLocalSession(), secrets: currentSecrets() });
  session = loggedIn() ? { ok: true, login: false } : { ok: false, login: true };
  renderSession();
  showHead({ title: '隨身小老師', problem: '拍照、相簿或語音開始學習；也可以說「考我國中常用單字」。' });
  // 字型和數學式好了再量一次字寬
  mathReady.then(() => player.refresh());
  document.fonts?.ready.then(() => player.refresh());
  const recordId = new URL(location.href).searchParams.get('lesson');
  if (recordId) {
    const record = await library.get(recordId).catch(() => null);
    if (record) await studyUI.restore(record);
    else studyUI.notice('這個瀏覽器找不到該題，請從題庫選取。');
  }
}

$('open-admin').addEventListener('click', async e => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const href = e.currentTarget.href;
  try { await flushLogWrites(); location.href = href; }
  catch { studyUI.notice('紀錄尚未保存，請稍後再開啟管理頁。'); }
});

addEventListener('focus', () => { if (!job && !ask.ac) refreshSettings({ local: isLocalSession(), secrets: currentSecrets() }); });

// 測試用：網址加 #test 時把播放器交給自動化測試
if (location.hash === '#test') window.__ss = { player, speech, showLesson, normalizeLesson,
  showTestPick: problems => { const id = 'test-pick'; photos.set(id, { listing: false, problems, thumb: '' }); showPick(id); } };

// 依可見視窗量測完整內容，縮放圖文而不裁切；完整解答不縮放。
let fitFrame = 0;
function scheduleFit() {
  if (!fitFrame) fitFrame = requestAnimationFrame(fitPage);
}
function fitContent(parent, content) {
  if (!parent.clientWidth || !parent.clientHeight) return;
  const css = getComputedStyle(parent);
  const width = parent.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
  const height = parent.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
  const scale = Math.min(1, width / Math.max(1, content.scrollWidth), height / Math.max(1, content.scrollHeight));
  content.style.transform = `translateX(${Math.max(0, (width - content.offsetWidth * scale) / 2)}px) scale(${scale})`;
}
function fitPage() {
  fitFrame = 0;
  document.documentElement.style.setProperty('--viewport-height', `${Math.round(window.visualViewport?.height || innerHeight)}px`);
  if (!answerOnly) fitContent($('board'), $('board-content'));
  else $('board-content').style.transform = '';
  const photo = photos.get(pickFor), list = $('b-pick-list');
  if (photo?.problems?.length && !$('b-pick').hidden && list.clientHeight) {
    const height = list.clientHeight - ($('pick-pages').hidden && photo.problems.length > 1 ? 38 : 0);
    const columns = Math.max(1, Math.floor((list.clientWidth + 8) / 228));
    for (const item of list.querySelectorAll('li')) pickRow = Math.max(pickRow, item.offsetHeight + 8);
    const count = Math.max(1, Math.floor((height + 8) / pickRow)) * columns;
    if (count !== pickCount) {
      const first = pickPage * pickCount;
      pickCount = count; pickPage = Math.floor(first / count);
      renderPick();
    }
  }
}
const layoutObserver = new MutationObserver(scheduleFit);
layoutObserver.observe($('app'), { childList: true, subtree: true, characterData: true, attributes: true,
  attributeFilter: ['hidden', 'data-layout', 'data-controls'] });
const sizeObserver = new ResizeObserver(scheduleFit);
for (const el of [$('board'), $('board-content'), $('b-pick-list')]) sizeObserver.observe(el);
addEventListener('resize', scheduleFit);
window.visualViewport?.addEventListener('resize', scheduleFit);
document.fonts?.ready.then(scheduleFit);
scheduleFit();

init();
