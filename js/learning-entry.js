import { speech } from './speech.js';
import { studyTask, currentSecrets, modelName, EFFORT } from './ai.js';
import { currentSettings } from './settings.js';
import { logEvent } from './logger.js';
import { library } from './library.js';
import { normalizeLesson } from './lesson.js';
import { quizCount, quizReview } from './quiz.js';
import { renderRich } from './rich.js';

export function initLearningEntry(bridge) {
  const host = document.createElement('div');
  host.innerHTML = `
  <dialog class="study-dialog" id="learning-entry">
    <form method="dialog" class="study-heading"><h2>說題目或學習範圍</h2><button class="btn">關閉</button></form>
    <p>直接說出題目，或指定想學、想測驗的範圍。辨識後可以修改文字，再開始。</p>
    <form id="learning-entry-form">
      <div class="entry-settings"><label>我要<select id="entry-mode"><option value="lesson">老師講解</option><option value="quiz">範圍測驗</option></select></label><label id="entry-count-field" hidden>題數<select id="entry-count"></select></label><label>語音輸入語言<select id="entry-language"><option value="zh-TW">中文</option><option value="en-US">英文</option></select></label></div>
      <label for="entry-text">題目、主題或學習範圍<textarea id="entry-text" maxlength="5000" rows="4" placeholder="例如：雞兔共 10 隻，腳共 28 隻，兔子有幾隻？\n或：考我國中常用英文單字。" required></textarea></label>
      <div class="entry-examples"><button class="mini" type="button" data-entry="教我一元一次方程式" data-mode="lesson">學習主題</button><button class="mini" type="button" data-entry="考我國中常用英文單字" data-mode="quiz">國中單字測驗</button><button class="mini" type="button" data-entry="測驗國中自然的光合作用觀念" data-mode="quiz">自然觀念測驗</button></div>
      <p class="entry-note">若要完全依照課本測驗，可貼上指定的單字表或教材內容。</p>
      <p id="entry-status" role="status"></p>
      <div class="study-actions"><button class="btn" type="button" id="entry-mic" aria-pressed="false"><svg class="ic" aria-hidden="true"><use href="#i-mic"/></svg><span>開始說話</span></button><button class="btn primary" id="entry-submit" type="submit">開始講解</button><button class="btn" id="entry-resume" type="button" hidden>繼續上次測驗</button></div>
    </form>
  </dialog>
  <dialog class="study-dialog" id="scope-quiz">
    <form method="dialog" class="study-heading"><h2 id="quiz-title">範圍測驗</h2><button class="btn">關閉</button></form>
    <p id="quiz-scope"></p><p id="quiz-progress" aria-live="polite"></p>
    <section id="quiz-question-panel" hidden>
      <div class="quiz-question" id="quiz-question"></div>
      <div class="study-actions"><button class="btn" id="quiz-read" type="button">朗讀題目</button><button class="btn" id="quiz-clue" type="button">給我提示</button></div><div id="quiz-hint" hidden></div>
      <form id="quiz-answer-form"><label for="quiz-answer">你的答案<textarea id="quiz-answer" maxlength="1500" rows="2" required></textarea></label><label>作答語言<select id="quiz-language"><option value="zh-TW">中文</option><option value="en-US">英文</option></select></label><div class="study-actions"><button class="btn" id="quiz-mic" type="button" aria-pressed="false">語音作答</button><button class="btn primary" id="quiz-check" type="submit">提交答案</button></div></form>
      <p id="quiz-feedback" role="status"></p><div class="quiz-explanation" id="quiz-explanation" hidden></div>
      <div class="study-actions"><button class="btn primary" id="quiz-next" type="button" hidden>下一題</button></div>
    </section>
    <section id="quiz-summary" hidden><p id="quiz-score"></p><ol id="quiz-results"></ol><div class="study-actions"><button class="btn primary" id="quiz-review" type="button">看複習講解</button><button class="btn" id="quiz-save-retry" type="button" hidden>重新儲存結果</button><button class="btn" id="quiz-again" type="button">再測一次</button></div></section>
    <p id="quiz-status" role="status"></p><button class="btn" id="quiz-retry" type="button" hidden>重新出題</button>
  </dialog>`;
  document.body.append(host);
  const $ = id => document.getElementById(id);
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const requests = new Map();
  let recognition = null, modeTouched = false, session = null;
  const busy = id => requests.has(id);
  $('entry-count').replaceChildren(...Array.from({ length: 10 }, (_, i) => new Option(`${i + 1} 題`, i + 1)));
  $('entry-count').value = '5';

  function modeUI() {
    const quiz = $('entry-mode').value === 'quiz';
    $('entry-count-field').hidden = !quiz;
    $('entry-submit').textContent = quiz ? '開始測驗' : '開始講解';
  }
  function suggestMode() {
    if (!modeTouched) $('entry-mode').value = /考我|測驗|出題|練習|quiz|test me/i.test($('entry-text').value) ? 'quiz' : 'lesson';
    const count = /(?:出|考|測驗)?\s*(10|[1-9])\s*題/.exec($('entry-text').value)?.[1];
    if (count) $('entry-count').value = count;
    modeUI();
  }
  $('entry-mode').onchange = () => { modeTouched = true; modeUI(); };
  $('entry-text').oninput = suggestMode;

  function micUI(button, active) {
    $(button).setAttribute('aria-pressed', String(active));
    if (button === 'entry-mic') $(button).querySelector('span').textContent = active ? '停止收音' : '開始說話';
    else $(button).textContent = active ? '停止收音' : '語音作答';
  }
  // 每次收音都完整釋放原生辨識器；iPhone 在朗讀／下一次辨識交替時不能留下舊音訊工作階段。
  let lastRelease = -Infinity;
  function dispose(mine) {
    clearTimeout(mine.timer);
    lastRelease = performance.now();
    const r = mine.r;
    r.onresult = r.onerror = r.onend = r.onspeechend = null;
    try { r.abort(); } catch { /* 原生辨識已結束 */ }
  }
  function stopListening() {
    if (!recognition) return;
    const mine = recognition;
    recognition = null;
    dispose(mine);
    $(mine.target).readOnly = false; micUI(mine.button, false);
  }
  function listen({ target, button, status, dialog }) {
    if (!Recognition) { $(status).textContent = '這個瀏覽器不支援語音辨識，可以直接打字，或使用鍵盤的麥克風。'; return; }
    if (recognition?.button === button) { recognition.stop(); return; }
    stopListening();
    const base = $(target).value.trim(), owner = target === 'quiz-answer' ? session : null, index = owner?.index;
    const current = mine => recognition === mine && $(dialog).open && !$(target).disabled &&
      (target !== 'quiz-answer' || (session === owner && session?.index === index));
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const waitForAudio = ios && (speech.busy || performance.now() - lastRelease < 350);
    speech.cancel();
    let heard = '', retried = false;
    function start() {
      const r = new Recognition();
      const mine = { r, target, button, timer: null, stopping: false };
      r.lang = $(target === 'quiz-answer' ? 'quiz-language' : 'entry-language').value;
      r.interimResults = true; r.continuous = ios;
      mine.stop = () => {
        if (!current(mine) || mine.stopping) return;
        mine.stopping = true;
        $(status).textContent = '正在完成辨識…';
        try { r.stop(); } catch { stopListening(); $(status).textContent = '收音已停止，請確認答案或重試。'; }
      };
      r.onspeechend = () => mine.stop();
      r.onresult = e => {
        if (!current(mine)) return;
        // Safari 的結果列表可能不可迭代；移除空的暫時結果也不能抹掉已辨識的答案。
        const text = Array.from(e.results || [], result => result?.[0]?.transcript || result?.item?.(0)?.transcript || '').join('').trim();
        if (!text) return;
        heard = text; armWatchdog();
        $(target).value = [base, heard].filter(Boolean).join(' ').slice(0, Number($(target).maxLength));
        $(target).dispatchEvent(new Event('input', { bubbles: true }));
        $(status).textContent = '已辨識文字，請確認後送出。';
      };
      r.onerror = e => {
        if (!current(mine)) return;
        $(status).textContent = ['not-allowed', 'service-not-allowed'].includes(e.error) ? '麥克風未開放，請允許瀏覽器使用麥克風，或改用打字。'
          : e.error === 'no-speech' ? '沒有聽到聲音，可以再試一次或打字。' : e.error === 'aborted' ? '已停止收音。' : '語音辨識失敗，請重試或改用打字。';
        stopListening();
      };
      r.onend = () => {
        if (!current(mine)) return;
        stopListening();
        $(status).textContent = heard.trim() ? '辨識完成，請確認文字後再送出。' : '沒有辨識到文字，請確認作答語言後重試，或使用鍵盤麥克風。';
      };
      recognition = mine;
      $(target).readOnly = true; micUI(button, true);
      function armWatchdog() {
        clearTimeout(mine.timer);
        mine.timer = setTimeout(() => {
          if (!current(mine)) return;
          if (ios && !heard && !retried && !mine.stopping) {
            retried = true; stopListening(); start();
            $(status).textContent = '辨識沒有回應，已重新收音，請再說一次。';
          } else {
            stopListening();
            $(status).textContent = heard ? '已保留辨識文字，可確認後送出。' : '沒有收到辨識文字，請確認作答語言後重試，或使用鍵盤麥克風。';
          }
        }, 15000);
      }
      const begin = () => {
        if (!current(mine)) return;
        try {
          r.start(); $(status).textContent = '正在聽，請說話…';
          // Safari 可能保持收音卻完全不回事件。僅重啟一次，不讓答案欄永久鎖住。
          armWatchdog();
        } catch { stopListening(); $(status).textContent = '語音辨識無法啟動，請重試或使用鍵盤麥克風。'; }
      };
      if (waitForAudio || retried) { $(status).textContent = '正在切換到麥克風…'; mine.timer = setTimeout(begin, 350); }
      else begin();
    }
    start();
  }
  for (const [button, target, status, dialog] of [['entry-mic', 'entry-text', 'entry-status', 'learning-entry'], ['quiz-mic', 'quiz-answer', 'quiz-status', 'scope-quiz']]) {
    $(button).disabled = !Recognition;
    $(button).onclick = () => listen({ target, button, status, dialog });
  }
  $('quiz-language').addEventListener('change', stopListening);
  $('entry-language').addEventListener('change', stopListening);
  for (const dialog of host.querySelectorAll('dialog')) {
    const close = () => { stopListening(); speech.cancel(); requests.get(dialog.id)?.abort(); };
    dialog.addEventListener('cancel', close);
    dialog.querySelector('.study-heading').addEventListener('submit', close);
    dialog.addEventListener('close', close);
  }

  async function request(task, context, status) {
    const id = 'scope-quiz';
    requests.get(id)?.abort();
    const ac = new AbortController(); requests.set(id, ac);
    const model = bridge.model(), profile = currentSettings(), started = Date.now();
    let outcome = { status: 'cancelled' };
    $(status).textContent = task === 'quiz' ? '老師正在依範圍出題…' : '老師正在檢查答案…';
    try {
      const result = await studyTask({ task, context, model, profile, signal: ac.signal });
      outcome = { status: 'done', usage: result.usage, usedModel: result.model, text: result.text };
      if (ac.signal.aborted || !$(id).open || requests.get(id) !== ac) return null;
      $(status).textContent = '';
      return result;
    } catch (e) {
      if (e.name !== 'AbortError') {
        outcome = { status: 'error', error: e.message, usage: e.usage, usedModel: e.model };
        if ($(id).open && requests.get(id) === ac) $(status).textContent = e.message;
        if (e.code === 'login') { $(id).close(); bridge.login(e.message); }
      }
      return null;
    } finally {
      if (requests.get(id) === ac) requests.delete(id);
      logEvent(currentSecrets(), { kind: task === 'quiz' ? 'practice' : 'check',
        note: '語音／文字範圍測驗', problem: context.scope || context.problem, question: context.studentAnswer,
        model: modelName(bridge.modelId(model)), effort: EFFORT, profile, ms: Date.now() - started, ...outcome });
    }
  }

  function openEntry({ autoListen = true } = {}) {
    if (!bridge.ready()) return;
    bridge.pause(); speech.cancel(); modeTouched = false;
    $('entry-status').textContent = Recognition ? '確認內容後，選擇老師講解或範圍測驗。' : '這個瀏覽器不支援語音辨識，可以打字或使用鍵盤的麥克風。';
    $('entry-resume').hidden = !session;
    modeUI(); $('learning-entry').showModal();
    if (autoListen && Recognition) listen({ target: 'entry-text', button: 'entry-mic', status: 'entry-status', dialog: 'learning-entry' });
  }
  $('voice-entry').onclick = () => openEntry();
  for (const button of host.querySelectorAll('[data-entry]')) button.onclick = () => {
    stopListening(); $('entry-status').textContent = '可以調整範圍或題數，再開始。';
    $('entry-text').value = button.dataset.entry; $('entry-mode').value = button.dataset.mode;
    modeTouched = true; modeUI();
  };
  $('learning-entry-form').onsubmit = e => {
    e.preventDefault();
    const text = $('entry-text').value.trim();
    if (!text || !bridge.ready()) return;
    stopListening();
    const mode = $('entry-mode').value, count = quizCount($('entry-count').value);
    $('learning-entry').close();
    if (mode === 'quiz') startQuiz(text, count);
    else bridge.teach(text);
  };

  async function startQuiz(scope, count) {
    if (!bridge.ready()) return;
    stopListening(); bridge.pause(); speech.cancel();
    if (!$('scope-quiz').open) $('scope-quiz').showModal();
    const s = session = { scope, count, quiz: null, attempts: [], index: 0, record: null, saved: false };
    $('quiz-title').textContent = '範圍測驗'; $('quiz-scope').textContent = `範圍：${scope}`;
    $('quiz-progress').textContent = ''; $('quiz-question-panel').hidden = $('quiz-summary').hidden = true;
    $('quiz-retry').hidden = true;
    const result = await request('quiz', { scope, count }, 'quiz-status');
    if (session !== s) return;
    if (!result) { $('quiz-retry').hidden = false; return; }
    s.quiz = result.value; s.model = result.model;
    renderQuestion();
  }
  function renderQuestion() {
    const s = session, q = s?.quiz?.questions[s.index];
    if (!q) return;
    stopListening(); speech.cancel();
    const attempt = s.attempts[s.index];
    $('quiz-title').textContent = s.quiz.title;
    $('quiz-scope').textContent = `範圍：${s.scope}`;
    $('quiz-progress').textContent = `第 ${s.index + 1} / ${s.quiz.questions.length} 題`;
    $('quiz-question-panel').hidden = false; $('quiz-summary').hidden = true; $('quiz-retry').hidden = true;
    renderRich($('quiz-question'), q.question);
    $('quiz-hint').hidden = true; $('quiz-explanation').hidden = !attempt;
    $('quiz-answer').value = attempt?.answer || ''; $('quiz-answer').disabled = Boolean(attempt);
    $('quiz-language').value = /[a-zA-Z]/.test(q.answer) && !/[\u3400-\u9fff]/.test(q.answer) ? 'en-US' : 'zh-TW';
    $('quiz-check').disabled = Boolean(attempt); $('quiz-mic').disabled = !Recognition || Boolean(attempt);
    $('quiz-read').disabled = !speech.ok;
    $('quiz-next').hidden = !attempt; $('quiz-next').disabled = false;
    $('quiz-next').textContent = s.index === s.quiz.questions.length - 1 ? '看測驗結果' : '下一題';
    $('quiz-feedback').textContent = attempt ? `${attempt.correct ? '答對了！' : '這題需要複習。'} ${attempt.feedback}` : '';
    $('quiz-status').textContent = '';
    if (attempt) renderRich($('quiz-explanation'), `參考答案：${q.answer}\n${q.explanation}`);
  }
  $('quiz-answer-form').onsubmit = async e => {
    e.preventDefault();
    const s = session, q = s?.quiz?.questions[s.index], answer = $('quiz-answer').value.trim();
    if (!q || !answer || busy('scope-quiz') || s.attempts[s.index]) return;
    stopListening(); speech.cancel();
    $('quiz-check').disabled = $('quiz-mic').disabled = true;
    const result = await request('check', { problem: q.question, expected: q.answer, explanation: q.explanation, studentAnswer: answer }, 'quiz-feedback');
    if (session !== s) return;
    if (!result) { $('quiz-check').disabled = false; $('quiz-mic').disabled = !Recognition; return; }
    s.attempts[s.index] = { answer, ...result.value };
    renderQuestion();
  };
  $('quiz-clue').onclick = () => {
    const q = session?.quiz?.questions[session.index];
    if (q) { renderRich($('quiz-hint'), q.hint); $('quiz-hint').hidden = false; }
  };
  $('quiz-read').onclick = () => {
    const q = session?.quiz?.questions[session.index];
    if (!q) return;
    stopListening(); speech.cancel();
    speech.say(q.read || q.question, { lang: q.read ? q.lang : '' });
  };
  $('quiz-next').onclick = () => {
    const s = session;
    if (!s?.attempts[s.index] || busy('scope-quiz')) return;
    if (s.index < s.quiz.questions.length - 1) { s.index++; renderQuestion(); }
    else showSummary(s);
  };
  async function saveResult(s) {
    if (s.saved) return true;
    $('quiz-save-retry').hidden = true;
    try { await library.put(s.record); s.saved = true; }
    catch (e) { if (session === s) { $('quiz-status').textContent = e.message; $('quiz-save-retry').hidden = false; } return false; }
    if (session === s) $('quiz-status').textContent = '測驗結果已存入學習庫，可重播複習。';
    return true;
  }
  async function showSummary(s) {
    stopListening(); speech.cancel();
    $('quiz-question-panel').hidden = true; $('quiz-summary').hidden = false; $('quiz-progress').textContent = '測驗完成';
    const correct = s.attempts.filter(a => a.correct).length;
    $('quiz-score').textContent = `${correct} / ${s.quiz.questions.length} 題答對（${Math.round(correct / s.quiz.questions.length * 100)} 分）`;
    $('quiz-results').replaceChildren(...s.quiz.questions.map((q, i) => {
      const li = document.createElement('li'), a = s.attempts[i];
      renderRich(li, `${a.correct ? '✓ 答對' : '待複習'}：${q.question}\n你的答案：${a.answer}\n參考答案：${q.answer}\n${q.explanation}`);
      return li;
    }));
    if (!s.record) {
      const now = new Date().toISOString();
      s.record = { id: crypto.randomUUID(), lesson: normalizeLesson(quizReview(s.quiz, s.scope, s.attempts)),
        source: { text: `測驗範圍：${s.scope}\n測驗題目與解答：${JSON.stringify(s.quiz.questions)}`, note: '測驗複習', kind: 'knowledge' },
        profile: currentSettings(), created: now, updated: now, favorite: false, review: correct < s.quiz.questions.length, turns: [],
        usedModel: s.model, quiz: { scope: s.scope, questions: s.quiz.questions, attempts: s.attempts } };
    }
    await saveResult(s);
  }
  $('quiz-review').onclick = async () => {
    const s = session;
    if (!s?.record) return;
    $('scope-quiz').close();
    await bridge.restore({ ...s.record, id: s.saved ? s.record.id : null });
  };
  $('quiz-save-retry').onclick = () => session?.record && saveResult(session);
  $('quiz-again').onclick = $('quiz-retry').onclick = () => session && startQuiz(session.scope, session.count);
  $('entry-resume').onclick = () => {
    stopListening(); $('learning-entry').close(); $('scope-quiz').showModal();
    if (session?.record) showSummary(session);
    else if (session?.quiz) renderQuestion();
    else if (session) startQuiz(session.scope, session.count);
  };
  return { get listening() { return Boolean(recognition); }, open: openEntry };
}
