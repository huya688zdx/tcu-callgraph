/**
 * 弹层原语：遮罩 + 居中面板
 * 工程选择和时间轴都用它，避免各自写一份遮罩逻辑
 */
const mask = document.getElementById('overlayMask');

export function openModal(id) {
  if (!mask) return;
  closeModal();
  mask.classList.add('show');
  document.getElementById(id)?.classList.add('show');
}

export function closeModal() {
  if (!mask) return;
  mask.classList.remove('show');
  document.querySelectorAll('.modal.show').forEach((m) => m.classList.remove('show'));
}

export function isModalOpen() {
  return !!mask && mask.classList.contains('show');
}

export function wireModals() {
  if (!mask) return;
  // 点遮罩空白处关闭：面板内部的点击要 stopPropagation 由调用方处理
  mask.addEventListener('click', () => {
    if (!document.querySelector('.confirm-modal.show')) closeModal();
  });
  document.querySelectorAll('.modal-close').forEach((b) => {
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      closeModal();
    });
  });
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => e.stopPropagation());
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isModalOpen()) closeModal();
  });
}

/** 统一的文本转义：函数名 / 路径都来自被扫描的工程，不能直接拼进 innerHTML */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

/**
 * 应用内确认弹窗（替代原生 confirm）：叠在当前弹层之上，返回 Promise<boolean>。
 * 必须挂到 body 上而不是遮罩里——.mask 是 z-index:40 的层叠上下文，
 * 放进去会被 z-index:41 的普通弹窗整个盖住（弹了但看不见）。
 * dangerous 操作把确认键标红，且默认焦点在取消上，回车不会误确认；
 * Escape 在捕获阶段拦下，只关本弹窗，不把底下打开的弹窗（如选择工程）一起带走。
 */
export function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false }) {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'modal confirm-modal show';
    box.innerHTML = `
      <div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close">&times;</button></div>
      <div class="modal-body">${esc(message)}</div>
      <div class="modal-foot confirm-foot">
        <button data-ok class="${danger ? 'danger' : 'primary'}">${esc(okText)}</button>
        <button data-cancel>${esc(cancelText)}</button>
      </div>`;
    let onMaskClick = null;
    const end = (v) => {
      document.removeEventListener('keydown', onKey, true);
      if (onMaskClick) mask?.removeEventListener('click', onMaskClick);
      box.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      end(false);
    };
    onMaskClick = () => end(false);
    box.querySelector('[data-ok]').addEventListener('click', (e) => { e.stopPropagation(); end(true); });
    box.querySelector('[data-cancel]').addEventListener('click', (e) => { e.stopPropagation(); end(false); });
    box.querySelector('.modal-close').addEventListener('click', (e) => { e.stopPropagation(); end(false); });
    box.addEventListener('click', (e) => e.stopPropagation());
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(box);
    if (mask) mask.addEventListener('click', onMaskClick);
    box.querySelector('[data-cancel]').focus();
  });
}
