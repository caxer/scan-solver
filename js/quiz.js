const clean = (v, max = 1000) => typeof v === 'string' ? v.trim().slice(0, max) : '';
export const quizCount = value => Math.min(10, Math.max(1, Math.round(Number(value) || 5)));

export function parseQuiz(value, count = 5) {
  if (clean(value?.error)) throw new Error(clean(value.error));
  const raw = value?.questions;
  if (!Array.isArray(raw) || raw.length !== quizCount(count)) throw new Error('測驗題數不完整，請重新出題。');
  const questions = raw.map(q => ({
    question: clean(q?.question), answer: clean(q?.answer), explanation: clean(q?.explanation, 2000), hint: clean(q?.hint),
    read: clean(q?.read), lang: typeof q?.lang === 'string' && /^[a-z]{2,3}(?:-[a-zA-Z]{2,8}){0,2}$/.test(q.lang) ? q.lang : 'zh-TW',
  }));
  if (questions.some(q => !q.question || !q.answer || !q.explanation || !q.hint) || new Set(questions.map(q => q.question)).size !== questions.length) {
    throw new Error('測驗有重複題目或缺少解答、提示，請重新出題。');
  }
  return { title: clean(value.title, 40) || '範圍測驗', subject: clean(value.subject, 12) || '其他', questions };
}

// 只有作答結束後才產生可重播的複習講解。
export function quizReview(quiz, scope, attempts) {
  if (attempts.length !== quiz.questions.length || attempts.some(a => typeof a?.correct !== 'boolean')) throw new Error('完成所有作答後才能產生測驗複習。');
  const correct = attempts.filter(a => a.correct).length;
  return {
    kind: 'knowledge', title: `${quiz.title}複習`, subject: quiz.subject,
    problem: `測驗範圍：${scope}`, answer: `${correct} / ${attempts.length} 題答對`,
    steps: quiz.questions.map((q, i) => ({
      say: `第 ${i + 1} 題。${q.explanation}`, lang: 'zh-TW', erase: 'notes',
      write: [q.question, `你的答案：${attempts[i].answer}（${attempts[i].correct ? '答對' : '待複習'}）`, `參考答案：${q.answer}`, q.explanation],
    })),
  };
}
