// 密碼鎖：用密碼經 PBKDF2-SHA256（60 萬次）導出 AES-GCM 256 金鑰，把一段文字（API key 等設定）加密。
// 網頁、管理頁和 scripts/setup.mjs 共用；只有知道密碼才解得開。
const ITERATIONS = 600_000;
const AAD = new TextEncoder().encode('scan-solver/locked/v1');
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function lockText(text, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(password, salt, ITERATIONS);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(text)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

// 密碼不對時丟出錯誤（AES-GCM 驗證失敗）
export async function unlockText(box, password) {
  if (box?.v !== 1) throw new Error('key.json 格式不對，請重新執行 npm run setup。');
  const key = await derive(password, unb64(box.salt), box.iterations);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv), additionalData: AAD }, key, unb64(box.data));
    return new TextDecoder().decode(plain);
  } catch { throw new Error('密碼不對。'); }
}
