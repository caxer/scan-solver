import { currentSecrets, isLocalSession } from './ai.js';
import { logEvent } from './logger.js';
import { logOutbox } from './log-outbox.js';

export function initWishes(bridge) {
  const dialog = document.createElement('dialog');
  dialog.id = 'feature-wish'; dialog.className = 'study-dialog';
  dialog.setAttribute('aria-labelledby', 'wish-title');
  dialog.innerHTML = `<form method="dialog" class="study-heading"><h2 id="wish-title">許願功能</h2><button class="btn">關閉</button></form>
    <p>希望小老師增加什麼功能？可以描述使用情境和想改善的地方。</p>
    <form id="wish-form"><label for="wish-text">我希望…<textarea id="wish-text" maxlength="2000" rows="5" required placeholder="例如：希望能把收藏的單字做成每週複習測驗。"></textarea></label>
    <p class="entry-note">送出後會交給管理員，列為待開發考量，不代表已排定開發。</p>
    <button class="btn primary" id="wish-submit" type="submit">送出許願</button></form><p id="wish-status" role="status"></p>`;
  document.body.append(dialog);
  const $ = id => document.getElementById(id);
  let busy = false, draft = null;
  $('open-wish').onclick = () => { bridge.pause(); dialog.showModal(); };
  $('wish-form').onsubmit = async event => {
    event.preventDefault();
    const text = $('wish-text').value.trim();
    if (busy) return;
    if (!text) { $('wish-status').textContent = '請輸入想增加的功能。'; return; }
    const secrets = currentSecrets();
    if (!isLocalSession() && !(secrets?.github?.token && secrets?.adminPublicKey)) {
      if (!secrets?.apiKey) { dialog.close(); bridge.login('登入後即可送出許願，文字會保留。'); }
      else $('wish-status').textContent = '目前尚未設定許願收件管道，請管理員設定紀錄連線後再送出。';
      return;
    }
    busy = true; $('wish-submit').disabled = true; $('wish-text').readOnly = true;
    $('wish-status').textContent = '正在送出…';
    draft = draft?.text === text ? draft : { text, id: crypto.randomUUID() };
    try {
      const sent = await logEvent(secrets, { kind: 'wish', eventId: draft.id, text, status: 'pending' });
      const pending = await logOutbox.get(draft.id);
      if (!sent && !pending) throw new Error('未能保存許願，請重試。');
      $('wish-status').textContent = sent ? '許願已送出，列為待開發考量。謝謝你的建議！' : '許願已保存在這台裝置，連線恢復後會自動補送；請保留網站資料。';
      $('wish-text').value = ''; draft = null;
    } catch (error) { $('wish-status').textContent = error.message || '送出失敗，請重試。'; }
    finally { busy = false; $('wish-submit').disabled = false; $('wish-text').readOnly = false; }
  };
}
