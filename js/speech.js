// 語音旁白：優先台灣國語，允許語音清單晚到，點「聲音」時試念一句，並提供失敗提示。
import { readMs, wait } from './timing.js';
import { normalizeVoice } from './voice-settings.js';

const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
const KEY = 'scan-solver.voice';
const keep = new Set(); // Chrome 會把還沒念完的 utterance 回收掉，留著參考
const finishes = new Map();
let voices = [];
let allVoices = [];
let config = normalizeVoice();
let generation = 0;
let chosen = null;
let issue = '';
let testing = false;
const notify = () => listeners.forEach(fn => fn());

function rank(v) {
  const lang = v.lang.replace('_', '-').toLowerCase();
  let s = lang === 'zh-tw' || lang.includes('hant') ? 100 : lang === 'zh-cn' || lang === 'cmn-cn' ? 50 : lang === 'zh-hk' ? 10 : lang.startsWith('zh') || lang.startsWith('cmn') ? 30 : -1;
  if (s < 0) return s;
  if (/natural|online|neural/i.test(v.name)) s += 20;
  if (/hsiaochen|hsiaoyu|yating|hanhan|zhiwei|國語|臺灣|台灣/i.test(v.name)) s += 5;
  return s;
}

function refresh() {
  try { allVoices = synth?.getVoices() ?? []; voices = allVoices.filter(v => rank(v) >= 0).sort((a, b) => rank(b) - rank(a)); }
  catch { voices = []; allVoices = []; }
  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch { /* 沒有儲存空間 */ }
  chosen = voices.find(v => v.name === (config.chinese || saved)) ?? voices[0] ?? null;
  notify();
}
const listeners = new Set();
if (synth) {
  refresh();
  synth.addEventListener?.('voiceschanged', refresh);
  for (const delay of [300, 1000, 3000]) setTimeout(() => { if (!voices.length) refresh(); }, delay);
  addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

// 短句併成一段念，減少段與段之間的停頓；太長才在逗號處切開（部分瀏覽器念太長會中斷）
function chunks(text) {
  const out = [];
  let pending = '';
  const flush = () => { if (pending) out.push(pending); pending = ''; };
  for (const part of String(text).split(/(?<=[。！？；!?;])/)) {
    let s = part.trim();
    if (!s) continue;
    if (pending && (pending + s).length <= 70) { pending += s; continue; }
    flush();
    while (s.length > 70) {
      const cut = Math.max(s.lastIndexOf('，', 70), s.lastIndexOf(',', 70), 30);
      out.push(s.slice(0, cut + 1));
      s = s.slice(cut + 1).trim();
    }
    pending = s;
  }
  flush();
  return out;
}

// 一段話只用一種聲音念完：中途換聲音會停頓、聽起來很機械。
// 有中文就整段交給中文聲音（中文聲音念夾在句中的英文詞很自然）；只有原文朗讀（純英文等）才用 lang 指定的聲音。
const HAN = /\p{Script=Han}/u;
function voiceLang(text, lang) {
  if (lang && !(/^en(-|$)/i.test(lang) && HAN.test(text))) return lang;
  if (HAN.test(text) || !/[A-Za-zÀ-ž]/.test(text)) return 'zh-TW';
  return config.englishLang;
}

function speechError(code) {
  if (code === 'not-allowed') return '瀏覽器尚未允許朗讀，請點「聲音」關掉再打開，再播放。';
  if (['voice-unavailable', 'language-unavailable'].includes(code)) return '裝置目前無法使用這個語言的聲音，請安裝對應語言的系統朗讀聲音後重試。';
  if (code === 'network') return '語音服務連線失敗，請檢查網路或改選其他聲音。';
  return '語音沒有回應，請點「聲音」關掉再打開，並檢查靜音與藍牙音訊輸出。';
}

function selectVoice(lang) {
  if (/^(zh|cmn)(-|$)/i.test(lang)) return chosen;
  const english = /^en(-|$)/i.test(lang);
  return allVoices.find(v => english && v.name === config.english && /^en[-_]/i.test(v.lang))
    ?? allVoices.find(v => v.lang.replace('_', '-').toLowerCase() === lang.toLowerCase())
    ?? allVoices.find(v => v.lang.split(/[-_]/)[0].toLowerCase() === lang.split('-')[0].toLowerCase()) ?? null;
}

function speakOne(text, rate, ctl, { prime = false, lang = 'zh-TW' } = {}) {
  return new Promise(resolve => {
    const u = new SpeechSynthesisUtterance(text);
    if (/^en(-|$)/i.test(lang)) lang = config.englishLang;
    const voice = selectVoice(lang);
    u.lang = voice?.lang || lang;
    if (voice) u.voice = voice;
    u.rate = Math.max(0.5, Math.min(2, rate * config.rate));
    u.pitch = config.pitch;
    u.volume = prime ? 0 : config.volume;
    let done = false;
    const finish = (error = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ctl?.pending.delete(stop);
      keep.delete(u);
      finishes.delete(u);
      u.onstart = u.onend = u.onerror = null;
      lastEnd = performance.now();
      if (error && !['canceled', 'interrupted'].includes(error)) {
        unlocked = false;
        if (!prime) { issue = speechError(error); notify(); }
      }
      resolve(!error);
    };
    const stop = () => { synth.cancel(); finish(); };
    ctl?.pending.add(stop);
    u.onstart = () => { unlocked = true; if (!prime) { issue = ''; notify(); } };
    u.onend = () => { unlocked = true; finish(); };
    u.onerror = e => finish(e.error || 'audio-unavailable');
    // 有些瀏覽器不會送 end 事件，估一個時間保底
    const timer = setTimeout(() => { synth.cancel(); finish('timeout'); }, (text.length / (3 * u.rate)) * 1000 + 3000);
    keep.add(u);
    finishes.set(u, finish);
    try { synth.resume(); synth.speak(u); }
    catch { finish('audio-unavailable'); }
  });
}

let lastEnd = -1e9;
let unlocked = false;

export const speech = {
  get ok() { return Boolean(synth && typeof SpeechSynthesisUtterance === 'function'); },
  get issue() { return issue; },
  get testing() { return testing; },
  // 正在念、或剛念完不到一秒（喇叭的聲音還可能被麥克風收到）
  get busy() { return Boolean(synth?.speaking || keep.size || performance.now() - lastEnd < 900); },
  get voices() { return voices; },
  get allVoices() { return allVoices; },
  get voice() { return chosen; },
  configure(value) { config = normalizeVoice(value); refresh(); },
  setVoice(name) {
    chosen = name ? voices.find(v => v.name === name) ?? voices[0] ?? null : voices[0] ?? null;
    try { localStorage.setItem(KEY, name || ''); } catch { /* 沒有儲存空間 */ }
    issue = '';
    notify();
  },
  onChange(fn) { listeners.add(fn); },
  async say(text, { rate = 1, ctl, lang = '' } = {}) {
    if (!this.ok || !text) return;
    refresh();
    const ownGeneration = generation;
    const t0 = performance.now();
    const voice = voiceLang(String(text), lang);
    for (const c of chunks(text)) {
      if (ctl?.cancelled || generation !== ownGeneration) return;
      if (!await speakOne(c, rate, ctl, { lang: voice })) break;
    }
    // 瀏覽器沒有真的念出來（例如不允許發聲）時，至少留時間讓人看字幕
    if (ctl?.cancelled || generation !== ownGeneration) return;
    const spent = performance.now() - t0, need = readMs(text) / (rate * config.rate);
    if (spent < need * 0.35) await wait(need - spent, ctl);
  },
  cancel() {
    generation++;
    synth?.cancel();
    for (const finish of [...finishes.values()]) finish('canceled');
  },
  // 必須在使用者點擊處理函式中直接呼叫，不能先 await。
  test(text = '語音測試。可以聽到這句話，就能播放教學旁白。', { lang = 'zh-TW' } = {}) {
    if (!this.ok) return Promise.resolve(false);
    this.cancel();
    refresh();
    issue = '';
    testing = true;
    notify();
    return speakOne(text, 1, null, { lang }).finally(() => { testing = false; notify(); });
  },
  // iPhone 的 Safari 要在點擊的當下念過一次，之後（例如 AI 解完）才能自己念
  unlock() {
    refresh();
    if (!this.ok || unlocked || synth.speaking || keep.size) return;
    speakOne(' ', 1, null, { prime: true });
  },
};
