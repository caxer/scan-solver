// 使用紀錄的加密：手機用管理員公鑰（RSA-OAEP 3072）包一把隨機 AES-GCM 金鑰，再用它加密紀錄。
// 只有管理員密碼解開的私鑰能讀；知道使用者密碼的人看不到紀錄內容。
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };
const b64 = bytes => {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
};
const unb64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

// → { publicJwk, privateJwk }
export async function createAdminKeys() {
  const pair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']);
  return { publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey), privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
}

export async function sealForAdmin(publicJwk, value) {
  const pub = await crypto.subtle.importKey('jwk', publicJwk, RSA, false, ['encrypt']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(value))));
  const key = new Uint8Array(await crypto.subtle.encrypt(RSA, pub, await crypto.subtle.exportKey('raw', aes)));
  return { v: 1, alg: 'RSA-OAEP-256+A256GCM', key: b64(key), iv: b64(iv), data: b64(data) };
}

export const importAdminKey = privateJwk => crypto.subtle.importKey('jwk', privateJwk, RSA, false, ['decrypt']);

export async function openAsAdmin(privateKey, sealed) {
  const raw = await crypto.subtle.decrypt(RSA, privateKey, unb64(sealed.key));
  const aes = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(sealed.iv) }, aes, unb64(sealed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

export { b64, unb64 };
