// 題庫只保存在這個瀏覽器；照片 Blob 與腳本一起存，重播不需 API。
let opening;
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const req = indexedDB.open('scan-solver.library', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('lessons', { keyPath: 'id' });
    req.onsuccess = () => { req.result.onversionchange = () => { req.result.close(); opening = null; }; resolve(req.result); };
    req.onerror = () => { opening = null; reject(new Error('題庫無法開啟，請確認瀏覽器允許儲存資料。')); };
  });
  return opening;
}
async function transaction(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('lessons', mode);
    const req = action(tx.objectStore('lessons'));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(new Error('題庫儲存失敗，可能是空間不足或瀏覽器限制。'));
  });
}
export const library = {
  async list() { return (await transaction('readonly', s => s.getAll())).sort((a, b) => b.updated.localeCompare(a.updated)); },
  get(id) { return transaction('readonly', s => s.get(id)); },
  put(record) { return transaction('readwrite', s => s.put(record)); },
  remove(id) { return transaction('readwrite', s => s.delete(id)); },
  async update(id, changes) {
    const db = await database();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('lessons', 'readwrite'), store = tx.objectStore('lessons');
      const req = store.get(id);
      req.onsuccess = () => { if (req.result) store.put({ ...req.result, ...changes, updated: new Date().toISOString() }); };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error('題庫更新失敗。'));
    });
  },
};
