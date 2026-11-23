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
const PROMPTS = [
  {
    title: 'ai.prompt.chain.title',
    text: 'ai.prompt.chain.text',
  },
  {
    title: 'ai.prompt.labels.title',
    text: 'ai.prompt.labels.text',
  },
  {
    title: 'ai.prompt.flow.title',
    text: 'ai.prompt.flow.text',
  },
];

let current = 'readonly';
let envLocked = false;

function ensurePanelStyle() {
  if (document.getElementById('aiPanelStyle')) return;
  const style = document.createElement('style');
  style.id = 'aiPanelStyle';
  style.textContent = `
    #aiLevels .ai-section { border-top: 1px solid #dedbd2; padding: 10px 0; }
    #aiLevels .ai-section h3 { font-size: 13px; margin: 0 0 7px; }
    #aiLevels .ai-endpoint { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    #aiLevels code { user-select: all; overflow-wrap: anywhere; }
    #aiLevels ul { list-style: '✓  '; margin: 0; padding-left: 1.4em; font-size: 12px; line-height: 1.6; }
    #aiLevels .ai-prompts { display: grid; gap: 6px; justify-items: start; }
    #aiLevels [data-ai-copy] { text-align: left; white-space: normal; }
    #aiLevels [role=status] { font-size: 12px; margin-top: 5px; }
  `;
  document.head.append(style);
}

function render() {
  if (!levelsEl) return;
  ensurePanelStyle();
  const endpoint = `${location.origin}/mcp`;
  const config = JSON.stringify({ mcpServers: { 'tcu-callgraph': { type: 'http', url: endpoint } } }, null, 2);
  const levels = LEVELS.map(
    (l) => `
    <label class="ai-level">
      <input type="radio" name="aiLevel" value="${l.key}" ${l.key === current ? 'checked' : ''} ${envLocked ? 'disabled' : ''}>
      <span class="ai-level-text">
        <strong>${t(l.label)}${l.key === 'readwrite' ? t('ai.readwriteHint') : ''}</strong>
        <small>${t(l.desc)}</small>
      </span>
    </label>`
  ).join('');
  levelsEl.innerHTML = `
    <section class="ai-section">
      <h3>${t('ai.localConnection')}</h3>
      <div class="ai-endpoint"><code>${esc(endpoint)}</code><button type="button" data-ai-copy="config">${t('ai.copyConfig')}</button><span role="status"></span></div>
    </section>
    <section class="ai-section"><h3>${t('ai.access')}</h3>${levels}</section>
    <section class="ai-section">
      <h3>${t('ai.rules')}</h3>
      <ul>
        <li>${t('ai.rule.source')}</li>
        <li>${t('ai.rule.functions')}</li>
        <li>${t('ai.rule.labels')}</li>
        <li>${t('ai.rule.history')}</li>
      </ul>
    </section>
    <section class="ai-section">
      <h3>${t('ai.prompts')}</h3>
      <div class="ai-prompts">${PROMPTS.map((prompt, index) => `<button type="button" data-ai-copy="${index}">${t(prompt.title)}</button>`).join('')}</div>
      <span role="status"></span>
    </section>`;
  for (const button of levelsEl.querySelectorAll('[data-ai-copy]')) {
    button.addEventListener('click', async () => {
      const key = button.dataset.aiCopy;
      const status = button.closest('.ai-section').querySelector('[role="status"]');
      try {
        await navigator.clipboard.writeText(key === 'config' ? config : t(PROMPTS[Number(key)].text));
        status.textContent = t('ai.copied');
      } catch {
        status.textContent = t('ai.clipboardError');
      }
    });
  }
  if (lockedEl) lockedEl.hidden = !envLocked;
  if (saveBtn) saveBtn.disabled = envLocked;
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
document.addEventListener('callgraph:langchange', () => {
  if (levelsEl?.childElementCount) render();
});

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
      lockedEl.textContent = r?.error || t('ai.locked');
    }
  });
