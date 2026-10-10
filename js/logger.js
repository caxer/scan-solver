// 使用紀錄：每次登入、列題、解題，把手機型號、送出的照片與 Claude 的回覆
// 本機保存到 local/logs；雲端用管理員公鑰加密寫進私人 repo。紀錄失敗不影響解題。
import { sealForAdmin } from './logbox.js';
import { blobToBase64, isLocalSession, currentSecrets } from './ai.js';
import { logOutbox } from './log-outbox.js';

const DEVICE_KEY = 'scan-solver.device';
const ZONE = 'Asia/Taipei';

const deviceId = (() => {
  try { const saved = localStorage.getItem(DEVICE_KEY); if (/^[a-f0-9]{16}$/.test(saved || '')) return saved; } catch { /* 沒有儲存空間 */ }
  const id = [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, '0')).join('');
  try { localStorage.setItem(DEVICE_KEY, id); } catch { /* 沒有儲存空間 */ }
  return id;
})();

// 從 UA 猜一個看得懂的名稱；Android Chrome 另外問得到確切型號（iPhone 不提供型號）
function describe(ua, model) {
  const ios = /\b(iPhone|iPad|iPod)\b.*?OS (\d+)[_.](\d+)/.exec(ua);
  if (ios) return `${ios[1]}（iOS ${ios[2]}.${ios[3]}）`;
  const android = /Android (\d+(?:\.\d+)?)(?:;\s*([^;)]+))?/.exec(ua);
  if (android) return `${model || (android[2] && android[2] !== 'K' ? android[2].trim() : 'Android 手機')}（Android ${android[1]}）`;
  if (/Macintosh/.test(ua)) return navigator.maxTouchPoints > 1 ? 'iPad（桌面模式）' : 'Mac';
  if (/Windows/.test(ua)) return 'Windows 電腦';
  return '其他裝置';
}

let device = null;
function basicDevice() {
  return {
    id: deviceId, label: describe(navigator.userAgent), model: '', platform: navigator.userAgentData?.platform || navigator.platform || '',
    platformVersion: '', ua: navigator.userAgent, screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
    language: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
async function deviceInfo() {
  if (device) return device;
  const ua = navigator.userAgent;
  let extra = {};
  try { extra = await navigator.userAgentData?.getHighEntropyValues(['model', 'platformVersion']) || {}; } catch { /* 不支援 */ }
  return (device = {
    id: deviceId, label: describe(ua, extra.model), model: extra.model || '', platform: navigator.userAgentData?.platform || navigator.platform || '',
    platformVersion: extra.platformVersion || '', ua, screen: `${screen.width}×${screen.height} @${devicePixelRatio}x`,
    language: navigator.language, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

const parts = date => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  .formatToParts(date).map(x => [x.type, x.value]));
const utf8b64 = text => {
  const bytes = new TextEncoder().encode(text);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

let queue = Promise.resolve();
const staged = new Set(), sending = new Map(), active = new Set();

// 切頁只等待 IndexedDB 寫入，不等待網路。
export async function flushLogWrites() { await Promise.all([...staged]); }

async function materialize(item) {
  const record = { ...item.record };
  if (item.photo) record.photo = { type: item.photo.type || 'image/jpeg', data: await blobToBase64(item.photo) };
  return record;
}
async function saveLocal(item) {
  if (!item.local) return true;
  const key = `local:${item.id}`;
  if (sending.has(key)) return sending.get(key);
  const run = (async () => {
    try {
      const record = await materialize(item);
      const res = await fetch('api/local-logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(record), signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`本機紀錄寫入失敗（${res.status}）`);
      await logOutbox.patch(item.id, { local: false }); item.local = false;
      return true;
    } catch (e) { console.warn('本機紀錄稍後重試', e); return false; }
  })();
  sending.set(key, run);
  try { return await run; } finally { sending.delete(key); }
}
async function saveRemote(item, secrets) {
  if (!item.remote) return true;
  if (!secrets?.github?.token || secrets.github.repo !== item.repo) return false;
  const key = `remote:${item.id}`;
  if (sending.has(key)) return sending.get(key);
  const send = async () => {
    try {
      // 多個分頁同時補送時，沿用已保存的密文與完成狀態。
      const current = await logOutbox.get(item.id);
      if (!current?.remote) { item.remote = false; return true; }
      Object.assign(item, current);
      const sealed = item.sealed || await sealForAdmin(item.publicKey, await materialize(item));
      if (!item.sealed) { await logOutbox.patch(item.id, { sealed }); item.sealed = sealed; }
      const url = `https://api.github.com/repos/${item.repo}/contents/${item.path}`;
      const headers = { authorization: `Bearer ${secrets.github.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' };
      const body = JSON.stringify({ message: `log ${item.record.kind} ${deviceId}`, content: utf8b64(JSON.stringify(sealed)) });
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const res = await fetch(url, { method: 'PUT', body, headers, signal: AbortSignal.timeout(15000) });
          let saved = res.ok;
          // 前次已寫入但回覆遺失：同一路徑與相同密文視為成功。
          if (!saved && [409, 422].includes(res.status)) {
            const previous = await fetch(url, { headers: { ...headers, accept: 'application/vnd.github.raw+json' }, signal: AbortSignal.timeout(15000) });
            saved = previous.ok && JSON.stringify(await previous.json()) === JSON.stringify(sealed);
          }
          if (saved) { await logOutbox.patch(item.id, { remote: false }); item.remote = false; return true; }
          if (![409, 422].includes(res.status)) break;
        } catch (e) { if (attempt === 3) console.warn('雲端紀錄稍後重試', e); }
        if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt + Math.random() * 400));
      }
    } catch (e) { console.warn('雲端紀錄稍後重試', e); }
    return false;
  };
  const task = () => navigator.locks ? navigator.locks.request(`scan-solver.log:${item.id}`, send) : send();
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  sending.set(key, run);
  try { return await run; } finally { sending.delete(key); }
}

// 到下一頁或恢復連線後補送；本機寫入不被雲端佇列阻塞。
export async function resumeLogEvents({ local = isLocalSession(), secrets = currentSecrets(), waitForRemote = false } = {}) {
  try {
    await flushLogWrites();
    const pending = (await logOutbox.list()).filter(item => !active.has(item.id)).sort((a, b) => a.record.time.localeCompare(b.record.time));
    const remote = [];
    for (const item of pending) {
      if (item.local && local) await saveLocal(item);
      remote.push(saveRemote(item, secrets));
    }
    if (waitForRemote) await Promise.all(remote);
  } catch (e) { console.warn('待送紀錄恢復失敗', e); }
}
addEventListener('online', () => { void resumeLogEvents(); });

// entry：{ kind, location?（Promise 或值）, photo?（Blob）, ...其他欄位 }
export function logEvent(secrets, entry) {
  const local = isLocalSession(), remote = Boolean(secrets?.github?.token && secrets?.adminPublicKey);
  if (!local && !remote) return Promise.resolve(false);
  const now = new Date(), id = entry.eventId || crypto.randomUUID(), t = parts(now);
  const { photo, location, ...rest } = entry;
  const item = { id, local, remote, repo: secrets?.github?.repo, publicKey: secrets?.adminPublicKey, photo,
    path: `logs/${t.year}-${t.month}-${t.day}/${t.hour}${t.minute}${t.second}-${entry.kind}-${id.replaceAll('-', '').slice(0, 8)}.json`,
    record: { time: now.toISOString(), ...rest, eventId: id, device: device || basicDevice(), location: null } };
  const ready = logOutbox.put(item);
  active.add(id);
  staged.add(ready);
  ready.then(() => staged.delete(ready), () => staged.delete(ready));
  return (async () => {
    try {
      await ready;
      item.record.device = await deviceInfo();
      item.record.location = await location ?? null;
      await logOutbox.patch(id, { record: item.record });
      const pending = await logOutbox.get(id);
      if (!pending) return true;
      if (local) await saveLocal(pending);
      await saveRemote(pending, secrets);
      return (local && !pending.local) || (remote && !pending.remote);
    } catch (e) { console.warn('紀錄保存失敗', e); return false; }
    finally { active.delete(id); }
  })();
}
