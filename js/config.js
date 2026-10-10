// key.json（npm run setup 產生，跟網頁一起公開）：
//   user：使用者密碼鎖住的 { apiKey, github: { token, repo } }
//   admin：管理員密碼鎖住的 { privateJwk, github: { token, repo } }
//   adminPublicKey：手機用來加密使用紀錄的管理員公鑰
import { unlockText } from './keybox.js';

let cached = null;
export async function loadKeyFile() {
  if (cached) return cached;
  let file;
  try {
    const res = await fetch('key.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    file = await res.json();
  } catch { throw new Error('找不到 key.json。請管理員先在電腦上執行 npm run setup，再發布。'); }
  if (file?.v !== 2 || !file.user || !file.admin || !file.adminPublicKey) throw new Error('key.json 是舊格式，請管理員重新執行 npm run setup。');
  return (cached = file);
}

// 用密碼打開 key.json 的其中一格（'user' 或 'admin'）
export async function unlock(which, password) {
  const file = await loadKeyFile();
  return { ...JSON.parse(await unlockText(file[which], password)), adminPublicKey: file.adminPublicKey };
}
