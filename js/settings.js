import { normalizeProfile } from './study.js';
import { normalizeVoice } from './voice-settings.js';

export const MODELS = [
  { id: 'haiku', model: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: '快速', fallback: false },
  { id: 'sonnet', model: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: '平衡', fallback: true },
  { id: 'opus', model: 'claude-opus-5-5', label: 'Opus 5.5', hint: '最強', fallback: true },
];
export const EFFORTS = ['low', 'medium', 'high'];
export function normalizeSettings(value = {}) {
  return { model: MODELS.some(m => m.id === value?.model) ? value.model : 'haiku',
    effort: EFFORTS.includes(value?.effort) ? value.effort : 'medium', ...normalizeProfile(value), voice: normalizeVoice(value?.voice) };
}
let settings = normalizeSettings();
export const currentSettings = () => ({ ...settings, voice: { ...settings.voice } });
export function applySettings(value) {
  settings = normalizeSettings(value);
  globalThis.dispatchEvent?.(new Event('scan-solver-settings'));
  return currentSettings();
}

const cloudURL = account => `https://api.github.com/repos/${account.repo}/contents/settings.json`;
const cloudHeaders = account => ({ authorization: `Bearer ${account.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
export async function readCloudSettings(account) {
  const res = await fetch(cloudURL(account), { headers: { ...cloudHeaders(account), accept: 'application/vnd.github.raw+json' }, cache: 'no-store', signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`管理員設定讀取失敗（GitHub ${res.status}）。`);
  return normalizeSettings(await res.json());
}
export async function writeCloudSettings(account, value) {
  const previous = await fetch(cloudURL(account), { headers: cloudHeaders(account), cache: 'no-store' });
  if (!previous.ok && previous.status !== 404) throw new Error(`無法讀取設定版本（GitHub ${previous.status}）。`);
  const sha = previous.ok ? (await previous.json()).sha : undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(normalizeSettings(value), null, 2) + '\n');
  const content = btoa(String.fromCharCode(...bytes));
  const res = await fetch(cloudURL(account), { method: 'PUT', headers: { ...cloudHeaders(account), 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'Update teaching settings', content, ...(sha ? { sha } : {}) }) });
  if (!res.ok) throw new Error(`設定同步失敗（GitHub ${res.status}），請再按一次儲存。`);
}
export async function refreshSettings({ local = false, secrets } = {}) {
  try {
    let value;
    if (local) {
      const res = await fetch('api/local-settings', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error('本機設定讀取失敗。');
      value = await res.json();
    } else if (secrets?.github?.token && secrets.github.repo) value = await readCloudSettings(secrets.github);
    if (!value) {
      const res = await fetch('settings.json', { cache: 'no-store' });
      if (res.ok) value = await res.json();
    }
    return applySettings(value || normalizeSettings());
  } catch (e) { console.warn(e.message); return currentSettings(); }
}
