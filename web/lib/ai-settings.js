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
    title: '📋 复制指令：读代码筛选核心调用链上画布',
    text: '先用 cg_page 确认当前视图，再用 cg_search、cg_node 和 cg_source 核对与我的问题相关的 C 源码及调用关系。挑选核心入口、相关函数和必要的全局变量，用 cg_compose_view 追加到当前画布，并说明选择依据。优先精确选函数，避免展开无关支路。',
  },
  {
    title: '📋 复制指令：分析当前画布并写入 TASK 周期与コール順',
    text: '用 cg_page 对齐当前画布。参考 cg_detect_tasks，并用 cg_node 和 cg_source 核对调度周期和调用顺序。用 cg_apply_task_labels 批量写入有源码证据的 TASK 标签（文字含周期，note 写文件行号和依据），按同一调用方的实际执行顺序从 コール順1 连续编号。保留现有其他标签，对不确定的分支或执行顺序只作说明。',
  },
  {
    title: '📋 复制指令：排查共享变量跨周期读写与 LSB 影响',
    text: '先用 cg_page、cg_vars、cg_shared_vars 和 cg_dataflow 确定当前链路共享的全局变量。用 cg_source 核对各读写者的调用周期、更新条件及 LSB、偏移、单位和类型转换。按变量列出读写函数和证据行号，说明跨周期采样或缩放对结果的影响，并区分可确认结论与待核实项。',
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
        <strong>${t(l.label)}${l.key === 'readwrite' ? '（允许 AI 读代码、选函数推上画布、规范写 TASK/コール順 标签）' : ''}</strong>
        <small>${t(l.desc)}</small>
      </span>
    </label>`
  ).join('');
  levelsEl.innerHTML = `
    <section class="ai-section">
      <h3>本机 MCP 连接</h3>
      <div class="ai-endpoint"><code>${esc(endpoint)}</code><button type="button" data-ai-copy="config">复制 MCP 配置 JSON</button><span role="status"></span></div>
    </section>
    <section class="ai-section"><h3>访问权限</h3>${levels}</section>
    <section class="ai-section">
      <h3>AI 绘图与标注约束</h3>
      <ul>
        <li>源码读取校验，只允许访问当前工程内已索引的源码。</li>
        <li>单次推图 ≤ 80 个函数，提交前校验节点 ID。</li>
        <li>TASK 文字与コール順 格式校验，拒绝同一调用方重号。</li>
        <li>组图和标注均在时间轴留痕。画布可返回，标注可从时间轴恢复。</li>
      </ul>
    </section>
    <section class="ai-section">
      <h3>AI 工作指令</h3>
      <div class="ai-prompts">${PROMPTS.map((prompt, index) => `<button type="button" data-ai-copy="${index}">${prompt.title}</button>`).join('')}</div>
      <span role="status"></span>
    </section>`;
  for (const button of levelsEl.querySelectorAll('[data-ai-copy]')) {
    button.addEventListener('click', async () => {
      const key = button.dataset.aiCopy;
      const status = button.closest('.ai-section').querySelector('[role="status"]');
      try {
        await navigator.clipboard.writeText(key === 'config' ? config : PROMPTS[Number(key)].text);
        status.textContent = '已复制 ✓';
      } catch {
        status.textContent = '无法访问剪贴板';
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
