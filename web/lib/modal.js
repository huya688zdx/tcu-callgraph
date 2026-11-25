/**
 * 弹层原语：遮罩 + 居中面板
 * 工程选择和时间轴都用它，避免各自写一份遮罩逻辑
 */
import { t } from '../i18n.js';

const mask = document.getElementById('overlayMask');
let wired = false;
let cancelConfirm = null;

export function openModal(id) {
  if (!mask) return;
  const modal = document.getElementById(id);
  if (!modal) return;
  closeModal();
  mask.classList.add('show');
  modal.classList.add('show');
}

export function closeModal() {
  cancelConfirm?.();
  if (!mask) return;
  mask.classList.remove('show');
  document.querySelectorAll('.modal.show').forEach((modal) => {
    modal.classList.remove('show');
    modal.dispatchEvent(new Event('cg:modal-closed'));
  });
}

export function isModalOpen() {
  return !!mask && mask.classList.contains('show');
}

export function wireModals() {
  if (!mask || wired) return;
  wired = true;
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

/**
 * 应用内确认弹窗（替代原生 confirm）：叠在当前弹层之上，返回 Promise<boolean>。
 * 确认框使用独立的遮罩，底层弹窗和 AI 抽屉都不会收到点击。
 * dangerous 操作把确认键标红，且默认焦点在取消上，回车不会误确认；
 * Escape 在捕获阶段拦下，只关本弹窗，不把底下打开的弹窗（如选择工程）一起带走。
 */
export function confirmDialog({ title, message, okText = t('common.confirm'), cancelText = t('common.cancel'), danger = false }) {
  cancelConfirm?.();
  return new Promise((resolve) => {
    const focused = document.activeElement;
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    const box = document.createElement('div');
    box.className = 'modal confirm-modal show';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', title);
    box.innerHTML = `
      <div class="modal-head"><h2>${esc(title)}</h2><button class="modal-close">&times;</button></div>
      <div class="modal-body">${esc(message)}</div>
      <div class="modal-foot confirm-foot">
        <button data-ok class="${danger ? 'danger' : 'primary'}">${esc(okText)}</button>
        <button data-cancel>${esc(cancelText)}</button>
      </div>`;
    const end = (v) => {
      document.removeEventListener('keydown', onKey, true);
      cancelConfirm = null;
      backdrop.remove();
      if (focused?.isConnected) focused.focus();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        end(false);
      } else if (e.key === 'Tab') {
        const buttons = [...box.querySelectorAll('button')];
        const index = buttons.indexOf(document.activeElement);
        buttons[(index + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
        e.preventDefault();
      }
    };
    cancelConfirm = () => end(false);
    box.querySelector('[data-ok]').addEventListener('click', (e) => { e.stopPropagation(); end(true); });
    box.querySelector('[data-cancel]').addEventListener('click', (e) => { e.stopPropagation(); end(false); });
    box.querySelector('.modal-close').addEventListener('click', (e) => { e.stopPropagation(); end(false); });
    box.addEventListener('click', (e) => e.stopPropagation());
    backdrop.addEventListener('click', cancelConfirm);
    document.addEventListener('keydown', onKey, true);
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);
    box.querySelector('[data-cancel]').focus();
  });
}
