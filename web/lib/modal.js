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
  mask.addEventListener('click', closeModal);
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
