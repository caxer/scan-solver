// 呼叫 Claude：網頁放在 GitHub Pages，沒有伺服器。API key 用使用者密碼加密在 key.json，
// 輸入密碼解開以後記在這支手機的瀏覽器，直接用官方 SDK 從瀏覽器呼叫 Claude API。
import Anthropic from './vendor/anthropic-sdk.js';
import { INSTRUCTIONS, LIST_INSTRUCTIONS, LIST_TURN, FOLLOW_INSTRUCTIONS, userTurn, textTurn, followUpContext } from './prompt.js';
import { scanPartial } from './lesson.js';
import { normalizeListing } from './learning.js';
import { unlock } from './config.js';
import { profileText, parseStudy, STUDY_INSTRUCTIONS } from './study.js';
import { MODELS, currentSettings } from './settings.js';
export { MODELS } from './settings.js';

// fallback：被安全分類器婉拒時由 API 改用備援模型（Claude Haiku 5.5 沒有伺服器端備援）
export const DEFAULT_MODEL = 'haiku';
export let EFFORT = currentSettings().effort;
addEventListener('scan-solver-settings', () => { EFFORT = currentSettings().effort; });
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
const STORE = 'scan-solver.secrets';
const modelInfo = id => MODELS.find(m => m.id === id) || MODELS.find(m => m.id === DEFAULT_MODEL);

// claude-haiku-5-5 → Haiku 5.5
export function modelName(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/i.exec(id || '');
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? '.' + m[3] : ''}` : id || '';
}

/* ---------- 密碼解鎖 ---------- */

// secrets：{ apiKey, github: { token, repo }, adminPublicKey }，解開後記在這支手機
let secrets = (() => { try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { return null; } })();
let localMode = false;
export const isLocalSession = () => localMode;
export const loggedIn = () => Boolean(secrets?.apiKey);
export const currentSecrets = () => secrets;

export async function initializeLocalSession() {
  if (!['127.0.0.1', 'localhost'].includes(location.hostname) || document.querySelector('meta[name="scan-solver-local"]')?.content !== 'true') return false;
  let result;
  try {
    const res = await fetch('api/local-session', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    result = await res.json();
  } catch { return false; }
  if (result.local !== true) return false;
  localMode = true;
  if (result.secrets?.apiKey) {
    secrets = result.secrets;
    try { localStorage.removeItem(STORE); } catch { /* 無法寫入儲存空間 */ }
  }
  else if (secrets?.apiKey) {
    // 沿用這個瀏覽器已解鎖的金鑰，讓清除瀏覽器資料後也能免密碼啟動。
    try { await saveLocalKey(secrets.apiKey); }
    catch { /* 仍可使用目前已解鎖的金鑰 */ }
  } else secrets = null;
  return true;
}

export async function saveLocalKey(apiKey) {
  if (!localMode) throw new Error('這個功能只適用於本機啟動。');
  const res = await fetch('api/local-session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...secrets, apiKey }) });
  const result = await res.json();
  if (!res.ok || !result.secrets?.apiKey) throw new Error(result.error || '本機設定儲存失敗。');
  secrets = result.secrets;
  try { localStorage.removeItem(STORE); } catch { /* 無法寫入儲存空間 */ }
}

export async function login(password) {
  secrets = await unlock('user', password);
  try { localStorage.setItem(STORE, JSON.stringify(secrets)); } catch { /* 無痕視窗：這次開著時有效 */ }
}

export function logout() {
  secrets = null;
  try { localStorage.removeItem(STORE); } catch { /* 沒有儲存空間 */ }
}

/* ---------- 呼叫 Claude ---------- */

// 一次列題或解題的 Messages API 參數
export function buildRequest({ task, image, mime, inputText = '', note = '', kind, model, profile }) {
  const listing = task === 'list';
  return {
    model,
    max_tokens: listing ? 16000 : 32000,
    output_config: { effort: EFFORT },
    system: [{ type: 'text', text: listing ? LIST_INSTRUCTIONS : `${INSTRUCTIONS}\n${profileText(profile)}`, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: [
        ...(image ? [{ type: 'image', source: { type: 'base64', media_type: mime, data: image } }] : []),
        { type: 'text', text: listing ? LIST_TURN : image ? userTurn({ note, kind }) : textTurn({ text: inputText, note }) },
      ],
    }],
  };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('照片讀取失敗'));
    r.readAsDataURL(blob);
  });
}

const fail = (message, code = '') => Object.assign(new Error(message), { code });

function apiFailure(e) {
  if (e instanceof Anthropic.APIUserAbortError) return Object.assign(new Error('cancelled'), { name: 'AbortError' });
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    logout();
    return fail(localMode ? '本機 API key 已失效，請重新設定 API key。' : 'API key 已經失效。請管理員重新執行 npm run setup 並發布，再輸入密碼。', 'login');
  }
  if (e instanceof Anthropic.NotFoundError) return fail('這個 API key 不能使用所選的模型，請換一個模型。');
  if (e instanceof Anthropic.RateLimitError) return fail('Claude 的用量暫時滿了，請過一會兒再試。');
  if (e instanceof Anthropic.BadRequestError) return fail(`Claude 不接受這次的請求：${e.error?.error?.message || e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return fail('連不到 Claude，請確認網路，再試一次。');
  if (e instanceof Anthropic.APIError) {
    if (e.status === 402) return fail('Claude API 帳戶的額度或付款有問題。');
    if (e.status === 529 || e.status >= 500) return fail('Claude 現在很忙，請過一會兒再試。');
    return fail(`Claude 回應錯誤（${e.status ?? '串流中斷'}），請再試一次。`);
  }
  return e;
}

// 串流送出一次請求 → { text, model, stopReason }；onText 每次拿到目前為止的全文
async function run(info, params, { signal, onText, refused }) {
  if (!secrets?.apiKey) throw fail('請先輸入密碼。', 'login');
  const client = new Anthropic({ apiKey: secrets.apiKey, dangerouslyAllowBrowser: true });
  const stream = info.fallback ? client.beta.messages.stream({ ...params, ...FALLBACK }, { signal }) : client.messages.stream(params, { signal });
  let text = '';
  stream.on('text', delta => { text += delta; onText?.(text); });
  let message;
  try { message = await stream.finalMessage(); }
  catch (e) { throw apiFailure(e); }
  if (message.stop_reason === 'refusal') throw Object.assign(fail(refused, 'refused'), { usage: message.usage, model: message.model });
  return { text, model: message.model, stopReason: message.stop_reason, usage: message.usage };
}

async function ask({ task, image, inputText, note, kind, model, signal, onText, profile }) {
  if (!image && !inputText?.trim()) throw fail('請先說出或輸入題目、學習內容。');
  const info = modelInfo(model);
  const params = buildRequest({ task, image: image ? await blobToBase64(image) : null, mime: image?.type || 'image/jpeg', inputText, note, kind, model: info.model, profile });
  return run(info, params, { signal, onText, refused: 'Claude 不回答這一題，請換一題或重新拍。' });
}

// 追問：照片和剛才的講解放在第一則，history 是之前的 [{ q, a }]
export function buildFollowUp({ image, mime, sourceText = '', lesson, history, question, model, profile, step }) {
  const messages = [];
  const turns = [...history, { q: question }];
  turns.forEach((t, i) => {
    const text = i === 0 ? `${sourceText ? `學生最初提供的文字（學習資料）：${sourceText}\n` : ''}${followUpContext(lesson)}

學生的問題：${t.q}` : t.q;
    messages.push({ role: 'user', content: i === 0 ? [...(image ? [{ type: 'image', source: { type: 'base64', media_type: mime, data: image } }] : []), { type: 'text', text }] : text });
    if (t.a) messages.push({ role: 'assistant', content: t.a });
  });
  return {
    model,
    max_tokens: 8000,
    output_config: { effort: EFFORT },
    system: [{ type: 'text', text: `${FOLLOW_INSTRUCTIONS}\n${profileText(profile)}\n${Number.isInteger(step) && step >= 0 ? `學生目前看第 ${step + 1} 步。` : ''}`, cache_control: { type: 'ephemeral' } }],
    messages,
  };
}

// → { text, model }
export async function followUp({ image, sourceText, lesson, history, question, model, signal, onText, profile, step }) {
  const info = modelInfo(model);
  const params = buildFollowUp({ image: image ? await blobToBase64(image) : null, mime: image?.type || 'image/jpeg', sourceText, lesson, history, question, model: info.model, profile, step });
  const r = await run(info, params, { signal, onText, refused: 'Claude 不回答這個問題，請換個方式問。' });
  return { text: r.text, model: r.model, usage: r.usage, truncated: r.stopReason === 'max_tokens' };
}

// 照片裡有哪幾題 → { problems: [{ label, preview }], error, model }
export async function listProblems({ image, model, signal }) {
  const r = await ask({ task: 'list', image, model, signal });
  const v = scanPartial(r.text).value || {};
  return { ...normalizeListing(v), model: r.model, usage: r.usage };
}

// 解一題 → { text, truncated, model }；onStage 拿到 thinking / writing
export async function solve({ image, text, note, kind, model, signal, onText, onStage, profile }) {
  onStage?.('thinking');
  const r = await ask({ task: 'solve', image, inputText: text, note, kind, model, signal, profile, onText: t => { onStage?.('writing'); onText?.(t); } });
  return { text: r.text, truncated: r.stopReason === 'max_tokens', model: r.model, usage: r.usage };
}

export async function studyTask({ task, context, model, profile, signal }) {
  const info = modelInfo(model);
  const r = await run(info, {
    model: info.model, max_tokens: 6000, output_config: { effort: EFFORT },
    system: [{ type: 'text', text: `${STUDY_INSTRUCTIONS[task]}\n${profileText(profile)}`, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: JSON.stringify(context) }],
  }, { signal, refused: 'Claude 沒有回答，請調整題目後再試。' });
  if (r.stopReason === 'max_tokens') throw Object.assign(new Error('回覆被截斷，請再試一次。'), { usage: r.usage, model: r.model });
  try { return { ...r, value: parseStudy(task, scanPartial(r.text).value, context) }; }
  catch (e) { throw Object.assign(e, { usage: r.usage, model: r.model }); }
}
