const number = (v, fallback, min, max) => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback;
const name = v => typeof v === 'string' ? v.trim().slice(0, 200) : '';
export function normalizeVoice(value = {}) {
  return {
    enabled: value?.enabled !== false,
    chinese: name(value?.chinese), english: name(value?.english),
    englishLang: value?.englishLang === 'en-GB' ? 'en-GB' : 'en-US',
    rate: number(value?.rate, 1, 0.5, 2), pitch: number(value?.pitch, 1, 0.5, 2),
    volume: number(value?.volume, 1, 0, 1),
  };
}
