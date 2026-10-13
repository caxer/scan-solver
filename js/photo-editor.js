import { preparePhoto, exportJPEG, decodePhoto } from './photo.js';

export function createPhotoEditor() {
  const dialog = document.createElement('dialog'); dialog.className = 'study-dialog'; dialog.id = 'photo-editor';
  dialog.innerHTML = `<form method="dialog" class="study-heading"><h2>確認題目照片</h2><button class="btn" value="cancel" aria-label="取消照片">取消</button></form>
    <p>拖曳框選要解的區域，再按「裁切」。也可以直接使用整張照片。</p>
    <canvas id="crop-canvas" aria-label="題目照片，可拖曳框選裁切範圍"></canvas>
    <div class="study-actions"><button class="btn" id="photo-rotate" type="button">旋轉 90°</button><button class="btn" id="photo-crop" type="button" disabled>裁切框選區</button><button class="btn" id="photo-reset" type="button">還原</button><button class="btn primary" id="photo-use" type="button">使用這張照片</button></div>
    <p id="photo-edit-status" role="status"></p>`;
  document.body.append(dialog);
  const canvas = dialog.querySelector('canvas'), ctx = canvas.getContext('2d');
  const work = document.createElement('canvas');
  let original, selected, anchor, resolve, active = 0;
  const status = dialog.querySelector('#photo-edit-status');
  const crop = dialog.querySelector('#photo-crop');
  function draw() {
    canvas.width = work.width; canvas.height = work.height;
    ctx.drawImage(work, 0, 0);
    if (selected) { ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = Math.max(3, canvas.width / 180); ctx.strokeRect(selected.x, selected.y, selected.w, selected.h); }
    crop.disabled = !selected || selected.w < 10 || selected.h < 10;
  }
  const point = e => {
    const r = canvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(work.width, (e.clientX - r.left) * work.width / r.width)), y: Math.max(0, Math.min(work.height, (e.clientY - r.top) * work.height / r.height)) };
  };
  canvas.addEventListener('pointerdown', e => { anchor = point(e); canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', e => {
    if (!anchor) return;
    const p = point(e);
    selected = { x: Math.min(anchor.x, p.x), y: Math.min(anchor.y, p.y), w: Math.abs(p.x - anchor.x), h: Math.abs(p.y - anchor.y) }; draw();
  });
  canvas.addEventListener('pointerup', () => { anchor = null; });
  canvas.addEventListener('pointercancel', () => { anchor = null; });
  function replace(image, width, height) {
    work.width = width; work.height = height; work.getContext('2d').drawImage(image, 0, 0); selected = null; anchor = null; draw();
  }
  dialog.querySelector('#photo-rotate').onclick = () => {
    const next = document.createElement('canvas'); next.width = work.height; next.height = work.width;
    const c = next.getContext('2d'); c.translate(next.width, 0); c.rotate(Math.PI / 2); c.drawImage(work, 0, 0);
    replace(next, next.width, next.height);
  };
  crop.onclick = () => {
    if (!selected || crop.disabled) return;
    const next = document.createElement('canvas'); next.width = Math.max(1, Math.round(selected.w)); next.height = Math.max(1, Math.round(selected.h));
    next.getContext('2d').drawImage(work, selected.x, selected.y, selected.w, selected.h, 0, 0, next.width, next.height);
    replace(next, next.width, next.height);
  };
  dialog.querySelector('#photo-reset').onclick = () => replace(original, original.width, original.height);
  dialog.querySelector('#photo-use').onclick = async () => {
    const button = dialog.querySelector('#photo-use'), token = active;
    button.disabled = true;
    try {
      const photo = await preparePhoto(await exportJPEG(work));
      if (token !== active || !dialog.open) return;
      const done = resolve; resolve = null; dialog.close(); done?.(photo);
    } catch (e) { status.textContent = e.message; }
    finally { button.disabled = false; }
  };
  dialog.addEventListener('close', () => { if (!dialog.open) { active++; resolve?.(null); resolve = null; original = null; work.width = canvas.width = 0; } });
  return async photo => {
    if (dialog.open) dialog.close();
    const token = ++active;
    const decoded = await decodePhoto(photo.blob);
    try {
      if (token !== active) return null;
      original = document.createElement('canvas'); original.width = decoded.width; original.height = decoded.height; original.getContext('2d').drawImage(decoded.image, 0, 0);
      replace(original, original.width, original.height); status.textContent = ''; dialog.showModal();
      return new Promise(done => { resolve = done; });
    } finally { decoded.close(); }
  };
}
