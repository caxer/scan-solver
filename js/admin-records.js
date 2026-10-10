// 同一事件可能同時存在本機與雲端；題目由上傳紀錄彙整，不依賴目前瀏覽器。
export const recordDay = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
export const photoKey = entry => JSON.stringify([entry.device?.id || '', entry.photoId || entry.file || entry.time]);
export function combineRecords(records) {
  const unique = new Map();
  for (const e of records) {
    const key = e.eventId || JSON.stringify([e.time, e.device?.id, e.kind, e.photoId, e.note, e.question, e.title, e.text, e.status]);
    if (unique.has(key)) {
      const previous = unique.get(key);
      previous.sources = [...new Set([...previous.sources, e.recordSource])];
      previous.photo ||= e.photo;
    } else unique.set(key, { ...e, sources: [e.recordSource] });
  }
  return [...unique.values()].sort((a, b) => b.time.localeCompare(a.time));
}
export function uploadedQuestions(records) {
  const uploads = new Map();
  for (const e of [...records].sort((a, b) => a.time.localeCompare(b.time))) {
    if (!['list', 'solve'].includes(e.kind)) continue;
    const key = photoKey(e);
    let upload = uploads.get(key);
    if (!upload) uploads.set(key, upload = { key, photoId: e.photoId, time: e.time, device: e.device, photo: null, sources: [], questions: [], errors: [] });
    upload.sources = [...new Set([...upload.sources, ...(e.sources || [e.recordSource])])];
    if (e.photo) upload.photo = e.photo;
    if (e.kind === 'list') {
      for (const p of e.problems || []) {
        if (!upload.questions.some(q => q.label === p.label)) upload.questions.push({ label: p.label, preview: p.preview || '', solution: null, latestAttempt: null });
      }
      if (e.error) upload.errors.push(e.error);
    } else {
      let q = upload.questions.find(q => q.label === e.note);
      if (!q && upload.questions.length === 1 && !e.note) q = upload.questions[0];
      if (!q) upload.questions.push(q = { label: e.note || e.title || '解題紀錄', preview: '', solution: null, latestAttempt: null });
      q.latestAttempt = e;
      if (!q.solution || q.solution.status !== 'done' || q.solution.truncated || (e.status === 'done' && !e.truncated)) q.solution = e;
    }
  }
  return [...uploads.values()].sort((a, b) => b.time.localeCompare(a.time));
}
