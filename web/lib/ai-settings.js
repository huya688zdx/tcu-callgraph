/**
 * AI 助手抽屉：
 * 1. 对话助手：直连本地/远程 OpenAI 兼容接口（含旧版无 tools 接口自动兼容），实时把找到的函数和 Git 改动加入画布；
 * 2. 直连 API：配置 Base URL / Model / Key / 兼容模式，支持拉取模型与连通性测试；
 * 3. 外部 MCP：保留原有三档权限控制、一键复制 CC 命令与精简指令。
 */
import { t } from '../i18n.js';
import { api } from './api.js';
import { esc } from './modal.js';
import { state } from './state.js';

const btn = document.getElementById('aiBtn');
const drawer = document.getElementById('aiDrawer');
const closeBtn = document.getElementById('aiDrawerClose');
const tabs = [...document.querySelectorAll('[data-ai-tab]')];
const panes = {
  chat: document.getElementById('aiPaneChat'),
  api: document.getElementById('aiPaneApi'),
  mcp: document.getElementById('aiPaneMcp'),
};

// 对话区 DOM
const projectTagEl = document.getElementById('aiProjectTag');
const chatSelectEl = document.getElementById('aiChatSelect');
const newChatBtn = document.getElementById('aiNewChat');
const deleteChatBtn = document.getElementById('aiDeleteChat');
const setupBanner = document.getElementById('aiSetupBanner');
const goConfigBtn = document.getElementById('aiGoConfig');
const messagesEl = document.getElementById('aiMessages');
const inputEl = document.getElementById('aiPromptInput');
const sendBtn = document.getElementById('aiSendChat');
const stopBtn = document.getElementById('aiStopChat');
const clearBtn = document.getElementById('aiClearChat');
const modelBadge = document.getElementById('aiModelBadge');

// API 配置区 DOM
const baseUrlEl = document.getElementById('aiBaseUrl');
const modelEl = document.getElementById('aiModel');
const modelListEl = document.getElementById('aiModelList');
const fetchModelsBtn = document.getElementById('aiFetchModels');
const apiKeyEl = document.getElementById('aiApiKey');
const clearKeyBtn = document.getElementById('aiClearKey');
const toolModeEl = document.getElementById('aiToolMode');
const reasoningEffortEl = document.getElementById('aiReasoningEffort');
const testConnBtn = document.getElementById('aiTestConn');
const saveApiBtn = document.getElementById('aiSaveApi');
const apiStatusEl = document.getElementById('aiApiStatus');

// MCP 区 DOM
const levelsEl = document.getElementById('aiLevels');
const lockedEl = document.getElementById('aiLocked');
const saveBtn = document.getElementById('aiSave');

const LEVELS = [
  { key: 'off', label: 'ai.level.off', desc: 'ai.desc.off' },
  { key: 'readonly', label: 'ai.level.readonly', desc: 'ai.desc.readonly' },
  { key: 'readwrite', label: 'ai.level.readwrite', desc: 'ai.desc.readwrite' },
];
const PROMPTS = [
  { title: 'ai.prompt.chain.title', text: 'ai.prompt.chain.text' },
  { title: 'ai.prompt.labels.title', text: 'ai.prompt.labels.text' },
  { title: 'ai.prompt.flow.title', text: 'ai.prompt.flow.text' },
];

let currentTab = 'chat';
let mcpLevel = 'readonly';
let envLocked = false;
const REASONING_LABELS = new Map([['off', '关'], ['low', '低'], ['medium', '中'], ['high', '高']]);
let llmConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1', model: '', hasApiKey: false,
  toolMode: 'auto', reasoningEffort: 'default',
};
let clearApiKeyPending = false;
let chatGeneration = 0;
let chatMutation = 0;
let chatProjectId = null;
let chatProjectName = '';
let chatThreads = []; // [{ id, title, updatedAt, messages }]
let activeChatId = '';
let activeAbort = null;

function newThreadObject(title = '新对话') {
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    title,
    updatedAt: Date.now(),
    messages: [],
  };
}

function activeThread() {
  let th = chatThreads.find((item) => item.id === activeChatId);
  if (!th) {
    th = newThreadObject();
    chatThreads.unshift(th);
    activeChatId = th.id;
  }
  return th;
}

function persistChats(projectId = chatProjectId) {
  if (projectId == null) return;
  chatMutation++;
  const payload = { projectId, activeId: activeChatId, threads: chatThreads.slice(0, 30) };
  void api.saveAiChats(payload).catch(() => {});
}

function renderChatBar() {
  if (projectTagEl) {
    projectTagEl.textContent = chatProjectName ? `工程：${chatProjectName}` : '工程';
    projectTagEl.title = chatProjectName ? `当前工程：${chatProjectName}（不同工程对话完全隔离）` : '按工程隔离保存对话';
  }
  if (chatSelectEl) {
    chatSelectEl.innerHTML = chatThreads.map((th) =>
      `<option value="${esc(th.id)}"${th.id === activeChatId ? ' selected' : ''}>${esc(th.title)} (${th.messages.length})</option>`
    ).join('');
  }
  if (deleteChatBtn) deleteChatBtn.disabled = chatThreads.length <= 1 && !(activeThread().messages.length);
}

function showThinking(box, before, thinking) {
  if (!thinking) return;
  let details = box.querySelector('.ai-think');
  if (!details) {
    details = document.createElement('details');
    details.className = 'ai-think';
    details.open = true;
    details.innerHTML = '<summary>💭 思考过程（点击收起/展开）</summary><pre></pre>';
    box.insertBefore(details, before);
  }
  details.querySelector('pre').textContent = thinking;
}

function renderQuestion(text, message, thread) {
  const card = document.createElement('div');
  card.className = 'ai-question';
  text.before(card);
  card.appendChild(text);

  const options = document.createElement('div');
  options.className = 'ai-question-opts';
  if (message.questionOptions.length) card.appendChild(options);

  const pending = thread.messages.at(-1) === message;
  for (const [index, option] of message.questionOptions.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-q-opt';
    button.textContent = option.label;
    button.disabled = !pending;
    button.classList.toggle('chosen', index === message.questionSelected);
    if (option.description) {
      const description = document.createElement('small');
      description.textContent = option.description;
      button.appendChild(description);
    }
    button.addEventListener('click', () => {
      if (activeAbort || activeChatId !== thread.id || thread.messages.at(-1) !== message) return;
      if (chatProjectId !== (state.view?.projectId ?? chatProjectId)) return;
      if (!llmConfig.baseUrl || !llmConfig.model) {
        void sendPrompt(option.label);
        return;
      }
      message.questionSelected = index;
      button.classList.add('chosen');
      void sendPrompt(option.label);
    });
    options.appendChild(button);
  }

  if (pending && message.allowCustom !== false) {
    const hint = document.createElement('p');
    hint.className = 'ai-q-hint';
    hint.textContent = '也可以直接在下方输入框自定义回复';
    card.appendChild(hint);
  }
}

function renderThreadMessages() {
  if (!messagesEl) return;
  const th = activeThread();
  if (!th.messages.length) {
    messagesEl.innerHTML = '<div class="empty">直接告诉我你想找什么函数、分析 Git 改动，或点上方快捷按钮，我会自动查找并加入当前画布。</div>';
    return;
  }
  messagesEl.innerHTML = '';
  for (const m of th.messages) {
    if (m.role === 'user') {
      const div = document.createElement('div');
      div.className = 'ai-msg user';
      div.textContent = m.text || '';
      messagesEl.appendChild(div);
    } else {
      const box = document.createElement('div');
      box.className = m.error ? 'ai-msg error' : 'ai-msg assistant';
      if (Array.isArray(m.tools) && m.tools.length) {
        const steps = document.createElement('div');
        steps.className = 'ai-steps';
        for (const tl of m.tools) {
          const row = document.createElement('div');
          row.className = `ai-step ${tl.ok !== false ? 'ok' : 'err'}`;
          row.textContent = `${tl.ok !== false ? '✓' : '✕'} ${tl.name}：${tl.summary || ''}`;
          steps.appendChild(row);
        }
        box.appendChild(steps);
      }
      const txt = document.createElement('div');
      txt.className = 'ai-msg-text';
      txt.textContent = m.text || '';
      box.appendChild(txt);
      showThinking(box, txt, m.thinking);
      if (Array.isArray(m.questionOptions)) renderQuestion(txt, m, th);
      messagesEl.appendChild(box);
    }
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadProjectChats({ force = false } = {}) {
  const currentId = state.view?.projectId ?? null;
  if ((!force || activeAbort) && chatProjectId !== null && currentId === chatProjectId && chatThreads.length) {
    renderChatBar();
    return;
  }
  const gen = ++chatGeneration;
  const mutation = chatMutation;
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  try {
    const res = await api.aiChats();
    if (gen !== chatGeneration || mutation !== chatMutation || !res?.ok) return;
    chatProjectId = res.projectId ?? currentId;
    chatProjectName = res.projectName || '';
    chatThreads = Array.isArray(res.threads) && res.threads.length ? res.threads : [newThreadObject()];
    activeChatId = res.activeId && chatThreads.some((x) => x.id === res.activeId) ? res.activeId : chatThreads[0].id;
    renderChatBar();
    renderThreadMessages();
  } catch {
    if (gen !== chatGeneration || mutation !== chatMutation) return;
    if (!chatThreads.length) {
      const th = newThreadObject();
      chatThreads = [th];
      activeChatId = th.id;
    }
    renderChatBar();
    renderThreadMessages();
  }
}

function ensurePanelStyle() {
  if (document.getElementById('aiPanelStyle')) return;
  const style = document.createElement('style');
  style.id = 'aiPanelStyle';
  style.textContent = `
    #aiLevels .ai-section { border-top: 1px solid #dedbd2; padding: 10px 0; }
    #aiLevels .ai-section h3 { font-size: 13px; margin: 0 0 7px; }
    #aiLevels .ai-endpoint { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    #aiLevels code { user-select: all; overflow-wrap: anywhere; font-size: 12px; }
    #aiLevels .ai-prompts { display: grid; gap: 6px; justify-items: start; }
    #aiLevels [data-ai-copy] { text-align: left; white-space: normal; }
    #aiLevels [role=status] { font-size: 12px; margin-top: 5px; color: #235326; }
  `;
  document.head.append(style);
}

function setTab(name) {
  currentTab = name;
  for (const tab of tabs) tab.classList.toggle('on', tab.dataset.aiTab === name);
  for (const [key, pane] of Object.entries(panes)) if (pane) pane.hidden = key !== name;
}

function setApiStatus(text, isError = false) {
  if (!apiStatusEl) return;
  apiStatusEl.textContent = text;
  apiStatusEl.classList.toggle('err', isError);
}

function syncApiForm() {
  if (!baseUrlEl) return;
  baseUrlEl.value = llmConfig.baseUrl || '';
  modelEl.value = llmConfig.model || '';
  apiKeyEl.value = '';
  apiKeyEl.placeholder = llmConfig.hasApiKey ? '已保存（留空保持不变）' : '可选；本地模型留空即可';
  clearApiKeyPending = false;
  if (clearKeyBtn) clearKeyBtn.hidden = !llmConfig.hasApiKey;
  if (toolModeEl) toolModeEl.value = llmConfig.toolMode || 'auto';
  const reasoningLabel = REASONING_LABELS.get(llmConfig.reasoningEffort);
  if (reasoningEffortEl) reasoningEffortEl.value = reasoningLabel ? llmConfig.reasoningEffort : 'default';
  const configured = Boolean(llmConfig.baseUrl && llmConfig.model);
  if (setupBanner) setupBanner.hidden = configured;
  if (modelBadge) {
    modelBadge.textContent = configured
      ? `${llmConfig.model}${llmConfig.toolMode === 'prompt' ? ' · 旧版兼容' : ''}${reasoningLabel ? ` · 思考:${reasoningLabel}` : ''}`
      : '未配置模型';
  }
}

function readApiDraft() {
  const draft = {
    baseUrl: baseUrlEl.value.trim(),
    model: modelEl.value.trim(),
    toolMode: toolModeEl.value,
    reasoningEffort: reasoningEffortEl?.value || 'default',
  };
  if (clearApiKeyPending) draft.apiKey = '';
  else if (apiKeyEl.value.trim()) draft.apiKey = apiKeyEl.value.trim();
  return draft;
}

function renderMcp() {
  if (!levelsEl) return;
  ensurePanelStyle();
  const endpoint = `${location.origin}/mcp`;
  const config = JSON.stringify({ mcpServers: { 'tcu-callgraph': { type: 'http', url: endpoint } } }, null, 2);
  const ccCmd = `claude mcp add --transport http tcu-callgraph ${endpoint}`;
  const levels = LEVELS.map(
    (l) => `
    <label class="ai-level">
      <input type="radio" name="aiLevel" value="${l.key}" ${l.key === mcpLevel ? 'checked' : ''} ${envLocked ? 'disabled' : ''}>
      <span class="ai-level-text">
        <strong>${t(l.label)}${l.key === 'readwrite' ? t('ai.readwriteHint') : ''}</strong>
        <small>${t(l.desc)}</small>
      </span>
    </label>`
  ).join('');
  levelsEl.innerHTML = `
    <section class="ai-section">
      <h3>${t('ai.localConnection')}</h3>
      <div class="ai-endpoint">
        <code>${esc(endpoint)}</code>
        <button type="button" data-ai-copy="cc">${t('ai.copyCc')}</button>
        <button type="button" data-ai-copy="config">${t('ai.copyConfig')}</button>
      </div>
      <span role="status"></span>
    </section>
    <section class="ai-section"><h3>${t('ai.access')}</h3>${levels}</section>
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
        const content = key === 'config' ? config : key === 'cc' ? ccCmd : t(PROMPTS[Number(key)].text);
        await navigator.clipboard.writeText(content);
        status.textContent = t('ai.copied');
      } catch {
        status.textContent = t('ai.clipboardError');
      }
    });
  }
  if (lockedEl) lockedEl.hidden = !envLocked;
  if (saveBtn) saveBtn.disabled = envLocked;
}

function appendUserMessage(text) {
  if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'ai-msg user';
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function createAssistantBox() {
  if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'ai-msg assistant';
  box.innerHTML = '<div class="ai-steps"></div><div class="ai-msg-text">正在连接模型…</div>';
  messagesEl.appendChild(box);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return {
    box,
    steps: box.querySelector('.ai-steps'),
    text: box.querySelector('.ai-msg-text'),
  };
}

function addStep(stepsEl, label, cls = '') {
  const row = document.createElement('div');
  row.className = 'ai-step' + (cls ? ' ' + cls : '');
  row.textContent = label;
  stepsEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return row;
}

async function sendPrompt(rawText) {
  const text = String(rawText ?? inputEl.value).trim();
  if (!text || activeAbort) return;
  if (!llmConfig.baseUrl || !llmConfig.model) {
    setTab('api');
    setApiStatus('请先填写本地模型 API 地址和模型名称', true);
    return;
  }
  const currentProjectId = state.view?.projectId ?? chatProjectId;
  if (chatProjectId === null || (currentProjectId !== null && currentProjectId !== chatProjectId)) {
    await loadProjectChats({ force: true });
  }
  const thread = activeThread();
  const threadId = thread.id;
  const myProjectId = chatProjectId;
  const myGen = chatGeneration;

  // 若是该对话首条消息，自动用问题摘要命名
  if (!thread.messages.length) {
    thread.title = text.replace(/\s+/g, ' ').slice(0, 22) || '新对话';
  }
  const historySnapshot = thread.messages
    .filter((m) => !m.error && m.text)
    .slice(-8)
    .map((m) => {
      let content = m.text;
      if (m.role === 'assistant' && Array.isArray(m.questionOptions) && m.questionOptions.length) {
        const optText = m.questionOptions.map((opt) => (opt.description ? `${opt.label}（${opt.description}）` : opt.label)).join(' / ');
        content = `${content}\n[已提供选项：${optText}]`;
      }
      return { role: m.role, content };
    });

  const questionCard = messagesEl.lastElementChild?.querySelector('.ai-question');
  if (questionCard) {
    for (const button of questionCard.querySelectorAll('.ai-q-opt')) button.disabled = true;
    questionCard.querySelector('.ai-q-hint')?.remove();
  }
  thread.messages.push({ role: 'user', text });
  thread.updatedAt = Date.now();
  renderChatBar();
  persistChats(myProjectId);

  inputEl.value = '';
  appendUserMessage(text);
  const ui = createAssistantBox();
  activeAbort = new AbortController();
  sendBtn.disabled = true;
  stopBtn.hidden = false;

  let lastPendingStep = null;
  let terminalReceived = false;
  let thinking = '';
  const collectedTools = [];
  const commitAssistantMsg = (entry) => {
    if (myGen !== chatGeneration || chatProjectId !== myProjectId) return;
    const target = chatThreads.find((x) => x.id === threadId);
    if (!target) return;
    target.messages.push(entry);
    target.updatedAt = Date.now();
    // 最近活跃对话排到最前
    chatThreads.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    renderChatBar();
    persistChats(myProjectId);
  };
  const handleLine = (line) => {
    if (terminalReceived || !line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'status') {
      ui.text.textContent = ev.text;
    } else if (ev.type === 'thinking') {
      if (ev.text) thinking = thinking ? `${thinking}\n\n${ev.text}` : ev.text;
      showThinking(ui.box, ui.text, thinking);
    } else if (ev.type === 'fallback') {
      addStep(ui.steps, `↻ ${ev.text}`);
    } else if (ev.type === 'tool_start') {
      const argBrief = ev.arguments && Object.keys(ev.arguments).length
        ? ` ${JSON.stringify(ev.arguments).slice(0, 80)}` : '';
      lastPendingStep = addStep(ui.steps, `🔧 ${ev.name}${argBrief}…`);
    } else if (ev.type === 'tool_end') {
      collectedTools.push({ name: ev.name, ok: ev.ok !== false, summary: ev.summary || '' });
      if (lastPendingStep) {
        lastPendingStep.textContent = `${ev.ok ? '✓' : '✕'} ${ev.name}：${ev.summary}`;
        lastPendingStep.classList.add(ev.ok ? 'ok' : 'err');
        lastPendingStep = null;
      } else {
        addStep(ui.steps, `${ev.ok ? '✓' : '✕'} ${ev.name}：${ev.summary}`, ev.ok ? 'ok' : 'err');
      }
    } else if (ev.type === 'done' || ev.type === 'question') {
      terminalReceived = true;
      thinking = ev.thinking || thinking;
      showThinking(ui.box, ui.text, thinking);
      const entry = { role: 'assistant', thinking, tools: collectedTools };
      if (ev.type === 'question') {
        entry.text = ev.question || '请确认以下选项：';
        entry.questionOptions = Array.isArray(ev.options) ? ev.options : [];
        entry.allowCustom = ev.allowCustom !== false;
      } else {
        entry.text = ev.answer || '已完成。';
      }
      ui.text.textContent = entry.text;
      commitAssistantMsg(entry);
      if (ev.type === 'question') renderQuestion(ui.text, entry, thread);
    } else if (ev.type === 'error') {
      terminalReceived = true;
      ui.box.className = 'ai-msg error';
      const msg = ev.error || '执行失败';
      ui.text.textContent = msg;
      commitAssistantMsg({ role: 'assistant', text: msg, thinking, tools: collectedTools, error: true });
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };
  try {
    const res = await api.aiChat({ prompt: text, history: historySnapshot, at: state.at || 0 }, activeAbort.signal);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
    if (!terminalReceived) {
      ui.box.className = 'ai-msg error';
      ui.text.textContent = '连接提前中断，请重试。';
    }
  } catch (err) {
    ui.box.className = 'ai-msg error';
    ui.text.textContent = err.name === 'AbortError' ? '已停止本次执行。' : (err.message || String(err));
  } finally {
    activeAbort = null;
    sendBtn.disabled = false;
    stopBtn.hidden = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

async function openDrawer() {
  if (!drawer) return;
  if (drawer.classList.contains('show')) {
    drawer.classList.remove('show');
    return;
  }
  drawer.classList.add('show');
  try {
    const [mcpCfg, aiCfg] = await Promise.all([
      api.mcpConfig().catch(() => null),
      api.aiConfig().catch(() => null),
      loadProjectChats({ force: true }),
    ]);
    if (mcpCfg) {
      mcpLevel = mcpCfg.level;
      envLocked = mcpCfg.source === 'env';
    }
    if (aiCfg?.config) llmConfig = aiCfg.config;
  } catch { /* 按默认渲染 */ }
  syncApiForm();
  renderMcp();
  if (!llmConfig.baseUrl || !llmConfig.model) setTab('api');
  else setTab(currentTab);
}

// 切换工程时自动隔离并切换到目标工程的独立对话列表
document.addEventListener('cg:project-changed', () => {
  chatGeneration++;
  chatProjectId = null;
  chatThreads = [];
  activeChatId = '';
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  if (drawer?.classList.contains('show')) void loadProjectChats({ force: true });
});

if (chatSelectEl) chatSelectEl.addEventListener('change', () => {
  if (activeAbort) activeAbort.abort();
  activeChatId = chatSelectEl.value;
  renderChatBar();
  renderThreadMessages();
  persistChats();
});
if (newChatBtn) newChatBtn.addEventListener('click', () => {
  if (activeAbort) activeAbort.abort();
  const th = newThreadObject();
  chatThreads.unshift(th);
  activeChatId = th.id;
  renderChatBar();
  renderThreadMessages();
  persistChats();
  inputEl?.focus();
});
if (deleteChatBtn) deleteChatBtn.addEventListener('click', () => {
  if (activeAbort) activeAbort.abort();
  chatThreads = chatThreads.filter((x) => x.id !== activeChatId);
  if (!chatThreads.length) chatThreads.push(newThreadObject());
  activeChatId = chatThreads[0].id;
  renderChatBar();
  renderThreadMessages();
  persistChats();
});

if (btn) btn.addEventListener('click', openDrawer);
if (closeBtn) closeBtn.addEventListener('click', () => drawer?.classList.remove('show'));
// 隔离抽屉内按键事件，防止 F / Delete / Esc 误触画布快捷键
if (drawer) drawer.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') drawer.classList.remove('show');
});
for (const tab of tabs) tab.addEventListener('click', () => setTab(tab.dataset.aiTab));
if (goConfigBtn) goConfigBtn.addEventListener('click', () => setTab('api'));

// 快捷任务按钮
for (const quick of document.querySelectorAll('[data-ai-quick]')) {
  quick.addEventListener('click', () => {
    const kind = quick.dataset.aiQuick;
    if (kind === 'git') {
      sendPrompt('先调用 get_git_changes 查看当前 Git 未提交改动。如果改动包含多个互不关联的独立模块，请先用 ask_user 询问我是否按书签拆分成多个图（默认推荐按书签拆分）；如果只有单一改动链路，直接调用 add_to_canvas({ fromGit: true }) 加入画布并简述影响。');
    } else if (kind === 'find') {
      inputEl.value = '帮我找出和 ';
      inputEl.focus();
      inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    } else if (kind === 'labels') {
      sendPrompt('立即补全当前画布上缺失的 TASK 周期（含函数上方注释中的周期）和 コール順 标签：先调 find_symbols({}) 查看画布连线与自动识别的候选标签，再直接调用 apply_labels 把标签写入画布（コール順 不带注释），不要只口头列出。');
    }
  });
}

if (sendBtn) sendBtn.addEventListener('click', () => sendPrompt());
if (stopBtn) stopBtn.addEventListener('click', () => activeAbort?.abort());
if (clearBtn) clearBtn.addEventListener('click', () => {
  if (activeAbort) activeAbort.abort();
  chatGeneration++;
  const th = activeThread();
  th.messages = [];
  th.title = '新对话';
  th.updatedAt = Date.now();
  renderChatBar();
  renderThreadMessages();
  persistChats();
});
if (inputEl) inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendPrompt();
  }
});

// API 配置事件
if (apiKeyEl) apiKeyEl.addEventListener('input', () => {
  if (apiKeyEl.value) clearApiKeyPending = false;
});
if (clearKeyBtn) clearKeyBtn.addEventListener('click', () => {
  clearApiKeyPending = true;
  apiKeyEl.value = '';
  apiKeyEl.placeholder = '保存后将清除已存 Key';
  clearKeyBtn.hidden = true;
});
if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
  setApiStatus('正在拉取模型列表…');
  fetchModelsBtn.disabled = true;
  try {
    const r = await api.aiModels(readApiDraft());
    if (!r?.ok) throw new Error(r?.error || '拉取失败');
    modelListEl.innerHTML = (r.models || []).map(id => `<option value="${esc(id)}"></option>`).join('');
    if (!modelEl.value.trim() && r.models?.length) modelEl.value = r.models[0];
    setApiStatus(r.models?.length ? `已获取 ${r.models.length} 个模型，可在下拉中选择` : '接口返回空列表，可手动输入模型名');
  } catch (err) {
    setApiStatus(err.message || String(err), true);
  } finally {
    fetchModelsBtn.disabled = false;
  }
});
if (testConnBtn) testConnBtn.addEventListener('click', async () => {
  setApiStatus('正在测试连接…');
  testConnBtn.disabled = true;
  try {
    const r = await api.aiTest(readApiDraft());
    if (!r?.ok) throw new Error(r?.error || '连接失败');
    setApiStatus(`✓ 连接成功（${r.latencyMs}ms · ${r.model}）`);
  } catch (err) {
    setApiStatus(err.message || String(err), true);
  } finally {
    testConnBtn.disabled = false;
  }
});
if (saveApiBtn) saveApiBtn.addEventListener('click', async () => {
  setApiStatus('正在保存…');
  try {
    const r = await api.saveAiConfig(readApiDraft());
    if (!r?.ok) throw new Error(r?.error || '保存失败');
    llmConfig = r.config;
    syncApiForm();
    setApiStatus('✓ 配置已保存，可直接切到「对话助手」使用');
  } catch (err) {
    setApiStatus(err.message || String(err), true);
  }
});

document.addEventListener('callgraph:langchange', () => {
  if (levelsEl?.childElementCount) renderMcp();
});

if (saveBtn)
  saveBtn.addEventListener('click', async () => {
    const checked = levelsEl?.querySelector('input[name="aiLevel"]:checked');
    if (!checked) return;
    const r = await api.setMcpConfig(checked.value).catch((err) => ({ ok: false, error: String(err.message || err) }));
    if (r && r.ok) {
      mcpLevel = checked.value;
      renderMcp();
      saveBtn.textContent = t('ai.save') + ' ✓';
      setTimeout(() => (saveBtn.textContent = t('ai.save')), 1500);
    } else if (lockedEl) {
      lockedEl.hidden = false;
      lockedEl.textContent = r?.error || t('ai.locked');
    }
  });
