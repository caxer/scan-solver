// 純前端解鎖：PRF 產生的金鑰只在裝置驗證後取得，磁碟只保存密文。
// 不保存 PRF 輸出，也不以一個「驗證成功」旗標代替資料解密。
const STORE = 'scan-solver.passkey';
const LEGACY_STORE = 'scan-solver.secrets';
const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const decode = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const random = size => crypto.getRandomValues(new Uint8Array(size));
const scope = () => location.origin + location.pathname.replace(/(?:index\.html)?$/, '');
const aad = () => new TextEncoder().encode('scan-solver/passkey/v1/' + scope());

// 有設定就不恢復舊的明文登入，包含格式損壞的設定。
export function hasPasskey() {
  try { return localStorage.getItem(STORE) !== null; } catch { return false; }
}

export async function supportsPasskey() {
  if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential || !navigator.credentials?.create || !navigator.credentials?.get) return false;
  try { return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}

function requirePRF(credential) {
  const result = credential?.getClientExtensionResults()?.prf?.results?.first;
  if (!result || result.byteLength !== 32) throw new Error('這個裝置或瀏覽器尚不支援安全的 Face ID 解鎖，請使用密碼登入。');
  return result;
}

const keyFrom = result => crypto.subtle.importKey('raw', result, 'AES-GCM', false, ['encrypt', 'decrypt']);

async function assertion(id, salt) {
  const credential = await navigator.credentials.get({ publicKey: {
    challenge: random(32), timeout: 60000, userVerification: 'required',
    allowCredentials: [{ type: 'public-key', id: decode(id), transports: ['internal'] }],
    extensions: { prf: { eval: { first: decode(salt) } } },
  } });
  if (!credential || encode(credential.rawId) !== id) throw new Error('找不到原本的通行密鑰，請使用密碼登入並重新設定 Face ID。');
  return requirePRF(credential);
}

export async function enrollPasskey(password) {
  const salt = random(32), iv = random(12);
  // 在點擊處直接開始系統提示，不先等待網路或 capability 檢查。
  const credential = await navigator.credentials.create({ publicKey: {
    rp: { name: '隨身小老師' },
    user: { id: random(32), name: '隨身小老師', displayName: '隨身小老師登入' },
    challenge: random(32), timeout: 60000,
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'required', userVerification: 'required' },
    attestation: 'none', extensions: { prf: { eval: { first: salt } } },
  } });
  if (!credential) throw new Error('未完成 Face ID 設定，仍可使用密碼登入。');
  const extensions = credential.getClientExtensionResults()?.prf;
  if (!extensions?.enabled && !extensions?.results?.first) requirePRF(credential);
  const id = encode(credential.rawId);
  // 部分裝置只會在 assertion 階段提供 PRF 輸出。
  const result = extensions?.results?.first ? requirePRF(credential) : await assertion(id, encode(salt));
  const key = await keyFrom(result);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad() }, key, new TextEncoder().encode(password));
  const record = JSON.stringify({ v: 1, scope: scope(), id, salt: encode(salt), iv: encode(iv), data: encode(data) });
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
}

export async function unlockPasskey() {
  let record;
  try {
    record = JSON.parse(localStorage.getItem(STORE));
    if (record?.v !== 1 || record.scope !== scope()) throw new Error('format');
    for (const name of ['id', 'salt', 'iv', 'data']) if (typeof record[name] !== 'string' || !decode(record[name]).length) throw new Error('format');
  } catch { throw new Error('Face ID 設定已遺失或損壞，請使用密碼登入並重新設定。'); }
  const result = await assertion(record.id, record.salt);
  const key = await keyFrom(result);
  try {
    const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(record.iv), additionalData: aad() }, key, decode(record.data));
    return new TextDecoder().decode(data);
  } catch { throw new Error('無法解開 Face ID 登入資料，請使用密碼登入並重新設定。'); }
}

export function forgetPasskey() {
  try {
    localStorage.removeItem(STORE);
    if (localStorage.getItem(STORE) !== null) throw new Error('storage');
  } catch { throw new Error('無法移除 Face ID 設定，請允許此網站儲存資料後再試。'); }
}

export function passkeyError(error) {
  if (['NotAllowedError', 'AbortError'].includes(error?.name)) return 'Face ID 驗證已取消或逾時；可重試或使用密碼登入。';
  if (['NotSupportedError', 'SecurityError'].includes(error?.name)) return '此瀏覽器無法使用 Face ID，請用支援通行密鑰的瀏覽器開啟 HTTPS 網站，或使用密碼登入。';
  return error?.message || 'Face ID 登入失敗，請使用密碼登入。';
}
