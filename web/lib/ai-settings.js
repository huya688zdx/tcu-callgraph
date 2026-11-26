/**
 * AI 助手抽屉：
 * 1. 对话助手：直连本地/远程 OpenAI 兼容接口（含旧版无 tools 接口自动兼容），实时把找到的函数和 Git 改动加入画布；
 * 2. 直连 API：配置 Base URL / Model / Key / 兼容模式，支持拉取模型与连通性测试；
 * 3. 外部 MCP：保留原有三档权限控制、一键复制 CC 命令与精简指令。
 */
import { t } from '../i18n.js';
import { boundSavedCodeAttachments, MAX_CODE_ATTACHMENTS, sanitizeCodeAttachments } from './ai-code-attachments.js';
import { api, clientId } from './api.js';
import { focusBox } from './camera.js';
import { hooks } from './hooks.js';
import { selectNode } from './menu.js';
import { confirmDialog, esc } from './modal.js';
import { runSearch } from './panels.js';
import { captureBoxImage, compositeEffects, draw } from './render.js';
import { edgeKey, els, state } from './state.js';

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
const renameChatBtn = document.getElementById('aiRenameChat');
const renameInputEl = document.getElementById('aiRenameInput');
const deleteChatBtn = document.getElementById('aiDeleteChat');
const setupBanner = document.getElementById('aiSetupBanner');
const goConfigBtn = document.getElementById('aiGoConfig');
const messagesEl = document.getElementById('aiMessages');
const selectionBar = document.getElementById('aiSelectionBar');
const pinnedListEl = document.getElementById('aiPinnedList');
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
const GENERIC_THREAD_TITLES = new Set([NEW_THREAD_TITLE, GIT_THREAD_TITLE, LABELS_THREAD_TITLE, BUILD_DIAG_THREAD_TITLE]);
const GIT_QUICK_PROMPT = '先调用 get_git_changes 查看当前 Git 未提交改动。如果改动涉及多个独立模块或多个车型目录（如不同路径前缀），先用 ask_user 询问我保留哪些车型或是否按书签拆分；如果范围唯一明确，直接调用 add_to_canvas({ fromGit: true }) 加入画布并简述影响。';
const LABELS_QUICK_PROMPT = '立即补全当前画布上缺失的 TASK 周期（含函数上方注释中的周期）和 コール順 标签：先调 find_symbols({}) 查看画布连线与自动识别的候选标签，再直接调用 apply_labels 把标签写入画布（コール順 不带注释），不要只口头列出。';
const BUILD_DIAG_QUICK_PROMPT = [
  '请调用 inspect_build_config（先 action:"scan"，再按需用 summarize_cproject 或 read 查看代表性的 .cproject/.mak/QAC 文件）做只读摸底。',
  '重要：我只能手打转述，请把最终回复严格压到 7 行、总字数不超过 120 字，且全部脱敏（不写真实机种/业务/公司名），严格按下面极简格式输出：',
  '1.cproject：个数(位置)、配置数、有无linkedResources',
  '2.编译器/架构：如 ccv850/ccrh/gcc + v800',
  '3.路径/宏：主要标签/变量(${...})、有无excluding',
  '4.mak：单/多mak、-I/-D/@rsp/-f 写法',
  '5.扩展语法：是否见到 __interrupt/__near/__far/@地址/#pragma/内联汇编',
  '6.QAC/pl：有无及主要扩展名(.via/.prj/xml/.pl)',
  '7.Clang：本机有/无、重名函数数',
].join('\n');
const BOOKMARK_COMMAND = '/bookmark';
const DEFAULT_CONTEXT_WINDOW = 32768;
const DEFAULT_MAX_TOKENS = 8192;

const LABELS_FOLLOWUP = { label: '🏷 补全当前图 TASK/顺序标签', prompt: LABELS_QUICK_PROMPT };
const FOLLOWUPS = new Map([
  ['add_to_canvas', [
    LABELS_FOLLOWUP,
    { label: '✨ 一键整理画布排版', prompt: '请调用 arrange_canvas({ action: "tidy", direction: "LR" }) 一键整理当前画布布局。' },
    { label: '🔖 为当前视图保存书签', draft: BOOKMARK_COMMAND + ' ' },
  ]],
  ['get_git_changes', [
    { label: '⚡ 按独立模块拆分书签上图', prompt: '请基于刚才的 Git 改动调用 add_to_canvas({ fromGit: true, splitByGroup: true })，复用已有 snapshotId 并沿用已确认的车型范围，按独立模块拆分书签并上图。' },
    { label: '🔍 查看上游车型分支', prompt: '请调用 trace_upstream 追踪刚才 Git 改动函数的上游 TASK/ISR 调用链，按车型或目录汇总上游分支。' },
  ]],
  ['apply_labels', [
    { label: '🔍 查找相关共享变量入图', prompt: '请查找当前画布函数相关的共享变量，确认读写关系后把找到的共享变量加入当前画布。' },
    { label: '⚡ 检查 Git 未提交改动', prompt: '请调用 get_git_changes 只读检查当前 Git 未提交改动，汇总改动涉及的文件、函数和独立模块。' },
  ]],
  ['remove_from_canvas', [
    LABELS_FOLLOWUP,
    { label: '🔖 保存当前筛选结果为书签', draft: BOOKMARK_COMMAND + ' ' },
  ]],
  ['read_function', [
    { label: '🔍 查上游 TASK 调用链', prompt: '请调用 trace_upstream 只读追踪刚才分析函数的上游 TASK/ISR 调用链。' },
    { label: '🧭 查间接/函数指针调用', prompt: '请调用 inspect_indirect_calls 和 read_source 检查刚才分析函数是否存在函数指针数组、常量结构体或回调间接调用。' },
    { label: '➕ 将相关函数加入画布', prompt: '请将刚才分析的相关函数及上游入口加入当前画布。' },
  ]],
  ['read_source', [
    { label: '🧭 核实并补入间接调用边', prompt: '请根据刚才查到的源码证据，调用 add_call_edge 只加入真正会触发的间接调用边到画布。' },
    { label: '🔍 追踪上游调用链', prompt: '请追踪刚才源码涉及核心函数的上游 TASK/ISR 调用链。' },
  ]],
  ['inspect_indirect_calls', [
    { label: '🔗 按源码核实并补边入图', prompt: '请结合实际代码逻辑，只选择真正会执行的间接调用目标，调用 add_call_edge 写入工程调用图并加入画布。' },
    { label: '📄 读取分派表定义源码', prompt: '请调用 read_source 读取对应常量结构体/分派表的完整定义源码。' },
  ]],
  ['add_call_edge', [
    { label: '🔍 重新追踪上游调用链', prompt: '请重新调用 trace_upstream 验证补边后的完整上游 TASK/ISR 调用链。' },
    { label: '✨ 整理当前画布布局', prompt: '请调用 arrange_canvas({ action: "tidy", direction: "LR" }) 整理当前画布。' },
  ]],
  ['trace_upstream', [
    { label: '➕ 将上游调用链加入画布', prompt: '请将刚才查到的上游调用链加入当前画布。' },
    { label: '🧭 排查缺失的间接调用', prompt: '请调用 inspect_indirect_calls 检查是否还有通过函数指针表或回调触发的上游调用。' },
  ]],
  ['find_symbols', [
    { label: '➕ 将匹配结果加入画布', prompt: '请将刚才找到的主要相关函数加入当前画布。' },
    { label: '📖 查看核心函数源码', prompt: '请调用 read_function 读取其中最核心函数的源码实现。' },
  ]],
  ['arrange_canvas', [
    { label: '↕️ 改为自上而下排布', prompt: '请调用 arrange_canvas({ action: "tidy", direction: "TB" }) 按从上到下方向重新整理画布。' },
    { label: '↩️ 恢复自动布局', prompt: '请调用 arrange_canvas({ action: "reset" }) 恢复画布自动布局。' },
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
const REASONING_LABELS = new Map([['default', '默认'], ['off', '关'], ['low', '低'], ['medium', '中'], ['high', '高']]);
const QUICK_CONFIG_ACTION = '__ai_open_config__';
const STEERING_PROMPT_PLACEHOLDER = '生成中可随时输入并按 Enter 中途引导或纠正…';
const MAX_PENDING_IMAGES = 2;
const MAX_PENDING_FILES = MAX_CODE_ATTACHMENTS;
let currentGhostSuggestion = '';
const pendingImages = []; // [{ id, dataUrl, label, width, height }]
const pendingFiles = [];  // [{ id, name, lines, startLine, endLine }]
let llmConfig = {
  baseUrl: 'http://127.0.0.1:11434/v1', model: '', hasApiKey: false,
  toolMode: 'auto', reasoningEffort: 'default', contextWindow: DEFAULT_CONTEXT_WINDOW,
  maxTokens: DEFAULT_MAX_TOKENS,
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
let chatThreads = []; // [{ id, title, customTitle?, updatedAt, messages }]
let activeChatId = '';
let renamingThread = null;
let activeAbort = null;
let pendingSteer = null;
let compacting = null;
let stickToBottom = true;
let displayedContext = { used: 0, promptTokens: 0, outputTokens: 0, estimated: false, hasMetrics: false };
let canvasSelection = null;
const pinnedSelections = [];
const MAX_PINNED_SELECTIONS = 16;
const dismissedSelectionKeys = new Set();
let activeStreamFlush = null;

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

function newThreadObject(title = NEW_THREAD_TITLE) {
  return {
    id: (crypto.randomUUID ? crypto.randomUUID() : `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    title,
    updatedAt: Date.now(),
    messages: [],
  };
}

function setActiveChat(id) {
  if (id !== activeChatId) stickToBottom = true;
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
      setChatStatus(`对话保存失败：${error.message}`, true);
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
  if (!save || !title || thread.id !== activeChatId || !chatThreads.includes(thread) ||
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

function messageContext(message) {
  const parts = [];
  if (message.role === 'user' && message.selectionSummary) {
    parts.push(`[当时画布选中：${message.selectionSummary}]`);
  }
  if (message.text) parts.push(message.text);
  if (message.role === 'assistant') {
    for (const tool of message.tools || []) {
      const digest = tool.digest || tool.summary;
      if (digest) parts.push(`[已执行工具：${tool.name} -> ${typeof digest === 'string' ? digest : JSON.stringify(digest)}]`);
    }
    if (message.questionOptions?.length) {
      const options = message.questionOptions.map((opt) =>
        opt.description ? `${opt.label}（${opt.description}）` : opt.label);
      parts.push(`[已提供选项：${options.join(' / ')}]`);
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
    contextBadge.textContent = `上下文 ${prefix}${formatTokens(used)} / ${formatWindowSize(limit)} · ${pct}%`;
  }
  contextBadge.classList.toggle('warn', rawPct >= 65 && rawPct < 85);
  contextBadge.classList.toggle('danger', rawPct >= 85);
  compactBtn?.classList.toggle('suggest', rawPct >= 75);

  const lines = [`上下文窗口占用：${used.toLocaleString()} / ${limit.toLocaleString()} tokens (${pct}%)`];
  if (hasMetrics && (promptTokens > 0 || outputTokens > 0)) {
    lines.push(`最近一轮：输入 ${promptTokens.toLocaleString()} · 输出 ${outputTokens.toLocaleString()} tokens（${estimated ? '估算' : '模型实测'}）`);
  } else if (used === 0) {
    lines.push('当前暂无对话消息');
  } else {
    lines.push('基于当前对话文本估算（发送请求后将按模型接口返回更新）');
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
    parts.push(`输出 ${metrics?.estimated ? '~' : ''}${formatTokens(tokens)}`);
  }
  if (Number.isFinite(speed) && speed > 0) {
    parts.push(`${speed.toFixed(1)} tok/s`);
  }
  speedBadge.textContent = parts.join(' · ');
  if (parts.length) {
    const detail = [];
    if (Number.isFinite(tokens) && tokens > 0) detail.push(`输出 ${tokens.toLocaleString()} tokens${metrics?.estimated ? '（估算）' : '（实测）'}`);
    if (Number.isFinite(speed) && speed > 0) detail.push(`速度 ${speed.toFixed(1)} tok/s`);
    if (Number.isFinite(elapsedMs) && elapsedMs >= 100) detail.push(`耗时 ${(elapsedMs / 1000).toFixed(1)}s`);
    speedBadge.title = detail.join(' · ');
  } else {
    speedBadge.title = '';
  }
}

function setChatStatus(text = '', error = false) {
  chatStatusEl.textContent = text;
  chatStatusEl.classList.toggle('err', error);
}

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
    if (root?.name) return `分析「${root.name}」的上下游调用链及共享变量读写关系`;
  }
  return '查看当前 Git 未提交改动，汇总涉及的文件、函数和独立模块';
}

function syncInputSuggestion() {
  if (!inputEl) return;
  if (activeAbort) {
    currentGhostSuggestion = '';
    inputEl.placeholder = STEERING_PROMPT_PLACEHOLDER;
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
  sendBtn.textContent = streaming ? '引导' : '发送';
  sendBtn.title = streaming ? '立即中止当前步骤并带上新引导继续' : '';
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
  if (stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
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
    setChatStatus(`已定位到画布${node.kind === 'var' ? '变量' : '函数'}：${node.name}`);
    return;
  }
  if (els.search) {
    const query = clean.replace(/^var::/, '').split('::').pop();
    els.search.value = query;
    els.search.focus();
    void runSearch();
    setChatStatus(`当前画布暂无「${query}」，已在左侧搜索定位`);
  }
}

function formatAssistantText(text) {
  const inline = (line) => line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, index) => {
    if (index % 2 === 0) return esc(part);
    if (part.startsWith('`')) {
      const inner = part.slice(1, -1);
      if (isClickableSymbolToken(inner)) {
        const clean = inner.trim().replace(/\(\s*\)$/, '');
        return `<button type="button" class="ai-sym-link" data-ai-sym="${esc(clean)}" title="点击在画布中定位「${esc(clean)}」">${esc(inner)}</button>`;
      }
      return `<code>${esc(inner)}</code>`;
    }
    return `<strong>${esc(part.slice(2, -2))}</strong>`;
  }).join('');
  const lines = String(text || '').replace(/\r\n?/g, '\n')
    .replace(/^\s*\n+/, '').replace(/\n+\s*$/, '').replace(/\n{3,}/g, '\n\n').split('\n');
  let block = '';
  let html = '';
  for (const line of lines) {
    const item = line.match(/^\s*([-*+]|\d+\.)\s+(\S.*)$/);
    const tag = item ? (/^\d/.test(item[1]) ? 'ol' : 'ul') : line.trim() ? 'p' : '';
    if (block !== tag) {
      if (block) html += `</${block}>`;
      if (tag) html += `<${tag}>`;
      block = tag;
    } else if (tag === 'p') {
      html += '<br>';
    }
    if (item) html += `<li>${inline(item[2])}</li>`;
    else if (tag) html += inline(line);
  }
  if (block) html += `</${block}>`;
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
    box.insertBefore(details, box.querySelector('.ai-steps') || before);
    const pre = details.querySelector('pre');
    pre.addEventListener('scroll', () => {
      if (pre.clientHeight) pre.dataset.stickToBottom = String(isNearBottom(pre));
    }, { passive: true });
    details.addEventListener('toggle', () => followThinkingScroll(details, pre));
  }
  details.dataset.streaming = String(streaming);
  const timer = Number.isFinite(seconds) ? ` · ${seconds.toFixed(1)}s` : '';
  details.querySelector('summary').textContent = streaming
    ? (timer ? `Thinking${timer}` : 'Thinking…')
    : `Thinking${timer} · 点击收起/展开`;
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
    hint.textContent = '也可以直接在下方输入框自定义回复';
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

function buildFallbackFollowups(message) {
  const tools = Array.isArray(message?.tools) ? message.tools : [];
  const successfulTools = tools.filter(tool => tool.ok !== false);
  const addedToCanvas = successfulTools.some(tool => tool.name === 'add_to_canvas');
  const action = successfulTools.findLast(tool => FOLLOWUPS.has(tool.name) &&
    (tool.name !== 'get_git_changes' || !addedToCanvas));
  if (action) return FOLLOWUPS.get(action.name) || [];
  if (canvasSelection) {
    const { questions } = describeSelection(canvasSelection);
    if (questions?.length) {
      return [
        ...questions.slice(0, 2).map(([label, prompt]) => ({ label: `🔍 ${label}`, prompt })),
        { label: '🧭 查间接/函数指针调用', prompt: '请调用 inspect_indirect_calls 检查当前选中对象是否存在间接调用或分派表关系。' },
      ];
    }
  }
  if (state.view?.nodes?.length) {
    return [
      LABELS_FOLLOWUP,
      { label: '✨ 一键整理画布排版', prompt: '请调用 arrange_canvas({ action: "tidy", direction: "LR" }) 整理当前画布布局。' },
      { label: '⚡ 检查 Git 未提交改动', prompt: '请调用 get_git_changes 只读检查当前 Git 未提交改动，汇总改动涉及的文件和函数。' },
    ];
  }
  return [
    { label: '⚡ 检查 Git 未提交改动', prompt: '请调用 get_git_changes 只读检查当前 Git 未提交改动，汇总改动涉及的文件、函数和独立模块。' },
    { label: '🔍 按关键词查找函数', draft: '帮我找出和 ' },
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
  chips.setAttribute('aria-label', isDynamic ? 'AI 推荐的后续操作' : '后续操作');
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
        if (option.draft.startsWith(BOOKMARK_COMMAND)) setChatStatus('输入书签名称后按 Enter 保存');
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
  if (selection?.kind === 'pair' && Array.isArray(selection.ids) && selection.ids.length >= 2) {
    return `pair:${selection.ids.join('|')}`;
  }
  return '';
}

function stripUiOnlySelectionFields(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.kind !== 'edge') return item;
  const { trunkBranches, trunkActiveIndex, trunkAll, ...clean } = item;
  return clean;
}

function expandSelectionItems(selection) {
  if (!selection || typeof selection !== 'object') return [];
  if (selection.kind === 'pair') {
    return [
      ...(Array.isArray(selection.nodes) ? selection.nodes : []),
      ...(Array.isArray(selection.edges) ? selection.edges : []),
    ].map(stripUiOnlySelectionFields);
  }
  return [stripUiOnlySelectionFields(selection)];
}

function describeSelection(selection) {
  if (selection.kind === 'pair') {
    const [a, b] = selection.nodes || [];
    const nameA = a?.name || a?.id?.split('::').pop() || selection.ids?.[0] || '';
    const nameB = b?.name || b?.id?.split('::').pop() || selection.ids?.[1] || '';
    const idA = a?.id || selection.ids?.[0] || nameA;
    const idB = b?.id || selection.ids?.[1] || nameB;
    const n = Number(selection.pathCount) || 0;
    const caption = n
      ? `两点链路：${nameA} ↔ ${nameB}（${n} 条路径）`
      : `两点关系：${nameA} ↔ ${nameB}（当前画布无直连）`;
    return {
      caption,
      questions: n ? [
        ['分析两点链路', `请结合当前选中的「${idA}」与「${idB}」及其中间连线，分析这两者之间的调用与数据流关系。`],
        ['核对关键路径', `请说明「${idA}」到「${idB}」之间各条路径的触发条件和先后顺序。`],
      ] : [
        ['查为何无路径', `请只读分析「${idA}」和「${idB}」为什么在当前画布没有直接相连的调用/数据流路径。`],
        ['补齐中间链', `请查找「${idA}」与「${idB}」之间的调用或数据流关系，确认范围后加入画布。`],
      ],
    };
  }
  if (selection.kind === 'node') {
    const { id, name, file, line } = selection;
    const variable = selection.nodeKind === 'var';
    const location = file ? ` (${file}${line ? `:${line}` : ''})` : '';
    return {
      caption: `${variable ? '变量' : '函数'}：${name || id}${location}`,
      questions: variable ? [
        ['解释变量', `请解释变量「${id}」的用途。`],
        ['查读写关系', `请查找读写变量「${id}」的函数。`],
      ] : [
        ['解释函数', `请解释函数「${id}」的职责和主要逻辑。`],
        ['查上游调用链', `请追踪函数「${id}」的上游调用链。`],
      ],
    };
  }
  if (selection.kind === 'edge') {
    const { from, to, fromName, toName, labels = [], line } = selection;
    const tag = labels.find(label => label.preset === 'task')?.text || labels[0]?.text;
    const endpoints = `${fromName || from?.split('::').pop()} → ${toName || to?.split('::').pop()}`;
    const edgeRef = `「${from} → ${to}」${line ? `（第 ${line} 行）` : ''}`;
    return {
      caption: `连线：${endpoints}${tag ? ` [${tag}]` : ''}`,
      questions: [
        ['分析此连线', `请分析连线${edgeRef}的关系和调用场景。`],
        ['核对标签周期', `请核对连线${edgeRef}的 TASK 标签和实际任务周期。`],
      ],
    };
  }
  const directory = selection.containerKind === 'dir';
  const kind = directory ? '目录' : '文件';
  const path = selection.path || '.';
  return {
    caption: `${kind}：${selection.path || selection.label || path}`,
    questions: [
      [directory ? '梳理目录函数' : '梳理文件函数', `请梳理${kind}「${path}」中的主要函数及其关系。`],
      ['查改动影响', `请分析${kind}「${path}」中的 Git 改动及其影响范围。`],
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
        const chip = document.createElement('span');
        chip.className = 'ai-pinned-chip';
        chip.title = caption;
        const label = document.createElement('span');
        label.textContent = caption;
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'ai-pinned-rm';
        rm.setAttribute('aria-label', `移除暂存：${caption}`);
        rm.textContent = '×';
        rm.addEventListener('click', () => {
          const idx = pinnedSelections.findIndex((x) => selectionKey(x) === key);
          if (idx >= 0) pinnedSelections.splice(idx, 1);
          renderSelectionBar();
        });
        chip.append(label, rm);
        pinnedListEl.appendChild(chip);
      }
      if (pinnedSelections.length >= 2) {
        const clearAll = document.createElement('button');
        clearAll.type = 'button';
        clearAll.className = 'ai-pinned-clear';
        clearAll.textContent = `清空暂存 (${pinnedSelections.length})`;
        clearAll.addEventListener('click', () => {
          pinnedSelections.length = 0;
          renderSelectionBar();
        });
        pinnedListEl.appendChild(clearAll);
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
      if (trunkBadgeEl) trunkBadgeEl.textContent = `共线 ${activeIdx + 1}/${branches.length}`;
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
    selectionText.textContent = selectionText.title = `📎 ${caption}`;
    const activeKey = selectionKey(canvasSelection);
    const alreadyPinned = pinnedSelections.some((item) => selectionKey(item) === activeKey);
    if (pinSelectionBtn) {
      pinSelectionBtn.disabled = alreadyPinned || pinnedSelections.length >= MAX_PINNED_SELECTIONS;
      pinSelectionBtn.textContent = alreadyPinned ? '✓' : '+';
      pinSelectionBtn.title = alreadyPinned
        ? '已暂存到待提问列表'
        : pinnedSelections.length >= MAX_PINNED_SELECTIONS
          ? `最多暂存 ${MAX_PINNED_SELECTIONS} 项`
          : '暂存到待提问列表，可继续点选多个画布关系';
    }
    for (const [label, prompt] of questions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'ai-followup-chip';
      chip.textContent = label;
      chip.disabled = Boolean(compacting);
      chip.addEventListener('click', () => sendPrompt(prompt));
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

function pinCurrentSelection() {
  if (!canvasSelection) return;
  const additions = canvasSelection.kind === 'pair'
    ? (canvasSelection.nodes || [])
    : [stripUiOnlySelectionFields(canvasSelection)];
  let added = 0;
  for (const item of additions) {
    const key = selectionKey(item);
    if (!key || pinnedSelections.some((x) => selectionKey(x) === key)) continue;
    if (pinnedSelections.length >= MAX_PINNED_SELECTIONS) {
      setChatStatus(`最多同时暂存 ${MAX_PINNED_SELECTIONS} 个画布关系`, true);
      break;
    }
    pinnedSelections.push({ ...item });
    added++;
  }
  if (!added) return;
  renderSelectionBar();
  setChatStatus(`已暂存到上下文（共 ${pinnedSelections.length} 项），可继续点选其他关系`);
}

function summarizeUiContext(uiContext) {
  if (!uiContext || typeof uiContext !== 'object') return '';
  const list = Array.isArray(uiContext.items) && uiContext.items.length ? uiContext.items : [uiContext];
  const labels = list.map((item) => {
    if (!item || typeof item !== 'object') return '';
    if (item.kind === 'node') return `节点 ${item.id || item.name || ''}`.trim();
    if (item.kind === 'edge') {
      const endpoints = item.from && item.to ? `${item.from} → ${item.to}` : (item.edgeKey || '');
      return endpoints ? `连线 ${endpoints}` : '';
    }
    if (item.kind === 'file') return item.path ? `文件 ${item.path}` : '';
    return '';
  }).filter(Boolean);
  if (!labels.length) return '';
  return labels.join('、').slice(0, 260);
}

function currentUiContext() {
  const items = [];
  const seen = new Set();
  const sources = [...(canvasSelection ? [canvasSelection] : []), ...pinnedSelections];
  for (const source of sources) {
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
  return { ...items[0], items };
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
  if (lightboxCaptionEl) lightboxCaptionEl.textContent = caption || '画布/附件图片预览';
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
    if (pendingImages.length) parts.push(`${pendingImages.length}图`);
    if (pendingFiles.length) parts.push(`${pendingFiles.length}文件`);
    attachShotBtn.textContent = `📎 已附 ${parts.join('+')}`;
  } else {
    attachShotBtn.textContent = '📎 截图/文件';
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
    thumb.alt = img.label || '截图';
    thumb.title = '点击查看大图预览';
    thumb.addEventListener('click', () => openImageLightbox(img.dataUrl, `${img.label} (${img.width}×${img.height})`));
    const meta = document.createElement('div');
    meta.className = 'ai-att-meta';
    const name = document.createElement('span');
    name.className = 'ai-att-name';
    name.textContent = name.title = img.label || '画布截图';
    const sub = document.createElement('span');
    sub.className = 'ai-att-sub';
    sub.textContent = `${img.width}×${img.height} · 点击预览`;
    meta.append(name, sub);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ai-att-rm';
    rm.setAttribute('aria-label', `移除图片：${img.label}`);
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
    title.title = `${file.name}（共 ${file.lines.length} 行）`;
    const range = document.createElement('span');
    range.className = 'ai-att-range';
    const startInput = document.createElement('input');
    startInput.type = 'number';
    startInput.min = '1';
    startInput.max = String(Math.max(1, file.lines.length));
    startInput.value = String(file.startLine);
    startInput.title = '导入起始行号';
    const endInput = document.createElement('input');
    endInput.type = 'number';
    endInput.min = '1';
    endInput.max = String(Math.max(1, file.lines.length));
    endInput.value = String(file.endLine);
    endInput.title = '导入结束行号（可只导入部分片段）';
    const syncRange = () => {
      const total = Math.max(1, file.lines.length);
      file.startLine = Math.max(1, Math.min(total, Math.trunc(Number(startInput.value) || 1)));
      file.endLine = Math.max(file.startLine, Math.min(total, Math.trunc(Number(endInput.value) || total)));
      startInput.value = String(file.startLine);
      endInput.value = String(file.endLine);
    };
    startInput.addEventListener('change', syncRange);
    endInput.addEventListener('change', syncRange);
    range.append('L', startInput, '-', endInput, ` / ${file.lines.length}行`);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ai-att-rm';
    rm.setAttribute('aria-label', `移除文件：${file.name}`);
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
    label: img.label || '图片',
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
    return dataUrl.startsWith('data:image/') ? { dataUrl, width: w, height: h, label: '当前画布视图' } : null;
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
      return g ? { kind: 'file', box: g, label: `文件：${g.label || g.id}` } : null;
    }
    const c = (v.containers || []).find((x) => x.id === id && !x.root);
    return c ? { kind: 'dir', box: c, label: `目录：${c.label || c.id}` } : null;
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
    setChatStatus('无法截取该层级/文件框，请确认画布已渲染', true);
    return false;
  }
  addImageAttachment({ ...shot, label: entry.label || entry.box.label || entry.box.id });
  setChatStatus(`已截取「${entry.label}」，点击缩略图可放大确认`);
  return true;
}

function encodeImageBlob(blob, label = '外部截图') {
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

async function addImageFromBlob(blob, label = '剪贴板截图') {
  const encoded = await encodeImageBlob(blob, label);
  if (!encoded) {
    setChatStatus('图片解析失败，请确认图片格式（PNG/JPG/WebP）', true);
    return false;
  }
  addImageAttachment(encoded);
  setChatStatus(`已附带图片「${label}」（${encoded.width}×${encoded.height}），点击缩略图可放大预览`);
  return true;
}

async function addExternalTextFile(file) {
  if (!file) return false;
  if (file.size > 1_500_000) {
    setChatStatus(`文件「${file.name}」超过 1.5MB，请裁剪后再导入`, true);
    return false;
  }
  const text = await file.text().catch(() => null);
  if (typeof text !== 'string' || !text.trim()) {
    setChatStatus(`文件「${file.name}」内容为空或无法按文本读取`, true);
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
  setChatStatus(`已导入「${file.name}」（共 ${lines.length} 行，默认 L1-${endLine}，可在上方微调导入行范围）`);
  return true;
}

function closeAttachMenu() {
  if (!attachMenuEl) return;
  attachMenuEl.hidden = true;
  attachShotBtn?.setAttribute('aria-expanded', 'false');
}

function openAttachMenu() {
  if (!attachMenuEl) return;
  if (!attachMenuEl.hidden) { closeAttachMenu(); return; }
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

  addTitle('画布截图（即时显示缩略图）');
  const hasNodes = Boolean(state.view?.nodes?.length);
  addItem('📷 截取当前画布视图', '当前视野', () => {
    const shot = captureViewportImage();
    if (shot) {
      addImageAttachment(shot);
      setChatStatus('已截取当前画布视图，点击缩略图可放大确认');
    } else {
      setChatStatus('当前画布暂无可截取内容', true);
    }
  }, !hasNodes);

  const selectedBox = resolveSelectedCanvasBox();
  addItem(
    selectedBox ? `📦 截取选中区域` : '📦 截取选中层级 / 文件框',
    selectedBox ? selectedBox.label : '先在画布点选文件或目录',
    () => captureScopedBoxAttachment(selectedBox),
    !selectedBox,
  );

  const v = state.view;
  const pickableBoxes = [
    ...(v?.containers || []).filter((c) => !c.root).map((c) => ({ kind: 'dir', box: c, label: `目录：${c.label || c.id}` })),
    ...(v?.groups || []).map((g) => ({ kind: 'file', box: g, label: `文件：${g.label || g.id}` })),
  ].slice(0, 8);
  if (pickableBoxes.length) {
    addSep();
    addTitle('按画布层级 / 文件框单独截图');
    for (const entry of pickableBoxes) {
      addItem(entry.kind === 'dir' ? `📁 ${entry.box.label || entry.box.id}` : `📄 ${entry.box.label || entry.box.id}`, entry.box.id, () => {
        captureScopedBoxAttachment(entry);
      });
    }
  }

  addSep();
  addTitle('外部图片与文件导入（也支持 Ctrl+V 粘贴截图 / 拖入文件）');
  addItem('🖼️ 导入外部图片', 'PNG / JPG / WebP', () => imageFileInputEl?.click());
  addItem('📄 导入外部代码/文本文件', '支持选定起止行片段', () => textFileInputEl?.click());

  attachMenuEl.hidden = false;
  attachShotBtn?.setAttribute('aria-expanded', 'true');
}

const EMPTY_CHAT_HTML = `<div class="empty">
  <div class="ai-empty-badge" aria-hidden="true">✦</div>
  <div class="ai-empty-title">TCU 调用图 AI 助手</div>
  <p class="ai-empty-desc">直接提问查找函数、分析 Git 改动或补全标签，选中的画布节点与连线会自动作为上下文。</p>
  <div class="ai-empty-keys"><span>Enter 发送</span><span>·</span><span>Shift+Enter 换行</span><span>·</span><span>/new 新建</span><span>·</span><span>/compact 压缩</span></div>
</div>`;

function renderThreadMessages() {
  if (!messagesEl) return;
  const th = activeThread();
  renderTelemetry(th);
  updateChatControls();
  setChatStatus();
  if (!th.messages.length) {
    messagesEl.innerHTML = EMPTY_CHAT_HTML;
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
    } else {
      const box = document.createElement('div');
      box.className = m.error ? 'ai-msg assistant error' : 'ai-msg assistant';
      if (Array.isArray(m.tools) && m.tools.length) {
        const steps = document.createElement('div');
        steps.className = 'ai-steps';
        for (const tl of m.tools) {
          finishStep(addStep(steps, tl.name), tl);
        }
        box.appendChild(steps);
      }
      const txt = document.createElement('div');
      txt.className = 'ai-msg-text';
      txt.innerHTML = formatAssistantText(m.text);
      box.appendChild(txt);
      showThinking(box, txt, m.thinking, m.thinkingSeconds);
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

function setApiStatus(text, isError = false) {
  if (!apiStatusEl) return;
  apiStatusEl.textContent = text;
  apiStatusEl.classList.toggle('err', isError);
}

function syncModelPicker() {
  modelSelectEl.value = modelEl.value.trim();
  if (modelSelectEl.selectedIndex < 0) modelSelectEl.value = '';
}

function applyFetchedModels(models, baseUrl = llmConfig.baseUrl || '') {
  fetchedModels = [...new Set((Array.isArray(models) ? models : []).map(id => String(id || '').trim()).filter(Boolean))];
  fetchedModelsBaseUrl = baseUrl;
  const placeholder = new Option('选择已获取的模型', '');
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
      const emptyOpt = new Option(llmConfig.baseUrl ? '选择或配置模型…' : '未配置模型 · 去配置', '');
      options.push(emptyOpt);
    }
    for (const id of list) {
      options.push(new Option(id, id));
    }
    options.push(new Option('⚙ 配置或刷新模型…', QUICK_CONFIG_ACTION));
    quickModelEl.replaceChildren(...options);
    quickModelEl.value = current || '';
    quickModelEl.classList.toggle('unconfigured', !configured);
    quickModelEl.title = configured
      ? `当前模型：${current}${llmConfig.toolMode === 'prompt' ? '（旧版兼容）' : ''} · 点击切换`
      : '尚未配置模型，点击前往配置';
  }
  if (quickReasoningEl) {
    const effort = REASONING_LABELS.has(llmConfig.reasoningEffort) ? llmConfig.reasoningEffort : 'default';
    quickReasoningEl.value = effort;
    quickReasoningEl.title = `思考强度：${REASONING_LABELS.get(effort) || '默认'}（切换后下轮生效）`;
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
      throw new Error(r?.error || (response.ok ? '保存失败' : `HTTP ${response.status}`));
    }
    llmConfig = r.config;
    syncApiForm();
    if (okMessage) setChatStatus(okMessage);
  } catch (err) {
    syncQuickControls();
    setChatStatus(controller.signal.aborted ? '切换超时，请重试' : `切换失败：${err.message || err}`, true);
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
  void api.aiModels({ baseUrl }, controller.signal)
    .then((r) => {
      if (r?.ok && Array.isArray(r.models) && r.models.length && llmConfig.baseUrl === baseUrl) {
        applyFetchedModels(r.models, baseUrl);
      }
    })
    .catch(() => {})
    .finally(() => { if (backgroundModelFetch === pending) backgroundModelFetch = null; });
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
  apiKeyEl.placeholder = llmConfig.hasApiKey ? '已保存（留空保持不变）' : '可选；本地模型留空即可';
  clearApiKeyPending = false;
  if (clearKeyBtn) clearKeyBtn.hidden = !llmConfig.hasApiKey;
  if (toolModeEl) toolModeEl.value = llmConfig.toolMode || 'auto';
  const effort = REASONING_LABELS.has(llmConfig.reasoningEffort) ? llmConfig.reasoningEffort : 'default';
  if (reasoningEffortEl) reasoningEffortEl.value = effort;
  contextWindowEl.value = llmConfig.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
  maxTokensEl.value = llmConfig.maxTokens ?? DEFAULT_MAX_TOKENS;
  renderContextBadge();
  const configured = Boolean(llmConfig.baseUrl && llmConfig.model);
  if (setupBanner) setupBanner.hidden = configured;
  syncQuickControls();
}

function readApiDraft() {
  const draft = {
    baseUrl: baseUrlEl.value.trim(),
    model: modelEl.value.trim(),
    toolMode: toolModeEl.value,
    reasoningEffort: reasoningEffortEl?.value || 'default',
    contextWindow: contextWindowEl.value ? contextWindowEl.valueAsNumber : DEFAULT_CONTEXT_WINDOW,
    maxTokens: maxTokensEl.value ? maxTokensEl.valueAsNumber : DEFAULT_MAX_TOKENS,
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
      el.alt = img.label || '已发送图片';
      el.title = `${img.label || '图片'} · 点击放大`;
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
  box.innerHTML = '<div class="ai-steps"></div><div class="ai-msg-text">正在连接模型…</div>';
  messagesEl.appendChild(box);
  followChatScroll();
  return {
    box,
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
  row.classList.add(tool.ok !== false ? 'ok' : 'err');
  const head = row.querySelector('.ai-step-head');
  head.textContent = head.title = tool.name;
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
  setChatStatus('正在压缩上下文…');
  try {
    const result = await api.compactChat({ projectId, threadId: thread.id, messages: compactMessages }, controller.signal);
    if (result?.ok === false) throw new Error(result.error);
    if (!Array.isArray(result?.messages)) throw new Error('压缩接口返回了无效的对话数据');
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
      setChatStatus(`已压缩上下文：${formatTokens(result.beforeTokens ?? before)} → ${formatTokens(after)} tokens`);
    }
  } catch (err) {
    if (isCurrent() && activeChatId === thread.id) setChatStatus(`压缩失败：${err.message}`, true);
  } finally {
    if (compacting === controller) {
      compacting = null;
      if (chatThreads.length) updateChatControls();
    }
  }
}

async function saveViewBookmark(name) {
  if (!name) {
    setChatStatus('请输入书签名称', true);
    inputEl.focus();
    return;
  }
  const projectId = state.view?.projectId;
  if (projectId == null || !state.roots.length) {
    setChatStatus('保存书签需要在当前画布选定至少一个入口函数', true);
    return;
  }
  const threadId = activeChatId;
  const isCurrent = () => activeChatId === threadId && state.view?.projectId === projectId && !activeAbort && !compacting;
  const draft = inputEl.value;
  inputEl.value = '';
  setChatStatus('正在保存书签…');
  try {
    const result = await api.saveBookmark({
      projectId, name, roots: state.roots, expansions: state.expansions,
      up: state.up, down: state.down, group: state.group, groupMode: state.groupMode, vars: [...state.vars],
    });
    if (!result?.ok) throw new Error(result?.error || '请求失败');
    if (isCurrent()) setChatStatus('已' + (result.overwritten ? '更新' : '保存') + '书签「' + name + '」');
  } catch (err) {
    if (isCurrent()) {
      if (!inputEl.value) inputEl.value = draft;
      setChatStatus('保存书签失败：' + (err.message || err), true);
    }
  }
}

async function sendPrompt(rawText, uiContext = currentUiContext()) {
  const text = String(rawText ?? inputEl.value).trim();
  if (!text) return;
  if (text === '/new' || text === '/clear') {
    pendingSteer = null;
    inputEl.value = '';
    if (await ensureChatProject()) {
      startNewThread();
      setChatStatus('已新建空白对话，原对话保留在历史列表中');
    }
    return;
  }
  if (text === '/compact') {
    if (activeAbort || compacting) {
      setChatStatus('请等待当前生成结束后再压缩上下文');
      return;
    }
    inputEl.value = '';
    await compactChat();
    return;
  }
  if (compacting) return;
  if (text === BOOKMARK_COMMAND || text.startsWith(BOOKMARK_COMMAND + ' ')) {
    if (activeAbort) {
      setChatStatus('请等待当前生成结束后再保存书签');
      return;
    }
    await saveViewBookmark(text.slice(BOOKMARK_COMMAND.length).trim());
    return;
  }
  if (activeAbort) {
    pendingSteer = {
      text,
      uiContext,
      threadId: activeChatId,
      projectId: chatProjectId,
      gen: chatGeneration,
    };
    inputEl.value = '';
    setChatStatus('正在中断当前步骤并应用新引导…');
    activeAbort.abort();
    return;
  }
  if (!llmConfig.baseUrl || !llmConfig.model) {
    setTab('api');
    setApiStatus('请先填写本地模型 API 地址和模型名称', true);
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

  if (!thread.customTitle && thread.title === NEW_THREAD_TITLE) {
    thread.title = deriveThreadTitle(text) || NEW_THREAD_TITLE;
  }
  const historySnapshot = chatHistory(turnMessages);

  const lastMessageEl = messagesEl.lastElementChild;
  lastMessageEl?.querySelector('.ai-followups')?.remove();
  const questionCard = lastMessageEl?.querySelector('.ai-question');
  if (questionCard) {
    for (const button of questionCard.querySelectorAll('.ai-q-opt')) button.disabled = true;
    questionCard.querySelector('.ai-q-hint')?.remove();
  }
  const images = pendingImages.splice(0, MAX_PENDING_IMAGES).map(({ dataUrl, label }) => ({ dataUrl, label }));
  const attachments = sanitizeCodeAttachments(pendingFiles.splice(0, MAX_PENDING_FILES).map((file) => {
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
  const selectionSummary = summarizeUiContext(uiContext);
  thread.messages.push({
    role: 'user',
    text,
    ...(selectionSummary ? { selectionSummary } : {}),
    ...(images.length ? { attachedImages: images } : {}),
    ...(attachments.length ? { attachedFiles: attachments } : {}),
  });
  thread.updatedAt = Date.now();
  renderChatBar();
  persistChats(myProjectId);

  inputEl.value = '';
  stickToBottom = true;
  appendUserMessage(text, images, attachments);
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
  activeStreamFlush = () => flushStreamPaint(true);
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
  const finishInterrupted = (message, stopped = false) => {
    stopThinking();
    for (const { row, name } of pendingSteps) {
      finishStep(row, { name, ok: false, summary: '执行中断' });
    }
    const steeringNow = stopped && isSteerQueuedForThisTurn();
    if (collectedTools.length || streamedText) {
      ui.text.innerHTML = formatAssistantText(streamedText);
      commitAssistantMsg({ text: streamedText });
    } else if (steeringNow) {
      // 中途引导且本轮尚未产生工具结果或正文时，直接移除空占位，避免插入多余报错气泡。
      ui.box.remove();
      return;
    } else {
      ui.box.classList.toggle('error', !stopped);
      ui.text.textContent = message;
      commitAssistantMsg({ text: message, error: true });
    }
    if (isVisible()) {
      if (!messagesEl.contains(ui.box)) renderThreadMessages();
      if (!steeringNow && (collectedTools.length || streamedText)) setChatStatus(message, !stopped);
    }
  };
  const handleLine = (line) => {
    if (terminalReceived || !line.trim()) return;
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
      const argBrief = ev.arguments && Object.keys(ev.arguments).length
        ? `(${JSON.stringify(ev.arguments).slice(0, 80)})` : '';
      pendingSteps.push({ name: ev.name, row: addStep(ui.steps, `${ev.name}${argBrief}…`) });
      dirtyScroll = true;
      scheduleStreamPaint();
    } else if (ev.type === 'tool_end') {
      const tool = { name: ev.name, ok: ev.ok !== false, summary: ev.summary || '', digest: ev.digest || '' };
      collectedTools.push(tool);
      const index = pendingSteps.findIndex((step) => step.name === tool.name);
      const row = index >= 0 ? pendingSteps.splice(index, 1)[0].row : addStep(ui.steps, tool.name);
      finishStep(row, tool);
      dirtyScroll = true;
      scheduleStreamPaint();
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
      const entry = {};
      if (Array.isArray(ev.toolLog) && ev.toolLog.length) {
        entry.tools = ev.toolLog.map(({ name, ok, summary, digest }) => ({ name, ok, summary, digest }));
      }
      if (ev.type === 'question' || ev.awaitingUser) {
        entry.text = ev.question || '请确认以下选项：';
        entry.questionOptions = Array.isArray(ev.options) ? ev.options : [];
        entry.allowCustom = ev.allowCustom !== false;
      } else {
        entry.text = ev.answer || streamedText || '已完成。';
        entry.completed = true;
        const suggestions = sanitizeSuggestions(ev.suggestions);
        if (suggestions.length) entry.suggestions = suggestions;
      }
      ui.text.innerHTML = formatAssistantText(entry.text);
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
      finishInterrupted(ev.error || '执行失败');
      if (isVisible()) followChatScroll();
    }
  };
  const canvasLayout = buildCanvasLayoutSnapshot();
  let streamTimer = setTimeout(() => controller.abort(new Error('连接 AI 服务超时')), 15_000);
  let reader;
  try {
    const res = await api.aiChat({
      prompt: text,
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
    reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      clearTimeout(streamTimer);
      streamTimer = setTimeout(() => controller.abort(new Error('等待 AI 响应超时')), 420_000);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    if (buffer.trim()) handleLine(buffer);
    if (!terminalReceived) finishInterrupted('连接提前中断，可以继续对话或重试。');
  } catch (err) {
    if (!terminalReceived) {
      const stopped = err.name === 'AbortError';
      finishInterrupted(stopped ? '已停止本次执行。' : (err.message || String(err)), stopped);
    }
  } finally {
    if (paintTimer) {
      clearTimeout(paintTimer);
      paintTimer = 0;
    }
    activeStreamFlush = null;
    clearTimeout(streamTimer);
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    let steer = null;
    if (activeAbort === controller) {
      activeAbort = null;
      if (isSteerQueuedForThisTurn() && isVisible()) steer = pendingSteer;
      pendingSteer = null;
      updateChatControls();
    }
    if (isVisible()) followChatScroll();
    if (steer) void sendPrompt(steer.text, steer.uiContext);
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
  openAttachMenu();
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
    await addImageFromBlob(f, f.name || '外部图片');
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
    if (blob) await addImageFromBlob(blob, '粘贴的外部截图');
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
  renameInputEl.value = renamingThread.title;
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
      title: '删除对话',
      message: `确定删除对话「${th.title || NEW_THREAD_TITLE}」（共 ${th.messages.length} 条记录）吗？\n删除后无法恢复；如只想开启新上下文，请点「+ 新建」。`,
      okText: '删除对话',
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
      sendPrompt(GIT_QUICK_PROMPT);
    } else if (kind === 'find') {
      prefillPrompt('帮我找出和 ');
    } else if (kind === 'labels') {
      sendPrompt(LABELS_QUICK_PROMPT);
    } else if (kind === 'build') {
      sendPrompt(BUILD_DIAG_QUICK_PROMPT);
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
  void saveQuickConfig({ model: val }, `已切换模型：${val}`);
});
if (quickReasoningEl) quickReasoningEl.addEventListener('change', () => {
  const val = quickReasoningEl.value;
  if (val === (llmConfig.reasoningEffort || 'default')) return;
  void saveQuickConfig({ reasoningEffort: val }, `已切换思考强度：${REASONING_LABELS.get(val) || val}`);
});
if (inputEl) {
  inputEl.addEventListener('input', syncInputSuggestion);
  inputEl.addEventListener('keydown', (e) => {
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
  apiKeyEl.placeholder = '保存后将清除已存 Key';
  clearKeyBtn.hidden = true;
});
if (fetchModelsBtn) fetchModelsBtn.addEventListener('click', async () => {
  setApiStatus('正在拉取模型列表…');
  fetchModelsBtn.disabled = true;
  try {
    const draft = readApiDraft();
    const r = await api.aiModels(draft);
    if (!r?.ok) throw new Error(r?.error || '拉取失败');
    const models = r.models || [];
    if (!modelEl.value.trim() && models.length) modelEl.value = models[0];
    applyFetchedModels(models, draft.baseUrl);
    setApiStatus(models.length ? `已获取 ${models.length} 个模型，可在下拉中选择` : '接口返回空列表，可手动输入模型名');
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
  const draft = readApiDraft();
  if (invalidTokenCount(contextWindowEl, draft.contextWindow)) {
    setApiStatus('上下文窗口须为 4096 到 1048576 之间的整数', true);
    contextWindowEl.focus();
    return;
  }
  if (invalidTokenCount(maxTokensEl, draft.maxTokens)) {
    setApiStatus('单次最大输出须为 0 到 65536 之间的整数', true);
    maxTokensEl.focus();
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  saveApiBtn.disabled = true;
  setApiStatus('正在保存…');
  try {
    const response = await fetch('/api/ai/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Callgraph-Client': clientId },
      body: JSON.stringify(draft),
      signal: controller.signal,
    });
    const r = await response.json().catch(() => null);
    if (!response.ok || !r?.ok || !r.config) {
      throw new Error(r?.error || (response.ok ? '保存失败' : `HTTP ${response.status}`));
    }
    llmConfig = r.config;
    syncApiForm();
    prefetchModelsForQuickPicker();
    setApiStatus('✓ 配置已保存，可直接切到「对话助手」使用');
  } catch (err) {
    setApiStatus(controller.signal.aborted ? '保存配置超时，请重试' : err.message || String(err), true);
  } finally {
    clearTimeout(timeout);
    saveApiBtn.disabled = false;
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
