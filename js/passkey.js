import './faceid-core.js';
// 純前端解鎖：PRF 產生的金鑰只在裝置驗證後取得，磁碟只保存密文。
// 不保存 PRF 輸出，也不以一個「驗證成功」旗標代替資料解密。
const STORE = 'scan-solver.passkey';
const LEGACY_STORE = 'scan-solver.secrets';
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const random = size => crypto.getRandomValues(new Uint8Array(size));
const scope = () => location.origin + location.pathname.replace(/(?:index\.html)?$/, '');
const aad = (value = scope()) => new TextEncoder().encode('scan-solver/passkey/v1/' + value);
// Only the known repository rename may reuse the previous path-bound vault.
const previousScope = () => location.pathname.replace(/(?:index\.html)?$/, '') === '/teacher/'
  ? location.origin + '/scan-solver/' : null;
let pending = null;
export const hasPending = () => pending !== null;

// 有設定就不恢復舊的明文登入，包含格式損壞的設定。
export function hasPasskey() {
  try { return localStorage.getItem(STORE) !== null; } catch { return false; }
}

export const supportsPasskey = () => FaceIDCore.available();
const keyFrom = result => FaceIDCore.keyFrom(result);
const assertion = (id, salt) => FaceIDCore.assertion(decode(id), decode(salt));

export async function enrollPasskey(password) {
  pending = null;
  const salt = random(32);
  const { id, result } = await FaceIDCore.register('隨身小老師', salt);
  const record = { v: 1, scope: scope(), id: encode(id), salt: encode(salt) };
  if (result) return savePassword(record, result, password);
  pending = record;
  return { pending: true };
}

export async function completeRegistration(password) {
  if (!pending) throw new Error('請重新建立通行密鑰。');
  const record = pending;
  return savePassword(record, await assertion(record.id, record.salt), password);
}

async function savePassword(vault, result, password) {
  if (!password) throw new Error('請先使用密碼登入，再啟用 Face ID。');
  const iv = random(12);
  const key = await keyFrom(result);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad() }, key, new TextEncoder().encode(password));
  const record = JSON.stringify({ ...vault, iv: encode(iv), data: encode(data) });
  const previous = localStorage.getItem(STORE);
  try {
    localStorage.setItem(STORE, record);
    if (localStorage.getItem(STORE) !== record) throw new Error('storage');
    localStorage.removeItem(LEGACY_STORE);
    if (localStorage.getItem(LEGACY_STORE) !== null) throw new Error('storage');
  } catch {
    try { if (previous === null) localStorage.removeItem(STORE); else localStorage.setItem(STORE, previous); } catch { /* 已有密文時仍維持鎖定 */ }
    throw new Error('無法保存 Face ID 設定，請允許此網站儲存資料後再試。');
  }
  pending = null;
  return { ready: true };
}

export async function unlockPasskey() {
  let record;
  try {
    record = JSON.parse(localStorage.getItem(STORE));
    if (record?.v !== 1 || typeof record.scope !== 'string' || (record.scope !== scope() && record.scope !== previousScope())) throw new Error('format');
    for (const name of ['id', 'salt', 'iv', 'data']) if (typeof record[name] !== 'string' || !decode(record[name]).length) throw new Error('format');
  } catch { throw new Error('Face ID 設定已遺失或損壞，請使用密碼登入並重新設定。'); }
  const result = await assertion(record.id, record.salt);
  const key = await keyFrom(result);
  try {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(record.iv), additionalData: aad(record.scope) }, key, decode(record.data));
    if (record.scope !== scope()) {
      // Migrate only after real device verification and successful authenticated decryption.
      const iv = random(12);
      const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad() }, key, data);
      try { localStorage.setItem(STORE, JSON.stringify({ ...record, scope: scope(), iv: encode(iv), data: encode(encrypted) })); }
      catch { /* The old vault still works on the renamed site; never write plaintext. */ }
    }
    return new TextDecoder().decode(data);
  } catch { throw new Error('無法解開 Face ID 登入資料，請使用密碼登入並重新設定。'); }
}

export function forgetPasskey() {
  try {
    localStorage.removeItem(STORE);
    if (localStorage.getItem(STORE) !== null) throw new Error('storage');
    pending = null;
  } catch { throw new Error('無法移除 Face ID 設定，請允許此網站儲存資料後再試。'); }
}

export const passkeyError = error => FaceIDCore.errorMessage(error);
