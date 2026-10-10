export const CONTENT_KINDS = { problem: '題目解題', article: '文章導讀', vocabulary: '單字朗讀', knowledge: '知識解說' };
export const contentKind = value => Object.hasOwn(CONTENT_KINDS, value) ? value : 'problem';
const clean = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

// 沿用 problems 欄位，讓既有題庫、紀錄與舊回覆仍能讀取。
export function normalizeListing(value) {
  const problems = (Array.isArray(value?.problems) ? value.problems : [])
    .map(p => ({ label: clean(p?.label, 40), preview: clean(p?.preview, 100), kind: contentKind(p?.kind) }))
    .filter(p => p.label).slice(0, 60);
  return { problems, error: problems.length ? '' : clean(value?.error, 200) || '照片內容看不清楚，請靠近一點、光線亮一點再拍。' };
}
