// HTML、CSS 與整個 ES module 圖使用同一發布版本；只在使用者點刷新時換頁。
export function initSiteUpdate({ beforeRefresh = async () => {} } = {}) {
  const loaded = document.querySelector('meta[name="scan-solver-version"]')?.content;
  if (!loaded) return;
  const manifest = new URL('version.json', document.baseURI);
  const style = document.createElement('style');
  style.textContent = `.site-update{position:fixed;z-index:10000;left:12px;right:12px;top:50%;transform:translateY(-50%);margin:auto;max-width:560px;padding:14px;border:1px solid #ffd54a;border-radius:14px;background:#203c2f;color:#edf2e9;box-shadow:0 8px 40px #0008;font:16px/1.5 system-ui,sans-serif}.site-update p{margin:0 0 10px}.site-update-actions{display:flex;gap:8px;flex-wrap:wrap}.site-update button{min-height:44px;padding:8px 14px;border:1px solid #9aaf9f;border-radius:10px;background:#355542;color:#edf2e9;font:inherit;cursor:pointer}.site-update .update-refresh{background:#ffd54a;color:#182d23;border-color:#ffd54a}.site-update[hidden],.site-update [hidden]{display:none}dialog .site-update{position:fixed;left:12px;right:12px;top:50%;margin:auto;width:auto}.site-update[data-compact=true]{padding:8px;width:max-content;max-width:calc(100vw - 24px);left:auto;top:auto;bottom:calc(12px + env(safe-area-inset-bottom));transform:none}.site-update[data-compact=true] .update-message,.site-update[data-compact=true] .update-later{display:none}`;
  document.head.append(style);
  const banner = document.createElement('aside');
  banner.id = 'site-update'; banner.className = 'site-update'; banner.hidden = true;
  banner.setAttribute('aria-label', '網站更新');
  banner.innerHTML = `<p class="update-message" role="status"><strong>小老師有新版本</strong><br>按刷新載入最新功能。若正在說題目或測驗，可完成後再刷新；尚未完成的輸入與測驗會清除。</p><div class="site-update-actions"><button type="button" class="update-refresh">立即刷新</button><button type="button" class="update-later">稍後提醒</button></div>`;
  let latest = null, checking = false;
  function place() {
    if (banner.hidden) return;
    const dialogs = [...document.querySelectorAll('dialog[open]')];
    const parent = dialogs.at(-1) || document.body;
    if (banner.parentElement !== parent) parent.append(banner);
  }
  new MutationObserver(place).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open'] });
  banner.querySelector('.update-later').onclick = () => {
    banner.dataset.compact = 'true';
    banner.querySelector('.update-refresh').textContent = '有新版 · 立即刷新';
  };
  banner.querySelector('.update-refresh').onclick = async () => {
    const button = banner.querySelector('.update-refresh');
    button.disabled = true; button.textContent = '正在刷新…';
    try {
      await beforeRefresh();
      const url = new URL(location.href);
      url.searchParams.set('v', latest);
      url.searchParams.set('_refresh', Date.now().toString());
      location.replace(url.href);
    } catch {
      button.disabled = false; button.textContent = '重試刷新';
    }
  };
  async function check() {
    if (checking || document.visibilityState === 'hidden' || navigator.onLine === false) return;
    checking = true;
    try {
      const url = new URL(manifest); url.searchParams.set('_', Date.now().toString());
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      if (!/^[a-f0-9]{16}$/.test(data.version) || data.version === loaded) return;
      latest = data.version; banner.hidden = false; place();
    } catch { /* 離線或發布尚未完成：下次回到網站時再檢查。 */ }
    finally { checking = false; }
  }
  for (const name of ['focus', 'pageshow', 'online']) addEventListener(name, check);
  document.addEventListener('visibilitychange', check);
  setInterval(check, 60_000);
  check();
}
