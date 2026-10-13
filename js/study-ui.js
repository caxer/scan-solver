import { library } from './library.js';
import { normalizeProfile } from './study.js';
import { currentSettings } from './settings.js';
import { studyTask, currentSecrets, modelName, EFFORT } from './ai.js';
import { logEvent } from './logger.js';
import { renderRich } from './rich.js';

export const studyProfile = () => normalizeProfile(currentSettings());
const el = (tag, text) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; };

export function initStudyUI(bridge) {
  const host = document.createElement('div');
  host.innerHTML = `
  <dialog class="study-dialog" id="study-library"><form method="dialog" class="study-heading"><h2>學習經歷</h2><button class="btn">關閉</button></form>
    <p>回顧學過的文章、單字、題目與測驗結果，可重播、收藏或複習錯題。成功且完整的講解會自動保存在這個瀏覽器；清除網站資料會刪除這些紀錄。</p>
    <div class="study-filters"><input id="library-search" type="search" placeholder="搜尋文章、單字、題目或科目" aria-label="搜尋學習經歷"><select id="library-filter" aria-label="學習經歷篩選"><option value="all">全部</option><option value="favorite">收藏</option><option value="review">待複習</option></select></div>
    <p id="library-status" role="status"></p><div id="library-list"></div></dialog>
  <dialog class="study-dialog" id="study-tools"><form method="dialog" class="study-heading"><h2>學習工具</h2><button class="btn">關閉</button></form>
    <p id="tools-title"></p><div class="study-actions"><button class="btn" id="tool-favorite" aria-pressed="false">收藏</button><button class="btn" id="tool-review" aria-pressed="false">標記</button><button class="btn" id="tool-hints">提示</button><button class="btn" id="tool-practice">出題</button></div>
    <form id="correction-form"><label>補充或修正學習內容<textarea id="problem-correction" maxlength="2000" placeholder="例如：圖上的長度是 18 公分，不是 13 公分；只解 (2) 小題。" required></textarea></label><button class="btn primary">依修正重新講解</button></form><p id="tools-status" role="status"></p></dialog>
  <dialog class="study-dialog" id="study-hints"><form method="dialog" class="study-heading"><h2>逐步提示</h2><button class="btn">關閉</button></form>
    <div id="hints-problem"></div><p id="hints-progress"></p><div id="hints-question"></div><p id="hints-clue" hidden></p>
    <form id="hints-form"><label>你的答案<input id="hints-answer" maxlength="1500" autocomplete="off" required></label><button class="btn primary" id="hints-check">檢查答案</button></form>
    <p id="hints-feedback" role="status"></p><div class="study-actions"><button class="btn" id="hints-clue-button">給我一點提示</button><button class="btn" id="hints-next" disabled>下一關</button><button class="btn" id="hints-reveal">看完整講解</button><button class="btn" id="hints-retry" hidden>重新取得提示</button></div></dialog>
  <dialog class="study-dialog" id="study-practice"><form method="dialog" class="study-heading"><h2>出題練習</h2><button class="btn">關閉</button></form>
    <p>依目前學習內容出一道練習題，先作答，再看提示與解析。</p>
    <div id="practice-problem"></div><div id="practice-hint" hidden></div>
    <form id="practice-form"><label>你的答案<textarea id="practice-answer" maxlength="1500" required></textarea></label><button class="btn primary" id="practice-check">提交答案</button></form>
    <p id="practice-feedback" role="status"></p><div class="study-actions"><button class="btn" id="practice-clue">提示</button><button class="btn" id="practice-reveal">揭曉答案與解析</button><button class="btn" id="practice-new">再出一題</button></div><div id="practice-solution" hidden></div></dialog>
  <p class="study-notice" id="study-notice" role="status" hidden></p>`;
  document.body.append(host);
  const $ = id => document.getElementById(id);
  let noticeTimer;
  const notice = text => {
    clearTimeout(noticeTimer); $('study-notice').textContent = text; $('study-notice').hidden = !text;
    if (text) noticeTimer = setTimeout(() => { $('study-notice').hidden = true; }, 6000);
  };
  let hintSession = null, practiceSession = null;
  const requests = new Map();
  for (const d of host.querySelectorAll('dialog')) {
    d.addEventListener('cancel', () => requests.get(d.id)?.abort());
    d.querySelector('.study-heading').addEventListener('submit', () => requests.get(d.id)?.abort());
    d.addEventListener('close', () => { if (!d.open) requests.get(d.id)?.abort(); });
  }
  const open = id => { bridge.pause(); $(id).showModal(); };

  async function request(task, context, dialog, status, owner) {
    requests.get(dialog)?.abort();
    const ac = new AbortController(); requests.set(dialog, ac);
    const model = bridge.model(), settings = studyProfile(), started = Date.now();
    let outcome = { status: 'cancelled' };
    $(status).textContent = 'Claude 正在準備…';
    try {
      const r = await studyTask({ task, context, model, profile: settings, signal: ac.signal });
      outcome = { status: 'done', usage: r.usage, usedModel: r.model, text: r.text };
      if (ac.signal.aborted || !$(dialog).open) return null;
      $(status).textContent = '';
      return r.value;
    } catch (e) {
      if (e.name !== 'AbortError') {
        outcome = { status: 'error', error: e.message, usage: e.usage, usedModel: e.model };
        if ($(dialog).open && requests.get(dialog) === ac) $(status).textContent = e.message;
      }
      return null;
    } finally {
      if (requests.get(dialog) === ac) requests.delete(dialog);
      logEvent(currentSecrets(), { kind: task === 'check' ? 'check' : task, photoId: owner?.source?.photoId, title: owner?.lesson?.title,
        question: context.studentAnswer, problem: context.problem, model: modelName(bridge.modelId(model)), effort: EFFORT, profile: settings, ms: Date.now() - started, ...outcome });
    }
  }
  const contextOf = owner => ({ kind: owner.lesson.kind, problem: owner.lesson.problem, answer: owner.lesson.answer, steps: owner.lesson.steps.map(s => ({ say: s.say, write: s.write })) });
  async function updateOwner(owner, changes) {
    if (!owner.id) { notice('這份講解尚未存入題庫。'); return; }
    try { await library.update(owner.id, changes); Object.assign(owner, changes); }
    catch (e) { notice(e.message); }
  }

  $('open-library').onclick = () => { open('study-library'); renderLibrary(); };
  let libraryVersion = 0;
  async function renderLibrary() {
    const version = ++libraryVersion;
    try {
      const records = await library.list();
      if (version !== libraryVersion) return;
      const query = $('library-search').value.trim().toLowerCase(), filter = $('library-filter').value;
      const shown = records.filter(r => `${r.lesson.title} ${r.lesson.problem} ${r.lesson.subject}`.toLowerCase().includes(query) && (filter === 'all' || r[filter]));
      $('library-status').textContent = `${shown.length} 份${records.length ? '' : '，拍照學習後會自動儲存。'}`;
      $('library-list').replaceChildren(...shown.map(r => {
        const card = el('article'); card.className = 'library-card';
        card.append(el('h3', r.lesson.title), el('p', `${r.lesson.subject || ''} · ${new Date(r.created).toLocaleString('zh-TW')}${r.favorite ? ' · 已收藏' : ''}${r.review ? ' · 待複習' : ''}`), el('p', r.lesson.problem));
        const actions = el('div'); actions.className = 'study-actions';
        const button = (label, fn) => { const b = el('button', label); b.className = 'btn'; b.onclick = () => Promise.resolve().then(fn).catch(e => { $('library-status').textContent = e.message; }); actions.append(b); };
        button('重播講解', async () => { await bridge.restore(r); $('study-library').close(); notice('已載入題庫講解，重播不使用 API。'); });
        button(r.favorite ? '取消收藏' : '收藏', async () => { await library.update(r.id, { favorite: !r.favorite }); if (bridge.current()?.id === r.id) bridge.current().favorite = !r.favorite; renderLibrary(); });
        button(r.review ? '已複習' : '待複習', async () => { await library.update(r.id, { review: !r.review }); if (bridge.current()?.id === r.id) bridge.current().review = !r.review; renderLibrary(); });
        button('刪除', async () => {
          // 再按一次才能刪除，避免手機誤觸。
          if (!card.dataset.deletePending) { card.dataset.deletePending = 'true'; actions.lastChild.textContent = '確定刪除'; return; }
          await library.remove(r.id); if (bridge.current()?.id === r.id) bridge.current().id = null; renderLibrary();
        });
        card.append(actions); return card;
      }));
    } catch (e) { $('library-status').textContent = e.message; }
  }
  $('library-search').oninput = renderLibrary; $('library-filter').onchange = renderLibrary;
  $('open-tools').onclick = () => {
    const c = bridge.current();
    if (!c?.lesson || bridge.busy()) { notice('先完成一份講解，再使用學習工具。'); return; }
    $('tools-title').textContent = c.lesson.title; $('tools-status').textContent = '';
    $('tool-favorite').textContent = c.favorite ? '取消收藏' : '收藏';
    $('tool-review').textContent = c.review ? '取消標記' : '標記';
    $('tool-favorite').setAttribute('aria-pressed', String(Boolean(c.favorite)));
    $('tool-review').setAttribute('aria-pressed', String(Boolean(c.review)));
    $('problem-correction').value = c.source?.correction || '';
    $('correction-form').hidden = !(c.source?.blob || c.source?.text);
    open('study-tools');
  };
  for (const [id, field] of [['tool-favorite', 'favorite'], ['tool-review', 'review']]) $(id).onclick = async () => {
    const c = bridge.current(); if (!c) return;
    await updateOwner(c, { [field]: !c[field] });
    $(id).textContent = field === 'favorite' ? (c.favorite ? '取消收藏' : '收藏') : (c.review ? '取消標記' : '標記');
    $(id).setAttribute('aria-pressed', String(Boolean(c[field])));
  };
  $('correction-form').onsubmit = e => {
    e.preventDefault(); const c = bridge.current(), correction = $('problem-correction').value.trim();
    if (!c?.source || !correction) return;
    $('study-tools').close(); bridge.solve({ ...c.source, correction });
  };

  async function showHints(owner = bridge.current()) {
    if (!owner?.lesson) return;
    if (!hintSession || hintSession.owner !== owner) hintSession = { owner, checkpoints: null, index: 0, passed: false };
    const s = hintSession;
    if (!$('study-hints').open) open('study-hints');
    renderRich($('hints-problem'), owner.lesson.problem);
    $('hints-retry').hidden = true;
    if (!s.checkpoints) {
      $('hints-question').textContent = ''; $('hints-progress').textContent = ''; $('hints-form').hidden = true;
      $('hints-clue').hidden = true; $('hints-next').disabled = true; $('hints-clue-button').disabled = true;
      const result = await request('hints', contextOf(owner), 'study-hints', 'hints-feedback', owner);
      if (hintSession !== s) return;
      if (!result) { $('hints-retry').hidden = false; return; }
      s.checkpoints = result.checkpoints;
    }
    renderHint();
  }
  function renderHint() {
    const s = hintSession, c = s?.checkpoints?.[s.index]; if (!c) return;
    $('hints-progress').textContent = `第 ${s.index + 1} / ${s.checkpoints.length} 關`;
    renderRich($('hints-question'), c.question); $('hints-clue').hidden = true;
    $('hints-form').hidden = false; $('hints-clue-button').disabled = false;
    $('hints-answer').value = ''; $('hints-feedback').textContent = s.passed ? '這一關已通過，可以繼續。' : '';
    $('hints-next').disabled = !s.passed || s.index === s.checkpoints.length - 1;
    $('hints-check').disabled = false;
  }
  $('tool-hints').onclick = () => { $('study-tools').close(); showHints(); };
  $('hints-retry').onclick = () => showHints();
  $('hints-clue-button').onclick = () => { const c = hintSession?.checkpoints?.[hintSession.index]; if (c) { renderRich($('hints-clue'), c.hint); $('hints-clue').hidden = false; } };
  $('hints-form').onsubmit = async e => {
    e.preventDefault(); const s = hintSession, c = s?.checkpoints?.[s.index], answer = $('hints-answer').value.trim();
    if (!c || !answer || requests.has('study-hints')) return;
    $('hints-check').disabled = true;
    const result = await request('check', { problem: s.owner.lesson.problem, question: c.question, expected: c.expected, studentAnswer: answer }, 'study-hints', 'hints-feedback', s.owner);
    $('hints-check').disabled = false;
    if (!result || hintSession !== s) return;
    $('hints-feedback').textContent = result.feedback;
    s.passed = result.correct; $('hints-next').disabled = !s.passed || s.index === s.checkpoints.length - 1;
    if (result.correct && s.index === s.checkpoints.length - 1) $('hints-feedback').textContent += ' 全部通過！可以看完整講解核對。';
    if (!result.correct) await updateOwner(s.owner, { review: true });
  };
  $('hints-next').onclick = () => { const s = hintSession; if (s?.passed && s.index < s.checkpoints.length - 1) { s.index++; s.passed = false; renderHint(); } };
  $('hints-reveal').onclick = async () => { const owner = hintSession?.owner; if (owner) { $('study-hints').close(); await bridge.reveal(owner); } };

  async function showPractice(fresh = false) {
    const owner = bridge.current(); if (!owner?.lesson) return;
    if (!$('study-practice').open) open('study-practice');
    if (!practiceSession || practiceSession.owner !== owner || fresh) practiceSession = { owner, value: !fresh ? owner.practice : null };
    const s = practiceSession;
    $('practice-hint').hidden = $('practice-solution').hidden = true;
    $('practice-answer').value = ''; $('practice-feedback').textContent = '';
    if (!s.value) {
      $('practice-problem').textContent = '正在設計同類題…'; $('practice-form').hidden = true;
      for (const id of ['practice-clue', 'practice-reveal', 'practice-new']) $(id).disabled = true;
      const result = await request('practice', contextOf(owner), 'study-practice', 'practice-feedback', owner);
      for (const id of ['practice-clue', 'practice-reveal', 'practice-new']) $(id).disabled = false;
      if (practiceSession !== s) return;
      if (!result) return;
      s.value = result; await updateOwner(owner, { practice: result, practiceAttempt: null });
    }
    renderRich($('practice-problem'), s.value.problem); $('practice-form').hidden = false;
    if (!fresh && owner.practiceAttempt) {
      $('practice-answer').value = owner.practiceAttempt.answer;
      $('practice-feedback').textContent = `上次作答：${owner.practiceAttempt.feedback}`;
      if (owner.practiceAttempt.correct) revealPractice();
    }
  }
  function revealPractice() {
    const v = practiceSession?.value; if (!v) return;
    renderRich($('practice-solution'), `答案：${v.answer}\n${v.explanation}`); $('practice-solution').hidden = false;
  }
  $('tool-practice').onclick = () => { $('study-tools').close(); showPractice(); };
  $('practice-new').onclick = () => showPractice(true);
  $('practice-clue').onclick = () => { const v = practiceSession?.value; if (v) { renderRich($('practice-hint'), v.hint); $('practice-hint').hidden = false; } };
  $('practice-reveal').onclick = revealPractice;
  $('practice-form').onsubmit = async e => {
    e.preventDefault(); const s = practiceSession, answer = $('practice-answer').value.trim();
    if (!s?.value || !answer || requests.has('study-practice')) return;
    $('practice-check').disabled = true;
    const result = await request('check', { problem: s.value.problem, expected: s.value.answer, explanation: s.value.explanation, studentAnswer: answer }, 'study-practice', 'practice-feedback', s.owner);
    $('practice-check').disabled = false;
    if (!result || practiceSession !== s) return;
    $('practice-feedback').textContent = result.feedback;
    if (result.correct) revealPractice();
    await updateOwner(s.owner, { practiceAttempt: { answer, ...result, time: new Date().toISOString() }, review: result.correct ? Boolean(s.owner.review) : true });
  };
  return { showHints, notice, restore: bridge.restore };
}
