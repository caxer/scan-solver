// key.json（npm run setup / npm run link 產生，跟網頁一起公開）：
//   user.slots：每條專屬連結一格，各用自己的網址金鑰鎖住 { apiKey, github: { token, repo } }
//   admin：舊版留下的管理員密碼盒，網頁不使用
//   adminPublicKey：手機用來加密使用紀錄的管理員公鑰
import './link-key.js';
import { normalizeDataCredentials } from './data-repo.js';

export const USER_CONTEXT = 'teacher/user/v3';

export function validKeyFile(file) {
  return file?.v === 3 && Array.isArray(file.user?.slots) && file.user.slots.every(slot => typeof slot?.id === 'string' && typeof slot.iv === 'string' && typeof slot.ct === 'string') &&
    file.adminPublicKey?.kty === 'RSA';
}

export async function loadKeyFile() {
  let file;
  try {
    const res = await fetch('key.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    file = await res.json();
  } catch { throw new Error('找不到 key.json。請管理員先在電腦上執行 npm run setup，再發布。'); }
  if (!validKeyFile(file)) throw new Error('key.json 是舊格式，請管理員在電腦上執行 npm run link -- add 後重新發布。');
  return file;
}

// 用網址金鑰（CryptoKey）打開 key.json 裡屬於這條連結的那一格；連結被移除時丟出 code: 'revoked'
export async function unlock(key) {
  const file = await loadKeyFile();
  const secrets = JSON.parse(await LinkKey.openAny(key, file.user.slots, USER_CONTEXT));
  return normalizeDataCredentials({ ...secrets, adminPublicKey: file.adminPublicKey });
}
