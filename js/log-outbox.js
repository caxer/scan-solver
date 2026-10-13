// 待送紀錄先存入 IndexedDB；不保存 API key 或 GitHub token。
let opening;
function database() {
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open('scan-solver.logs', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('pending', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opening = null; reject(request.error); };
  });
  return opening;
}
async function transaction(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending', mode), request = action(tx.objectStore('pending'));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('待送紀錄儲存失敗'));
  });
}
export const logOutbox = {
  put: item => transaction('readwrite', store => store.put(item)),
  get: id => transaction('readonly', store => store.get(id)),
  list: () => transaction('readonly', store => store.getAll()),
  async patch(id, changes) {
    return transaction('readwrite', store => {
      const request = store.get(id);
      request.onsuccess = () => {
        if (!request.result) return;
        const next = { ...request.result, ...changes };
        if (!next.local && !next.remote) store.delete(id);
        else store.put(next);
      };
      return request;
    });
  },
};
