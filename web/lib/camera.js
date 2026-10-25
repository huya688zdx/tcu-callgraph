/**
 * 视角：自适应缩放、平移/缩放动画、聚焦某个框
 */
import { els, state, cam } from './state.js';
import { draw } from './render.js';

/** 取当前内容的实际边界，包含拖出原布局范围的节点、折线和标签。 */
function contentBounds() {
  const v = state.view;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const include = (x, y) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); };
  for (const b of [...(v?.nodes || []), ...(v?.groups || []), ...(v?.containers || [])]) {
    include(b.x, b.y); include(b.x + b.w, b.y + b.h);
  }
  for (const e of v?.edges || []) {
    for (const p of e.points || []) include(p[0], p[1]);
    for (const { rect: r } of e._lbs || []) { include(r.x, r.y); include(r.x + r.w, r.y + r.h); }
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
    : { x: 0, y: 0, w: 1, h: 1 };
}

const fittedZoom = (b) => Math.min(2, Math.max(1, els.cv.clientWidth - 64) / b.w, Math.max(1, els.cv.clientHeight - 64) / b.h);
/** 通常 50%–200%；大图允许缩至整图适配比例，再往下就停止。 */
function zoomLimits() { return { min: Math.min(0.5, fittedZoom(contentBounds())), max: 2 }; }
function clampZoom(k) { const { min, max } = zoomLimits(); return Math.min(max, Math.max(min, k)); }

/** 恢复旧视角或改变画布尺寸后，保持画布中心并纠正越界比例。 */
function constrainCam() {
  const k = clampZoom(cam.k);
  if (k === cam.k) return;
  stopCamAnim();
  const x = els.cv.clientWidth / 2, y = els.cv.clientHeight / 2;
  cam.x = x - (x - cam.x) * k / cam.k;
  cam.y = y - (y - cam.y) * k / cam.k;
  cam.k = k;
}

function fit() {
  stopCamAnim();
  const v = state.view;
  if (!v) return;
  const W = els.cv.clientWidth;
  const H = els.cv.clientHeight;
  const b = contentBounds();
  cam.k = fittedZoom(b);
  cam.x = W / 2 - (b.x + b.w / 2) * cam.k;
  cam.y = H / 2 - (b.y + b.h / 2) * cam.k;
  draw();
}

// ---------------- 视角动画 ----------------

const camAnim = { on: false, mode: 'focus', anchor: null, raf: 0, last: 0, t0: 0, dur: 420, from: null, to: null };

function stopCamAnim() {
  camAnim.on = false;
  cancelAnimationFrame(camAnim.raf);
  camAnim.raf = 0;
}

function stepCam(now) {
  camAnim.raf = 0;
  if (!camAnim.on) return;
  const to = camAnim.to;
  if (camAnim.mode !== 'focus') {
    // 按经过时间衰减，保持不同刷新率下的阻尼手感一致。
    const alpha = 1 - Math.exp(-Math.max(0, now - camAnim.last) / (camAnim.mode === 'zoom' ? 120 : 150));
    camAnim.last = Math.max(now, camAnim.last);
    const a = camAnim.anchor;
    if (a) {
      cam.k += (to.k - cam.k) * alpha;
      // 每一帧都锁定鼠标下的世界坐标，避免缩放时画面游移。
      cam.x = a.x - a.wx * cam.k;
      cam.y = a.y - a.wy * cam.k;
    } else {
      cam.x += (to.x - cam.x) * alpha;
      cam.y += (to.y - cam.y) * alpha;
    }
    if (a ? Math.abs(Math.log(to.k / cam.k)) < 0.0005 : Math.hypot(to.x - cam.x, to.y - cam.y) < 0.1) {
      cam.x = to.x;
      cam.y = to.y;
      cam.k = to.k;
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
  camAnim.mode = 'focus';
  camAnim.t0 = performance.now();
  camAnim.dur = dur;
  camAnim.from = { x: cam.x, y: cam.y, k: cam.k };
  camAnim.to = to;
  camAnim.raf = requestAnimationFrame(stepCam);
}

function beginWheel(mode) {
  if (!camAnim.on || camAnim.mode !== mode) {
    stopCamAnim();
    camAnim.on = true;
    camAnim.mode = mode;
    camAnim.anchor = null;
    camAnim.last = performance.now();
    camAnim.to = { ...cam };
  }
  if (!camAnim.raf) camAnim.raf = requestAnimationFrame(stepCam);
}

/** 累积滚轮位移，温和地随缩放变速，避免缩小时过慢、放大时过快。 */
function panCam(dx, dy) {
  beginWheel('pan');
  camAnim.to.x += dx * Math.sqrt(cam.k);
  camAnim.to.y += dy * Math.sqrt(cam.k);
}

/** 每格约 10% 的平滑缩放，连续滚动累积倍率，以当前鼠标位置为锚点。 */
function zoomCam(x, y, delta) {
  let base = camAnim.on && camAnim.mode === 'zoom' ? camAnim.to.k : cam.k;
  // 反向滚动直接从当前比例起步，不必先抵消尚未完成的缩放。
  if ((base - cam.k) * delta > 0) base = cam.k;
  const k = clampZoom(base * Math.exp(-Math.max(-160, Math.min(160, delta)) * 0.0008));
  if (camAnim.on && camAnim.mode === 'zoom' && k === camAnim.to.k || !camAnim.on && k === cam.k) return;
  beginWheel('zoom');
  const a = { x, y, wx: (x - cam.x) / cam.k, wy: (y - cam.y) / cam.k };
  camAnim.anchor = a;
  camAnim.to = { x: x - a.wx * k, y: y - a.wy * k, k };
}

/** 把文件框 / 目录容器整体居中并适配到视野 */
function focusBox(box, pad = 90) {
  const W = els.cv.clientWidth;
  const H = els.cv.clientHeight;
  if (!W || !H || !box.w || !box.h) return;
  const k = clampZoom(Math.min(W / (box.w + pad * 2), H / (box.h + pad * 2), 1.6));
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
  const k = clampZoom(Math.min(cam.k, (W - pad * 2) / Math.max(1, x1 - x0), (H - pad * 2) / Math.max(1, y1 - y0)));
  const shift = (lo, hi, origin, size) => lo * k + origin < pad ? pad - lo * k :
    hi * k + origin > size - pad ? size - pad - hi * k : origin;
  animateCam({ x: shift(x0, x1, cam.x, W), y: shift(y0, y1, cam.y, H), k });
}
export { fit, zoomLimits, constrainCam, stopCamAnim, stepCam, animateCam, panCam, zoomCam, focusBox, revealAdded };
