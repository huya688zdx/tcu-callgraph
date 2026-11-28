/**
 * AI 助手抽屉：
 * 1. 对话助手：直连本地/远程 OpenAI 兼容接口（含旧版无 tools 接口自动兼容），实时把找到的函数和 Git 改动加入画布；
 * 2. 直连 API：配置 Base URL / Model / Key / 兼容模式，支持拉取模型与连通性测试；
 * 3. 外部 MCP：保留原有三档权限控制、一键复制 CC 命令与精简指令。
 */
import { applyI18n, getLang, t } from '../i18n.js';
import { boundSavedCodeAttachments, MAX_CODE_ATTACHMENTS, sanitizeCodeAttachments } from './ai-code-attachments.js';
import { api, clientId } from './api.js';
import { focusBox, stopCamAnim } from './camera.js';
import { hooks } from './hooks.js';
import { refreshAfterAiUndo } from './live.js';
import { selectNode } from './menu.js';
import { confirmDialog, esc } from './modal.js';
import { runSearch } from './panels.js';
import { captureBoxImage, compositeEffects, draw } from './render.js';
import { edgeKey, els, state } from './state.js';

const btn = document.getElementById('aiBtn');
const drawer = document.getElementById('aiDrawer');
const resizeHandle = document.getElementById('aiResizeHandle');
const closeBtn = document.getElementById('aiDrawerClose');
const tabs = [...document.querySelectorAll('[data-ai-tab]')];
const panes = {
  chat: document.getElementById('aiPaneChat'),
  api: document.getElementById('aiPaneApi'),
  mcp: document.getElementById('aiPaneMcp'),
  guide: document.getElementById('aiPaneGuide'),
};

// 对话区 DOM
const projectTagEl = document.getElementById('aiProjectTag');
const chatSelectEl = document.getElementById('aiChatSelect');
const newChatBtn = document.getElementById('aiNewChat');
const renameChatBtn = document.getElementById('aiRenameChat');
const renameInputEl = document.getElementById('aiRenameInput');
const deleteChatBtn = document.getElementById('aiDeleteChat');
const setupBanner = document.getElementById('aiSetupBanner');
const goConfigBtn = document.getElementById('aiGoConfig');
const bookmarkBannerEl = document.getElementById('aiBookmarkBanner');
const bookmarkBannerTextEl = document.getElementById('aiBookmarkBannerText');
const bookmarkNewChatBtn = document.getElementById('aiBookmarkNewChat');
const bookmarkBindChatBtn = document.getElementById('aiBookmarkBindChat');
const bookmarkDismissBtn = document.getElementById('aiBookmarkDismiss');
const messagesEl = document.getElementById('aiMessages');
const selectionBar = document.getElementById('aiSelectionBar');
const pinnedListEl = document.getElementById('aiPinnedList');
const relationBarEl = document.getElementById('aiRelationBar');
const selectionRowEl = document.getElementById('aiSelectionRow');
const trunkSwitchEl = document.getElementById('aiTrunkSwitch');
const trunkBadgeEl = document.getElementById('aiTrunkBadge');
const trunkSelectEl = document.getElementById('aiTrunkSelect');
const trunkPrevBtn = document.getElementById('aiTrunkPrev');
const trunkNextBtn = document.getElementById('aiTrunkNext');
const selectionText = document.getElementById('aiSelectionText');
const pinSelectionBtn = document.getElementById('aiPinSelection');
const selectionQuestions = document.getElementById('aiSelectionQuestions');
const clearSelectionBtn = document.getElementById('aiClearSelection');
const inputShellEl = document.getElementById('aiInputShell');
const slashMenuEl = document.getElementById('aiSlashMenu');
const attachmentsEl = document.getElementById('aiAttachments');
const inputEl = document.getElementById('aiPromptInput');
const ghostTabHintEl = document.getElementById('aiGhostTabHint');
const attachMenuEl = document.getElementById('aiAttachMenu');
const imageFileInputEl = document.getElementById('aiImageFileInput');
const textFileInputEl = document.getElementById('aiTextFileInput');
const lightboxEl = document.getElementById('aiImageLightbox');
const lightboxImgEl = document.getElementById('aiLightboxImg');
const lightboxCaptionEl = document.getElementById('aiLightboxCaption');
const lightboxCloseEl = document.getElementById('aiLightboxClose');
const sendBtn = document.getElementById('aiSendChat');
const stopBtn = document.getElementById('aiStopChat');
const quickModelEl = document.getElementById('aiQuickModel');
const quickReasoningEl = document.getElementById('aiQuickReasoning');
const attachShotBtn = document.getElementById('aiAttachShot');
const contextBadge = document.getElementById('aiContextBadge');
const contextFillEl = document.getElementById('aiContextFill');
const contextTextEl = document.getElementById('aiContextText');
const speedBadge = document.getElementById('aiSpeedBadge');
const compactBtn = document.getElementById('aiCompactChat');
const chatStatusEl = document.getElementById('aiChatStatus');

// 导览 HUD DOM
const presHudEl = document.getElementById('aiPresentationHud');
const presHudTitleEl = document.getElementById('aiPresHudTitle');
const presHudSubEl = document.getElementById('aiPresHudSub');
const presHudCounterEl = document.getElementById('aiPresHudCounter');
const presPrevBtn = document.getElementById('aiPresPrev');
const presNextBtn = document.getElementById('aiPresNext');
const presCloseBtn = document.getElementById('aiPresClose');

// API 配置区 DOM
const baseUrlEl = document.getElementById('aiBaseUrl');
const modelEl = document.getElementById('aiModel');
const modelSelectEl = document.getElementById('aiModelSelect');
const fetchModelsBtn = document.getElementById('aiFetchModels');
const apiKeyEl = document.getElementById('aiApiKey');
const clearKeyBtn = document.getElementById('aiClearKey');
const toolModeEl = document.getElementById('aiToolMode');
const reasoningEffortEl = document.getElementById('aiReasoningEffort');
const contextWindowEl = document.getElementById('aiContextWindow');
const maxTokensEl = document.getElementById('aiMaxTokens');
const subagentEnabledEl = document.getElementById('aiSubagentEnabled');
const subagentConcurrencyEl = document.getElementById('aiSubagentConcurrency');
const subagentMaxStepsEl = document.getElementById('aiSubagentMaxSteps');
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
const NEW_THREAD_TITLE = '新对话';
const GIT_THREAD_TITLE = 'Git 改动分析';
const LABELS_THREAD_TITLE = '补全 TASK / 顺序标签';
const BUILD_DIAG_THREAD_TITLE = '构建配置诊断';
// 自动标题沿用已有存储值，仅在显示时翻译。
const GENERIC_THREAD_TITLES = new Map([
  [NEW_THREAD_TITLE, 'ai.thread.new'], [GIT_THREAD_TITLE, 'ai.thread.git'],
  [LABELS_THREAD_TITLE, 'ai.thread.labels'], [BUILD_DIAG_THREAD_TITLE, 'ai.thread.build'],
]);

function displayThreadTitle(thread) {
  if (thread.customTitle) return thread.title;
  const key = GENERIC_THREAD_TITLES.get(thread.title || NEW_THREAD_TITLE);
  if (key) return t(key);
  return thread.title.replace(/^(画布|标签)(?= · )/, prefix =>
    prefix === '画布' ? t('timeline.kindCanvas') : t('ai.thread.labelPrefix'));
}

const BOOKMARK_COMMAND = '/bookmark';
const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 8192;

const LABELS_FOLLOWUP = { label: 'ai.follow.labels', prompt: 'ai.quickPrompt.labels' };
const FOLLOWUPS = new Map([
  ['add_to_canvas', [
    LABELS_FOLLOWUP,
    { label: 'ai.follow.tidy', prompt: 'ai.action.tidy' },
    { label: 'ai.follow.bookmark', draft: BOOKMARK_COMMAND + ' ' },
  ]],
  ['get_git_changes', [
    { label: 'ai.follow.split', prompt: 'ai.action.split' },
    { label: 'ai.follow.variants', prompt: 'ai.action.variants' },
  ]],
  ['apply_labels', [
    { label: 'ai.follow.shared', prompt: 'ai.action.shared' },
    { label: 'ai.follow.git', prompt: 'ai.action.git' },
  ]],
  ['remove_from_canvas', [
    LABELS_FOLLOWUP,
    { label: 'ai.follow.filtered', draft: BOOKMARK_COMMAND + ' ' },
  ]],
  ['read_function', [
    { label: 'ai.follow.tasks', prompt: 'ai.action.tasks' },
    { label: 'ai.follow.indirect', prompt: 'ai.action.indirect' },
    { label: 'ai.follow.functions', prompt: 'ai.action.functions' },
  ]],
  ['read_source', [
    { label: 'ai.follow.verifyEdges', prompt: 'ai.action.verifyEdges' },
    { label: 'ai.follow.callers', prompt: 'ai.action.callers' },
  ]],
  ['inspect_indirect_calls', [
    { label: 'ai.follow.addEdges', prompt: 'ai.action.addEdges' },
    { label: 'ai.follow.dispatch', prompt: 'ai.action.dispatch' },
  ]],
  ['add_call_edge', [
    { label: 'ai.follow.retrace', prompt: 'ai.action.retrace' },
    { label: 'ai.follow.layout', prompt: 'ai.action.layout' },
  ]],
  ['trace_upstream', [
    { label: 'ai.follow.addChain', prompt: 'ai.action.addChain' },
    { label: 'ai.follow.missing', prompt: 'ai.action.missing' },
  ]],
  ['find_symbols', [
    { label: 'ai.follow.matches', prompt: 'ai.action.matches' },
    { label: 'ai.follow.source', prompt: 'ai.action.source' },
  ]],
  ['arrange_canvas', [
    { label: 'ai.follow.vertical', prompt: 'ai.action.vertical' },
    { label: 'ai.follow.reset', prompt: 'ai.action.reset' },
  ]],
]);

const TITLE_SOURCES = [
  { name: 'get_git_changes', prefix: 'Git', symbols: ['changedFunctions', 'changedVars'], paths: ['changedFiles'] },
  { name: 'add_to_canvas', prefix: '画布', symbols: ['functions', 'roots', 'vars'], paths: ['includePaths'] },
  { name: 'apply_labels', prefix: '标签', symbols: ['edgeKeys'] },
  { name: 'remove_from_canvas', prefix: '画布', symbols: ['removed', 'functions'], paths: ['excludePaths'] },
];

let apiConfigLoad = null;
let showApiOnOpen = false;
let mcpLevel = 'readonly';
let envLocked = false;
const EFFORT_KEYS = {
  default: 'ai.effort.default', off: 'ai.effort.off', low: 'ai.effort.low',
  medium: 'ai.effort.medium', high: 'ai.effort.high',
};
const QUICK_CONFIG_ACTION = '__ai_open_config__';
const MAX_PENDING_IMAGES = 2;
const MAX_PENDING_FILES = MAX_CODE_ATTACHMENTS;
let currentGhostSuggestion = '';
const pendingImages = []; // [{ id, dataUrl, label, width, height }]
const pendingFiles = [];  // [{ id, name, lines, startLine, endLine }]
let llmConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1', model: '', hasApiKey: false,
  toolMode: 'auto', reasoningEffort: 'default', contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS, subagentEnabled: true, subagentMaxConcurrency: 2, subagentMaxSteps: 6,
};
let clearApiKeyPending = false;
let fetchedModels = [];
let fetchedModelsBaseUrl = '';
let backgroundModelFetch = null;
let quickSaving = false;
let chatGeneration = 0;
let chatMutation = 0;
let chatProjectId = null;
let chatProjectName = '';
let chatThreads = []; // [{ id, title, customTitle?, bookmarkId?, bookmarkName?, updatedAt, messages }]
let activeChatId = '';
let renamingThread = null;
let activeAbort = null;
let pendingSteer = null;
let compacting = null;
let stickToBottom = true;
let displayedContext = { used: 0, promptTokens: 0, outputTokens: 0, estimated: false, hasMetrics: false };
let canvasSelection = null; // 被动画布候选（不主动随普通发送进入模型）
const pinnedSelections = []; // 显式附着/暂存的上下文芯片（支持单轮自动消费或 _pinned 跨轮锁定）
const MAX_PINNED_SELECTIONS = 16;
let selectedRelationIntent = 'auto';
const dismissedSelectionKeys = new Set();
let activeStreamFlush = null;
let slashMenuState = { open: false, mode: '', items: [], activeIndex: 0, triggerStart: 0 };
let pendingBookmarkSwitch = null;

function isCanvasDragging() {
  return Boolean(
    state.panning || state.dragBox || state.dragNode || state.dragSeg ||
    state.dragLabel || state.resizeBox || state.marquee
  );
}

function toolTitleSubject(tool, { prefix, symbols, paths = [] }) {
  const digest = typeof tool.digest === 'string' ? tool.digest : '';
  const fields = tool.digest && typeof tool.digest === 'object' ? tool.digest
    : Object.fromEntries(Array.from(
      digest.matchAll(/(?:^|\s)(\w+)=(.*?)(?=\s+\w+=|$)/gs),
      ([, key, value]) => [key, value],
    ));
  const fieldText = (key) => {
    const value = fields[key];
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(item => typeof item === 'string' ? item : item?.id || item?.name || item?.file || item?.path).join(', ');
  };
  const plainDigest = Object.keys(fields).length ? ''
    : (digest.startsWith(tool.name) ? digest.slice(tool.name.length) : digest);
  const summary = [tool.summary, plainDigest].filter(Boolean).join(' ');
  const symbolRefs = (text) => Array.from(text.matchAll(/::([A-Za-z_]\w*)\b(?!::|[./\\…])/gu), match => match[1]);
  const symbol = symbols.map(key => {
    const first = fieldText(key).split(', ', 1)[0].trim();
    const refs = symbolRefs(first);
    return (key === 'edgeKeys' ? refs.at(-1) : refs[0]) || first.match(/^[A-Za-z_]\w*$/u)?.[0];
  }).find(Boolean) || symbolRefs(summary)[0]
    || summary.match(/(?:函数|符号|画布)\s*[:：]?\s*["“「`]?([A-Za-z_]\w*)\b/u)?.[1]
    || summary.match(/\b[A-Za-z][A-Za-z\d]*(?:_[A-Za-z\d]+)+\b(?![./\\…])/u)?.[0];
  const vehicle = [...symbols.map(fieldText), ...paths.map(fieldText), summary].join(' ').match(/\bz\d+\b/iu)?.[0];
  const subjects = [...new Set([vehicle, symbol].filter(value => value && value !== tool.name))];
  if (!subjects.length) return '';
  const label = String(fields.fromGit) === 'true' ? 'Git' : prefix;
  const title = label + ' · ' + subjects.join(' / ');
  if (title.length <= 20) return title;
  const compact = label + ' · ' + subjects.join('/');
  return compact.length <= 20 ? compact : compact.slice(0, 19) + '…';
}

function deriveThreadTitle(prompt, tools = []) {
  for (const source of TITLE_SOURCES) {
    const tool = tools.findLast(item => item.name === source.name && item.ok !== false);
    const title = tool && toolTitleSubject(tool, source);
    if (title) return title;
  }
  if (prompt === t('ai.quickPrompt.git') || prompt === '/git') return GIT_THREAD_TITLE;
  if (prompt === t('ai.quickPrompt.labels') || prompt === '/labels') return LABELS_THREAD_TITLE;
  if (prompt === t('ai.quickPrompt.build')) return BUILD_DIAG_THREAD_TITLE;
  const request = String(prompt ?? '').trim()
    .replace(/^(?:(?:请(?:你)?(?:帮我)?|帮我|麻烦(?:帮我|你)?|能否)\s*[，,:：]?\s*)+/u, '');
  if (/^(?:先)?(?:调用|调)\s*`?get_git_changes\b/iu.test(request)) return GIT_THREAD_TITLE;
  if (/^(?:立即)?补全当前画布.*\bTASK\b.*(?:コール順|顺序)/isu.test(request)) return LABELS_THREAD_TITLE;
  if (/^(?:先)?(?:调用|调)\s*`?inspect_build_config\b/iu.test(request)) return BUILD_DIAG_THREAD_TITLE;
  const subject = request
    .replace(/^(?:(?:查看当前|(?:先)?(?:调用|调)\s*`?[A-Za-z_]\w*`?(?:\([^)]*\))?)[\s，、。:：,；;]*)+/u, '')
    .split(/[。！？!?；;\n]/u, 1)[0].trim().replace(/\s+/g, ' ');
  return [...subject].slice(0, 16).join('');
}

function newThreadObject(title = NEW_THREAD_TITLE, bm = state.activeBookmark) {
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    title,
    ...(bm?.id ? { bookmarkId: bm.id, bookmarkName: bm.name || '' } : {}),
    updatedAt: Date.now(),
    messages: [],
  };
}

function setActiveChat(id) {
  if (id !== activeChatId) {
    stickToBottom = true;
    if (restoredTurn && restoredTurn.threadId !== id) {
      inputEl.value = '';
      restoredTurn = null;
    }
  }
  activeChatId = id;
}

function activeThread() {
  let th = chatThreads.find((item) => item.id === activeChatId);
  if (!th) {
    th = newThreadObject();
    chatThreads.unshift(th);
    setActiveChat(th.id);
  }
  return th;
}

function persistChats(projectId = chatProjectId) {
  if (projectId == null) return;
  const mutation = ++chatMutation;
  const threads = chatThreads.slice(0, 30).map((th) => ({
    ...th,
    messages: (th.messages || []).slice(-80).map(({ attachedImages, ...rest }) => rest),
  }));
  boundSavedCodeAttachments(threads, activeChatId);
  const payload = { projectId, activeId: activeChatId, threads };
  void api.saveAiChats(payload).catch(error => {
    if (projectId === chatProjectId && mutation === chatMutation) {
      setChatStatus(() => t('ai.thread.saveError', { error: error.message }), true);
    }
  });
}

function finishThreadRename(save) {
  const thread = renamingThread;
  if (!thread) return;
  const title = renameInputEl.value.trim().slice(0, renameInputEl.maxLength).trimEnd();
  renamingThread = null;
  renameInputEl.hidden = true;
  chatSelectEl.hidden = false;
  renameChatBtn.disabled = chatProjectId == null;
  if (!save || !title || title === renameInputEl.defaultValue || thread.id !== activeChatId || !chatThreads.includes(thread) ||
      chatProjectId !== (state.view?.projectId ?? chatProjectId)) return;
  thread.title = title;
  thread.customTitle = true;
  renderChatBar();
  persistChats();
}

function renderChatBar() {
  if (renamingThread && (renamingThread.id !== activeChatId || !chatThreads.includes(renamingThread))) {
    finishThreadRename(false);
  }
  renameChatBtn.disabled = chatProjectId == null || Boolean(renamingThread);
  if (projectTagEl) {
    projectTagEl.textContent = chatProjectName ? t('ai.projectName', { name: chatProjectName }) : t('timeline.kindProject');
    projectTagEl.title = chatProjectName ? t('ai.currentProject', { name: chatProjectName }) : t('ai.projectHint');
  }
  if (chatSelectEl) {
    chatSelectEl.innerHTML = chatThreads.map((th) =>
      `<option value="${esc(th.id)}"${th.id === activeChatId ? ' selected' : ''}>${esc(displayThreadTitle(th))} (${th.messages.length})</option>`
    ).join('');
  }
  if (deleteChatBtn) deleteChatBtn.disabled = chatThreads.length <= 1 && !(activeThread().messages.length);
}

function messageContext(message) {
  const parts = [];
  if (message.role === 'user' && message.selectionSummary) {
    parts.push(t('ai.history.selection', { name: message.selectionSummary }));
  }
  if (message.text) parts.push(message.text);
  if (message.role === 'assistant') {
    for (const tool of message.tools || []) {
      const digest = tool.digest || tool.summary;
      if (digest) parts.push(t('ai.history.tool', { name: tool.name, result: typeof digest === 'string' ? digest : JSON.stringify(digest) }));
    }
    if (message.questionOptions?.length) {
      const options = message.questionOptions.map((opt) =>
        opt.description ? `${opt.label}（${opt.description}）` : opt.label);
      parts.push(t('ai.history.options', { options: options.join(' / ') }));
    }
  }
  return parts.filter(Boolean).join('\n');
}

function chatHistory(messages) {
  const history = messages.filter((m) => !m.error).slice(-16).map((m) => ({
    role: m.role,
    content: messageContext(m),
    ...(m.attachedFiles?.length ? { attachedFiles: m.attachedFiles } : {}),
  })).filter(m => m.content || m.attachedFiles?.length);
  boundSavedCodeAttachments([{ messages: history }]);
  return history;
}

function estimateTextTokens(text) {
  let weight = 0;
  for (const ch of String(text ?? '')) {
    weight += ch.charCodeAt(0) <= 0x7f ? 28 : 120;
  }
  return Math.ceil(weight / 100);
}

function estimateContext(messages) {
  return chatHistory(messages).reduce((total, { content, attachedFiles }) =>
    total + estimateHistoryMessage(content, attachedFiles), 0);
}

function estimateHistoryMessage(content, files = []) {
  return 4 + estimateTextTokens(content) + files.reduce((total, file) =>
    total + estimateTextTokens(file.name) + estimateTextTokens(file.content), 0);
}

function formatTokens(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1000) return `${Number((n / 1000).toFixed(1))}k`;
  return String(n);
}

function formatWindowSize(limit) {
  const n = Math.max(1, Math.round(Number(limit) || DEFAULT_CONTEXT_WINDOW));
  if (n >= 4096 && n % 1024 === 0) return `${n / 1024}k`;
  if (n >= 1000 && n % 1000 === 0) return `${n / 1000}k`;
  return formatTokens(n);
}

function resolveMetricsTokens(metrics) {
  if (!metrics || typeof metrics !== 'object') return null;
  const promptTokens = Number(metrics.promptTokens ?? metrics.contextTokens) || 0;
  const outputTokens = Number(metrics.outputTokens ?? metrics.completionTokens) || 0;
  const total = Number(metrics.totalTokens) || (promptTokens + outputTokens) || Number(metrics.contextEstTokens) || 0;
  if (total <= 0) return null;
  return { total, promptTokens, outputTokens, estimated: Boolean(metrics.estimated) };
}

function computeContextState(thread, liveMetrics) {
  const live = resolveMetricsTokens(liveMetrics);
  if (live) {
    return { used: live.total, promptTokens: live.promptTokens, outputTokens: live.outputTokens, estimated: live.estimated, hasMetrics: true };
  }
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  if (!messages.length) {
    return { used: 0, promptTokens: 0, outputTokens: 0, estimated: false, hasMetrics: false };
  }
  let baseIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (resolveMetricsTokens(messages[i]?.metrics)) {
      baseIdx = i;
      break;
    }
  }
  const saved = resolveMetricsTokens(baseIdx >= 0 ? messages[baseIdx].metrics : thread?.metrics);
  if (saved) {
    const trailing = baseIdx >= 0 ? messages.slice(baseIdx + 1) : [];
    const extra = trailing.reduce((sum, msg) =>
      sum + (msg.error ? 0 : estimateHistoryMessage(messageContext(msg), msg.attachedFiles)), 0);
    return {
      used: saved.total + extra,
      promptTokens: saved.promptTokens,
      outputTokens: saved.outputTokens,
      estimated: saved.estimated || extra > 0,
      hasMetrics: true,
    };
  }
  return {
    used: estimateContext(messages),
    promptTokens: 0,
    outputTokens: 0,
    estimated: true,
    hasMetrics: false,
  };
}

function renderContextBadge() {
  const limit = llmConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  const { used, promptTokens, outputTokens, estimated, hasMetrics } = displayedContext;
  const rawPct = limit > 0 ? (used / limit) * 100 : 0;
  const pct = used > 0 ? Math.max(1, Math.round(rawPct)) : 0;
  const barPct = Math.min(100, Math.max(0, rawPct));
  const prefix = used > 0 && estimated ? '~' : '';

  if (contextFillEl) contextFillEl.style.width = `${barPct.toFixed(1)}%`;
  if (contextTextEl) {
    contextTextEl.innerHTML = `${prefix}${formatTokens(used)} / ${formatWindowSize(limit)}<span class="ai-ctx-pct"> · ${pct}%</span>`;
  } else {
    contextBadge.textContent = `${prefix}${formatTokens(used)} / ${formatWindowSize(limit)} · ${pct}%`;
  }
  contextBadge.classList.toggle('warn', rawPct >= 65 && rawPct < 85);
  contextBadge.classList.toggle('danger', rawPct >= 85);
  compactBtn?.classList.toggle('suggest', rawPct >= 75);

  const lines = [t('ai.context.usage', { used: used.toLocaleString(getLang()), limit: limit.toLocaleString(getLang()), pct })];
  if (hasMetrics && (promptTokens > 0 || outputTokens > 0)) {
    lines.push(t('ai.context.lastTurn', { input: promptTokens.toLocaleString(getLang()), output: outputTokens.toLocaleString(getLang()), source: estimated ? t('ai.context.estimated') : t('ai.context.measured') }));
  } else if (used === 0) {
    lines.push(t('ai.context.empty'));
  } else {
    lines.push(t('ai.context.estimateHint'));
  }
  contextBadge.title = lines.join('\n');
}

function renderTelemetry(thread, liveMetrics) {
  const metrics = liveMetrics || thread.metrics || thread.messages.findLast((m) => m.metrics)?.metrics;
  displayedContext = computeContextState(thread, liveMetrics);
  renderContextBadge();

  const speed = Number(metrics?.tokensPerSecond ?? metrics?.tokPerSec);
  const tokens = Number(metrics?.outputTokens ?? metrics?.completionTokens);
  const elapsedMs = Number(metrics?.elapsedMs);
  const parts = [];
  if (Number.isFinite(tokens) && tokens > 0) {
    parts.push(t('ai.context.output', { count: (metrics?.estimated ? ', ' : '') + formatTokens(tokens) }));
  }
  if (Number.isFinite(speed) && speed > 0) {
    parts.push(`${speed.toFixed(1)} tok/s`);
  }
  speedBadge.textContent = parts.join(' · ');
  if (parts.length) {
    const detail = [];
    if (Number.isFinite(tokens) && tokens > 0) detail.push(t('ai.context.outputDetail', { n: tokens.toLocaleString(getLang()), source: metrics?.estimated ? t('ai.context.estimated') : t('ai.context.measured') }));
    if (Number.isFinite(speed) && speed > 0) detail.push(t('ai.context.speed', { n: speed.toFixed(1) }));
    if (Number.isFinite(elapsedMs) && elapsedMs >= 100) detail.push(t('ai.context.elapsed', { n: (elapsedMs / 1000).toFixed(1) }));
    speedBadge.title = detail.join(' · ');
  } else {
    speedBadge.title = '';
  }
}

// 已显示的状态也随语言刷新，服务端或模型返回的原文直接保留。
function bindStatus(element) {
  let render;
  document.addEventListener('callgraph:langchange', () => {
    if (render) element.textContent = render();
  });
  return (message = '', isError = false) => {
    render = typeof message === 'function' ? message : null;
    element.textContent = render ? render() : message;
    element.classList.toggle('err', isError);
  };
}

const setChatStatus = bindStatus(chatStatusEl);
const setApiStatus = bindStatus(apiStatusEl);

function computeInputSuggestion() {
  if (activeAbort) return '';
  const thread = chatThreads.find((item) => item.id === activeChatId);
  const latest = thread?.messages?.at(-1);
  if (latest?.role === 'assistant' && !latest.error && !Array.isArray(latest.questionOptions)) {
    const dynamic = sanitizeSuggestions(latest.suggestions);
    const first = dynamic[0] || buildFallbackFollowups(latest)[0];
    if (first?.prompt) return first.prompt;
    if (first?.draft) return first.draft;
  }
  if (canvasSelection) {
    const { questions } = describeSelection(canvasSelection);
    if (questions?.[0]?.[1]) return questions[0][1];
  }
  const nodes = state.view?.nodes || [];
  if (nodes.length) {
    const root = nodes.find((n) => n.id === state.roots?.[0]) || nodes[0];
    if (root?.name) return t('ai.suggest.root', { name: root.name });
  }
  return t('ai.suggest.git');
}

function syncInputSuggestion() {
  if (!inputEl) return;
  if (activeAbort) {
    currentGhostSuggestion = '';
    inputEl.placeholder = t('ai.steerPlaceholder');
    if (ghostTabHintEl) ghostTabHintEl.hidden = true;
    return;
  }
  currentGhostSuggestion = computeInputSuggestion();
  inputEl.placeholder = currentGhostSuggestion || '';
  if (ghostTabHintEl) {
    ghostTabHintEl.hidden = !currentGhostSuggestion || Boolean(inputEl.value);
  }
}

function acceptGhostSuggestion() {
  if (!inputEl || inputEl.value || !currentGhostSuggestion) return false;
  inputEl.value = currentGhostSuggestion;
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  syncInputSuggestion();
  return true;
}

function updateChatControls() {
  const streaming = Boolean(activeAbort);
  sendBtn.disabled = Boolean(compacting);
  sendBtn.textContent = streaming ? t('ai.steer') : t('ai.send');
  sendBtn.title = streaming ? t('ai.steerHint') : '';
  sendBtn.classList.toggle('steering', streaming);
  syncInputSuggestion();
  compactBtn.disabled = Boolean(streaming || compacting) || !activeThread().messages.length;
  stopBtn.hidden = !streaming;
  for (const chip of selectionQuestions.children) chip.disabled = Boolean(compacting);
}

function isNearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

function followChatScroll() {
  if (stickToBottom) messagesEl.scrollTop = messagesEl.querySelector('.empty') ? 0 : messagesEl.scrollHeight;
}

const NON_SYMBOL_CODE_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'auto', 'replace', 'add', 'tools', 'prompt',
  'fromGit', 'splitByGroup', 'includePaths', 'excludePaths', 'includeAllBranches',
  'bookmarkName', 'snapshotId', 'autoDetect', 'allowCustom', 'utf-8', 'cp932',
  'inspect', 'move', 'align', 'reset', 'groups', 'items', 'functions', 'vars',
]);

function findCanvasNodeBySymbol(rawSym) {
  const nodes = state.view?.nodes;
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const clean = String(rawSym || '').trim().replace(/\(\s*\)$/, '');
  if (!clean) return null;
  return nodes.find((n) => n.id === clean)
    || nodes.find((n) => n.id === `var::${clean}`)
    || nodes.find((n) => n.name === clean)
    || nodes.find((n) => n.name?.toLowerCase() === clean.toLowerCase())
    || null;
}

function isClickableSymbolToken(raw) {
  const token = String(raw || '').trim();
  if (!token || token.length < 2 || token.length > 160 || /\s/.test(token)) return false;
  if (token.startsWith('/') || token.startsWith('-')) return false;
  const clean = token.replace(/\(\s*\)$/, '');
  if (NON_SYMBOL_CODE_WORDS.has(clean)) return false;
  if (findCanvasNodeBySymbol(clean)) return true;
  if (/^(?:var::)?(?:[\w./-]+\.(?:c|h)::)??[A-Za-z_][A-Za-z0-9_]*$/.test(clean)) {
    return clean.includes('::') || clean.includes('_') || token.endsWith('()');
  }
  return false;
}

function locateSymbolFromChat(rawSym) {
  const clean = String(rawSym || '').trim().replace(/\(\s*\)$/, '');
  if (!clean) return;
  const node = findCanvasNodeBySymbol(clean);
  if (node) {
    selectNode(node.id);
    focusBox(node, 110, { keepZoom: true });
    state.flash = { box: node, until: performance.now() + 900, dur: 900 };
    draw({ geometryUnchanged: true });
    setChatStatus(() => t('ai.located', { kind: node.kind === 'var' ? t('manual.kindVar') : t('manual.kindFn'), name: node.name }));
    return;
  }
  if (els.search) {
    const query = clean.replace(/^var::/, '').split('::').pop();
    els.search.value = query;
    els.search.focus();
    void runSearch();
    setChatStatus(() => t('ai.focusSearch', { query }));
  }
}

function splitTableCells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function parseTableAlignRow(line) {
  if (!line || !line.includes('|')) return null;
  const cells = splitTableCells(line);
  if (cells.length < 2) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-{2,}:?$/.test(cell)) return null;
    if (cell.startsWith(':') && cell.endsWith(':')) aligns.push('center');
    else if (cell.endsWith(':')) aligns.push('right');
    else aligns.push('left');
  }
  return aligns;
}

function formatAssistantText(text) {
  const inline = (line) => line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (index % 2 === 0) return esc(part);
    if (part.startsWith('`')) {
      const inner = part.slice(1, -1);
      if (isClickableSymbolToken(inner)) {
        const clean = inner.trim().replace(/\(\s*\)$/, '');
        return `<button type="button" class="ai-sym-link" data-ai-sym="${esc(clean)}" title="${esc(t('ai.symbolLocate', { name: clean }))}">${esc(inner)}</button>`;
      }
      return `<code>${esc(inner)}</code>`;
    }
    return `<strong>${esc(part.slice(2, -2))}</strong>`;
  }).join('');
  const lines = String(text || '').replace(/\r\n?/g, '\n')
    .replace(/^\s*\n+/, '').replace(/\n+\s*$/, '').replace(/\n{3,}/g, '\n\n').split('\n');
  let block = '';
  let html = '';
  const closeBlock = () => {
    if (block) {
      html += `</${block}>`;
      block = '';
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 围栏代码块 ```
    if (/^\s*```/.test(line)) {
      closeBlock();
      const codeLines = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) codeLines.push(lines[i]);
      html += `<pre class="ai-md-pre"><code>${esc(codeLines.join('\n'))}</code></pre>`;
      continue;
    }

    // GFM 表格（表头行 + 对齐分隔行 + 数据行）
    const aligns = line.includes('|') && i + 1 < lines.length ? parseTableAlignRow(lines[i + 1]) : null;
    if (aligns) {
      const headers = splitTableCells(line);
      if (headers.length >= 2) {
        closeBlock();
        const colCount = Math.max(headers.length, aligns.length);
        const alignAttr = (c) => (aligns[c] && aligns[c] !== 'left' ? ` style="text-align:${aligns[c]}"` : '');
        html += '<div class="ai-table-wrap"><table class="ai-md-table"><thead><tr>';
        for (let c = 0; c < colCount; c++) {
          html += `<th${alignAttr(c)}>${inline(headers[c] || '')}</th>`;
        }
        html += '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const cells = splitTableCells(lines[i]);
          html += '<tr>';
          for (let c = 0; c < colCount; c++) {
            html += `<td${alignAttr(c)}>${inline(cells[c] || '')}</td>`;
          }
          html += '</tr>';
          i++;
        }
        i--;
        html += '</tbody></table></div>';
        continue;
      }
    }

    // 标题 #..####
    const heading = line.match(/^\s*#{1,4}\s+(\S.*)$/);
    if (heading) {
      closeBlock();
      html += `<h4 class="ai-md-h">${inline(heading[1])}</h4>`;
      continue;
    }

    // 引用 >
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeBlock();
      const qLines = [quote[1]];
      while (i + 1 < lines.length && /^\s*>\s?/.test(lines[i + 1])) {
        i++;
        qLines.push(lines[i].replace(/^\s*>\s?/, ''));
      }
      html += `<blockquote class="ai-md-quote">${qLines.map(inline).join('<br>')}</blockquote>`;
      continue;
    }

    const item = line.match(/^\s*([-*+]|\d+\.)\s+(\S.*)$/);
    const tag = item ? (/^\d/.test(item[1]) ? 'ol' : 'ul') : line.trim() ? 'p' : '';
    if (block !== tag) {
      closeBlock();
      if (tag) html += `<${tag}>`;
      block = tag;
    } else if (tag === 'p') {
      html += '<br>';
    }
    if (item) html += `<li>${inline(item[2])}</li>`;
    else if (tag) html += inline(line);
  }
  closeBlock();
  return html;
}

function followThinkingScroll(details, pre) {
  if (details.open && details.dataset.streaming === 'true' && pre.dataset.stickToBottom !== 'false') {
    pre.scrollTop = pre.scrollHeight;
  }
}

function showThinking(box, before, thinking, seconds, streaming = false) {
  if (!thinking) return;
  let details = box.querySelector('.ai-think');
  if (!details) {
    details = document.createElement('details');
    details.className = 'ai-think';
    details.open = streaming;
    details.innerHTML = '<summary></summary><pre></pre>';
    box.insertBefore(details, box.querySelector('.ai-investigate') || box.querySelector('.ai-steps') || before);
    const pre = details.querySelector('pre');
    details.querySelector('summary').addEventListener('click', () => {
      details.dataset.userToggled = '1';
    });
    pre.addEventListener('scroll', () => {
      if (pre.clientHeight) pre.dataset.stickToBottom = String(isNearBottom(pre));
    }, { passive: true });
    details.addEventListener('toggle', () => followThinkingScroll(details, pre));
  }
  details.dataset.streaming = String(streaming);
  if (!streaming && !details.dataset.userToggled) details.open = false;
  const timer = Number.isFinite(seconds) ? ` · ${seconds.toFixed(1)}s` : '';
  details.querySelector('summary').textContent = streaming
    ? t('ai.thinking', { timer: timer || '…' })
    : t('ai.thought', { timer });
  const pre = details.querySelector('pre');
  pre.textContent = thinking;
  followThinkingScroll(details, pre);
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
      if (activeAbort || compacting || activeChatId !== thread.id || thread.messages.at(-1) !== message) return;
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
    hint.textContent = t('ai.questionCustom');
    card.appendChild(hint);
  }
}

function prefillPrompt(draft) {
  inputEl.value = draft;
  inputEl.focus();
  inputEl.setSelectionRange(draft.length, draft.length);
  syncInputSuggestion();
}

function sanitizeSuggestions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const label = String(item.label ?? '').trim().slice(0, 40);
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim().slice(0, 400) : '';
    const draft = typeof item.draft === 'string' && item.draft.trim() ? item.draft.trimStart().slice(0, 200) : '';
    if (!label || (!prompt && !draft) || seen.has(label)) continue;
    seen.add(label);
    out.push(draft ? { label, draft } : { label, prompt });
    if (out.length >= 3) break;
  }
  return out;
}

function translateFollowup(option) {
  return option.draft ? { label: t(option.label), draft: option.draft }
    : { label: t(option.label), prompt: t(option.prompt) };
}

function buildFallbackFollowups(message) {
  const tools = Array.isArray(message?.tools) ? message.tools : [];
  const successfulTools = tools.filter(tool => tool.ok !== false);
  const addedToCanvas = successfulTools.some(tool => tool.name === 'add_to_canvas');
  const action = successfulTools.findLast(tool => FOLLOWUPS.has(tool.name) &&
    (tool.name !== 'get_git_changes' || !addedToCanvas));
  if (action) return FOLLOWUPS.get(action.name).map(translateFollowup);
  if (canvasSelection) {
    const { questions } = describeSelection(canvasSelection);
    if (questions?.length) {
      return [
        ...questions.slice(0, 2).map(([label, prompt]) => ({ label: `🔍 ${label}`, prompt })),
        { label: t('ai.follow.indirect'), prompt: t('ai.inspectSelection') },
      ];
    }
  }
  if (state.view?.nodes?.length) {
    return [
      translateFollowup(LABELS_FOLLOWUP),
      { label: t('ai.follow.tidy'), prompt: t('ai.action.tidy') },
      { label: t('ai.follow.git'), prompt: t('ai.reviewFiles') },
    ];
  }
  return [
    { label: t('ai.follow.git'), prompt: t('ai.action.git') },
    { label: t('ai.findFunctions'), draft: t('ai.findDraft') },
  ];
}

function renderFollowups(box, message, thread) {
  if (thread.messages.at(-1) !== message || message.error) return;
  const tools = message.tools || [];
  if (tools.some(tool => tool.name === 'ask_user')) return;
  const dynamicOptions = sanitizeSuggestions(message.suggestions);
  let options = dynamicOptions;
  const isDynamic = dynamicOptions.length > 0;
  if (!isDynamic) {
    if (message.completed === false) return;
    options = buildFallbackFollowups(message);
  }
  if (!options.length) return;

  const chips = document.createElement('div');
  chips.className = 'ai-followups';
  chips.setAttribute('role', 'group');
  chips.setAttribute('aria-label', isDynamic ? t('ai.followupDynamic') : t('ai.followupGroup'));
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ai-followup-chip';
    if (isDynamic) button.dataset.aiDynamic = 'true';
    button.textContent = option.label;
    button.title = option.prompt || option.draft || option.label;
    button.addEventListener('click', () => {
      if (compacting || activeChatId !== thread.id || thread.messages.at(-1) !== message) return;
      if (chatProjectId !== (state.view?.projectId ?? chatProjectId)) return;
      if (option.draft) {
        prefillPrompt(option.draft);
        if (option.draft.startsWith(BOOKMARK_COMMAND)) setChatStatus(() => t('ai.bookmarkEnter'));
      } else {
        void sendPrompt(option.prompt);
      }
    });
    chips.appendChild(button);
  }
  box.appendChild(chips);
  syncInputSuggestion();
}

function selectionKey(selection) {
  if (selection?.kind === 'node' && selection.id) return `node:${selection.id}`;
  if (selection?.kind === 'edge' && selection.edgeKey) return `edge:${selection.edgeKey}`;
  if (selection?.kind === 'file' && typeof selection.path === 'string') return `file:${selection.path}`;
  if (selection?.kind === 'pair') {
    const a = selection.fromId || selection.ids?.[0] || '';
    const b = selection.toId || selection.ids?.[1] || '';
    if (a && b) return `pair:${a}|${b}`;
  }
  if (selection?.kind === 'dataflow' && (selection.targetId || selection.id)) {
    return `df:${selection.targetId || selection.id}:${selection.dir || 'out'}`;
  }
  return '';
}

function stripUiOnlySelectionFields(item) {
  if (!item || typeof item !== 'object') return item;
  const { _pinned, trunkBranches, trunkActiveIndex, trunkAll, ...clean } = item;
  return clean;
}

function expandSelectionItems(selection) {
  if (!selection || typeof selection !== 'object') return [];
  return [stripUiOnlySelectionFields(selection)];
}

function chipGlyph(item) {
  if (item?.kind === 'pair') return 'A↔B';
  if (item?.kind === 'dataflow') return '⇅';
  if (item?.kind === 'edge') return '→';
  if (item?.kind === 'file') return '📄';
  if (item?.nodeKind === 'var' || item?.kind === 'var') return '◇';
  return 'ƒ';
}

function describeSelection(selection) {
  if (selection.kind === 'pair') {
    const [a, b] = selection.nodes || [];
    const idA = selection.fromId || a?.id || selection.ids?.[0] || '';
    const idB = selection.toId || b?.id || selection.ids?.[1] || '';
    const nameA = selection.fromName || a?.name || idA.split('::').pop() || '';
    const nameB = selection.toName || b?.name || idB.split('::').pop() || '';
    const n = Number(selection.pathCount) || (selection.visiblePaths?.length || 0);
    const rwCount = Array.isArray(selection.rwPaths) ? selection.rwPaths.length : 0;
    const caption = n || rwCount
      ? t('ai.selection.pair', { nameA, nameB, n, rwCount })
      : t('ai.selection.noPath', { nameA, nameB });
    return {
      caption,
      questions: (n || rwCount) ? [
        [t('ai.question.pair'), t('ai.prompt.pair', { idA, idB })],
        [t('ai.question.paths'), t('ai.prompt.paths', { idA, idB })],
      ] : [
        [t('ai.question.noPath'), t('ai.prompt.noPath', { idA, idB })],
        [t('ai.question.findRelation'), t('ai.prompt.findRelation', { idA, idB })],
      ],
    };
  }
  if (selection.kind === 'dataflow') {
    const id = selection.targetId || selection.id || '';
    const name = selection.targetName || selection.name || id.replace(/^var::/, '').split('::').pop();
    const dirLabel = selection.dir === 'in' ? t('ai.selection.in') : selection.dir === 'both' ? t('ai.selection.both') : t('ai.selection.out');
    return {
      caption: t('ai.selection.flow', { dirLabel, name }),
      questions: [
        [t('ai.question.flow'), t('ai.prompt.flowSelection', { id, dirLabel })],
        [t('ai.question.present'), t('ai.prompt.presentFlow', { id })],
      ],
    };
  }
  if (selection.kind === 'node') {
    const { id, name, file, line } = selection;
    const variable = selection.nodeKind === 'var';
    const location = file ? ` (${file}${line ? `:${line}` : ''})` : '';
    return {
      caption: t('ai.selection.caption', { kind: variable ? t('manual.kindVar') : t('manual.kindFn'), name: (name || id) + location }),
      questions: variable ? [
        [t('ai.question.variable'), t('ai.prompt.variable', { id })],
        [t('ai.question.readWrite'), t('ai.prompt.readWrite', { id })],
      ] : [
        [t('ai.question.function'), t('ai.prompt.function', { id })],
        [t('ai.question.upstream'), t('ai.prompt.upstream', { id })],
      ],
    };
  }
  if (selection.kind === 'edge') {
    const { from, to, fromName, toName, labels = [], line } = selection;
    const tag = labels.find(label => label.preset === 'task')?.text || labels[0]?.text;
    const endpoints = `${fromName || from?.split('::').pop()} → ${toName || to?.split('::').pop()}`;
    const edgeRef = `「${from} → ${to}」${line ? t('ai.selection.line', { line }) : ''}`;
    return {
      caption: t('ai.selection.edge', { tagText: tag ? ` [${tag}]` : '', endpoints }),
      questions: [
        [t('ai.question.edge'), t('ai.prompt.edge', { edgeRef })],
        [t('ai.question.period'), t('ai.prompt.period', { edgeRef })],
      ],
    };
  }
  const directory = selection.containerKind === 'dir';
  const kind = directory ? t('ai.directory') : t('ai.file');
  const path = selection.path || '.';
  return {
    caption: t('ai.selection.caption', { kind, name: selection.path || selection.label || path }),
    questions: [
      [directory ? t('ai.question.dir') : t('ai.question.file'), t('ai.prompt.fileFunctions', { kind, path })],
      [t('ai.question.impact'), t('ai.prompt.fileImpact', { kind, path })],
    ],
  };
}

function selectTrunkBranchAt(index) {
  const branches = canvasSelection?.kind === 'edge' ? canvasSelection.trunkBranches : null;
  if (!Array.isArray(branches) || branches.length < 2) return;
  const wrapped = ((index % branches.length) + branches.length) % branches.length;
  const targetDetail = branches[wrapped];
  const trunkHits = Array.isArray(state.trunkHits) && state.trunkHits.length > 1 ? state.trunkHits : null;
  const targetEdge = trunkHits?.find((e) => edgeKey(e) === targetDetail?.edgeKey)
    || state.view?.edges?.find((e) => edgeKey(e) === targetDetail?.edgeKey);
  if (targetEdge && typeof hooks.selectEdge === 'function') {
    hooks.selectEdge(targetEdge, { trunkHits, trunkGroup: null, scrollToTrunkBranch: true });
  }
}

function renderSelectionBar() {
  const hasPinned = pinnedSelections.length > 0;
  const hasActive = Boolean(canvasSelection);
  selectionBar.hidden = !hasPinned && !hasActive;

  if (pinnedListEl) {
    pinnedListEl.hidden = !hasPinned;
    pinnedListEl.replaceChildren();
    if (hasPinned) {
      for (const item of pinnedSelections) {
        const key = selectionKey(item);
        const { caption } = describeSelection(item);
        const glyph = chipGlyph(item);
        const chip = document.createElement('span');
        chip.className = item._pinned ? 'ai-pinned-chip is-pinned' : 'ai-pinned-chip';
        chip.title = `${caption}${item._pinned ? t('ai.pin.lockedSuffix') : t('ai.pin.onceSuffix')}`;
        const label = document.createElement('span');
        label.textContent = `${glyph} ${caption}`;
        const pinToggle = document.createElement('button');
        pinToggle.type = 'button';
        pinToggle.className = 'ai-pinned-pin';
        pinToggle.setAttribute('aria-pressed', String(Boolean(item._pinned)));
        pinToggle.setAttribute('aria-label', item._pinned ? t('ai.pin.unlock', { caption }) : t('ai.pin.lock', { caption }));
        pinToggle.title = item._pinned ? t('ai.pin.lockedHint') : t('ai.pin.hint');
        pinToggle.textContent = '📌';
        pinToggle.addEventListener('click', () => {
          item._pinned = !item._pinned;
          renderSelectionBar();
        });
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ai-pinned-rm';
        rm.setAttribute('aria-label', t('ai.pin.remove', { caption }));
        rm.textContent = '×';
        rm.addEventListener('click', () => {
          const idx = pinnedSelections.findIndex((x) => selectionKey(x) === key);
          if (idx >= 0) pinnedSelections.splice(idx, 1);
          renderSelectionBar();
        });
        chip.append(label, pinToggle, rm);
        pinnedListEl.appendChild(chip);
      }
      if (pinnedSelections.length >= 2) {
        const clearAll = document.createElement('button');
        clearAll.type = 'button';
        clearAll.className = 'ai-pinned-clear';
        clearAll.textContent = t('ai.pin.clear', { n: pinnedSelections.length });
        clearAll.addEventListener('click', () => {
          pinnedSelections.length = 0;
          selectedRelationIntent = 'auto';
          renderSelectionBar();
        });
        pinnedListEl.appendChild(clearAll);
      }
    }
  }

  if (relationBarEl) {
    const showRel = pinnedSelections.length >= 2 || pinnedSelections.some(s => s?.kind === 'pair' || s?.kind === 'dataflow');
    relationBarEl.hidden = !showRel;
    if (showRel) {
      for (const relBtn of relationBarEl.querySelectorAll('.ai-rel-btn')) {
        relBtn.classList.toggle('on', relBtn.dataset.aiRel === selectedRelationIntent);
      }
    }
  }

  if (selectionRowEl) selectionRowEl.hidden = !hasActive;
  if (trunkSwitchEl) {
    const branches = hasActive && canvasSelection.kind === 'edge' && Array.isArray(canvasSelection.trunkBranches) && canvasSelection.trunkBranches.length > 1
      ? canvasSelection.trunkBranches
      : null;
    trunkSwitchEl.hidden = !branches;
    if (branches && trunkSelectEl) {
      const activeIdx = Number.isInteger(canvasSelection.trunkActiveIndex) && canvasSelection.trunkActiveIndex >= 0
        ? canvasSelection.trunkActiveIndex
        : Math.max(0, branches.findIndex((b) => b.edgeKey === canvasSelection.edgeKey));
      if (trunkBadgeEl) trunkBadgeEl.textContent = t('ai.trunkPosition', { current: activeIdx + 1, total: branches.length });
      trunkSelectEl.replaceChildren(...branches.map((b, idx) => {
        const from = b.fromName || b.from?.split('::').pop() || '';
        const to = b.toName || b.to?.split('::').pop() || '';
        const line = b.line ? ` :${b.line}` : '';
        return new Option(`${idx + 1}. ${from} → ${to}${line}`, String(idx), false, idx === activeIdx);
      }));
      trunkSelectEl.value = String(activeIdx);
    }
  }
  selectionQuestions.replaceChildren();
  if (hasActive) {
    const { caption, questions } = describeSelection(canvasSelection);
    selectionText.textContent = selectionText.title = `${chipGlyph(canvasSelection)} ${caption}`;
    const activeKey = selectionKey(canvasSelection);
    const alreadyPinned = pinnedSelections.some((item) => selectionKey(item) === activeKey);
    if (pinSelectionBtn) {
      pinSelectionBtn.disabled = alreadyPinned || pinnedSelections.length >= MAX_PINNED_SELECTIONS;
      pinSelectionBtn.textContent = alreadyPinned ? '✓' : '+';
      pinSelectionBtn.title = alreadyPinned
        ? t('ai.pin.attached')
        : pinnedSelections.length >= MAX_PINNED_SELECTIONS
          ? t('ai.pin.limit', { n: MAX_PINNED_SELECTIONS })
          : t('ai.pin.previewHint');
    }
    for (const [label, prompt] of questions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-followup-chip';
      chip.textContent = label;
      chip.disabled = Boolean(compacting);
      chip.addEventListener('click', () => {
        const stagedOk = pinSelectionSnapshot(canvasSelection, { quiet: true });
        const frozenCtx = currentUiContext();
        if (!stagedOk && pinnedSelections.length >= MAX_PINNED_SELECTIONS) {
          setChatStatus(() => t('ai.pin.full', { n: MAX_PINNED_SELECTIONS }), false);
        }
        void sendPrompt(prompt, frozenCtx);
      });
      selectionQuestions.appendChild(chip);
    }
  }
  followChatScroll();
}

function setCanvasSelection(selection, explicit = false) {
  const key = selectionKey(selection);
  if (explicit) dismissedSelectionKeys.delete(key);
  const next = key && !dismissedSelectionKeys.has(key) ? selection : null;
  if (canvasSelection === next) return;
  canvasSelection = next;
  renderSelectionBar();
  syncInputSuggestion();
}

function pinSelectionSnapshot(selection, { pinned = false, quiet = false } = {}) {
  if (!selection) return false;
  const clean = stripUiOnlySelectionFields(selection);
  const key = selectionKey(clean);
  if (!key) return false;
  if (pinnedSelections.some((x) => selectionKey(x) === key)) return true;
  if (pinnedSelections.length >= MAX_PINNED_SELECTIONS) {
    if (!quiet) setChatStatus(() => t('ai.pin.kept', { n: MAX_PINNED_SELECTIONS }), true);
    return false;
  }
  pinnedSelections.push({ ...clean, ...(pinned ? { _pinned: true } : {}) });
  renderSelectionBar();
  if (!quiet) {
    const n = pinnedSelections.length;
    setChatStatus(() => t('ai.pin.added', { n }));
  }
  return true;
}

function pinCurrentSelection() {
  pinSelectionSnapshot(canvasSelection);
}

function summarizeUiContext(uiContext) {
  if (!uiContext || typeof uiContext !== 'object') return '';
  const list = Array.isArray(uiContext.items) && uiContext.items.length ? uiContext.items : [uiContext];
  const labels = list.map((item) => {
    if (!item || typeof item !== 'object') return '';
    if (item.kind === 'node') return t('ai.history.node', { id: item.id || item.name || '' }).trim();
    if (item.kind === 'edge') {
      const endpoints = item.from && item.to ? `${item.from} → ${item.to}` : (item.edgeKey || '');
      return endpoints ? t('ai.history.edge', { endpoints }) : '';
    }
    if (item.kind === 'pair') {
      const a = item.fromName || item.fromId || '';
      const b = item.toName || item.toId || '';
      return a && b ? t('ai.history.pair', { a, b }) : '';
    }
    if (item.kind === 'dataflow') {
      const tName = item.targetName || item.targetId || '';
      return tName ? t('ai.history.flow', { name: tName }) : '';
    }
    if (item.kind === 'file') return item.path ? t('ai.history.file', { path: item.path }) : '';
    return '';
  }).filter(Boolean);
  if (!labels.length) return '';
  return labels.join(t('ai.history.sep')).slice(0, 260);
}

/** 仅返回用户明确附着/暂存进芯片槽位的上下文（被动候选绝不自动发送）。 */
function currentUiContext() {
  const items = [];
  const seen = new Set();
  for (const source of pinnedSelections) {
    for (const item of expandSelectionItems(source)) {
      const key = selectionKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      items.push(item);
      if (items.length >= MAX_PINNED_SELECTIONS) break;
    }
    if (items.length >= MAX_PINNED_SELECTIONS) break;
  }
  if (!items.length) return undefined;
  return {
    ...items[0],
    items,
    ...(selectedRelationIntent && selectedRelationIntent !== 'auto' ? { relationIntent: selectedRelationIntent } : {}),
  };
}

function consumeUnpinnedStagedSelections(sentUiContext) {
  if (!sentUiContext?.items?.length) return;
  const sentKeys = new Set(sentUiContext.items.map(selectionKey).filter(Boolean));
  const kept = pinnedSelections.filter((item) => item._pinned || !sentKeys.has(selectionKey(item)));
  if (kept.length !== pinnedSelections.length) {
    pinnedSelections.splice(0, pinnedSelections.length, ...kept);
    if (!pinnedSelections.length) selectedRelationIntent = 'auto';
    renderSelectionBar();
  }
}

function buildCanvasLayoutSnapshot() {
  const v = state.view;
  if (!v || !Array.isArray(v.nodes) || !v.nodes.length) return undefined;
  return {
    root: (Array.isArray(state.roots) && state.roots.length ? state.roots.join('+') : '') || v.root || '',
    mode: state.groupMode || (state.group ? 'file' : 'flat'),
    width: Math.round(v.width || 0),
    height: Math.round(v.height || 0),
    nodes: v.nodes.slice(0, 200).map((n) => ({
      id: n.id,
      name: n.name,
      kind: n.kind === 'var' ? 'var' : 'fn',
      file: n.file || '',
      group: n.group || '',
      x: Math.round(n.x),
      y: Math.round(n.y),
      w: Math.round(n.w),
      h: Math.round(n.h),
    })),
    groups: (v.groups || []).slice(0, 100).map((g) => ({
      id: g.id,
      x: Math.round(g.x),
      y: Math.round(g.y),
      w: Math.round(g.w),
      h: Math.round(g.h),
    })),
    containers: (v.containers || []).slice(0, 100).map((c) => ({
      id: c.id,
      x: Math.round(c.x),
      y: Math.round(c.y),
      w: Math.round(c.w),
      h: Math.round(c.h),
    })),
  };
}

function openImageLightbox(dataUrl, caption = '') {
  if (!lightboxEl || !lightboxImgEl) return;
  lightboxImgEl.src = dataUrl;
  if (lightboxCaptionEl) lightboxCaptionEl.textContent = caption || t('ai.lightboxCaption');
  lightboxEl.hidden = false;
}

function closeImageLightbox() {
  if (!lightboxEl) return;
  lightboxEl.hidden = true;
  if (lightboxImgEl) lightboxImgEl.removeAttribute('src');
}

function updateAttachButton() {
  if (!attachShotBtn) return;
  const total = pendingImages.length + pendingFiles.length;
  attachShotBtn.setAttribute('aria-pressed', String(total > 0));
  if (total > 0) {
    const parts = [];
    if (pendingImages.length) parts.push(t('ai.imageCount', { n: pendingImages.length }));
    if (pendingFiles.length) parts.push(t('ai.fileCount', { n: pendingFiles.length }));
    attachShotBtn.textContent = t('ai.attachedCount', { items: parts.join('+') });
  } else {
    attachShotBtn.textContent = t('ai.attach');
  }
}

function renderAttachments() {
  updateAttachButton();
  if (!attachmentsEl) return;
  const hasAny = pendingImages.length > 0 || pendingFiles.length > 0;
  attachmentsEl.hidden = !hasAny;
  attachmentsEl.replaceChildren();
  if (!hasAny) return;

  for (const img of pendingImages) {
    const card = document.createElement('div');
    card.className = 'ai-att-img';
    const thumb = document.createElement('img');
    thumb.className = 'ai-att-thumb';
    thumb.src = img.dataUrl;
    thumb.alt = img.label || t('ai.screenshot');
    thumb.title = t('ai.previewHint');
    thumb.addEventListener('click', () => openImageLightbox(img.dataUrl, `${img.label} (${img.width}×${img.height})`));
    const meta = document.createElement('div');
    meta.className = 'ai-att-meta';
    const name = document.createElement('span');
    name.className = 'ai-att-name';
    name.textContent = name.title = img.label || t('ai.canvasShot');
    const sub = document.createElement('span');
    sub.className = 'ai-att-sub';
    sub.textContent = t('ai.thumbHint', { width: img.width, height: img.height });
    meta.append(name, sub);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ai-att-rm';
    rm.setAttribute('aria-label', t('ai.removeImage', { label: img.label }));
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      const idx = pendingImages.findIndex((x) => x.id === img.id);
      if (idx >= 0) pendingImages.splice(idx, 1);
      renderAttachments();
    });
    card.append(thumb, meta, rm);
    attachmentsEl.appendChild(card);
  }

  for (const file of pendingFiles) {
    const chip = document.createElement('div');
    chip.className = 'ai-att-file';
    const title = document.createElement('span');
    title.textContent = `📄 ${file.name}`;
    title.title = t('ai.fileLines', { name: file.name, n: file.lines.length });
    const range = document.createElement('span');
    range.className = 'ai-att-range';
    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.min = '1';
    startInput.max = String(Math.max(1, file.lines.length));
    startInput.value = String(file.startLine);
    startInput.title = t('ai.startLine');
    const endInput = document.createElement('input');
    endInput.type = 'number';
    endInput.min = '1';
    endInput.max = String(Math.max(1, file.lines.length));
    endInput.value = String(file.endLine);
    endInput.title = t('ai.endLine');
    const syncRange = () => {
      const total = Math.max(1, file.lines.length);
      file.startLine = Math.max(1, Math.min(total, Math.trunc(Number(startInput.value) || 1)));
      file.endLine = Math.max(file.startLine, Math.min(total, Math.trunc(Number(endInput.value) || total)));
      startInput.value = String(file.startLine);
      endInput.value = String(file.endLine);
    };
    startInput.addEventListener('change', syncRange);
    endInput.addEventListener('change', syncRange);
    range.append('L', startInput, '-', endInput, t('ai.linesTotal', { n: file.lines.length }));
    if (file.saved) range.textContent = `L${file.startLine}–${file.endLine}`;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ai-att-rm';
    rm.setAttribute('aria-label', t('ai.removeFile', { name: file.name }));
    rm.textContent = '×';
    rm.addEventListener('click', () => {
      const idx = pendingFiles.findIndex((x) => x.id === file.id);
      if (idx >= 0) pendingFiles.splice(idx, 1);
      renderAttachments();
    });
    chip.append(title, range, rm);
    attachmentsEl.appendChild(chip);
  }
}

function addImageAttachment(img) {
  if (!img?.dataUrl) return false;
  if (pendingImages.length >= MAX_PENDING_IMAGES) {
    pendingImages.shift();
  }
  pendingImages.push({
    id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    dataUrl: img.dataUrl,
    label: img.label || t('ai.image'),
    width: img.width || 0,
    height: img.height || 0,
  });
  renderAttachments();
  return true;
}

function captureViewportImage() {
  const cv = els.cv;
  if (!cv || !cv.width || !cv.height) return null;
  try {
    const maxDim = 1280;
    const scale = Math.min(1, maxDim / Math.max(cv.width, cv.height));
    const w = Math.max(1, Math.round(cv.width * scale));
    const h = Math.max(1, Math.round(cv.height * scale));
    const off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const ctx = off.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#F7F6F2';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(cv, 0, 0, w, h);
    ctx.save();
    ctx.scale(scale, scale);
    compositeEffects(ctx);
    ctx.restore();
    const dataUrl = off.toDataURL('image/jpeg', 0.85);
    return dataUrl.startsWith('data:image/') ? { dataUrl, width: w, height: h, label: t('ai.canvasView') } : null;
  } catch {
    return null;
  }
}

function resolveSelectedCanvasBox() {
  const v = state.view;
  if (!v) return null;
  const findBox = (kind, id) => {
    if (!id) return null;
    if (kind === 'file') {
      const g = (v.groups || []).find((x) => x.id === id);
      return g ? { kind: 'file', box: g, label: t('ai.selection.file', { name: g.label || g.id }) } : null;
    }
    const c = (v.containers || []).find((x) => x.id === id && !x.root);
    return c ? { kind: 'dir', box: c, label: t('ai.selection.dir', { name: c.label || c.id }) } : null;
  };
  if (state.ctxBox?.id) {
    const found = findBox(state.ctxBox.kind, state.ctxBox.id);
    if (found) return found;
  }
  if (canvasSelection?.kind === 'file' && canvasSelection.path) {
    const found = findBox(canvasSelection.containerKind === 'dir' ? 'dir' : 'file', canvasSelection.path);
    if (found) return found;
  }
  if (state.selected) {
    const node = (v.nodes || []).find((n) => n.id === state.selected);
    if (node?.group) {
      const found = findBox('file', node.group);
      if (found) return found;
    }
  }
  return null;
}

function captureScopedBoxAttachment(entry) {
  if (!entry?.box) return false;
  const shot = captureBoxImage(entry.box, { padding: 28, maxDim: 1280 });
  if (!shot) {
    setChatStatus(() => t('ai.captureFail'), true);
    return false;
  }
  addImageAttachment({ ...shot, label: entry.label || entry.box.label || entry.box.id });
  setChatStatus(() => t('ai.captured', { name: entry.label }));
  return true;
}

function encodeImageBlob(blob, label = t('ai.externalShot')) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      try {
        const maxDim = 1280;
        const scale = Math.min(1, maxDim / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
        const w = Math.max(1, Math.round((img.naturalWidth || 1) * scale));
        const h = Math.max(1, Math.round((img.naturalHeight || 1) * scale));
        const off = document.createElement('canvas');
        off.width = w;
        off.height = h;
        const ctx = off.getContext('2d');
        if (!ctx) { resolve(null); return; }
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = off.toDataURL('image/jpeg', 0.85);
        resolve(dataUrl.startsWith('data:image/') ? { dataUrl, width: w, height: h, label } : null);
      } catch {
        resolve(null);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

async function addImageFromBlob(blob, label = t('ai.clipboardShot')) {
  const encoded = await encodeImageBlob(blob, label);
  if (!encoded) {
    setChatStatus(() => t('ai.imageError'), true);
    return false;
  }
  addImageAttachment(encoded);
  setChatStatus(() => t('ai.imageAdded', { w: encoded.width, h: encoded.height, label }));
  return true;
}

async function addExternalTextFile(file) {
  if (!file) return false;
  if (file.size > 1_500_000) {
    setChatStatus(() => t('ai.fileTooLarge', { name: file.name }), true);
    return false;
  }
  const text = await file.text().catch(() => null);
  if (typeof text !== 'string' || !text.trim()) {
    setChatStatus(() => t('ai.fileEmpty', { name: file.name }), true);
    return false;
  }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (pendingFiles.length >= MAX_PENDING_FILES) pendingFiles.shift();
  const endLine = Math.min(lines.length, 200);
  pendingFiles.push({
    id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: file.name,
    lines,
    startLine: 1,
    endLine,
  });
  renderAttachments();
  setChatStatus(() => t('ai.fileAdded', { name: file.name, n: lines.length, endLine }));
  return true;
}

function closeAttachMenu() {
  if (!attachMenuEl) return;
  attachMenuEl.hidden = true;
  attachShotBtn?.setAttribute('aria-expanded', 'false');
}

function openAttachMenu() {
  if (!attachMenuEl) return;
  attachMenuEl.replaceChildren();
  const addItem = (title, hint, onClick, disabled = false) => {
    const btnEl = document.createElement('button');
    btnEl.type = 'button';
    btnEl.setAttribute('role', 'menuitem');
    btnEl.disabled = disabled;
    const span = document.createElement('span');
    span.textContent = title;
    btnEl.appendChild(span);
    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      btnEl.appendChild(small);
    }
    btnEl.addEventListener('click', () => {
      closeAttachMenu();
      onClick();
    });
    attachMenuEl.appendChild(btnEl);
  };
  const addSep = () => {
    const sep = document.createElement('div');
    sep.className = 'ai-attach-sep';
    attachMenuEl.appendChild(sep);
  };
  const addTitle = (text) => {
    const el = document.createElement('div');
    el.className = 'ai-attach-menu-title';
    el.textContent = text;
    attachMenuEl.appendChild(el);
  };

  addTitle(t('ai.captureMenu'));
  const hasNodes = Boolean(state.view?.nodes?.length);
  addItem(t('ai.captureCurrent'), t('ai.viewport'), () => {
    const shot = captureViewportImage();
    if (shot) {
      addImageAttachment(shot);
      setChatStatus(() => t('ai.capturedView'));
    } else {
      setChatStatus(() => t('ai.captureEmpty'), true);
    }
  }, !hasNodes);

  const selectedBox = resolveSelectedCanvasBox();
  addItem(
    selectedBox ? t('ai.captureSelected') : t('ai.captureBox'),
    selectedBox ? selectedBox.label : t('ai.selectBox'),
    () => captureScopedBoxAttachment(selectedBox),
    !selectedBox,
  );

  const v = state.view;
  const pickableBoxes = [
    ...(v?.containers || []).filter((c) => !c.root).map((c) => ({ kind: 'dir', box: c, label: t('ai.selection.dir', { name: c.label || c.id }) })),
    ...(v?.groups || []).map((g) => ({ kind: 'file', box: g, label: t('ai.selection.file', { name: g.label || g.id }) })),
  ].slice(0, 8);
  if (pickableBoxes.length) {
    addSep();
    addTitle(t('ai.captureBoxes'));
    for (const entry of pickableBoxes) {
      addItem(entry.kind === 'dir' ? `📁 ${entry.box.label || entry.box.id}` : `📄 ${entry.box.label || entry.box.id}`, entry.box.id, () => {
        captureScopedBoxAttachment(entry);
      });
    }
  }

  addSep();
  addTitle(t('ai.importMenu'));
  addItem(t('ai.importImage'), 'PNG / JPG / WebP', () => imageFileInputEl?.click());
  addItem(t('ai.importFile'), t('ai.importRange'), () => textFileInputEl?.click());

  attachMenuEl.hidden = false;
  attachShotBtn?.setAttribute('aria-expanded', 'true');
}

const emptyChatEl = messagesEl.querySelector('.empty');

function syncPresentationHud() {
  if (!presHudEl) return;
  const pres = state.presentation;
  const steps = Array.isArray(pres?.steps) ? pres.steps : [];
  if (!pres || !steps.length) {
    presHudEl.hidden = true;
    return;
  }
  const idx = Math.max(0, Math.min(steps.length - 1, Number(pres.activeIndex) || 0));
  const step = steps[idx];
  presHudEl.hidden = false;
  if (presHudTitleEl) presHudTitleEl.textContent = `${pres.title || t('ai.walkthrough')} · ${step.title || t('ai.step', { n: idx + 1 })}`;
  if (presHudSubEl) presHudSubEl.textContent = step.summary || '';
  if (presHudCounterEl) presHudCounterEl.textContent = `${idx + 1}/${steps.length}`;
  if (presPrevBtn) presPrevBtn.disabled = idx <= 0;
  if (presNextBtn) presNextBtn.disabled = idx >= steps.length - 1;
}

function activatePresentation(pres, stepIndex = 0) {
  const steps = Array.isArray(pres?.steps) ? pres.steps : [];
  if (!pres || !steps.length) {
    state.presentation = null;
    state.aiOverlay = null;
    syncPresentationHud();
    draw();
    return;
  }
  const idx = Math.max(0, Math.min(steps.length - 1, stepIndex));
  const step = steps[idx];
  state.presentation = { ...pres, activeIndex: idx };
  state.aiOverlay = {
    action: 'highlight',
    nodeIds: step.nodeIds || [],
    edgeKeys: step.edgeKeys || [],
    focusNodeId: step.focusNodeId || step.nodeIds?.[0] || null,
    stepNumber: idx + 1,
    label: step.title || pres.title || t('ai.walkthrough'),
  };
  syncPresentationHud();
  const focusId = step.focusNodeId || step.nodeIds?.[0];
  const node = focusId && state.view?.nodes?.find((n) => n.id === focusId);
  if (node) focusBox(node, 110, { keepZoom: true });
  draw();
}

function ensureInvestigateContainer(box, before, collapsed = false) {
  let inv = box.querySelector('.ai-investigate');
  if (!inv) {
    inv = document.createElement('details');
    inv.className = 'ai-investigate';
    inv.open = !collapsed;
    inv.innerHTML = '<summary></summary><div class="ai-steps"></div>';
    inv.querySelector('summary').textContent = t('ai.investigation');
    if (before) box.insertBefore(inv, before);
    else box.appendChild(inv);
  }
  return { inv, summary: inv.querySelector('summary'), steps: inv.querySelector('.ai-steps') };
}

function updateInvestigateSummary(inv, count, running = false) {
  const summary = inv?.querySelector('summary');
  if (!summary) return;
  summary.textContent = running ? t('ai.toolsRunning', { count }) : t('ai.toolsDone', { count });
}

function renderSubagentCards(box, subagents, before = null) {
  if (!Array.isArray(subagents) || !subagents.length) return;
  let listEl = box.querySelector('.ai-subagent-list');
  if (!listEl) {
    listEl = document.createElement('div');
    listEl.className = 'ai-subagent-list';
    if (before) box.insertBefore(listEl, before);
    else box.appendChild(listEl);
  }
  listEl.replaceChildren();
  for (const sa of subagents) {
    const card = document.createElement('div');
    card.className = 'ai-subagent-card';
    const head = document.createElement('div');
    head.className = 'ai-subagent-head';
    const icon = sa.running ? '◐' : (sa.ok !== false ? '✓' : '✕');
    head.textContent = t('ai.subtask', { title: sa.title || sa.id, icon });
    const meta = document.createElement('div');
    meta.className = 'ai-subagent-meta';
    meta.textContent = sa.running
      ? (sa.lastTool ? [t('ai.runningTool', { name: sa.lastTool }), sa.lastSummary].filter(Boolean).join(' · ') : t('ai.investigating'))
      : t('ai.subtaskDone', { n: sa.steps || 0 });
    card.append(head, meta);
    if (sa.summary) {
      const body = document.createElement('div');
      body.className = 'ai-subagent-body';
      body.textContent = sa.summary;
      card.appendChild(body);
    }
    listEl.appendChild(card);
  }
}

function chainEdgeKeys(chain, nodeIds) {
  if (chain.edgeKeys?.length) return chain.edgeKeys;
  // 旧版单边导览卡把完整调用点键存在 id 中，其他旧链路只保留了端点。
  if (chain.id?.startsWith('pres_edge:')) return [chain.id.slice('pres_edge:'.length)];
  return nodeIds.slice(1).map((to, i) => {
    const from = nodeIds[i];
    return chain.kind === 'dataflow' && from.startsWith('var::') ? `${to}->${from}` : `${from}->${to}`;
  });
}

function clearChainHover(nodeId) {
  if (nodeId && state.aiHover?.nodeId === nodeId) {
    state.aiHover = null;
    draw();
  }
}

function renderChainCards(box, chains) {
  if (!Array.isArray(chains) || !chains.length) return;
  const txtEl = box.querySelector('.ai-msg-text');
  for (const chain of chains.slice(0, 6)) {
    const steps = Array.isArray(chain?.steps) ? chain.steps : [];
    if (!steps.length) continue;
    const card = document.createElement('div');
    card.className = 'ai-chain-card';
    // 严格分离点击区：卡片主体不绑点击，头部只放链路级操作，节点芯片只聚焦单节点。
    const head = document.createElement('div');
    head.className = 'ai-chain-head';
    const title = document.createElement('span');
    title.className = 'ai-chain-title';
    title.textContent = `${chain.kind === 'dataflow' ? '⇅' : '⟿'} ${chain.title || t('ai.chain')}`;
    const actions = document.createElement('span');
    actions.className = 'ai-chain-actions';

    const nodeIds = steps.map((s) => s.id).filter(Boolean);
    const edgeKeys = chainEdgeKeys(chain, nodeIds);

    const hlBtn = document.createElement('button');
    hlBtn.type = 'button';
    hlBtn.textContent = t('ai.highlight');
    hlBtn.title = t('ai.highlightHint');
    hlBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.aiOverlay = { action: 'highlight', nodeIds, edgeKeys, label: chain.title || t('ai.pathHighlight') };
      draw();
    });

    const flowBtn = document.createElement('button');
    flowBtn.type = 'button';
    flowBtn.textContent = t('ai.animate');
    flowBtn.title = t('ai.animateHint');
    flowBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.aiOverlay = { action: 'play_flow', nodeIds, edgeKeys, label: chain.title || t('ai.flowAnimation') };
      draw();
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = t('ai.addChain');
    addBtn.title = t('ai.addChainHint');
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetIds = nodeIds.slice(0, 6);
      void sendPrompt(t('ai.addChainPrompt', { ids: targetIds.join(', ') }));
    });

    actions.append(hlBtn, flowBtn, addBtn);
    head.append(title, actions);

    const body = document.createElement('div');
    body.className = 'ai-chain-steps';
    steps.forEach((step, idx) => {
      if (idx > 0) {
        const arr = document.createElement('span');
        arr.className = 'ai-chain-arrow';
        arr.textContent = step.edgeKind === 'var' ? '──⇄──' : '──▶';
        body.appendChild(arr);
      }
      const nodeBtn = document.createElement('button');
      nodeBtn.type = 'button';
      nodeBtn.className = 'ai-chain-node';
      const isVar = String(step.id || '').startsWith('var::');
      nodeBtn.textContent = `${isVar ? '◇' : 'ƒ'} ${step.name || step.id}`;
      nodeBtn.title = `${step.id}${step.file ? ` (${step.file}${step.line ? `:${step.line}` : ''})` : ''}`;
      nodeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        locateSymbolFromChat(step.id || step.name);
      });
      nodeBtn.addEventListener('mouseenter', () => {
        if (!step.id) return;
        state.aiHover = { nodeId: step.id };
        draw();
      });
      nodeBtn.addEventListener('mouseleave', () => clearChainHover(step.id));
      body.appendChild(nodeBtn);
    });
    card.append(head, body);
    const anchor = txtEl?.nextSibling || null;
    if (anchor) box.insertBefore(card, anchor);
    else box.appendChild(card);
  }
}

function renderPresCard(box, pres) {
  if (!pres?.steps?.length) return;
  const card = document.createElement('div');
  card.className = 'ai-pres-card';
  const head = document.createElement('div');
  head.className = 'ai-pres-head';
  const title = document.createElement('span');
  title.textContent = t('ai.walkthroughTitle', { title: pres.title || t('ai.walkthroughDefault'), n: pres.steps.length });
  const startBtn = document.createElement('button');
  startBtn.type = 'button';
  startBtn.textContent = t('ai.startWalkthrough');
  startBtn.addEventListener('click', () => activatePresentation(pres, 0));
  head.append(title, startBtn);
  const ol = document.createElement('ol');
  ol.className = 'ai-pres-steps';
  for (const s of pres.steps.slice(0, 8)) {
    const li = document.createElement('li');
    li.textContent = [s.title, s.summary].filter(Boolean).join(' · ');
    ol.appendChild(li);
  }
  card.append(head, ol);
  box.appendChild(card);
}

function renderHealthCard(box, report) {
  if (!report) return;
  const card = document.createElement('div');
  card.className = 'ai-health-card';
  const head = document.createElement('div');
  head.className = 'ai-health-head';
  head.textContent = t('ai.health', { score: report.score ?? 100, summary: report.summary || '' });
  card.appendChild(head);
  if (Array.isArray(report.issues) && report.issues.length) {
    const list = document.createElement('div');
    list.className = 'ai-health-issues';
    for (const issue of report.issues) {
      const row = document.createElement('div');
      row.className = `ai-health-issue sev-${issue.severity || 'medium'}`;
      const rowHead = document.createElement('div');
      rowHead.style.display = 'flex';
      rowHead.style.justifyContent = 'space-between';
      rowHead.style.gap = '6px';
      const title = document.createElement('strong');
      title.textContent = issue.title || issue.id;
      rowHead.appendChild(title);
      if (issue.fixPrompt) {
        const fixBtn = document.createElement('button');
        fixBtn.type = 'button';
        fixBtn.textContent = t('ai.fix');
        fixBtn.style.height = '21px';
        fixBtn.style.fontSize = '11px';
        fixBtn.addEventListener('click', () => void sendPrompt(issue.fixPrompt));
        rowHead.appendChild(fixBtn);
      }
      row.appendChild(rowHead);
      if (issue.detail) {
        const det = document.createElement('div');
        det.style.color = '#5F5E5A';
        det.style.marginTop = '2px';
        det.textContent = issue.detail;
        row.appendChild(det);
      }
      list.appendChild(row);
    }
    card.appendChild(list);
  }
  box.appendChild(card);
}

// Keep the submitted attachments and selection available for an exact retry in this tab.
const interruptedInputs = new WeakMap();
let restoredTurn = null;

function restoreInputs(original, source, recovery, thread, canRetry) {
  const items = source?.uiContext?.items || [];
  const keys = new Set(items.map(selectionKey));
  if ((inputEl.value.trim() && inputEl.value.trim() !== original.text) || pendingFiles.length || pendingImages.length ||
      pinnedSelections.some(item => !keys.has(selectionKey(item)))) {
    setChatStatus(() => t('ai.recovery.draftBusy'), true);
    return;
  }
  const files = source?.files || (original.attachedFiles || []).map(file => ({
    id: crypto.randomUUID?.() || file.name, name: file.name, lines: file.content.split('\n'),
    startLine: file.startLine, endLine: file.endLine, saved: file,
  }));
  pendingFiles.push(...files);
  pendingImages.push(...(source?.stagedImages || []));
  for (const item of items) pinSelectionSnapshot(item, { quiet: true });
  selectedRelationIntent = source?.uiContext?.relationIntent || 'auto';
  inputEl.value = original.text;
  restoredTurn = { threadId: thread.id, projectId: chatProjectId, draft: original.text, accessMode: canRetry ? recovery.mode : 'read',
    ...(canRetry ? { retryOf: recovery.turnId } : {}) };
  renderSelectionBar();
  renderAttachments();
  updateChatControls();
  if (!source && recovery.hasContext) setChatStatus(() => t('ai.recovery.partial'));
  else if (!canRetry) setChatStatus(() => t('ai.recovery.readDraft'));
  inputEl.focus();
}

async function readTurnStatus(id, threadId) {
  for (let i = 0; i < 4; i++) {
    try {
      const result = await api.aiTurnStatus(id, threadId);
      if (result.state !== 'running' || i === 3) return result;
    } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 100 * (i + 1)));
  }
  return { state: 'unknown', canRetry: false };
}

function renderRecovery(box, entry, thread, original = thread.messages[thread.messages.indexOf(entry) - 1]) {
  const recovery = entry.recovery;
  if (!recovery || original?.role !== 'user') return;
  const source = interruptedInputs.get(entry);
  const retry = recovery.state === 'safe' && (!recovery.hasContext || source);
  const row = document.createElement('div');
  row.className = 'ai-recovery';
  const status = document.createElement('span');
  status.textContent = t('ai.recovery.' + recovery.state);
  const action = document.createElement('button');
  action.type = 'button';
  action.dataset.recovery = retry ? 'retry' : 'inspect';
  action.textContent = t(retry ? 'ai.recovery.retry' : 'ai.recovery.inspect');
  const project = chatProjectId;
  const current = () => !activeAbort && !compacting && project === chatProjectId && activeThread() === thread;
  action.onclick = async () => {
    if (!current()) return;
    action.disabled = true;
    if (retry) {
      const status = await readTurnStatus(recovery.turnId, thread.id);
      if (!current()) { action.disabled = false; return; }
      if (!status.canRetry) {
        recovery.state = status.changeset ? 'changed' : 'unknown';
        row.remove();
        renderRecovery(box, entry, thread, original);
        return;
      }
      await sendPrompt(original.text, source?.uiContext ?? null, {
        accessMode: recovery.mode, retryOf: recovery.turnId, original: source || {},
      });
    } else {
      await sendPrompt(t('ai.recovery.prompt'), null, { accessMode: 'read', original: {} });
    }
    action.disabled = false;
  };
  const restore = document.createElement('button');
  restore.type = 'button';
  restore.dataset.recovery = 'restore';
  restore.textContent = t('ai.recovery.restore');
  restore.onclick = async () => {
    if (!current()) return;
    const status = await readTurnStatus(recovery.turnId, thread.id);
    if (current()) restoreInputs(original, source, recovery, thread, status.canRetry);
  };
  row.append(status, action, restore);
  box.append(row);
}

// Reload can close the stream before its error handler runs. The saved user row carries
// its turn reference. Looking it up never overwrites another tab's in-flight transcript.
async function showPendingTurn(original, thread) {
  const box = document.createElement('div');
  box.className = 'ai-msg assistant';
  messagesEl.append(box);
  const project = chatProjectId;
  const turn = original.pendingTurn;
  const status = await readTurnStatus(turn.turnId, thread.id);
  if (!box.isConnected || project !== chatProjectId || original !== thread.messages.at(-1)) return;
  const recovery = { ...turn, state: status.changeset ? 'changed' : status.canRetry ? 'safe' : 'unknown' };
  if (status.changeset) renderChangesetUndo(box, status.changeset);
  renderRecovery(box, { recovery }, thread, original);
}

function renderChangesetUndo(box, changeset) {
  if (!changeset?.id || box.querySelector('.ai-undo-btn')) return;
  const bar = document.createElement('div');
  bar.className = 'ai-msg-toolbar';
  const btnUndo = document.createElement('button');
  btnUndo.type = 'button';
  btnUndo.className = 'ai-undo-btn';
  btnUndo.textContent = `${t('ai.undo')} (${(changeset.ops || []).join(', ') || t('ai.canvasEdit')})`;
  btnUndo.addEventListener('click', async () => {
    btnUndo.disabled = true;
    btnUndo.textContent = t('ai.undoing');
    const projectId = state.view?.projectId;
    let res;
    try {
      res = await api.aiUndoChangeset(changeset.id, getLang());
      if (!res?.ok) throw new Error(res?.error || t('ai.undoFailed'));
    } catch (err) {
      btnUndo.disabled = false;
      btnUndo.textContent = t('ai.undo');
      setChatStatus(() => t('ai.undoError', { error: err.message || err }), true);
      return;
    }
    try {
      await refreshAfterAiUndo(res, projectId);
      btnUndo.textContent = t('ai.undone');
      setChatStatus(() => t(state.at ? 'ai.undoHistory' : 'ai.restored'));
    } catch (err) {
      btnUndo.textContent = t('ai.undoRefresh');
      setChatStatus(() => t('ai.undoRefreshError', { error: err.message || err }), true);
    }
  });
  bar.appendChild(btnUndo);
  box.appendChild(bar);
}

function renderThreadMessages({ preserveStatus = false } = {}) {
  if (!messagesEl) return;
  clearChainHover(state.aiHover?.nodeId); // 替换消息 DOM 不会触发旧芯片的 mouseleave。
  const th = activeThread();
  renderTelemetry(th);
  updateChatControls();
  if (!preserveStatus) setChatStatus();
  if (!th.messages.length) {
    applyI18n(emptyChatEl);
    messagesEl.replaceChildren(emptyChatEl);
    return;
  }
  const scrollTop = messagesEl.scrollTop;
  messagesEl.innerHTML = '';
  for (const m of th.messages) {
    if (m.role === 'user') {
      const div = document.createElement('div');
      div.className = 'ai-msg user';
      buildUserBubbleContent(div, m.text || '', m.attachedImages || [], m.attachedFiles || []);
      messagesEl.appendChild(div);
      if (!activeAbort && m.pendingTurn && m === th.messages.at(-1)) void showPendingTurn(m, th);
    } else {
      const box = document.createElement('div');
      box.className = m.error ? 'ai-msg assistant error' : 'ai-msg assistant';
      if (Array.isArray(m.tools) && m.tools.length) {
        const { inv, steps } = ensureInvestigateContainer(box, null, true);
        for (const tl of m.tools) {
          finishStep(addStep(steps, tl.name), tl);
        }
        updateInvestigateSummary(inv, m.tools.length, false);
      }
      if (Array.isArray(m.subagents) && m.subagents.length) {
        renderSubagentCards(box, m.subagents);
      }
      const txt = document.createElement('div');
      txt.className = 'ai-msg-text';
      txt.innerHTML = formatAssistantText(m.text);
      box.appendChild(txt);
      showThinking(box, txt, m.thinking, m.thinkingSeconds);
      if (Array.isArray(m.chains) && m.chains.length) renderChainCards(box, m.chains);
      if (m.presentation) renderPresCard(box, m.presentation);
      if (m.healthReport) renderHealthCard(box, m.healthReport);
      if (m.changeset) renderChangesetUndo(box, m.changeset);
      if (m.recovery) renderRecovery(box, m, th);
      if (Array.isArray(m.questionOptions)) renderQuestion(txt, m, th);
      else renderFollowups(box, m, th);
      messagesEl.appendChild(box);
    }
  }
  if (!stickToBottom) messagesEl.scrollTop = scrollTop;
  followChatScroll();
}

async function loadProjectChats({ force = false } = {}) {
  const currentId = state.view?.projectId ?? null;
  if ((!force || activeAbort) && chatProjectId !== null && currentId === chatProjectId && chatThreads.length) {
    renderChatBar();
    return;
  }
  const gen = ++chatGeneration;
  const mutation = chatMutation;
  pendingSteer = null;
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  try {
    const res = await api.aiChats();
    if (gen !== chatGeneration || mutation !== chatMutation || !res?.ok) return;
    const projectId = res.projectId ?? currentId;
    const previousThreads = projectId === chatProjectId ? chatThreads : [];
    chatProjectId = projectId;
    chatProjectName = res.projectName || '';
    chatThreads = Array.isArray(res.threads) && res.threads.length ? res.threads : [newThreadObject()];
    // 重开抽屉时保留本次会话中已收到 done 的建议与动态提示。
    for (const thread of chatThreads) {
      const previous = previousThreads.find(item => item.id === thread.id && item.updatedAt === thread.updatedAt)?.messages.at(-1);
      const latest = thread.messages.at(-1);
      if (latest?.role === 'assistant') {
        const cleanSaved = sanitizeSuggestions(latest.suggestions);
        if (cleanSaved.length) latest.suggestions = cleanSaved;
        else delete latest.suggestions;
        if (previous && latest.text === previous.text) {
          if (previous.completed) latest.completed = true;
          if (!latest.suggestions?.length && previous.suggestions?.length) {
            latest.suggestions = sanitizeSuggestions(previous.suggestions);
          }
        }
      }
    }
    setActiveChat(res.activeId && chatThreads.some((x) => x.id === res.activeId) ? res.activeId : chatThreads[0].id);
    renderChatBar();
    renderThreadMessages();
  } catch {
    if (gen !== chatGeneration || mutation !== chatMutation) return;
    if (!chatThreads.length) {
      const th = newThreadObject();
      chatThreads = [th];
      setActiveChat(th.id);
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
    #aiLevels .ai-section { border-top: 1px solid #ECEAE2; padding: 12px 0; }
    #aiLevels .ai-section:first-child { border-top: 0; padding-top: 2px; }
    #aiLevels .ai-section h3 { font-size: 12px; font-weight: 600; color: #5F5E5A; margin: 0 0 8px; letter-spacing: .01em; }
    #aiLevels .ai-endpoint { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 9px; background: #FAF9F6; border: 1px solid #ECEAE2; }
    #aiLevels code { user-select: all; overflow-wrap: anywhere; font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 11.5px; color: #1B3A5C; flex: 1 1 180px; }
    #aiLevels .ai-endpoint button { height: 26px; padding: 0 9px; font-size: 11.5px; border-radius: 7px; }
    #aiLevels .ai-prompts { display: grid; gap: 6px; }
    #aiLevels [data-ai-copy] { text-align: left; white-space: normal; height: auto; min-height: 30px; padding: 5px 10px; border-radius: 8px; font-size: 12px; }
    #aiLevels [role=status] { display: block; font-size: 11.5px; margin-top: 6px; color: #235326; }
  `;
  document.head.append(style);
}

function setTab(name) {
  showApiOnOpen = false;
  for (const tab of tabs) tab.classList.toggle('on', tab.dataset.aiTab === name);
  for (const [key, pane] of Object.entries(panes)) if (pane) pane.hidden = key !== name;
  if (name === 'chat') followChatScroll();
}

function syncModelPicker() {
  modelSelectEl.value = modelEl.value.trim();
  if (modelSelectEl.selectedIndex < 0) modelSelectEl.value = '';
}

function applyFetchedModels(models, baseUrl = llmConfig.baseUrl || '') {
  fetchedModels = [...new Set((Array.isArray(models) ? models : []).map(id => String(id || '').trim()).filter(Boolean))];
  fetchedModelsBaseUrl = baseUrl;
  const placeholder = new Option(t('ai.selectFetched'), '');
  placeholder.dataset.i18n = 'ai.selectFetched';
  placeholder.disabled = true;
  modelSelectEl.replaceChildren(placeholder, ...fetchedModels.map(id => new Option(id, id)));
  modelSelectEl.hidden = !fetchedModels.length;
  syncModelPicker();
  syncQuickControls();
}

function syncQuickControls() {
  const configured = Boolean(llmConfig.baseUrl && llmConfig.model);
  if (quickModelEl) {
    const current = String(llmConfig.model || '').trim();
    const list = [];
    if (current) list.push(current);
    for (const id of fetchedModels) {
      if (!list.includes(id)) list.push(id);
    }
    const options = [];
    if (!current) {
      const emptyOpt = new Option(llmConfig.baseUrl ? t('ai.chooseModel') : t('ai.noModel'), '');
      options.push(emptyOpt);
    }
    for (const id of list) {
      options.push(new Option(id, id));
    }
    options.push(new Option(t('ai.configureModels'), QUICK_CONFIG_ACTION));
    quickModelEl.replaceChildren(...options);
    quickModelEl.value = current || '';
    quickModelEl.classList.toggle('unconfigured', !configured);
    quickModelEl.title = configured
      ? t('ai.modelCurrent', { name: current, mode: llmConfig.toolMode === 'prompt' ? t('ai.modelLegacy') : '' })
      : t('ai.modelMissingHint');
  }
  if (quickReasoningEl) {
    const effort = Object.hasOwn(EFFORT_KEYS, llmConfig.reasoningEffort) ? llmConfig.reasoningEffort : 'default';
    quickReasoningEl.value = effort;
    quickReasoningEl.title = t('ai.effortHint', { effort: t(EFFORT_KEYS[effort]) });
  }
}

async function saveQuickConfig(patch, okMessage) {
  if (quickSaving) return;
  quickSaving = true;
  if (quickModelEl) quickModelEl.disabled = true;
  if (quickReasoningEl) quickReasoningEl.disabled = true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Callgraph-Client': clientId },
      body: JSON.stringify(patch),
      signal: controller.signal,
    });
    const r = await response.json().catch(() => null);
    if (!response.ok || !r?.ok || !r.config) {
      throw new Error(r?.error || (response.ok ? t('bookmark.failed') : `HTTP ${response.status}`));
    }
    llmConfig = r.config;
    syncApiForm();
    if (okMessage) setChatStatus(okMessage);
  } catch (err) {
    syncQuickControls();
    setChatStatus(() => controller.signal.aborted ? t('ai.switchTimedOut') : t('ai.switchFailed', { error: err.message || err }), true);
  } finally {
    clearTimeout(timeout);
    quickSaving = false;
    if (quickModelEl) quickModelEl.disabled = false;
    if (quickReasoningEl) quickReasoningEl.disabled = false;
  }
}

function prefetchModelsForQuickPicker() {
  const baseUrl = String(llmConfig.baseUrl || '').trim();
  if (backgroundModelFetch?.baseUrl === baseUrl) return;
  backgroundModelFetch?.controller.abort();
  if (!baseUrl || (fetchedModelsBaseUrl === baseUrl && fetchedModels.length)) return;
  const controller = new AbortController();
  const pending = { baseUrl, controller };
  backgroundModelFetch = pending;
  void api.aiModels({ baseUrl, language: getLang() }, controller.signal)
    .then((r) => {
      if (r?.ok && Array.isArray(r.models) && r.models.length && llmConfig.baseUrl === baseUrl) {
        applyFetchedModels(r.models, baseUrl);
      }
    })
    .catch(() => {})
    .finally(() => { if (backgroundModelFetch === pending) backgroundModelFetch = null; });
}

function syncApiKeyHint() {
  apiKeyEl.placeholder = clearApiKeyPending ? t('ai.api.keyPending')
    : llmConfig.hasApiKey ? t('ai.api.keySaved') : t('ai.api.keyOptional');
}

function syncApiForm() {
  if (!baseUrlEl) return;
  baseUrlEl.value = llmConfig.baseUrl || '';
  modelEl.value = llmConfig.model || '';
  if (fetchedModelsBaseUrl && fetchedModelsBaseUrl !== (llmConfig.baseUrl || '')) {
    fetchedModels = [];
    fetchedModelsBaseUrl = '';
    modelSelectEl.replaceChildren();
    modelSelectEl.hidden = true;
  }
  syncModelPicker();
  apiKeyEl.value = '';
  clearApiKeyPending = false;
  syncApiKeyHint();
  if (clearKeyBtn) clearKeyBtn.hidden = !llmConfig.hasApiKey;
  if (toolModeEl) toolModeEl.value = llmConfig.toolMode || 'auto';
  const effort = Object.hasOwn(EFFORT_KEYS, llmConfig.reasoningEffort) ? llmConfig.reasoningEffort : 'default';
  if (reasoningEffortEl) reasoningEffortEl.value = effort;
  contextWindowEl.value = llmConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  maxTokensEl.value = llmConfig.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (subagentEnabledEl) subagentEnabledEl.checked = llmConfig.subagentEnabled !== false;
  if (subagentConcurrencyEl) subagentConcurrencyEl.value = String(llmConfig.subagentMaxConcurrency ?? 2);
  if (subagentMaxStepsEl) subagentMaxStepsEl.value = String(llmConfig.subagentMaxSteps ?? 6);
  renderContextBadge();
  const configured = Boolean(llmConfig.baseUrl && llmConfig.model);
  if (setupBanner) setupBanner.hidden = configured;
  syncQuickControls();
}

function readApiDraft() {
  const conc = Number(subagentConcurrencyEl?.value);
  const subSteps = Number(subagentMaxStepsEl?.value);
  const draft = {
    language: getLang(),
    baseUrl: baseUrlEl.value.trim(),
    model: modelEl.value.trim(),
    toolMode: toolModeEl.value,
    reasoningEffort: reasoningEffortEl?.value || 'default',
    contextWindow: contextWindowEl.value ? contextWindowEl.valueAsNumber : DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokensEl.value ? maxTokensEl.valueAsNumber : DEFAULT_MAX_TOKENS,
    subagentEnabled: subagentEnabledEl ? subagentEnabledEl.checked : true,
    subagentMaxConcurrency: Number.isFinite(conc) ? Math.max(1, Math.min(3, Math.trunc(conc))) : 2,
    subagentMaxSteps: Number.isFinite(subSteps) ? Math.max(2, Math.min(12, Math.trunc(subSteps))) : 6,
  };
  if (clearApiKeyPending) draft.apiKey = '';
  else if (apiKeyEl.value.trim()) draft.apiKey = apiKeyEl.value.trim();
  return draft;
}

function invalidTokenCount(input, value) {
  return input.validity.badInput || !Number.isInteger(value) || value < Number(input.min) || value > Number(input.max);
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

function buildUserBubbleContent(div, text, attachedImages = [], attachedFiles = []) {
  div.replaceChildren();
  if (attachedImages.length || attachedFiles.length) {
    const atts = document.createElement('div');
    atts.className = 'ai-msg-atts';
    for (const img of attachedImages) {
      const el = document.createElement('img');
      el.className = 'ai-msg-att-img';
      el.src = img.dataUrl;
      el.alt = img.label || t('ai.sentImage');
      el.title = t('ai.enlarge', { name: img.label || t('ai.image') });
      el.addEventListener('click', () => openImageLightbox(img.dataUrl, img.label));
      atts.appendChild(el);
    }
    for (const f of attachedFiles) {
      const badge = document.createElement('span');
      badge.className = 'ai-msg-att-file';
      badge.textContent = f.endLine ? `📄 ${f.name} (L${f.startLine}-${f.endLine})` : `📄 ${f.name}`;
      atts.appendChild(badge);
    }
    div.appendChild(atts);
  }
  const body = document.createElement('div');
  body.textContent = text || '';
  div.appendChild(body);
}

function appendUserMessage(text, attachedImages = [], attachedFiles = []) {
  if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'ai-msg user';
  buildUserBubbleContent(div, text, attachedImages, attachedFiles);
  messagesEl.appendChild(div);
}

function createAssistantBox() {
  if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'ai-msg assistant';
  box.innerHTML = '<details class="ai-investigate" hidden><summary></summary><div class="ai-steps"></div></details><div class="ai-msg-text"></div>';
  box.querySelector('summary').textContent = t('ai.investigation');
  box.querySelector('.ai-msg-text').textContent = t('ai.connecting');
  messagesEl.appendChild(box);
  followChatScroll();
  return {
    box,
    investigate: box.querySelector('.ai-investigate'),
    steps: box.querySelector('.ai-steps'),
    text: box.querySelector('.ai-msg-text'),
  };
}

function addStep(stepsEl, label) {
  const row = document.createElement('div');
  row.className = 'ai-step';
  const head = document.createElement('div');
  head.className = 'ai-step-head';
  head.textContent = head.title = label;
  row.appendChild(head);
  stepsEl.appendChild(row);
  return row;
}

function finishStep(row, tool) {
  const cls = tool.ok !== false ? 'ok' : (tool.blocked ? 'blocked' : 'err');
  row.classList.add(cls);
  const head = row.querySelector('.ai-step-head');
  head.textContent = head.title = tool.blocked ? t('ai.toolPending', { name: tool.name }) : tool.name;
  if (tool.summary) {
    const result = document.createElement('div');
    result.className = 'ai-step-result';
    result.textContent = `⎿ ${tool.summary}`;
    result.title = tool.summary;
    row.appendChild(result);
  }
}

async function ensureChatProject() {
  const currentId = state.view?.projectId ?? chatProjectId;
  if (chatProjectId === null || currentId !== chatProjectId) {
    await loadProjectChats({ force: true });
  }
  return chatProjectId !== null && chatProjectId === (state.view?.projectId ?? chatProjectId);
}

async function compactChat() {
  if (!(await ensureChatProject()) || activeAbort || compacting) return;
  const thread = activeThread();
  const projectId = chatProjectId;
  const messages = thread.messages;
  if (!messages.length) return;
  const compactMessages = messages.map(message => ({ ...message }));
  boundSavedCodeAttachments([{ messages: compactMessages }]);
  const isCurrent = () => chatProjectId === projectId && chatThreads.includes(thread) && thread.messages === messages;
  const before = estimateContext(messages);
  const controller = new AbortController();
  compacting = controller;
  updateChatControls();
  setChatStatus(() => t('ai.compacting'));
  try {
    const result = await api.compactChat({ language: getLang(), projectId, threadId: thread.id, messages: compactMessages }, controller.signal);
    if (result?.ok === false) throw new Error(result.error);
    if (!Array.isArray(result?.messages)) throw new Error(t('ai.compactInvalid'));
    if (!isCurrent()) return;
    thread.messages = result.messages;
    const after = result.afterTokens ?? estimateContext(thread.messages);
    const compactedMetrics = {
      promptTokens: after,
      completionTokens: 0,
      totalTokens: after,
      contextEstTokens: after,
      contextWindow: llmConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      tokPerSec: 0,
      elapsedMs: 0,
      estimated: true,
    };
    for (const msg of thread.messages) delete msg.metrics;
    if (thread.messages.length) thread.messages.at(-1).metrics = compactedMetrics;
    thread.metrics = compactedMetrics;
    thread.updatedAt = Date.now();
    renderChatBar();
    persistChats();
    if (activeChatId === thread.id) {
      renderThreadMessages();
      setChatStatus(() => t('ai.compacted', { before: formatTokens(result.beforeTokens ?? before), after: formatTokens(after) }));
    }
  } catch (err) {
    if (isCurrent() && activeChatId === thread.id) setChatStatus(() => t('ai.compactFailed', { error: err.message }), true);
  } finally {
    if (compacting === controller) {
      compacting = null;
      if (chatThreads.length) updateChatControls();
    }
  }
}

async function saveViewBookmark(name) {
  if (!name) {
    setChatStatus(() => t('ai.nameBookmark'), true);
    inputEl.focus();
    return;
  }
  const projectId = state.view?.projectId;
  if (projectId == null || !state.roots.length) {
    setChatStatus(() => t('ai.bookmarkRoot'), true);
    return;
  }
  const threadId = activeChatId;
  const isCurrent = () => activeChatId === threadId && state.view?.projectId === projectId && !activeAbort && !compacting;
  const draft = inputEl.value;
  inputEl.value = '';
  setChatStatus(() => t('ai.savingBookmark'));
  try {
    const result = await api.saveBookmark({
      projectId, name, roots: state.roots, expansions: state.expansions,
      up: state.up, down: state.down, group: state.group, groupMode: state.groupMode, vars: [...state.vars],
    });
    if (!result?.ok) throw new Error(result?.error || t('common.requestFailed'));
    if (isCurrent()) setChatStatus(() => t(result.overwritten ? 'ai.bookmarkUpdated' : 'ai.bookmarkSaved', { name }));
  } catch (err) {
    if (isCurrent()) {
      if (!inputEl.value) inputEl.value = draft;
      setChatStatus(() => t('ai.bookmarkFailed', { error: err.message || err }), true);
    }
  }
}

async function sendPrompt(rawText, uiContext = currentUiContext(), options = {}) {
  const restoring = !options.original && restoredTurn?.projectId === chatProjectId &&
    restoredTurn?.threadId === activeChatId ? restoredTurn : null;
  if (restoring && (!restoring.retryOf || (rawText ?? inputEl.value).trim() === restoring.draft)) options = { ...restoring, ...options };
  const accessMode = options.accessMode ?? 'edit';
  const rawInput = String(rawText ?? inputEl.value).trim();
  if (!rawInput) return;
  closeSlashMenu();
  if (rawInput === '/new' || rawInput === '/clear') {
    pendingSteer = null;
    inputEl.value = '';
    if (await ensureChatProject()) {
      startNewThread();
      setChatStatus(() => t('ai.createdChat'));
    }
    return;
  }
  if (rawInput === '/compact') {
    if (activeAbort || compacting) {
      setChatStatus(() => t('ai.waitCompact'));
      return;
    }
    inputEl.value = '';
    await compactChat();
    return;
  }
  if (compacting) return;
  if (rawInput === BOOKMARK_COMMAND || rawInput.startsWith(BOOKMARK_COMMAND + ' ')) {
    if (activeAbort) {
      setChatStatus(() => t('ai.waitBookmark'));
      return;
    }
    if (accessMode === 'read') {
      setChatStatus(() => t('ai.recovery.readDraft'), true);
      return;
    }
    await saveViewBookmark(rawInput.slice(BOOKMARK_COMMAND.length).trim());
    return;
  }
  let text = rawInput;
  const slashMatch = /^\/(present|check|flow|impact|subagent|git|labels)(?:\s+([\s\S]*))?$/i.exec(rawInput);
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase();
    const rest = (slashMatch[2] || '').trim();
    if (cmd === 'check') {
      text = rest ? t('ai.slash.check', { rest }) : t('ai.slash.checkAll');
    } else if (cmd === 'present') {
      text = t('ai.slash.present', { subject: rest || t('ai.slash.presentDefault') });
    } else if (cmd === 'flow') {
      text = t('ai.slash.flow', { subject: rest || t('ai.slash.flowDefault') });
    } else if (cmd === 'impact') {
      text = t('ai.slash.impact', { subject: rest || t('ai.slash.impactDefault') });
    } else if (cmd === 'subagent') {
      text = t('ai.slash.subagent', { subject: rest || t('ai.slash.subDefault') });
    } else if (cmd === 'git') {
      text = rest || t('ai.quickPrompt.git');
    } else if (cmd === 'labels') {
      text = rest || t('ai.quickPrompt.labels');
    }
  }
  if (activeAbort) {
    pendingSteer = {
      text: rawInput,
      options: { ...options, accessMode },
      uiContext,
      threadId: activeChatId,
      projectId: chatProjectId,
      gen: chatGeneration,
    };
    inputEl.value = '';
    setChatStatus(() => t('ai.steering'));
    activeAbort.abort();
    return;
  }
  if (!llmConfig.baseUrl || !llmConfig.model) {
    setTab('api');
    setApiStatus(() => t('ai.api.required'), true);
    return;
  }
  const submittedProjectId = state.view?.projectId ?? chatProjectId;
  if (!(await ensureChatProject()) || activeAbort || compacting ||
      (submittedProjectId !== null && submittedProjectId !== chatProjectId)) return;
  const thread = activeThread();
  const threadId = thread.id;
  const myProjectId = chatProjectId;
  const myGen = chatGeneration;
  const turnMessages = thread.messages;
  const turnId = crypto.randomUUID?.() ?? `turn_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  if (!thread.customTitle && thread.title === NEW_THREAD_TITLE) {
    thread.title = deriveThreadTitle(rawInput) || NEW_THREAD_TITLE;
  }
  const historySnapshot = options.original?.history ?? chatHistory(turnMessages);

  const lastMessageEl = messagesEl.lastElementChild;
  lastMessageEl?.querySelector('.ai-followups')?.remove();
  const questionCard = lastMessageEl?.querySelector('.ai-question');
  if (questionCard) {
    for (const button of questionCard.querySelectorAll('.ai-q-opt')) button.disabled = true;
    questionCard.querySelector('.ai-q-hint')?.remove();
  }
  const stagedImages = options.original ? options.original.stagedImages || [] : pendingImages.splice(0, MAX_PENDING_IMAGES);
  const files = options.original ? options.original.files || [] : pendingFiles.splice(0, MAX_PENDING_FILES);
  const images = options.original ? options.original.images || [] : stagedImages.map(({ dataUrl, label }) => ({ dataUrl, label }));
  const attachments = options.original ? options.original.attachments || [] : sanitizeCodeAttachments(files.map((file) => {
    if (file.saved) return file.saved;
    const start = Math.max(1, file.startLine || 1);
    const end = Math.max(start, Math.min(file.lines.length, file.endLine || file.lines.length));
    return {
      name: file.name,
      startLine: start,
      endLine: end,
      totalLines: file.lines.length,
      content: file.lines.slice(start - 1, end).join('\n'),
    };
  }));
  renderAttachments();
  if (restoring || (options.retryOf && restoredTurn?.retryOf === options.retryOf)) restoredTurn = null;
  const selectionSummary = summarizeUiContext(uiContext);
  const userEntry = {
    role: 'user', text: rawInput,
    pendingTurn: { turnId, mode: accessMode, hasContext: Boolean(images.length || attachments.length || uiContext) },
    ...(selectionSummary ? { selectionSummary } : {}),
    ...(images.length ? { attachedImages: images } : {}),
    ...(attachments.length ? { attachedFiles: attachments } : {}),
  };
  thread.messages.push(userEntry);
  thread.updatedAt = Date.now();
  renderChatBar();
  persistChats(myProjectId);

  if (!options.original || inputEl.value.trim() === rawInput) inputEl.value = '';
  stickToBottom = true;
  appendUserMessage(rawInput, images, attachments);
  const ui = createAssistantBox();
  const controller = new AbortController();
  activeAbort = controller;
  updateChatControls();
  setChatStatus();
  renderTelemetry(thread);

  const pendingSteps = [];
  let terminalReceived = false;
  let thinking = '';
  let thinkingDelta = '';
  let thinkingSince = null;
  let thinkingSeconds = 0;
  let streamedText = '';
  let metrics;
  const collectedTools = [];
  const collectedSubagents = [];
  const collectedChains = [];
  let collectedPresentation = null;
  let collectedHealthReport = null;
  let collectedChangeset = null;
  let dirtyText = false;
  let dirtyThinking = false;
  let dirtyMetrics = false;
  let dirtyScroll = false;
  let paintTimer = 0;
  let lastPaintAt = 0;
  const isCurrent = () => myGen === chatGeneration && chatProjectId === myProjectId &&
    thread.messages === turnMessages && chatThreads.includes(thread);
  const isVisible = () => isCurrent() && activeChatId === threadId;
  const joinThinking = (part) => [thinking, part].filter(Boolean).join('\n\n');
  const flushStreamPaint = (force = false) => {
    if (paintTimer) {
      clearTimeout(paintTimer);
      paintTimer = 0;
    }
    if (!force && isCanvasDragging()) {
      // 画布正在平移或拖拽节点/容器时暂缓流式 DOM 重排，避免抢占主线程造成画布掉帧；松手后立刻补刷。
      paintTimer = setTimeout(() => flushStreamPaint(false), 120);
      return;
    }
    if (dirtyThinking) {
      dirtyThinking = false;
      const seconds = thinkingSince !== null ? thinkingSeconds + (performance.now() - thinkingSince) / 1000 : thinkingSeconds;
      showThinking(ui.box, ui.text, joinThinking(thinkingDelta), seconds, thinkingSince !== null);
    }
    if (dirtyText) {
      dirtyText = false;
      ui.text.innerHTML = formatAssistantText(streamedText);
    }
    if (dirtyMetrics) {
      dirtyMetrics = false;
      if (isVisible()) renderTelemetry(thread, metrics);
    }
    if (dirtyScroll) {
      dirtyScroll = false;
      if (isVisible()) followChatScroll();
    }
    lastPaintAt = performance.now();
  };
  const scheduleStreamPaint = () => {
    if (paintTimer) return;
    if (isCanvasDragging()) {
      paintTimer = setTimeout(() => flushStreamPaint(false), 120);
      return;
    }
    const wait = Math.max(16, 48 - (performance.now() - lastPaintAt));
    paintTimer = setTimeout(() => flushStreamPaint(false), wait);
  };
  const flushThisStream = () => flushStreamPaint(true);
  activeStreamFlush = flushThisStream;
  const stopThinking = () => {
    dirtyThinking = false;
    if (thinkingSince !== null) {
      thinkingSeconds += (performance.now() - thinkingSince) / 1000;
      thinkingSince = null;
    }
    showThinking(ui.box, ui.text, joinThinking(thinkingDelta), thinkingSeconds);
  };
  const commitAssistantMsg = ({ tools = collectedTools, ...entry }) => {
    if (!isCurrent()) return;
    if ((entry.completed || entry.questionOptions) && !thread.customTitle && GENERIC_THREAD_TITLES.has(thread.title)) {
      thread.title = deriveThreadTitle('', tools) || thread.title;
    }
    delete userEntry.pendingTurn;
    turnMessages.push({
      role: 'assistant',
      thinking: joinThinking(thinkingDelta),
      thinkingSeconds,
      tools,
      metrics,
      ...entry,
    });
    if (metrics) thread.metrics = metrics;
    thread.updatedAt = Date.now();
    // 最近活跃对话排到最前
    chatThreads.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    renderChatBar();
    persistChats(myProjectId);
    if (isVisible()) renderTelemetry(thread, metrics);
    return turnMessages.at(-1);
  };
  const isSteerQueuedForThisTurn = () => Boolean(
    pendingSteer && pendingSteer.threadId === threadId &&
    pendingSteer.projectId === myProjectId && pendingSteer.gen === myGen
  );
  let recoveryLookup;
  const finishInterrupted = (message, stopped = false) => {
    stopThinking();
    for (const { row, name } of pendingSteps) {
      finishStep(row, { name, ok: false, summary: t('ai.interrupted') });
    }
    const partial = Boolean(collectedTools.length || streamedText);
    const recovering = readTurnStatus(turnId, threadId);
    if (partial) ui.text.innerHTML = formatAssistantText(streamedText);
    else ui.text.textContent = message;
    recoveryLookup = recovering.then(status => {
      if (!isCurrent()) return;
      const changeset = status.changeset || collectedChangeset;
      const steering = stopped && isSteerQueuedForThisTurn();
      if (steering && !partial && !changeset && status.canRetry) { ui.box.remove(); return; }
      const entry = commitAssistantMsg({
        text: partial ? streamedText : message,
        error: !partial && !stopped,
        ...(changeset ? { changeset } : {}),
        recovery: {
          turnId, mode: accessMode,
          state: changeset ? 'changed' : status.canRetry ? 'safe' : 'unknown',
          hasContext: Boolean(images.length || attachments.length || uiContext),
        },
      });
      interruptedInputs.set(entry, { images, attachments, uiContext, history: historySnapshot, files, stagedImages });
      if (!isVisible()) return;
      if (changeset) renderChangesetUndo(ui.box, changeset);
      renderRecovery(ui.box, entry, thread);
      if (!messagesEl.contains(ui.box)) renderThreadMessages();
      if (!steering && partial) setChatStatus(message, !stopped);
      if (!steering && status.canRetry && !inputEl.value && !entry.recovery.hasContext &&
          !pendingImages.length && !pendingFiles.length && !pinnedSelections.length) {
        inputEl.value = rawInput;
        restoredTurn = { threadId, projectId: myProjectId, accessMode, retryOf: turnId, draft: rawInput };
      }
    });
  };
  const handleLine = (line) => {
    if (!isCurrent() || terminalReceived || !line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === 'status') {
      if (!streamedText) {
        ui.text.textContent = ev.text;
        dirtyScroll = true;
        scheduleStreamPaint();
      }
    } else if (ev.type === 'thinking_delta') {
      thinkingSince ??= performance.now();
      thinkingDelta += ev.delta || '';
      dirtyThinking = true;
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'thinking') {
      thinking = joinThinking(ev.text || thinkingDelta);
      thinkingDelta = '';
      stopThinking();
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'text_delta') {
      if (thinkingSince !== null) stopThinking();
      streamedText += ev.delta || '';
      dirtyText = true;
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'fallback') {
      addStep(ui.steps, `↻ ${ev.text}`);
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'tool_start') {
      if (thinkingSince !== null) stopThinking();
      if (ui.investigate) { ui.investigate.hidden = false; ui.investigate.open = true; }
      const argBrief = ev.arguments && Object.keys(ev.arguments).length
        ? `(${JSON.stringify(ev.arguments).slice(0, 80)})` : '';
      pendingSteps.push({ callId: ev.callId, name: ev.name, row: addStep(ui.steps, `${ev.name}${argBrief}…`) });
      updateInvestigateSummary(ui.investigate, collectedTools.length + pendingSteps.length, true);
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'tool_end') {
      const tool = { name: ev.name, ok: ev.ok !== false, ...(ev.blocked ? { blocked: true } : {}), summary: ev.summary || '', digest: ev.digest || '' };
      collectedTools.push(tool);
      const index = ev.callId
        ? pendingSteps.findIndex((step) => step.callId === ev.callId)
        : pendingSteps.findIndex((step) => step.name === tool.name);
      const row = index >= 0 ? pendingSteps.splice(index, 1)[0].row : addStep(ui.steps, tool.name);
      finishStep(row, tool);
      updateInvestigateSummary(ui.investigate, collectedTools.length, pendingSteps.length > 0);
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'subagent_start') {
      collectedSubagents.push({ id: ev.id, title: ev.title, running: true, steps: 0, summary: '' });
      renderSubagentCards(ui.box, collectedSubagents, ui.text);
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'subagent_progress') {
      const sa = collectedSubagents.find((s) => s.id === ev.id);
      if (sa) {
        sa.steps = (sa.steps || 0) + 1;
        sa.lastTool = ev.tool;
        sa.lastSummary = ev.summary;
        renderSubagentCards(ui.box, collectedSubagents, ui.text);
      }
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'subagent_end') {
      const sa = collectedSubagents.find((s) => s.id === ev.id);
      if (sa) {
        sa.running = false;
        sa.ok = ev.ok !== false;
        sa.summary = ev.summary || '';
        sa.steps = ev.steps ?? sa.steps;
        renderSubagentCards(ui.box, collectedSubagents, ui.text);
      }
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'chains' && Array.isArray(ev.chains)) {
      for (const ch of ev.chains) {
        if (ch && !collectedChains.some((x) => x.id === ch.id)) collectedChains.push(ch);
      }
      renderChainCards(ui.box, ev.chains);
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'presentation' && ev.presentation) {
      collectedPresentation = ev.presentation;
      renderPresCard(ui.box, ev.presentation);
      activatePresentation(ev.presentation, 0);
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'health_report' && ev.report) {
      collectedHealthReport = ev.report;
      renderHealthCard(ui.box, ev.report);
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'canvas_overlay') {
      state.aiOverlay = ev.action === 'clear' ? null : {
        action: ev.action || 'highlight',
        nodeIds: ev.nodeIds || [],
        edgeKeys: ev.edgeKeys || [],
        label: ev.label,
      };
      draw();
    } else if (ev.type === 'changeset' && ev.changesetId) {
      collectedChangeset = { id: ev.changesetId, ops: ev.ops || [] };
    } else if (ev.type === 'metrics') {
      metrics = ev;
      dirtyMetrics = true;
      scheduleStreamPaint();
    } else if (ev.type === 'done' || ev.type === 'question') {
      terminalReceived = true;
      flushStreamPaint(true);
      if (ev.thinking) {
        thinking = ev.thinking;
        thinkingDelta = '';
      }
      metrics = ev.metrics || metrics;
      stopThinking();
      if (ui.investigate) {
        ui.investigate.open = false;
        updateInvestigateSummary(ui.investigate, collectedTools.length || ev.toolLog?.length || 0, false);
        ui.investigate.hidden = !(collectedTools.length || ev.toolLog?.length);
      }
      const entry = {};
      if (Array.isArray(ev.toolLog) && ev.toolLog.length) {
        entry.tools = ev.toolLog.map(({ name, ok, blocked, summary, digest }) => ({ name, ok, ...(blocked ? { blocked: true } : {}), summary, digest }));
      }
      const finalChains = Array.isArray(ev.chains) && ev.chains.length ? ev.chains : collectedChains;
      if (finalChains.length) entry.chains = finalChains;
      const finalPres = ev.presentation || collectedPresentation;
      if (finalPres) entry.presentation = finalPres;
      const finalHealth = ev.healthReport || collectedHealthReport;
      if (finalHealth) entry.healthReport = finalHealth;
      const finalSubagents = Array.isArray(ev.subagents) && ev.subagents.length ? ev.subagents : collectedSubagents;
      if (finalSubagents.length) entry.subagents = finalSubagents.map(({ id, title, ok, summary, steps }) => ({ id, title, ok: ok !== false, summary, steps }));
      const finalChangeset = ev.changeset || collectedChangeset;
      if (finalChangeset?.id) entry.changeset = finalChangeset;

      if (ev.type === 'question' || ev.awaitingUser) {
        entry.text = ev.question || t('ai.confirmOptions');
        entry.questionOptions = Array.isArray(ev.options) ? ev.options : [];
        entry.allowCustom = ev.allowCustom !== false;
      } else {
        entry.text = ev.answer || streamedText || t('ai.done');
        entry.completed = true;
        const suggestions = sanitizeSuggestions(ev.suggestions);
        if (suggestions.length) entry.suggestions = suggestions;
      }
      ui.text.innerHTML = formatAssistantText(entry.text);
      if (finalChangeset?.id) renderChangesetUndo(ui.box, finalChangeset);
      const saved = commitAssistantMsg(entry);
      if (saved && isVisible()) {
        if (!messagesEl.contains(ui.box)) renderThreadMessages();
        else if (Array.isArray(saved.questionOptions)) renderQuestion(ui.text, saved, thread);
        else renderFollowups(ui.box, saved, thread);
        followChatScroll();
      }
    } else if (ev.type === 'error') {
      terminalReceived = true;
      flushStreamPaint(true);
      finishInterrupted(ev.error || t('ai.failed'));
      if (isVisible()) followChatScroll();
    }
  };
  const canvasLayout = buildCanvasLayoutSnapshot();
  let streamTimer = setTimeout(() => controller.abort(new Error(t('ai.connectTimeout'))), 15_000);
  let reader;
  try {
    const res = await api.aiChat({
      language: getLang(), prompt: text, turnId, accessMode,
      ...(options.retryOf ? { retryOf: options.retryOf } : {}),
      history: historySnapshot,
      at: state.at || 0,
      threadId,
      uiContext,
      ...(images.length ? { images } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(canvasLayout ? { canvasLayout } : {}),
    }, controller.signal);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    if (isCurrent() && !options.original) consumeUnpinnedStagedSelections(uiContext);
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      clearTimeout(streamTimer);
      streamTimer = setTimeout(() => controller.abort(new Error(t('ai.responseTimeout'))), 420_000);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
    if (!terminalReceived) finishInterrupted(t('ai.disconnected'));
  } catch (err) {
    if (!terminalReceived) {
      const stopped = err.name === 'AbortError';
      finishInterrupted(stopped ? t('ai.stopped') : (err.message || String(err)), stopped);
    }
  } finally {
    if (paintTimer) {
      clearTimeout(paintTimer);
      paintTimer = 0;
    }
    if (activeStreamFlush === flushThisStream) activeStreamFlush = null;
    clearTimeout(streamTimer);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (recoveryLookup) await recoveryLookup;
    let steer = null;
    if (activeAbort === controller) {
      activeAbort = null;
      if (isSteerQueuedForThisTurn() && isVisible()) steer = pendingSteer;
      pendingSteer = null;
      updateChatControls();
    }
    if (isVisible()) followChatScroll();
    if (steer) void sendPrompt(steer.text, steer.uiContext, steer.options);
  }
}

function showDrawer(showSetup = false) {
  if (drawer.classList.contains('show')) return apiConfigLoad;
  drawer.classList.add('show');
  showApiOnOpen = showSetup;
  followChatScroll();
  void loadProjectChats({ force: true });
  if (!apiConfigLoad) {
    const previousConfig = llmConfig;
    apiConfigLoad = api.aiConfig().catch(() => null).then((result) => {
      if (llmConfig === previousConfig) {
        if (result?.config) llmConfig = result.config;
        syncApiForm();
      }
      prefetchModelsForQuickPicker();
      if (showApiOnOpen && (!llmConfig.baseUrl || !llmConfig.model)) setTab('api');
    }).finally(() => { apiConfigLoad = null; });
    void api.mcpConfig().catch(() => null).then((config) => {
      if (config) {
        mcpLevel = config.level;
        envLocked = config.source === 'env';
      }
      renderMcp();
    });
  }
  return apiConfigLoad;
}

document.addEventListener('cg:selection-changed', (event) => setCanvasSelection(event.detail));
document.addEventListener('cg:pair-flow-cleared', ({ detail: ids }) => {
  const selection = ids.length === 1 ? { kind: 'node', id: ids[0] } : { kind: 'pair', ids };
  if (selectionKey(canvasSelection) === selectionKey(selection)) setCanvasSelection(null);
});
document.addEventListener('cg:ask-ai', async (event) => {
  const { prompt, ...selection } = event.detail || {};
  setCanvasSelection(selection, true);
  if (selection?.kind) pinSelectionSnapshot(selection, { quiet: true });
  const uiContext = currentUiContext();
  const projectId = state.view?.projectId;
  const configLoad = showDrawer();
  setTab('chat');
  inputEl.focus({ preventScroll: true });
  if (typeof prompt !== 'string' || !prompt.trim()) return;
  await configLoad;
  if (!drawer.classList.contains('show') || state.view?.projectId !== projectId) return;
  if (activeAbort || compacting || !llmConfig.baseUrl || !llmConfig.model) {
    prefillPrompt(prompt);
  } else {
    await sendPrompt(prompt, uiContext);
  }
});
if (relationBarEl) {
  relationBarEl.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('.ai-rel-btn[data-ai-rel]');
    if (!btn) return;
    selectedRelationIntent = btn.dataset.aiRel || 'auto';
    renderSelectionBar();
  });
}

function hideBookmarkBanner() {
  pendingBookmarkSwitch = null;
  if (bookmarkBannerEl) bookmarkBannerEl.hidden = true;
}

const seenBookmarkEvents = new WeakSet();
function handleBookmarkChanged(e) {
  if (!e || seenBookmarkEvents.has(e)) return;
  seenBookmarkEvents.add(e);
  const bm = e.detail?.bookmark || null;
  if (!bm?.id || !chatThreads.length) {
    hideBookmarkBanner();
    return;
  }
  const th = activeThread();
  if (!th.messages.length) {
    th.bookmarkId = bm.id;
    th.bookmarkName = bm.name || '';
    hideBookmarkBanner();
    persistChats();
    return;
  }
  if (th.bookmarkId === bm.id) {
    hideBookmarkBanner();
    return;
  }
  pendingBookmarkSwitch = bm;
  if (bookmarkBannerEl && bookmarkBannerTextEl) {
    bookmarkBannerTextEl.textContent = t('ai.bookmarkSwitch', { name: bm.name });
    bookmarkBannerEl.hidden = false;
  }
}
document.addEventListener('cg:bookmark-changed', handleBookmarkChanged);
window.addEventListener('cg:bookmark-changed', handleBookmarkChanged);

if (bookmarkNewChatBtn) {
  bookmarkNewChatBtn.addEventListener('click', () => {
    const bm = pendingBookmarkSwitch || state.activeBookmark;
    hideBookmarkBanner();
    startNewThread();
    const th = activeThread();
    if (bm?.id) {
      th.bookmarkId = bm.id;
      th.bookmarkName = bm.name || '';
      persistChats();
    }
  });
}
if (bookmarkBindChatBtn) {
  bookmarkBindChatBtn.addEventListener('click', () => {
    const bm = pendingBookmarkSwitch || state.activeBookmark;
    const th = activeThread();
    if (bm?.id) {
      th.bookmarkId = bm.id;
      th.bookmarkName = bm.name || '';
      persistChats();
    }
    hideBookmarkBanner();
  });
}
if (bookmarkDismissBtn) bookmarkDismissBtn.addEventListener('click', hideBookmarkBanner);

if (presPrevBtn) presPrevBtn.addEventListener('click', () => {
  if (state.presentation) activatePresentation(state.presentation, (state.presentation.activeIndex || 0) - 1);
});
if (presNextBtn) presNextBtn.addEventListener('click', () => {
  if (state.presentation) activatePresentation(state.presentation, (state.presentation.activeIndex || 0) + 1);
});
if (presCloseBtn) presCloseBtn.addEventListener('click', () => activatePresentation(null));
document.addEventListener('cg:ai-overlay-cleared', () => syncPresentationHud());

const SLASH_COMMANDS = [
  { cmd: '/present', desc: 'ai.command.present', fill: '/present ' },
  { cmd: '/check', desc: 'ai.command.check', run: true, prompt: '/check' },
  { cmd: '/flow', desc: 'ai.command.flow', fill: '/flow ' },
  { cmd: '/impact', desc: 'ai.command.impact', fill: '/impact ' },
  { cmd: '/subagent', desc: 'ai.command.subagent', fill: '/subagent ' },
  { cmd: '/git', desc: 'ai.command.git', run: true, prompt: '/git' },
  { cmd: '/labels', desc: 'ai.command.labels', run: true, prompt: '/labels' },
  { cmd: '/compact', desc: 'ai.command.compact', run: true, prompt: '/compact' },
  { cmd: '/new', desc: 'ai.command.new', run: true, prompt: '/new' },
];

function closeSlashMenu() {
  slashMenuState = { open: false, mode: '', items: [], activeIndex: 0, triggerStart: 0 };
  if (slashMenuEl) {
    slashMenuEl.hidden = true;
    slashMenuEl.replaceChildren();
  }
}

function renderSlashMenu() {
  if (!slashMenuEl) return;
  if (!slashMenuState.open || !slashMenuState.items.length) {
    closeSlashMenu();
    return;
  }
  slashMenuEl.replaceChildren();
  slashMenuState.items.forEach((item, idx) => {
    const btnItem = document.createElement('button');
    btnItem.type = 'button';
    btnItem.className = idx === slashMenuState.activeIndex ? 'ai-slash-item active' : 'ai-slash-item';
    btnItem.setAttribute('role', 'option');
    btnItem.setAttribute('aria-selected', String(idx === slashMenuState.activeIndex));
    const left = document.createElement('strong');
    left.textContent = item.label || item.cmd;
    const right = document.createElement('small');
    right.textContent = item.desc ? t(item.desc) : item.meta || '';
    btnItem.append(left, right);
    btnItem.addEventListener('mousedown', (ev) => {
      ev.preventDefault();
      applySlashMenuItem(item);
    });
    slashMenuEl.appendChild(btnItem);
  });
  slashMenuEl.hidden = false;
}

function applySlashMenuItem(item) {
  if (!item || !inputEl) return;
  if (slashMenuState.mode === 'slash') {
    closeSlashMenu();
    if (item.run) {
      inputEl.value = '';
      void sendPrompt(item.prompt);
      return;
    }
    const val = item.fill || `${item.cmd} `;
    inputEl.value = val;
    inputEl.focus();
    inputEl.setSelectionRange(val.length, val.length);
    syncInputSuggestion();
    return;
  }
  // '@' 符号插入 + 自动附着上下文
  const val = inputEl.value;
  const start = slashMenuState.triggerStart;
  const cursor = inputEl.selectionStart ?? val.length;
  const before = val.slice(0, start);
  const after = val.slice(cursor);
  const inserted = `${item.id} `;
  inputEl.value = before + inserted + after;
  const nextPos = before.length + inserted.length;
  inputEl.focus();
  inputEl.setSelectionRange(nextPos, nextPos);
  if (item.node) {
    pinSelectionSnapshot({
      kind: 'node',
      id: item.node.id,
      name: item.node.name,
      nodeKind: item.node.kind === 'var' ? 'var' : 'fn',
      file: item.node.file || '',
      line: item.node.line || 0,
    }, { quiet: true });
  }
  closeSlashMenu();
  syncInputSuggestion();
}

function updateAutocompletePopover() {
  if (!inputEl || !slashMenuEl) return;
  const val = inputEl.value;
  const cursor = inputEl.selectionStart ?? val.length;
  const prefix = val.slice(0, cursor);
  if (prefix.startsWith('/') && !/\s/.test(prefix)) {
    const q = prefix.toLowerCase();
    const matches = SLASH_COMMANDS.filter((c) => c.cmd.startsWith(q));
    if (matches.length) {
      slashMenuState = { open: true, mode: 'slash', items: matches, activeIndex: 0, triggerStart: 0 };
      renderSlashMenu();
      return;
    }
  }
  const atMatch = /(?:^|\s)(@[A-Za-z0-9_.:/-]*)$/.exec(prefix);
  if (atMatch) {
    const q = atMatch[1].slice(1).toLowerCase();
    const triggerStart = prefix.length - atMatch[1].length;
    const nodes = state.view?.nodes || [];
    const items = nodes
      .filter((n) => !q || String(n.name || '').toLowerCase().includes(q) || String(n.id || '').toLowerCase().includes(q))
      .slice(0, 8)
      .map((n) => ({ id: n.id, label: `@${n.name || n.id}`, meta: n.file || n.id, node: n }));
    if (items.length) {
      slashMenuState = { open: true, mode: 'at', items, activeIndex: 0, triggerStart };
      renderSlashMenu();
      return;
    }
  }
  closeSlashMenu();
}
if (pinSelectionBtn) pinSelectionBtn.addEventListener('click', pinCurrentSelection);
if (trunkSelectEl) {
  trunkSelectEl.addEventListener('change', () => selectTrunkBranchAt(Number(trunkSelectEl.value)));
}
if (trunkPrevBtn) {
  trunkPrevBtn.addEventListener('click', () => selectTrunkBranchAt(Number(trunkSelectEl?.value || 0) - 1));
}
if (trunkNextBtn) {
  trunkNextBtn.addEventListener('click', () => selectTrunkBranchAt(Number(trunkSelectEl?.value || 0) + 1));
}
clearSelectionBtn.addEventListener('click', () => {
  const key = selectionKey(canvasSelection);
  if (!key) return;
  dismissedSelectionKeys.add(key);
  setCanvasSelection(null);
  inputEl.focus({ preventScroll: true });
});
if (attachShotBtn) attachShotBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  if (attachMenuEl.hidden) openAttachMenu();
  else closeAttachMenu();
});
document.addEventListener('click', (e) => {
  if (attachMenuEl && !attachMenuEl.hidden && !attachMenuEl.contains(e.target) && e.target !== attachShotBtn) {
    closeAttachMenu();
  }
});
if (lightboxCloseEl) lightboxCloseEl.addEventListener('click', closeImageLightbox);
if (lightboxEl) lightboxEl.addEventListener('click', (e) => {
  if (e.target === lightboxEl) closeImageLightbox();
});
if (ghostTabHintEl) ghostTabHintEl.addEventListener('click', () => acceptGhostSuggestion());
if (imageFileInputEl) imageFileInputEl.addEventListener('change', async () => {
  const files = [...(imageFileInputEl.files || [])];
  imageFileInputEl.value = '';
  for (const f of files.slice(0, MAX_PENDING_IMAGES)) {
    await addImageFromBlob(f, f.name || t('ai.externalImage'));
  }
});
if (textFileInputEl) textFileInputEl.addEventListener('change', async () => {
  const files = [...(textFileInputEl.files || [])];
  textFileInputEl.value = '';
  for (const f of files.slice(0, MAX_PENDING_FILES)) {
    if (f.type?.startsWith('image/')) await addImageFromBlob(f, f.name);
    else await addExternalTextFile(f);
  }
});
const handlePasteFiles = async (e) => {
  const items = [...(e.clipboardData?.items || [])];
  const imageItems = items.filter((item) => item.kind === 'file' && item.type.startsWith('image/'));
  if (!imageItems.length) return;
  e.preventDefault();
  for (const item of imageItems.slice(0, MAX_PENDING_IMAGES)) {
    const blob = item.getAsFile();
    if (blob) await addImageFromBlob(blob, t('ai.pastedImage'));
  }
};
if (inputEl) inputEl.addEventListener('paste', handlePasteFiles);
if (drawer) drawer.addEventListener('paste', (e) => {
  if (e.target === inputEl) return;
  void handlePasteFiles(e);
});
if (inputShellEl) {
  inputShellEl.addEventListener('dragover', (e) => {
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      inputShellEl.classList.add('drag-over');
    }
  });
  inputShellEl.addEventListener('dragleave', () => inputShellEl.classList.remove('drag-over'));
  inputShellEl.addEventListener('drop', async (e) => {
    inputShellEl.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files.slice(0, MAX_PENDING_FILES)) {
      if (f.type?.startsWith('image/')) await addImageFromBlob(f, f.name);
      else await addExternalTextFile(f);
    }
  });
}
messagesEl.addEventListener('click', (event) => {
  const symBtn = event.target?.closest?.('.ai-sym-link[data-ai-sym]');
  if (!symBtn) return;
  locateSymbolFromChat(symBtn.dataset.aiSym);
});
// 画布拖拽松手后立刻补刷被暂缓的 AI 流式 DOM 更新，保证拖动零卡顿且松手即时同步。
window.addEventListener('pointerup', () => { if (activeStreamFlush) activeStreamFlush(); }, { passive: true });
window.addEventListener('pointercancel', () => { if (activeStreamFlush) activeStreamFlush(); }, { passive: true });
messagesEl.addEventListener('scroll', () => {
  if (messagesEl.clientHeight) stickToBottom = isNearBottom(messagesEl);
}, { passive: true });

// 切换工程时自动隔离并切换到目标工程的独立对话列表
document.addEventListener('cg:project-changed', () => {
  state.aiHover = null;
  stopCamAnim();
  activatePresentation(null);
  applyI18n(emptyChatEl);
  messagesEl.replaceChildren(emptyChatEl);
  finishThreadRename(false);
  dismissedSelectionKeys.clear();
  pinnedSelections.length = 0;
  pendingImages.length = 0;
  pendingFiles.length = 0;
  closeAttachMenu();
  closeImageLightbox();
  renderAttachments();
  setCanvasSelection(null);
  renderSelectionBar();
  chatGeneration++;
  if (restoredTurn) inputEl.value = '';
  restoredTurn = null;
  chatProjectId = null;
  chatThreads = [];
  setActiveChat('');
  renameChatBtn.disabled = true;
  pendingSteer = null;
  compacting?.abort();
  compacting = null;
  if (activeAbort) {
    activeAbort.abort();
    activeAbort = null;
  }
  if (drawer?.classList.contains('show')) void loadProjectChats({ force: true });
});

if (chatSelectEl) chatSelectEl.addEventListener('change', () => {
  pendingSteer = null;
  if (activeAbort) activeAbort.abort();
  setActiveChat(chatSelectEl.value);
  renderChatBar();
  renderThreadMessages();
  persistChats();
});
function startNewThread() {
  pendingSteer = null;
  if (activeAbort) activeAbort.abort();
  const th = newThreadObject();
  chatThreads.unshift(th);
  setActiveChat(th.id);
  renderChatBar();
  renderThreadMessages();
  persistChats();
  inputEl?.focus();
}

if (newChatBtn) newChatBtn.addEventListener('click', startNewThread);
renameChatBtn.addEventListener('click', () => {
  if (renamingThread || chatProjectId == null || chatProjectId !== (state.view?.projectId ?? chatProjectId)) return;
  renamingThread = activeThread();
  renameInputEl.defaultValue = renameInputEl.value = displayThreadTitle(renamingThread);
  chatSelectEl.hidden = true;
  renameInputEl.hidden = false;
  renameChatBtn.disabled = true;
  renameInputEl.focus();
  renameInputEl.select();
});
renameInputEl.addEventListener('blur', () => finishThreadRename(true));
renameInputEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  e.stopPropagation();
  if (e.isComposing) return;
  e.preventDefault();
  finishThreadRename(e.key === 'Enter');
  renameChatBtn.focus();
});
if (deleteChatBtn) deleteChatBtn.addEventListener('click', async () => {
  const th = activeThread();
  const targetId = th?.id;
  if (!targetId) return;
  if (th.messages.length) {
    const ok = await confirmDialog({
      title: t('ai.deleteChat'),
      message: t('ai.deleteConfirm', { name: displayThreadTitle(th), n: th.messages.length }),
      okText: t('ai.deleteChat'),
      danger: true,
    });
    if (!ok || activeChatId !== targetId) return;
  }
  pendingSteer = null;
  if (activeAbort) activeAbort.abort();
  chatThreads = chatThreads.filter((x) => x.id !== targetId);
  if (!chatThreads.length) chatThreads.push(newThreadObject());
  setActiveChat(chatThreads[0].id);
  renderChatBar();
  renderThreadMessages();
  persistChats();
});

if (btn) btn.addEventListener('click', () => {
  if (drawer.classList.contains('show')) drawer.classList.remove('show');
  else void showDrawer(true);
});
if (closeBtn) closeBtn.addEventListener('click', () => drawer?.classList.remove('show'));
// 隔离抽屉内按键事件，防止 F / Delete / Esc 误触画布快捷键
if (drawer) drawer.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Escape') {
    if (lightboxEl && !lightboxEl.hidden) { closeImageLightbox(); return; }
    if (attachMenuEl && !attachMenuEl.hidden) { closeAttachMenu(); return; }
    drawer.classList.remove('show');
  }
});
for (const tab of tabs) tab.addEventListener('click', () => setTab(tab.dataset.aiTab));
if (goConfigBtn) goConfigBtn.addEventListener('click', () => setTab('api'));

// 快捷任务按钮
for (const quick of document.querySelectorAll('[data-ai-quick]')) {
  quick.addEventListener('click', () => {
    const kind = quick.dataset.aiQuick;
    if (kind === 'git') {
      sendPrompt(t('ai.quickPrompt.git'));
    } else if (kind === 'find') {
      prefillPrompt(t('ai.findDraft'));
    } else if (kind === 'labels') {
      sendPrompt(t('ai.quickPrompt.labels'));
    } else if (kind === 'build') {
      sendPrompt(t('ai.quickPrompt.build'));
    }
  });
}

if (sendBtn) sendBtn.addEventListener('click', () => sendPrompt());
if (stopBtn) stopBtn.addEventListener('click', () => {
  pendingSteer = null;
  activeAbort?.abort();
});
compactBtn.addEventListener('click', compactChat);
if (quickModelEl) quickModelEl.addEventListener('change', () => {
  const val = quickModelEl.value;
  if (!val || val === QUICK_CONFIG_ACTION) {
    syncQuickControls();
    setTab('api');
    (llmConfig.baseUrl ? modelEl : baseUrlEl)?.focus();
    return;
  }
  if (val === llmConfig.model) return;
  void saveQuickConfig({ model: val }, () => t('ai.modelSwitched', { name: val }));
});
if (quickReasoningEl) quickReasoningEl.addEventListener('change', () => {
  const val = quickReasoningEl.value;
  if (val === (llmConfig.reasoningEffort || 'default')) return;
  void saveQuickConfig({ reasoningEffort: val }, () => t('ai.effortSwitched', { effort: t(EFFORT_KEYS[val]) }));
});
if (inputEl) {
  inputEl.addEventListener('input', () => {
    if (restoredTurn && (!inputEl.value || (restoredTurn.retryOf && inputEl.value.trim() !== restoredTurn.draft))) {
      restoredTurn = null;
    }
    syncInputSuggestion();
    updateAutocompletePopover();
  });
  inputEl.addEventListener('keydown', (e) => {
    if (slashMenuState.open && slashMenuState.items.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        slashMenuState.activeIndex = (slashMenuState.activeIndex + 1) % slashMenuState.items.length;
        renderSlashMenu();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        slashMenuState.activeIndex = (slashMenuState.activeIndex - 1 + slashMenuState.items.length) % slashMenuState.items.length;
        renderSlashMenu();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeSlashMenu();
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (!e.isComposing) {
          e.preventDefault();
          applySlashMenuItem(slashMenuState.items[slashMenuState.activeIndex]);
          return;
        }
      }
    }
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'a') {
      if (canvasSelection) {
        e.preventDefault();
        pinCurrentSelection();
      }
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing && !inputEl.value && currentGhostSuggestion) {
      e.preventDefault();
      acceptGhostSuggestion();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt();
    }
  });
}

// API 配置事件
modelEl.addEventListener('input', syncModelPicker);
modelSelectEl.addEventListener('change', () => {
  if (modelSelectEl.value) modelEl.value = modelSelectEl.value;
});
if (apiKeyEl) apiKeyEl.addEventListener('input', () => {
  if (apiKeyEl.value) clearApiKeyPending = false;
});
if (clearKeyBtn) clearKeyBtn.addEventListener('click', () => {
  clearApiKeyPending = true;
  apiKeyEl.value = '';
  syncApiKeyHint();
  clearKeyBtn.hidden = true;
});
if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
  setApiStatus(() => t('ai.api.fetching'));
  fetchModelsBtn.disabled = true;
  try {
    const draft = readApiDraft();
    const r = await api.aiModels(draft);
    if (!r?.ok) throw new Error(r?.error || t('ai.api.fetchFailed'));
    const models = r.models || [];
    if (!modelEl.value.trim() && models.length) modelEl.value = models[0];
    applyFetchedModels(models, draft.baseUrl);
    setApiStatus(() => models.length ? t('ai.api.fetchedCount', { n: models.length }) : t('ai.api.noModels'));
  } catch (err) {
    setApiStatus(err.message || String(err), true);
  } finally {
    fetchModelsBtn.disabled = false;
  }
});
if (testConnBtn) testConnBtn.addEventListener('click', async () => {
  setApiStatus(() => t('ai.api.testing'));
  testConnBtn.disabled = true;
  try {
    const r = await api.aiTest(readApiDraft());
    if (!r?.ok) throw new Error(r?.error || t('ai.api.testFailed'));
    setApiStatus(() => t('ai.api.connected', { ms: r.latencyMs, model: r.model }));
  } catch (err) {
    setApiStatus(err.message || String(err), true);
  } finally {
    testConnBtn.disabled = false;
  }
});
if (saveApiBtn) saveApiBtn.addEventListener('click', async () => {
  const draft = readApiDraft();
  if (invalidTokenCount(contextWindowEl, draft.contextWindow)) {
    setApiStatus(() => t('ai.api.windowInvalid'), true);
    contextWindowEl.focus();
    return;
  }
  if (invalidTokenCount(maxTokensEl, draft.maxTokens)) {
    setApiStatus(() => t('ai.api.outputInvalid'), true);
    maxTokensEl.focus();
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  saveApiBtn.disabled = true;
  setApiStatus(() => t('common.saving'));
  try {
    const response = await fetch('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Callgraph-Client': clientId },
      body: JSON.stringify(draft),
      signal: controller.signal,
    });
    const r = await response.json().catch(() => null);
    if (!response.ok || !r?.ok || !r.config) {
      throw new Error(r?.error || (response.ok ? t('bookmark.failed') : `HTTP ${response.status}`));
    }
    llmConfig = r.config;
    syncApiForm();
    prefetchModelsForQuickPicker();
    setApiStatus(() => t('ai.api.saved'));
  } catch (err) {
    setApiStatus(() => controller.signal.aborted ? t('ai.api.saveTimeout') : err.message || String(err), true);
  } finally {
    clearTimeout(timeout);
    saveApiBtn.disabled = false;
  }
});

document.addEventListener('callgraph:langchange', () => {
  syncApiKeyHint();
  syncQuickControls();
  if (chatThreads.length) {
    renderChatBar();
    // 流式回调仍持有当前消息元素，此时只更新控件，不替换消息树。
    if (activeAbort) updateChatControls();
    else renderThreadMessages({ preserveStatus: true });
  } else {
    syncInputSuggestion();
  }
  renderSelectionBar();
  renderAttachments();
  if (slashMenuState.open) renderSlashMenu();
  if (attachMenuEl && !attachMenuEl.hidden) openAttachMenu();
  if (pendingBookmarkSwitch) bookmarkBannerTextEl.textContent = t('ai.bookmarkSwitch', { name: pendingBookmarkSwitch.name });
  syncPresentationHud();
  if (levelsEl?.childElementCount) {
    const selected = levelsEl.querySelector('input:checked')?.value;
    renderMcp();
    const previous = [...levelsEl.querySelectorAll('input')].find(input => input.value === selected);
    if (previous) previous.checked = true;
  }
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

// AI 抽屉左侧拖拽调宽（记住宽度并在窄窗自动收拢，双击恢复默认 460px）
const AI_DRAWER_WIDTH_KEY = 'cg.aiDrawerWidth';
const AI_DRAWER_DEFAULT_WIDTH = 460;
const AI_DRAWER_MIN_WIDTH = 340;
const AI_DRAWER_MAX_WIDTH = 960;

function applyAiDrawerWidth(px, { persist = false } = {}) {
  if (!drawer) return;
  if (window.innerWidth <= 480) {
    drawer.style.width = '';
    return;
  }
  const maxW = Math.max(AI_DRAWER_MIN_WIDTH, Math.min(AI_DRAWER_MAX_WIDTH, window.innerWidth - 24));
  const clamped = Math.round(Math.max(AI_DRAWER_MIN_WIDTH, Math.min(maxW, px)));
  drawer.style.width = `${clamped}px`;
  if (persist) {
    try { localStorage.setItem(AI_DRAWER_WIDTH_KEY, String(clamped)); } catch { /* ignore */ }
  }
}

try {
  const saved = Number(localStorage.getItem(AI_DRAWER_WIDTH_KEY));
  if (Number.isFinite(saved) && saved >= AI_DRAWER_MIN_WIDTH) applyAiDrawerWidth(saved);
} catch { /* ignore */ }

window.addEventListener('resize', () => {
  if (!drawer) return;
  if (window.innerWidth <= 480) {
    drawer.style.width = '';
    return;
  }
  const cur = Number.parseFloat(drawer.style.width);
  if (Number.isFinite(cur) && cur > 0) applyAiDrawerWidth(cur);
});

if (resizeHandle && drawer) {
  let resizing = false;
  resizeHandle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || window.innerWidth <= 480) return;
    resizing = true;
    drawer.classList.add('resizing');
    resizeHandle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  resizeHandle.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const desired = window.innerWidth - 12 - e.clientX;
    applyAiDrawerWidth(desired);
  });
  const endResize = (e) => {
    if (!resizing) return;
    resizing = false;
    drawer.classList.remove('resizing');
    if (e?.pointerId != null) resizeHandle.releasePointerCapture?.(e.pointerId);
    const cur = Number.parseFloat(drawer.style.width);
    if (Number.isFinite(cur) && cur > 0) applyAiDrawerWidth(cur, { persist: true });
  };
  resizeHandle.addEventListener('pointerup', endResize);
  resizeHandle.addEventListener('pointercancel', endResize);
  resizeHandle.addEventListener('dblclick', () => {
    applyAiDrawerWidth(AI_DRAWER_DEFAULT_WIDTH, { persist: true });
  });
}
