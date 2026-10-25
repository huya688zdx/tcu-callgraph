/**
 * 视角：自适应缩放、平移/缩放动画、聚焦某个框
 */
import { els, state, cam } from './state.js';
import { draw } from './render.js';
function fit() {
  stopCamAnim();
  const v = state.view;
  if (!v) return;
  const W = els.cv.clientWidth;
  const H = els.cv.clientHeight;
  const k = Math.min(W / v.width, H / v.height, 1.8) * 0.93;
  cam.k = Math.max(0.08, k);
  cam.x = (W - v.width * cam.k) / 2;
  cam.y = (H - v.height * cam.k) / 2;
  draw();
}

// ---------------- 视角动画 ----------------

const camAnim = { on: false, pan: false, raf: 0, last: 0, t0: 0, dur: 420, from: null, to: null };

function stopCamAnim() {
  camAnim.on = false;
  cancelAnimationFrame(camAnim.raf);
  camAnim.raf = 0;
}

function stepCam(now) {
  camAnim.raf = 0;
  if (!camAnim.on) return;
  const to = camAnim.to;
  if (camAnim.pan) {
    // 按经过时间衰减，保持不同刷新率下的阻尼手感一致。
    const alpha = 1 - Math.exp(-Math.max(0, now - camAnim.last) / 65);
    camAnim.last = Math.max(now, camAnim.last);
    cam.x += (to.x - cam.x) * alpha;
    cam.y += (to.y - cam.y) * alpha;
    if (Math.hypot(to.x - cam.x, to.y - cam.y) < 0.1) {
      cam.x = to.x;
      cam.y = to.y;
      camAnim.on = false;
    }
  } else {
    const t = Math.min(1, (now - camAnim.t0) / camAnim.dur);
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // 平滑聚焦
    const f = camAnim.from;
    cam.x = f.x + (to.x - f.x) * e;
    cam.y = f.y + (to.y - f.y) * e;
    cam.k = f.k + (to.k - f.k) * e;
    camAnim.on = t < 1;
  }
  draw();
  if (camAnim.on) camAnim.raf = requestAnimationFrame(stepCam);
}

function animateCam(to, dur = 420) {
  stopCamAnim();
  camAnim.on = true;
  camAnim.pan = false;
  camAnim.t0 = performance.now();
  camAnim.dur = dur;
  camAnim.from = { x: cam.x, y: cam.y, k: cam.k };
  camAnim.to = to;
  camAnim.raf = requestAnimationFrame(stepCam);
}

/** 累积滚轮位移，放大后移动更快，缩小后移动更慢。 */
function panCam(dx, dy) {
  if (!camAnim.on || !camAnim.pan) {
    stopCamAnim();
    camAnim.on = true;
    camAnim.pan = true;
    camAnim.last = performance.now();
    camAnim.to = { x: cam.x, y: cam.y };
  }
  camAnim.to.x += dx * cam.k;
  camAnim.to.y += dy * cam.k;
  if (!camAnim.raf) camAnim.raf = requestAnimationFrame(stepCam);
}

/** 把文件框 / 目录容器整体居中并适配到视野 */
function focusBox(box, pad = 90) {
  const W = els.cv.clientWidth;
  const H = els.cv.clientHeight;
  if (!W || !H || !box.w || !box.h) return;
  const k = Math.max(0.08, Math.min(W / (box.w + pad * 2), H / (box.h + pad * 2), 1.6));
  animateCam({
    x: W / 2 - (box.x + box.w / 2) * k,
    y: H / 2 - (box.y + box.h / 2) * k,
    k,
  });
}

/** 新内容在视野外时才平移或适度缩小，保留原有缩放作为上限。 */
function revealAdded(nodes, edges) {
  const points = nodes.length ? nodes.flatMap((n) => [[n.x, n.y], [n.x + n.w, n.y + n.h]]) :
    edges.flatMap((e) => e.points || []);
  if (!points.length) return;
  const W = els.cv.clientWidth, H = els.cv.clientHeight, pad = 40;
  if (points.every(([x, y]) => x * cam.k + cam.x >= pad && x * cam.k + cam.x <= W - pad &&
      y * cam.k + cam.y >= pad && y * cam.k + cam.y <= H - pad)) return;
  const x0 = Math.min(...points.map((p) => p[0])), x1 = Math.max(...points.map((p) => p[0]));
  const y0 = Math.min(...points.map((p) => p[1])), y1 = Math.max(...points.map((p) => p[1]));
  const k = Math.max(0.08, Math.min(cam.k, (W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0)));
  const shift = (lo, hi, origin, size) => lo * k + origin < pad ? pad - lo * k :
    hi * k + origin > size - pad ? size - pad - hi * k : origin;
  animateCam({ x: shift(x0, x1, cam.x, W), y: shift(y0, y1, cam.y, H), k });
}
export { fit, stopCamAnim, stepCam, animateCam, panCam, focusBox, revealAdded };
