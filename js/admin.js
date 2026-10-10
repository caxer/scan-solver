// 管理頁：本機免密碼讀 local/logs；雲端用管理員私鑰解開私人 repo 的紀錄。
// 紀錄內容來自手機和 Claude，一律用 textContent 顯示。
import { unlock } from './config.js';
import { importAdminKey, openAsAdmin } from './logbox.js';
import { summarizeUsage, METHODS } from './study.js';
import { MODELS, normalizeSettings, readCloudSettings, writeCloudSettings } from './settings.js';
import { speech } from './speech.js';
import { normalizeVoice } from './voice-settings.js';
import { library } from './library.js';
import { recordDay, photoKey, combineRecords, uploadedQuestions } from './admin-records.js';
import { lessonFromText, normalizeLesson } from './lesson.js';
import { resumeLogEvents } from './logger.js';
import { initSiteUpdate } from './site-update.js';
import { initPasswordToggle } from './password-toggle.js';

initSiteUpdate();

const $ = id => document.getElementById(id);
const passwordToggle = initPasswordToggle();
const tabs = [...document.querySelectorAll('.admin-tabs [role="tab"]')];
function selectTab(name, focus = false) {
  for (const tab of tabs) {
    const selected = tab.id === 'tab-' + name;
    tab.setAttribute('aria-selected', String(selected)); tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  $('admin-settings').hidden = !['teaching', 'voice'].includes(name);
  $('admin-data-controls').hidden = ['teaching', 'voice', 'wishes'].includes(name);
  if (name === 'wishes' && !wishesLoaded) void loadWishes();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  tab.addEventListener('keydown', event => {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); selectTab(tabs[next].id.slice(4), true); }
  });
}
let wishes = [], wishesLoaded = false, wishesVersion = 0;
selectTab('dashboard');
const SESSION = 'scan-solver.admin';
const KINDS = { login: '登入', list: '列題', solve: '解題', ask: '追問', hints: '提示生成', practice: '同類題生成', check: '作答批改', wish: '許願' };
const STATUS = { done: '完成', error: '失敗', cancelled: '中途停止', pending: '待開發考量' };
const localMode = ['127.0.0.1', 'localhost'].includes(location.hostname) && document.querySelector('meta[name="scan-solver-local"]')?.content === 'true';
const localSource = () => localMode && $('source').value !== 'cloud';
const wantsCloud = () => !localMode || $('source').value !== 'local';
let loadVersion = 0;

let admin = null;     // { github: { token, repo }, key: CryptoKey }
let entries = [];     // 這一天解密後的紀錄
let allEntries = [], loadWarnings = [];
let knownDays = [], historyComplete = false, loadedDay = null;
const chosenCount = () => Number($('load-count').value) || Infinity;

async function github(path, accept = 'application/vnd.github+json', account = admin) {
  const res = await fetch(`https://api.github.com/repos/${account.github.repo}/contents/${path}`, {
    headers: { authorization: `Bearer ${account.github.token}`, accept, 'x-github-api-version': '2022-11-28' }, cache: 'no-store', signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) throw new Error('GitHub token 失效或沒有權限讀紀錄 repo，請重新執行 npm run setup。');
  if (!res.ok) throw new Error(`讀取紀錄失敗（GitHub ${res.status}）`);
  return accept.includes('raw') ? res.text() : res.json();
}

async function start(secrets) {
  admin = { github: secrets.github, key: await importAdminKey(secrets.privateJwk) };
  $('login').hidden = true;
  $('panel').hidden = false;
  $('logout').hidden = localMode;
  await loadSettingsForm();
  await loadDays();
  if ($('tab-wishes').getAttribute('aria-selected') === 'true') await loadWishes();
}

async function loadDays({ limit = chosenCount(), day: requestedDay = null } = {}) {
  const version = ++loadVersion, useLocal = localSource(), account = admin;
  ++libraryVersion;
  const warnings = [];
  showError('');
  historyComplete = false; loadedDay = requestedDay;
  allEntries = []; entries = []; loadWarnings = []; $('entries').replaceChildren(); $('admin-library-list').replaceChildren();
  for (const id of ['library-refresh', 'refresh']) $(id).disabled = true;
  $('load-status').textContent = Number.isFinite(limit) ? `正在載入最新 ${limit} 筆…` : '正在載入紀錄…';
  $('admin-library-status').textContent = '正在讀取題目…';
  $('summary').textContent = '讀取日期…';
  $('usage-stats').replaceChildren();
  try {
    const user = localMode && !account ? (await localApi('api/local-session')).secrets : null;
    await resumeLogEvents({ local: localMode, secrets: account || user, waitForRemote: !localMode });
    const localDays = useLocal ? (await localApi('api/local-logs')).days : [];
    let cloudDays = [];
    if (wantsCloud() && account) {
      try { cloudDays = ((await github('logs', undefined, account)) || []).filter(d => d.type === 'dir').map(d => d.name).sort().reverse(); }
      catch (e) { warnings.push(`雲端尚未載入：${e.message}`); }
    }
    knownDays = [...new Set([...localDays, ...cloudDays])].sort().reverse();
    const days = requestedDay ? knownDays.filter(d => d === requestedDay) : knownDays, loaded = [];
    let hasMore = false;
    let failed = 0;
    for (const day of days) {
      if (version !== loadVersion) return;
      $('admin-library-status').textContent = `正在彙整 ${day} · 已讀取 ${loaded.length} 筆紀錄…`;
      if (localDays.includes(day)) {
        try { const result = await localApi(`api/local-logs?day=${day}${Number.isFinite(limit) ? `&limit=${limit}` : ''}`); hasMore ||= Boolean(result.more); loaded.push(...result.entries.map(e => ({ ...e, recordSource: '本機' }))); failed += result.failed; }
        catch (e) { warnings.push(`${day} 本機讀取失敗：${e.message}`); }
      }
      if (cloudDays.includes(day)) {
        try { const result = await readCloudDay(day, account, version, limit); hasMore ||= result.more; loaded.push(...result.entries); failed += result.failed; }
        catch (e) { warnings.push(`${day} 雲端讀取失敗：${e.message}`); }
      }
      if (Number.isFinite(limit) && combineRecords(loaded).length >= limit) { hasMore ||= day !== days.at(-1); break; }
    }
    if (version !== loadVersion) return;
    const combined = combineRecords(loaded);
    hasMore ||= combined.length > limit;
    allEntries = combined.slice(0, limit);
    historyComplete = !requestedDay && !hasMore;
    libraryLimit = Number.isFinite(limit) ? limit : 30;
    $('load-status').textContent = `已載入 ${allEntries.length} 筆紀錄${requestedDay ? ` · ${requestedDay}` : ''}${hasMore ? ' · 尚有較舊紀錄，可分類、搜尋或選全部後載入。' : ''}`;
    if (failed) warnings.push(`${failed} 筆紀錄無法讀取或解密（可能使用舊的管理員金鑰）。`);
    loadWarnings = warnings;
    await renderLibrary();
    if (version !== loadVersion) return;
    const availableDays = knownDays;
    const keep = $('day').value;
    $('day').replaceChildren(...availableDays.map(d => new Option(d, d)));
    if (!allEntries.length) { entries = []; $('device').replaceChildren(new Option('全部裝置', '')); render(); $('summary').textContent = '還沒有任何紀錄。'; showError(loadWarnings.join(' ')); return; }
    $('day').value = allEntries.some(e => recordDay(e.time) === keep) ? keep : recordDay(allEntries[0].time);
    loadDay();
  } catch (e) { if (version === loadVersion) { showError(e.message); $('summary').textContent = ''; $('load-status').textContent = '載入失敗，請重試。'; $('admin-library-status').textContent = `題目尚未載入：${e.message}`; } }
  finally { if (version === loadVersion) for (const id of ['library-refresh', 'refresh']) $(id).disabled = false; }
}

async function readCloudDay(day, account, version, limit = Infinity) {
    const loaded = []; let failed = 0;
    const files = ((await github(`logs/${day}`, undefined, account)) || []).filter(f => f.type === 'file' && f.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name));
    const queue = files.slice(0, limit);
    await Promise.all(Array.from({ length: 6 }, async () => {
      for (let f; version === loadVersion && (f = queue.shift());) {
        try {
          const entry = await openAsAdmin(account.key, JSON.parse(await github(f.path, 'application/vnd.github.raw+json', account)));
          if (!Number.isFinite(new Date(entry.time).getTime())) throw new Error('紀錄時間不正確');
          loaded.push({ ...entry, file: f.name, recordSource: '雲端' });
        }
        catch { failed++; }
      }
    }));
    return { entries: loaded, failed, more: files.length > limit };
}

function loadDay() {
  entries = allEntries.filter(e => recordDay(e.time) === $('day').value);
  const devices = new Map(entries.map(e => [e.device?.id, e.device?.label || e.device?.id]));
  const keep = $('device').value;
  $('device').replaceChildren(new Option('全部裝置', ''), ...[...devices].map(([id, label]) => new Option(`${label}（${String(id).slice(-4)}）`, id)));
  $('device').value = devices.has(keep) ? keep : '';
  showError(loadWarnings.join(' '));
  render();
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const row = (label, value) => { const p = el('p', 'row'); p.append(el('b', '', label), String(value)); p.style.margin = '0'; return p; };
const clock = iso => new Date(iso).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

function place(loc) {
  const p = el('p', 'row'); p.style.margin = '0';
  p.append(el('b', '', '位置'));
  if (!loc) p.append('沒有資料');
  else if (loc.error) p.append(loc.error);
  else {
    const a = el('a', '', `${loc.lat}, ${loc.lon}`);
    a.href = `https://www.google.com/maps?q=${loc.lat},${loc.lon}`;
    a.target = '_blank'; a.rel = 'noopener';
    p.append(a, ` ±${loc.accuracy} 公尺`);
  }
  return p;
}

function render() {
  const device = $('device').value, kind = $('kind').value;
  const shown = entries.filter(e => (!device || e.device?.id === device) && (!kind || e.kind === kind));
  const photos = new Map(allEntries.filter(e => e.photo).map(e => [photoKey(e), `data:${e.photo.type};base64,${e.photo.data}`]));
  $('summary').textContent = `${shown.length} 筆紀錄 · ${new Set(shown.map(e => e.device?.id)).size} 台裝置`;
  const stats = summarizeUsage(shown);
  const totals = stats.reduce((sum, g) => { for (const k of ['requests', 'ms', 'timed', 'input', 'output']) sum[k] += g[k]; return sum; }, { requests: 0, ms: 0, timed: 0, input: 0, output: 0 });
  const seconds = g => g.timed ? (g.ms / g.timed / 1000).toFixed(1) + ' 秒' : '—';
  const metrics = el('div', 'metric-grid');
  for (const [label, value] of [['模型', stats.length], ['請求', totals.requests], ['平均耗時', seconds(totals)], ['Token', totals.input + totals.output]]) {
    const card = el('div', 'metric'); card.append(el('span', '', label), el('strong', '', String(value))); metrics.append(card);
  }
  const models = el('div', 'model-list');
  for (const g of stats) {
    const detail = el('details', 'model-usage'); detail.dataset.model = g.model;
    const summary = el('summary'); summary.append(el('span', 'model-name', g.model));
    const brief = el('div', 'model-brief');
    for (const text of [g.requests + ' 次請求', seconds(g), (g.input + g.output) + ' token']) brief.append(el('span', '', text));
    summary.append(brief);
    const list = el('dl', 'usage-details');
    for (const [label, value] of [['請求', g.requests], ['失敗率', (g.failed / g.requests * 100).toFixed(1) + '%'], ['中途停止', g.cancelled], ['平均耗時', seconds(g)], ['輸入 token', g.input], ['輸出 token', g.output], ['快取讀／寫', g.cacheRead + ' / ' + g.cacheWrite], ['用量覆蓋', g.measured + ' / ' + g.requests]]) {
      const item = el('div'); item.append(el('dt', '', label), el('dd', '', String(value))); list.append(item);
    }
    detail.append(summary, list); models.append(detail);
  }
  $('usage-stats').replaceChildren(el('h2', '', '用量看板'), metrics, ...(stats.length ? [models] : [el('p', 'muted', '沒有模型請求紀錄。')]), el('p', 'muted compact-note', '依已載入紀錄與目前篩選統計；Token 為輸入＋輸出，不含快取。點模型向下展開詳情。'));
  $('record-count').textContent = '（' + shown.length + ' 筆）';
  $('entries').replaceChildren(...shown.map(e => {
    const photo = photos.get(photoKey(e));
    const card = el('article', `card entry${photo ? '' : ' no-photo'}`);
    if (photo) {
      const img = el('img', 'thumb'); img.src = photo; img.alt = '拍的照片'; img.loading = 'lazy';
      img.addEventListener('click', () => { $('viewer-img').src = photo; $('viewer').hidden = false; });
      card.append(img);
    }
    const body = el('div', 'entry-body');
    const head = el('div', 'head');
    head.append(el('span', 'time', clock(e.time)), el('span', 'chip', KINDS[e.kind] || e.kind));
    if (e.status) head.append(el('span', `chip${e.status === 'done' ? '' : ' bad'}`, STATUS[e.status] || e.status));
    head.append(el('span', 'muted', e.device?.label || '未知裝置'));
    head.append(el('span', 'chip', e.sources.join('＋')));
    body.append(head, place(e.location));
    if (e.model) body.append(row('模型', [`${e.model}${e.usedModel ? ` → ${e.usedModel}` : ''}`, e.effort && `effort ${e.effort}`, e.ms && `${(e.ms / 1000).toFixed(1)} 秒`].filter(Boolean).join(' · ')));
    if (e.usage) body.append(row('Token 用量', `輸入 ${e.usage.input_tokens || 0} · 輸出 ${e.usage.output_tokens || 0} · 快取讀 ${e.usage.cache_read_input_tokens || 0} · 快取寫 ${e.usage.cache_creation_input_tokens || 0}`));
    if (e.profile) body.append(row('學習設定', `${e.profile.grade || '依題目判斷程度'} · ${e.profile.method} · ${e.profile.mode === 'hints' ? '逐步提示' : '直接講解'}`));
    if (e.kind === 'list') body.append(row('找到的題目', e.problems?.length ? e.problems.map(q => q.label).join('、') : '沒有'));
    if (e.note) body.append(row('選的題目', e.note));
    if (e.question) body.append(row(e.kind === 'check' ? '作答' : '追問', e.question));
    if (e.title) body.append(row('題目', e.title));
    if (e.answer) body.append(row('答案', e.answer));
    if (e.error) body.append(Object.assign(row('錯誤', e.error), { className: 'row error' }));
    if (e.text) {
      const d = el('details'); d.append(el('summary', '', e.kind === 'ask' ? 'Claude 的回答' : 'Claude 的回覆原文'), el('pre', '', e.text)); body.append(d);
    }
    const dev = el('details');
    dev.append(el('summary', '', '裝置詳細資料'), el('pre', '', JSON.stringify(e.device, null, 2)));
    body.append(dev);
    card.append(body);
    return card;
  }));
}

function showError(message) { $('load-error').hidden = !message; $('load-error').textContent = message; }

$('login').addEventListener('submit', async e => {
  e.preventDefault();
  $('login-submit').disabled = true;
  $('login-submit').textContent = '解鎖中…';
  try {
    const secrets = await unlock('admin', $('password').value);
    $('password').value = '';
    passwordToggle.hide();
    $('login-error').hidden = true;
    // 本機保存設定；公開站的管理員金鑰只留在當前頁面記憶體。
    if (localMode) await localApi('api/local-admin', secrets);
    await start(secrets);
  } catch (error) {
    $('login-error').hidden = false;
    $('login-error').textContent = error.message;
  } finally { $('login-submit').disabled = false; $('login-submit').textContent = '登入'; }
});
$('logout').addEventListener('click', () => {
  try { sessionStorage.removeItem(SESSION); } catch { /* 沒有儲存空間 */ }
  if (!localMode) lockPublicAdmin();
  location.reload();
});
$('day').addEventListener('change', () => {
  const day = $('day').value;
  if (!historyComplete && day !== loadedDay && !allEntries.some(e => recordDay(e.time) === day)) loadDays({ limit: Infinity, day });
  else loadDay();
});
$('device').addEventListener('change', render);
$('kind').addEventListener('change', render);
$('refresh').addEventListener('click', () => loadDays());
$('viewer').addEventListener('click', () => { $('viewer').hidden = true; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('viewer').hidden = true; });

const saved = localMode ? (() => { try { return JSON.parse(sessionStorage.getItem(SESSION) || 'null'); } catch { return null; } })() : null;
if (!localMode) try { sessionStorage.removeItem(SESSION); } catch { /* 移除舊版保留的管理員金鑰。 */ }
async function localApi(path, value) {
  const res = await fetch(path, { cache: 'no-store', ...(value ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) } : {}) });
  const result = await res.json();
  if (!res.ok) throw new Error(result.error || '本機管理資料讀取失敗。');
  return result;
}
async function selectSource() {
  ++wishesVersion; wishes = []; wishesLoaded = false; $('admin-wish-list').replaceChildren();
  ++loadVersion; entries = []; $('entries').replaceChildren(); $('usage-stats').replaceChildren(); showError('');
  $('connect-cloud').hidden = true;
  if (localSource()) {
    $('login').hidden = true; $('panel').hidden = false; $('logout').hidden = true;
    if ($('source').value === 'all') {
      try {
        let secrets = (await localApi('api/local-admin')).secrets;
        if (!secrets && saved) { await localApi('api/local-admin', saved); secrets = saved; }
        if (secrets) admin = { github: secrets.github, key: await importAdminKey(secrets.privateJwk) };
      } catch (e) { $('local-source-note').textContent = e.message; }
      $('local-source-note').textContent = admin ? '已連接本機與雲端，預設讀取最新 10 筆，可選筆數後載入。' : '目前僅載入本機。雲端紀錄尚未連接，匯入管理員金鑰一次後即可自動載入。';
      $('connect-cloud').hidden = Boolean(admin);
    } else $('local-source-note').textContent = '目前只查看本機紀錄；要看手機上傳題目，請選「全部（本機＋雲端）」。';
    await loadSettingsForm();
    await loadDays();
    if ($('tab-wishes').getAttribute('aria-selected') === 'true') await loadWishes();
    return;
  }
  $('panel').hidden = true;
  try {
    let secrets = (await localApi('api/local-admin')).secrets;
    if (!secrets && saved) { await localApi('api/local-admin', saved); secrets = saved; }
    if (localSource()) return;
    if (secrets) { $('local-source-note').textContent = '已載入本機管理員設定。'; await start(secrets); }
    else {
      $('login').hidden = false;
      $('login').querySelector('label').textContent = '匯入既有雲端紀錄（只需一次管理員密碼）';
      $('local-source-note').textContent = '匯入一次後，這台電腦可自動開啟私人 repo 紀錄。';
    }
  } catch (e) {
    if (localSource()) return;
    $('login').hidden = false; $('login-error').hidden = false; $('login-error').textContent = e.message;
  }
}
$('connect-cloud').onclick = () => { $('source').value = 'cloud'; selectSource(); };

$('settings-model').replaceChildren(...MODELS.map(m => new Option(`${m.label} · ${m.hint}`, m.id)));
$('settings-method').replaceChildren(...METHODS.map(m => new Option(m, m)));
const voiceFields = ['chinese', 'english', 'englishLang', 'rate', 'pitch', 'volume'];
function setVoiceField(key, value) {
  const select = $(`voice-${key}`), text = String(value);
  if (![...select.options].some(o => o.value === text)) select.add(new Option(text, text));
  select.value = text;
}
function refreshVoiceOptions() {
  for (const key of ['chinese', 'english']) {
    const select = $(`voice-${key}`), saved = select.value;
    const voices = speech.allVoices.filter(v => key === 'chinese' ? /^(zh|cmn)([-_]|$)/i.test(v.lang) : /^en([-_]|$)/i.test(v.lang));
    select.replaceChildren(new Option(key === 'chinese' ? '自動選擇台灣國語' : '依口音自動選擇', ''), ...voices.map(v => new Option(`${v.name} (${v.lang})`, v.name)));
    if (saved && !voices.some(v => v.name === saved)) select.add(new Option(`${saved}（本裝置未安裝，將自動替代）`, saved));
    select.value = saved;
  }
  $('voice-status').textContent = !speech.ok ? '此瀏覽器不支援語音朗讀，仍可儲存設定。' : speech.issue;
  $('voice-test-zh').disabled = $('voice-test-en').disabled = !speech.ok;
}
function voiceForm() {
  return normalizeVoice({ ...Object.fromEntries(voiceFields.map(k => [k, $(`voice-${k}`).value])), enabled: $('voice-enabled').value === 'true' });
}
speech.onChange(refreshVoiceOptions);
refreshVoiceOptions();
for (const [id, lang, text] of [['voice-test-zh', 'zh-TW', '你好，我是你的學習老師，一起來認識新知識。'], ['voice-test-en', 'en-US', 'Apple. I eat an apple every day.']]) $(id).onclick = () => {
  speech.configure(voiceForm());
  speech.test(text, { lang });
};
$('voice-stop').onclick = () => speech.cancel();
async function loadSettingsForm() {
  $('settings-save').disabled = true;
  try {
    const value = normalizeSettings(localMode ? await localApi('api/local-settings') : await readCloudSettings(admin.github));
    for (const key of ['model', 'effort', 'method', 'mode']) $(`settings-${key}`).value = value[key];
    for (const key of voiceFields) setVoiceField(key, value.voice[key]);
    $('voice-enabled').value = String(value.voice.enabled);
    refreshVoiceOptions();
    $('settings-status').textContent = '';
  } catch (e) { $('settings-status').textContent = e.message; }
  finally { $('settings-save').disabled = false; }
}
$('admin-settings').addEventListener('submit', async e => {
  e.preventDefault(); $('settings-save').disabled = true;
  let localSaved = false;
  try {
    const value = Object.fromEntries(['model', 'effort', 'method', 'mode'].map(k => [k, $(`settings-${k}`).value]));
    value.voice = voiceForm();
    let account = admin?.github;
    if (localMode) {
      await localApi('api/local-settings', value); localSaved = true;
      account ||= (await localApi('api/local-admin')).secrets?.github;
      account ||= (await localApi('api/local-session')).secrets?.github;
    }
    if (account?.token) {
      await writeCloudSettings(account, value);
      $('settings-status').textContent = localMode ? '已儲存本機設定，並同步到手機使用的私人 repo。' : '已儲存，手機重新整理或回到解題分頁即會套用。';
    } else $('settings-status').textContent = '已儲存本機設定。尚未設定 GitHub，手機公開版不會同步。';
  } catch (e) { $('settings-status').textContent = `${localSaved ? '本機已儲存；雲端尚未同步。' : ''}${e.message}`; }
  finally { $('settings-save').disabled = false; }
});
let libraryVersion = 0;
let libraryLimit = 30;
const uploadDevice = u => u.device?.id || '__unknown__';
const deviceLabel = u => `${u.device?.label || '未知裝置'}${u.device?.id ? `（${String(u.device.id).slice(-4)}）` : ''}`;
function refreshLibraryFilters(uploads) {
  const days = knownDays;
  const devices = new Map();
  for (const u of uploads) if (!devices.has(uploadDevice(u))) devices.set(uploadDevice(u), deviceLabel(u));
  for (const [id, title, values] of [
    ['admin-library-day', '全部日期', days.map(d => [d, d])],
    ['admin-library-device', '全部裝置', [...devices].sort((a, b) => a[1].localeCompare(b[1], 'zh-TW'))],
  ]) {
    const keep = $(id).value;
    $(id).replaceChildren(new Option(title, ''), ...values.map(([value, label]) => new Option(label, value)));
    $(id).value = values.some(([v]) => v === keep) ? keep : '';
  }
  return devices;
}
async function renderLibrary() {
  const version = ++libraryVersion;
  try {
    const records = await library.list();
    if (version !== libraryVersion) return;
    const query = $('admin-library-search').value.trim().toLowerCase(), filter = $('admin-library-filter').value;
    const uploads = uploadedQuestions(allEntries);
    const deviceLabels = refreshLibraryFilters(uploads);
    const uploadLabel = u => deviceLabels.get(uploadDevice(u));
    const day = $('admin-library-day').value, device = $('admin-library-device').value, source = $('admin-library-source').value;
    const replayId = (u, q) => `admin:${u.key}:${q.label}:${q.solution?.time}`;
    const personal = (u, q) => {
      const s = q.solution;
      if (!s) return null;
      const exact = records.find(r => (s.eventId && r.solveEventId === s.eventId) || r.id === replayId(u, q));
      if (exact) return exact;
      // 舊題庫沒有事件識別碼：只沿用同次解題且內容完全相同的紀錄。
      let lesson;
      try { lesson = lessonFromText(s.text || ''); } catch { return null; }
      return lesson && records.find(r => r.source?.photoId === u.photoId && r.source.note === q.label &&
        (r.source.correction || '') === (s.correction || '') && Date.parse(s.time) >= Date.parse(r.created) && Date.parse(s.time) - Date.parse(r.created) < 3000 &&
        JSON.stringify(normalizeLesson(r.lesson)) === JSON.stringify(lesson));
    };
    const shown = uploads.filter(u => {
      if ((day && recordDay(u.time) !== day) || (device && uploadDevice(u) !== device) || (source && !u.sources.includes(source))) return false;
      const matches = `${recordDay(u.time)} ${u.device?.label || ''} ${u.device?.id || ''} ${u.questions.map(q => `${q.label} ${q.preview} ${q.solution?.title || ''} ${q.solution?.problem || ''}`).join(' ')}`.toLowerCase().includes(query);
      const completed = q => q.solution?.status === 'done';
      return matches && (filter === 'all' || (filter === 'solved' && u.questions.some(completed)) || (filter === 'unsolved' && (!u.questions.length || u.questions.some(q => !completed(q)))) ||
        (filter === 'error' && (u.errors.length || u.questions.some(q => q.latestAttempt?.status === 'error'))) ||
        (['favorite', 'review'].includes(filter) && u.questions.some(q => personal(u, q)?.[filter])));
    });
    $('admin-library-status').textContent = `${shown.length} 張上傳 · ${shown.reduce((n, u) => n + u.questions.length, 0)} 題 · ${new Set(shown.map(uploadDevice)).size} 台裝置${uploads.length ? (shown.length ? '' : '，沒有符合篩選的題目。') : '，目前來源尚無上傳紀錄。'}${shown.length > libraryLimit ? `（目前顯示 ${libraryLimit} 張）` : ''}${loadWarnings.length ? '（部分紀錄未能載入，請查看下方錯誤）' : ''}`;
    $('library-more').hidden = shown.length <= libraryLimit;
    const group = $('admin-library-group').value;
    const groupKey = u => group === 'date' ? recordDay(u.time) : group === 'device' ? uploadDevice(u) : '';
    const ordered = group === 'device' ? [...shown].sort((a, b) => uploadLabel(a).localeCompare(uploadLabel(b), 'zh-TW') || uploadDevice(a).localeCompare(uploadDevice(b)) || b.time.localeCompare(a.time)) : shown;
    const counts = new Map();
    for (const u of ordered) { const key = groupKey(u), count = counts.get(key) || { photos: 0, questions: 0 }; count.photos++; count.questions += u.questions.length; counts.set(key, count); }
    let previousGroup;
    $('admin-library-list').replaceChildren(...ordered.slice(0, libraryLimit).flatMap(u => {
      const heading = [], key = groupKey(u);
      if (group !== 'none' && key !== previousGroup) {
        const count = counts.get(key);
        heading.push(el('h3', 'library-group-heading', `${group === 'date' ? key : uploadLabel(u)} · ${count.photos} 張上傳 · ${count.questions} 題`));
        previousGroup = key;
      }
      const card = el('article', 'library-card');
      card.append(el('h3', '', `${recordDay(u.time)} · ${uploadLabel(u)}`), el('p', 'muted', `${u.sources.join('＋')} · ${u.questions.length} 題`));
      const thumb = u.photo ? `data:${u.photo.type};base64,${u.photo.data}` : '';
      if (thumb) {
        const img = el('img', 'thumb'); img.src = thumb; img.alt = '上傳的題目照片'; img.loading = 'lazy';
        img.onclick = () => { $('viewer-img').src = thumb; $('viewer').hidden = false; }; card.append(img);
      }
      for (const error of u.errors) card.append(el('p', 'error', error));
      for (const q of u.questions) {
        const s = q.solution, stored = personal(u, q);
        card.append(el('h4', '', `${q.label}${s?.title && s.title !== q.label ? ` · ${s.title}` : ''}`), el('p', '', s?.problem || q.preview || '請查看上傳照片。'),
          el('p', s?.status === 'error' ? 'error' : 'muted', s ? `${STATUS[s.status] || '已解題'}${s.truncated ? '（回覆未完整）' : ''}${s.error ? `：${s.error}` : ''}` : '尚未解答'));
        if (q.latestAttempt && q.latestAttempt !== s) {
          const a = q.latestAttempt;
          card.append(el('p', a.status === 'error' ? 'error' : 'muted', `最近一次嘗試：${STATUS[a.status] || a.status}${a.truncated ? '（回覆未完整）' : ''}${a.error ? `：${a.error}` : ''}；保留上次成功解答。`));
        }
        if (s?.answer) card.append(row('答案', s.answer));
        if (s?.text) { const d = el('details'); d.append(el('summary', '', '查看解答原文'), el('pre', '', s.text)); card.append(d); }
        let lesson = null;
        if (s?.status === 'done' && !s.truncated) { try { const value = lessonFromText(s.text || ''); if (value?.steps?.length && value.answer) lesson = value; } catch { /* 舊紀錄可能只有答案 */ } }
        if (!lesson && !stored) continue;
        const ensureRecord = async () => {
          const id = replayId(u, q), previous = stored || await library.get(id);
          if (previous) {
            // 修補舊版已匯入、但缺少修正文字的同一份解答。
            if ((previous.source?.correction || '') !== (s.correction || '')) {
              previous.source = { ...previous.source, correction: s.correction || '' };
              await library.update(previous.id, { source: previous.source });
            }
            return previous;
          }
          const blob = u.photo ? new Blob([Uint8Array.from(atob(u.photo.data), c => c.charCodeAt(0))], { type: u.photo.type }) : null;
          const r = { id, lesson, source: { blob, thumb, photoId: u.photoId, note: q.label, kind: lesson.kind, correction: s.correction || '' }, profile: s.profile, created: s.time, updated: s.time, favorite: false, review: false, turns: [], usedModel: s.usedModel, solveEventId: s.eventId };
          await library.put(r); records.push(r); return r;
        };
        const actions = el('div', 'library-actions');
        const replay = el('button', 'btn secondary', '重播講解'); replay.type = 'button';
        replay.onclick = async () => { try { const r = await ensureRecord(); location.href = `index.html?lesson=${encodeURIComponent(r.id)}`; } catch (e) { $('admin-library-status').textContent = e.message; } }; actions.append(replay);
        for (const [field, label] of [['favorite', stored?.favorite ? '取消收藏' : '收藏'], ['review', stored?.review ? '取消標記' : '標記']]) {
          const button = el('button', stored?.[field] ? 'btn selected' : 'btn', label); button.type = 'button'; button.setAttribute('aria-pressed', String(Boolean(stored?.[field])));
          button.onclick = async () => { try { const r = await ensureRecord(); await library.update(r.id, { [field]: !r[field] }); await renderLibrary(); } catch (e) { $('admin-library-status').textContent = e.message; } }; actions.append(button);
        }
        card.append(actions);
      }
      return [...heading, card];
    }));
  } catch (e) { $('admin-library-status').textContent = e.message; }
}
let searchTimer;
async function findHistory() {
  clearTimeout(searchTimer);
  libraryLimit = 30;
  const day = $('admin-library-day').value || null;
  if (!historyComplete && (day !== loadedDay || !day)) await loadDays({ limit: Infinity, day });
  else renderLibrary();
}
$('admin-library-search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(findHistory, 350); });
$('admin-library-filter').addEventListener('change', findHistory);
for (const id of ['admin-library-day', 'admin-library-device', 'admin-library-source']) $(id).addEventListener('change', findHistory);
$('admin-library-group').addEventListener('change', () => { libraryLimit = 30; renderLibrary(); });
$('library-reset').onclick = () => {
  $('admin-library-search').value = '';
  for (const id of ['admin-library-day', 'admin-library-device', 'admin-library-source']) $(id).value = '';
  $('admin-library-filter').value = 'all'; libraryLimit = 30; renderLibrary();
};
$('library-more').onclick = () => { libraryLimit += 30; renderLibrary(); };
$('library-refresh').addEventListener('click', () => loadDays());
function renderWishes() {
  const query = $('wish-search').value.trim().toLowerCase();
  const shown = wishes.filter(e => e.text.toLowerCase().includes(query));
  $('admin-wish-list').replaceChildren(...shown.map(e => {
    const card = el('article', 'library-card');
    card.append(el('span', 'chip', '待開發考量'), el('h3', '', recordDay(e.time) + ' · ' + clock(e.time)),
      el('p', 'muted', (e.device?.label || '未知裝置') + ' · ' + e.sources.join('＋')), el('p', 'wish-text', e.text));
    card.querySelector('.wish-text').style.whiteSpace = 'pre-wrap';
    return card;
  }));
  $('admin-wish-status').textContent = '顯示 ' + shown.length + ' / ' + wishes.length + ' 筆許願' + (shown.length ? '' : '，沒有符合條件的需求。');
}
async function loadWishes() {
  const version = ++wishesVersion, account = admin, limit = Number($('wish-load-count').value) || Infinity;
  const warnings = [], loaded = [];
  $('wish-refresh').disabled = true; $('admin-wish-status').textContent = '正在載入許願…';
  try {
    const user = localMode && !account ? (await localApi('api/local-session')).secrets : null;
    await resumeLogEvents({ local: localMode, secrets: account || user, waitForRemote: !localMode });
    const localDays = localSource() ? (await localApi('api/local-logs')).days : [];
    let cloudDays = [];
    if (wantsCloud() && account) {
      try { cloudDays = ((await github('logs', undefined, account)) || []).filter(d => d.type === 'dir').map(d => d.name); }
      catch (error) { warnings.push('雲端許願尚未載入：' + error.message); }
    }
    for (const day of [...new Set([...localDays, ...cloudDays])].sort().reverse()) {
      if (version !== wishesVersion) return;
      if (localDays.includes(day)) {
        try {
          const result = await localApi('api/local-logs?day=' + day + '&kind=wish' + (Number.isFinite(limit) ? '&limit=' + limit : ''));
          loaded.push(...result.entries.map(e => ({ ...e, recordSource: '本機' })));
          if (result.failed) warnings.push(day + ' 有紀錄無法讀取。');
        } catch (error) { warnings.push(error.message); }
      }
      if (cloudDays.includes(day)) {
        try {
          const files = ((await github('logs/' + day, undefined, account)) || []).filter(f => f.type === 'file' && /-wish-[a-f0-9]+\.json$/i.test(f.name)).sort((a, b) => b.name.localeCompare(a.name)).slice(0, limit);
          const queue = [...files];
          await Promise.all(Array.from({ length: 6 }, async () => {
            for (let f; version === wishesVersion && (f = queue.shift());) {
              try {
                const entry = await openAsAdmin(account.key, JSON.parse(await github(f.path, 'application/vnd.github.raw+json', account)));
                if (entry.kind !== 'wish' || typeof entry.text !== 'string' || !Number.isFinite(Date.parse(entry.time))) throw new Error('許願格式不正確。');
                loaded.push({ ...entry, recordSource: '雲端' });
              } catch { warnings.push('有許願紀錄無法讀取或解密。'); }
            }
          }));
        } catch (error) { warnings.push(error.message); }
      }
      if (combineRecords(loaded).length >= limit) break;
    }
    if (version !== wishesVersion) return;
    wishes = combineRecords(loaded).filter(e => typeof e.text === 'string').slice(0, limit); wishesLoaded = true;
    renderWishes();
    if (warnings.length) $('admin-wish-status').textContent += ' · ' + [...new Set(warnings)].join(' ');
  } catch (error) { if (version === wishesVersion) $('admin-wish-status').textContent = error.message; }
  finally { if (version === wishesVersion) $('wish-refresh').disabled = false; }
}
$('wish-refresh').addEventListener('click', loadWishes);
$('wish-search').addEventListener('input', renderWishes);

function lockPublicAdmin() {
  clearTimeout(searchTimer);
  ++loadVersion; ++libraryVersion; ++wishesVersion;
  wishes = []; wishesLoaded = false; $('admin-wish-list').replaceChildren(); $('admin-wish-status').textContent = '';
  admin = null; entries = []; allEntries = []; loadWarnings = [];
  $('panel').hidden = true; $('login').hidden = false; $('logout').hidden = true;
  $('password').value = ''; $('viewer').hidden = true; $('viewer-img').removeAttribute('src');
  passwordToggle.hide();
  for (const id of ['entries', 'admin-library-list', 'usage-stats']) $(id).replaceChildren();
  speech.cancel();
}
if (!localMode) {
  // 返回快取的管理頁前也必須重新登入，避免顯示已解密的舊畫面。
  addEventListener('pagehide', lockPublicAdmin);
  addEventListener('pageshow', event => { if (event.persisted) { lockPublicAdmin(); location.reload(); } });
}
if (localMode) {
  $('local-source-toolbar').hidden = false;
  $('source').addEventListener('change', selectSource);
  selectSource().catch(e => showError(e.message));
}
