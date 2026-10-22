/**
 * AI 访问（MCP）权限设置面板
 * 三档：off（禁用）/ readonly（只读+导出，默认）/ readwrite（读写）
 * 保存即生效：MCP 端点每个请求都重读权限，不用重启服务
 */
import { t } from '../i18n.js';
import { api } from './api.js';
import { openModal, esc } from './modal.js';

const btn = document.getElementById('aiBtn');
const levelsEl = document.getElementById('aiLevels');
const lockedEl = document.getElementById('aiLocked');
const saveBtn = document.getElementById('aiSave');

const LEVELS = [
  { key: 'off', label: 'ai.level.off', desc: 'ai.desc.off' },
  { key: 'readonly', label: 'ai.level.readonly', desc: 'ai.desc.readonly' },
  { key: 'readwrite', label: 'ai.level.readwrite', desc: 'ai.desc.readwrite' },
];

let current = 'readonly';
let envLocked = false;

function render() {
  if (!levelsEl) return;
  levelsEl.innerHTML = LEVELS.map(
    (l) => `
    <label class="ai-level">
      <input type="radio" name="aiLevel" value="${l.key}" ${l.key === current ? 'checked' : ''}>
      <span class="ai-level-text">
        <strong>${t(l.label)}</strong>
        <small>${t(l.desc)}</small>
      </span>
    </label>`
  ).join('');
  if (lockedEl) lockedEl.hidden = !envLocked;
}

async function open() {
  try {
    const cfg = await api.mcpConfig();
    current = cfg.level;
    envLocked = cfg.source === 'env';
  } catch {
    /* 拿不到就按默认渲染，保存时再报错 */
  }
  render();
  openModal('aiModal');
}

if (btn) btn.addEventListener('click', open);

if (saveBtn)
  saveBtn.addEventListener('click', async () => {
    const checked = levelsEl?.querySelector('input[name="aiLevel"]:checked');
    if (!checked) return;
    const r = await api.setMcpConfig(checked.value).catch((err) => ({ ok: false, error: String(err.message || err) }));
    if (r && r.ok) {
      current = checked.value;
      render();
      saveBtn.textContent = t('ai.save') + ' ✓';
      setTimeout(() => (saveBtn.textContent = t('ai.save')), 1500);
    } else if (lockedEl) {
      lockedEl.hidden = false;
      lockedEl.textContent = esc(r?.error || t('ai.locked'));
    }
  });
