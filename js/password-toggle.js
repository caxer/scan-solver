// 切換可見度只改顯示方式，保留輸入值、游標與瀏覽器的密碼自動填入。
export function initPasswordToggle() {
  const input = document.getElementById('password');
  const button = document.getElementById('password-toggle');
  function setVisible(visible) {
    input.type = visible ? 'text' : 'password';
    button.querySelector('.eye-slash').toggleAttribute('hidden', !visible);
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? '隱藏密碼' : '顯示密碼');
    button.title = button.getAttribute('aria-label');
  }
  button.addEventListener('click', () => {
    const start = input.selectionStart, end = input.selectionEnd, direction = input.selectionDirection;
    setVisible(input.type === 'password');
    input.focus({ preventScroll: true });
    if (start !== null && end !== null) input.setSelectionRange(start, end, direction);
  });
  setVisible(false);
  return { hide: () => setVisible(false) };
}
