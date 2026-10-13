// 動畫計時：tween，以及可以中途喊停的控制器。
// cancel() 讓所有進行中的動畫立刻跳到結尾（這一步照樣做完）；abandon() 連後面的動作都不做（要重建畫面時用）。

export class Ctl {
  constructor() {
    this.cancelled = false;
    this.dead = false;
    this.pending = new Set();
  }
  cancel() {
    this.cancelled = true;
    for (const finish of [...this.pending]) finish();
    this.pending.clear();
  }
  abandon() {
    this.dead = true;
    this.cancel();
  }
}

const easeInOut = t => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function tween(dur, ctl, frame, ease = easeInOut) {
  return new Promise(resolve => {
    if (!(dur > 0) || ctl?.cancelled) { frame(1); resolve(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ctl?.pending.delete(finish);
      frame(1);
      resolve();
    };
    ctl?.pending.add(finish);
    const t0 = performance.now();
    const tick = now => {
      if (done) return;
      const t = Math.min(1, (now - t0) / dur);
      if (t >= 1) { finish(); return; }
      frame(ease(t));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export const wait = (ms, ctl) => tween(ms, ctl, () => {});

// 中文大約一秒讀 4.5 個字
export const readMs = text => Math.max(1800, (String(text || '').length / 4.5) * 1000 + 600);
