/**
 * 内置直连 OpenAI 兼容模型代理：
 * - 零新依赖，直接调用本地或远程 /v1/chat/completions（兼容 Ollama / vLLM / LM Studio / llama.cpp / 旧版中转）。
 * - 为本地中小模型（如 Qwen 27B）提供简洁的工具参数。
 * - 自动兼容旧版 OpenAI 接口：支持标准 tool_calls、旧版 function_call，以及不传 tools / role:"tool" 的纯对话工具调用回退。
 */

const VALID_TOOL_MODES = new Set(['auto', 'tools', 'prompt']);
const VALID_REASONING_EFFORTS = new Set(['default', 'off', 'low', 'medium', 'high']);
const MAX_AGENT_STEPS = 24;
const DEFAULT_TIMEOUT_MS = 180_000;

export const DEFAULT_AI_CONFIG = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: '',
  apiKey: '',
  toolMode: 'auto',
  reasoningEffort: 'default',
  temperature: 0.2,
  maxTokens: 2048,
};

/** 兼容用户填写 http://host:port、.../v1、.../v1/chat/completions（含查询参数）三种形式。 */
export function normalizeBaseUrl(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { baseUrl: '', chatUrl: '', modelsUrl: '' };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('API 地址格式无效，请填写以 http:// 或 https:// 开头的地址');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('API 地址仅支持 http:// 或 https:// 协议');
  }
  parsed.hash = '';
  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  const withPath = (pathname) => {
    const u = new URL(parsed.href);
    u.pathname = pathname;
    return u.toString();
  };
  const baseUrl = withPath(cleanPath || '/').replace(/\/(?=$|\?)/, '');
  if (/\/chat\/completions$/i.test(cleanPath)) {
    const prefix = cleanPath.replace(/\/chat\/completions$/i, '');
    return { baseUrl, chatUrl: withPath(cleanPath), modelsUrl: withPath(`${prefix}/models`) };
  }
  if (/\/v\d+(?:alpha|beta)?$/i.test(cleanPath) || /\/openai$/i.test(cleanPath)) {
    return { baseUrl, chatUrl: withPath(`${cleanPath}/chat/completions`), modelsUrl: withPath(`${cleanPath}/models`) };
  }
  return { baseUrl, chatUrl: withPath(`${cleanPath}/v1/chat/completions`), modelsUrl: withPath(`${cleanPath}/v1/models`) };
}

export function normalizeAiConfig(raw = {}, existing = DEFAULT_AI_CONFIG) {
  const prev = { ...DEFAULT_AI_CONFIG, ...(existing || {}) };
  const baseUrlInput = raw.baseUrl !== undefined ? String(raw.baseUrl || '').trim() : prev.baseUrl;
  const nextNorm = baseUrlInput ? normalizeBaseUrl(baseUrlInput).baseUrl : '';
  const prevNorm = prev.baseUrl ? (() => { try { return normalizeBaseUrl(prev.baseUrl).baseUrl; } catch { return prev.baseUrl; } })() : '';
  const urlChanged = nextNorm !== prevNorm;
  const model = raw.model !== undefined ? String(raw.model || '').trim().slice(0, 200) : prev.model;
  // apiKey 传 undefined 表示保持原值，但清空或更换 API 地址时绝不把旧服务的 Key 串发给新地址。
  const apiKey = raw.apiKey !== undefined
    ? String(raw.apiKey || '').trim().slice(0, 500)
    : urlChanged ? '' : prev.apiKey;
  const toolMode = VALID_TOOL_MODES.has(raw.toolMode) ? raw.toolMode : prev.toolMode;
  const reasoningEffort = VALID_REASONING_EFFORTS.has(raw.reasoningEffort) ? raw.reasoningEffort : prev.reasoningEffort;
  const temperature = raw.temperature === undefined ? prev.temperature
    : Math.max(0, Math.min(2, Number(raw.temperature) || 0));
  const maxTokens = raw.maxTokens === undefined ? prev.maxTokens
    : Math.max(0, Math.min(32768, Math.trunc(Number(raw.maxTokens) || 0)));
  return { baseUrl: nextNorm, model, apiKey, toolMode, reasoningEffort, temperature, maxTokens };
}

export function publicAiConfig(config) {
  const c = { ...DEFAULT_AI_CONFIG, ...(config || {}) };
  return {
    baseUrl: c.baseUrl,
    model: c.model,
    hasApiKey: Boolean(c.apiKey),
    toolMode: c.toolMode,
    reasoningEffort: c.reasoningEffort,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
  };
}

function scrubSecret(text, apiKey) {
  let out = String(text || '');
  if (apiKey) out = out.replaceAll(apiKey, '***');
  return out;
}

/** 保持工具返回始终为合法 JSON，按字段裁剪大文本，避免硬切片破坏 JSON 结构。 */
function clipToolOutput(output, maxChars = 12000) {
  let text = JSON.stringify(output);
  if (text.length <= maxChars) return text;
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const clone = { ...output, truncated: true };
    if (typeof clone.source === 'string' && clone.source.length > 2000) {
      const budget = Math.max(800, maxChars - (text.length - clone.source.length) - 120);
      clone.source = clone.source.slice(0, budget) + '\n/* ...truncated */';
      text = JSON.stringify(clone);
      if (text.length <= maxChars) return text;
    }
    for (const key of Object.keys(clone)) {
      if (Array.isArray(clone[key]) && clone[key].length > 12) {
        clone[key] = clone[key].slice(0, 12);
      } else if (typeof clone[key] === 'string' && clone[key].length > 1000) {
        clone[key] = clone[key].slice(0, 1000) + '…';
      }
    }
    text = JSON.stringify(clone);
    if (text.length <= maxChars) return text;
  }
  return JSON.stringify({
    ok: output?.ok !== false,
    truncated: true,
    preview: text.slice(0, Math.max(200, maxChars - 120)),
  });
}

/** 直连模型可用的画布工具。 */
export const AGENT_TOOLS = [
  {
    name: 'get_git_changes',
    description: '获取当前 Git 仓库的未提交改动（或指定提交区间）涉及的文件、修改函数和变量，同时返回 snapshotId。',
    parameters: {
      type: 'object',
      properties: {
        baseRef: { type: 'string', description: '基准引用，默认 HEAD' },
        targetRef: { type: 'string', description: '目标引用，默认 WORKTREE（未提交改动）' },
      },
    },
  },
  {
    name: 'find_symbols',
    description: '按关键词搜索工程中的函数或全局变量；不传 query 时返回当前画布摘要和顶层 TASK/ISR 入口。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '函数名或变量名关键词，可留空' },
        kind: { type: 'string', enum: ['all', 'fn', 'var'], description: '搜索范围：all / fn / var，默认 all' },
        limit: { type: 'integer', description: '最多返回条数，默认 20' },
      },
    },
  },
  {
    name: 'read_function',
    description: '读取某个函数的 C 源码、直接调用关系、变量读写和上游 TASK/ISR 入口。可直接传短函数名或完整 文件::函数名。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '函数名或完整函数 ID，如 "range_gather" 或 "app/pa7_hook.c::range_gather"' },
        encoding: { type: 'string', enum: ['auto', 'cp932', 'utf-8'], description: '源码编码，日文工程可传 cp932，默认 auto' },
      },
      required: ['name'],
    },
  },
  {
    name: 'add_to_canvas',
    description: '把找到的函数和全局变量直接加入画布。支持短函数名或完整 ID；设 fromGit=true 可直接把 Git 未提交改动推上画布并着色。',
    parameters: {
      type: 'object',
      properties: {
        functions: { type: 'array', items: { type: 'string' }, description: '要加入的函数名或完整 ID 列表' },
        vars: { type: 'array', items: { type: 'string' }, description: '要加入的全局变量名或 var::ID 列表' },
        fromGit: { type: 'boolean', description: '为 true 时使用当前 Git 改动快照并自动按变更着色' },
        mode: { type: 'string', enum: ['add', 'replace'], description: 'add 追加到画布，replace 替换画布' },
        splitByGroup: { type: 'boolean', description: '当 Git 改动包含多个互不关联的独立模块时，自动拆分为多个视图书签（默认 true）' },
        bookmarkName: { type: 'string', description: '可选：同时将本次画布保存为该名称的书签' },
        includeTasks: { type: 'boolean', description: '是否自动补齐上游 TASK/ISR 调用链，默认 true' },
        up: { type: 'integer', description: '向上展开调用者层数 (0-3)，默认 0' },
        down: { type: 'integer', description: '向下展开被调者层数 (0-3)，默认 0' },
        reason: { type: 'string', description: '在画布提示栏显示的简短理由' },
      },
    },
  },
  {
    name: 'apply_labels',
    description: '给画布上的调用连线批量添加 TASK:xms 周期标签、コール順 调用顺序或結合点标签。注意：コール順（call）标签不要填 note 注释。from/to 支持短函数名，可选 line 指定调用行号。',
    parameters: {
      type: 'object',
      properties: {
        autoDetect: { type: 'boolean', description: '为 true 时直接将当前画布自动识别的 TASK（含函数头注释周期）和 コール順 标签写入画布' },
        items: {
          type: 'array',
          description: '标签列表',
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: '调用方函数名或完整 ID' },
              to: { type: 'string', description: '被调方函数名或完整 ID' },
              line: { type: 'integer', description: '可选：具体调用行号' },
              preset: { type: 'string', enum: ['task', 'call', 'conn'], description: 'task=周期(TASK:xms)，call=调用顺序(コール順N，不带注释)，conn=结合点' },
              text: { type: 'string', description: '标签文字，如 "TASK:10ms"' },
              order: { type: 'integer', description: 'preset=call 时的顺序编号，从 1 开始' },
              note: { type: 'string', description: '仅 task/conn 可选填简短依据，call(コール順) 不要填写' },
            },
            required: ['from', 'to', 'preset'],
          },
        },
      },
    },
  },
  {
    name: 'ask_user',
    description: '在修改画布前遇到明确歧义时向用户提问（如：Git 改动含多个独立模块问是否按书签拆分、重名函数或分析范围不清）。提供 2-4 个简洁选项；若指令已明确或用户刚回答过，直接动手不要多余提问。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '简明中文问题' },
        options: {
          type: 'array',
          description: '2-4 个简洁选项',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '按钮标题（简短）' },
              description: { type: 'string', description: '可选简短补充' },
            },
            required: ['label'],
          },
        },
        allowCustom: { type: 'boolean', description: '是否允许用户自由回复，默认 true' },
      },
      required: ['question'],
    },
  },
];

const TOOL_NAME_SET = new Set(AGENT_TOOLS.map(t => t.name));

function openAiToolsPayload() {
  return AGENT_TOOLS.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function authHeaders(apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function buildSystemPrompt(context, promptToolMode) {
  const ctxLines = [
    `当前工程：${context.projectName || '未命名'}（函数 ${context.fnCount ?? 0} / 变量 ${context.varCount ?? 0}）`,
    `当前画布入口：${context.canvasRoots?.length ? context.canvasRoots.join(', ') : '空画布'}`,
  ];
  if (context.gitDirtyFiles?.length) {
    ctxLines.push(`Git 未提交改动文件（${context.gitDirtyFiles.length} 个）：${context.gitDirtyFiles.slice(0, 15).join(', ')}${context.gitDirtyFiles.length > 15 ? '…' : ''}`);
  } else if (context.isGitRepo) {
    ctxLines.push('Git 工作区当前无未提交 C/H 改动');
  }
  if (context.tasks?.length) {
    ctxLines.push(`已识别任务入口：${context.tasks.slice(0, 10).join(', ')}`);
  }

  const base = [
    '你是 TCU C 调用图画布助手。目标是尽快调用工具把用户需要的函数和变量加入可编辑画布，再给出简明中文说明。',
    '核心原则：',
    '1. 不要长篇空想，立刻动手调工具。',
    '2. 用户要求将 Git 改动加入画布时，调用 add_to_canvas({ fromGit: true })，自动写入改动函数、上游 TASK 链、变更颜色和 TASK:xms 标签。多个独立模块可调用 add_to_canvas({ fromGit: true, splitByGroup: true }) 自动拆分为独立书签；如确实需要用户决定，先用 ask_user 询问拆分书签还是合并到单个画布。用户要求合并时传 splitByGroup: false。',
    '3. 用户按功能/关键词找函数或变量时，先调 find_symbols，再调 add_to_canvas 加入画布（支持短函数名，默认自动补齐上游 TASK 链）。',
    '4. 补齐 TASK 周期或调用顺序时，先调用 find_symbols({}) 查看 canvasEdges 和 suggestedLabels（含从函数头注释提取的周期），再调用 apply_labels 传入 items 或 { autoDetect: true } 写入画布。手动标周期用 preset:"task"（如 text:"TASK:10ms"），标调用顺序用 preset:"call"（コール順N），且 call 标签禁止填写 note。',
    '5. 源码若为日文 CP932，调 read_function 可传 encoding:"cp932"，严禁将乱码写入标签注释或回复。',
    '6. 只使用已确认存在的函数名。遇到重名时，根据上下文选择完整「文件::函数名」；如果目标仍不明确，在修改画布前用 ask_user 提供候选项。仅在重大画布修改前确有歧义时提问，用户意图明确或已回答时直接执行。',
    '7. 完成后用 2-5 句中文总结：加入了哪些函数/变量、触发任务周期及关键调用或数据流。',
    '',
    '当前上下文：',
    ...ctxLines,
  ];

  if (promptToolMode) {
    base.push(
      '',
      '【工具调用格式】需要调用工具时，只输出如下标签块（不要额外废话），等待工具结果后再继续：',
      '<tool_call>{"name":"工具名","arguments":{...}}</tool_call>',
      '可用工具清单：',
      ...AGENT_TOOLS.map(t => `- ${t.name}: ${t.description} 参数: ${JSON.stringify(t.parameters.properties)}`),
    );
  }
  return base.join('\n');
}

function flattenContent(content, thoughts) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'thinking' || block.type === 'reasoning') {
      const t = String(block.thinking ?? block.reasoning ?? block.text ?? '').trim();
      if (t) thoughts.push(t);
    } else if (typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** 分离 Qwen / DeepSeek 等本地模型的 <think> 思考过程、数组 content 与正式回复正文。 */
export function extractThinkingAndText(content, reasoningContent = '') {
  const thoughts = [];
  if (typeof reasoningContent === 'string' && reasoningContent.trim()) thoughts.push(reasoningContent.trim());
  let text = flattenContent(content, thoughts);
  text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, inner) => {
    if (inner.trim()) thoughts.push(inner.trim());
    return '';
  });
  const openIdx = text.search(/<think>/i);
  if (openIdx !== -1) {
    const rest = text.slice(openIdx + 7).trim();
    if (rest) thoughts.push(rest);
    text = text.slice(0, openIdx);
  }
  return { thinking: thoughts.join('\n\n').trim(), text: text.trim() };
}

function safeJsonParse(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch { return null; }
}

function normalizeParsedCall(obj, allowedNames) {
  if (!obj || typeof obj !== 'object') return null;
  const name = obj.name || obj.tool || obj.function;
  if (typeof name !== 'string' || !allowedNames.has(name)) return null;
  const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? {};
  const args = typeof rawArgs === 'string' ? (safeJsonParse(rawArgs) ?? {}) : (rawArgs && typeof rawArgs === 'object' ? rawArgs : {});
  return { name, arguments: args };
}

/** 从纯文本回复里提取工具调用（兼容 Qwen <tool_call>、Markdown 代码块与裸 JSON）。 */
export function parsePromptToolCalls(text, allowedNames = TOOL_NAME_SET, { tagOnly = false } = {}) {
  if (typeof text !== 'string' || !text.trim()) return [];
  const calls = [];
  const pushParsed = (raw) => {
    const parsed = safeJsonParse(raw);
    if (!parsed) return;
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      const call = normalizeParsedCall(item, allowedNames);
      if (call) calls.push(call);
    }
  };
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)) pushParsed(m[1]);
  if (calls.length || tagOnly) return calls;

  for (const m of text.matchAll(/```(?:tool_call|json)?\s*\r?\n([\s\S]*?)\r?\n```/gi)) pushParsed(m[1]);
  if (calls.length) return calls;

  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    pushParsed(trimmed);
  }
  return calls;
}

export function isToolUnsupportedError(status, bodyText) {
  if (![400, 404, 422, 500, 501].includes(status)) return false;
  return /tool|function|role|schema|choice|unsupported|unrecognized|not\s+supported|not\s+allowed|invalid_request/i.test(String(bodyText || ''));
}

export function isReasoningUnsupportedError(status, bodyText) {
  if (![400, 422].includes(status)) return false;
  const text = String(bodyText || '');
  if (/reasoning|thinking|chat_template_kwargs/i.test(text)) return true;
  if (/tool|function|role/i.test(text)) return false;
  return /extra_forbidden|unrecognized|unknown\s+(?:field|param|parameter|property)|additional\s+properties|not\s+permitted/i.test(text);
}

function buildReasoningPayload(effort) {
  if (effort === 'off') return { enable_thinking: false, chat_template_kwargs: { enable_thinking: false } };
  if (['low', 'medium', 'high'].includes(effort)) return { reasoning_effort: effort };
  return {};
}

/** 把已包含 tool_calls / role:tool / role:function 的会话无损转为纯 system/user/assistant，避免回退时重跑写工具。 */
function convertMessagesToPromptMode(messages, context) {
  const out = [{ role: 'system', content: buildSystemPrompt(context, true) }];
  let pendingToolTexts = [];
  const flushTools = () => {
    if (!pendingToolTexts.length) return;
    out.push({
      role: 'user',
      content: `${pendingToolTexts.join('\n\n')}\n请根据以上工具结果继续下一步；若画布已完成，直接用简明中文总结结果，不要再输出工具调用。`,
    });
    pendingToolTexts = [];
  };
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool' || m.role === 'function') {
      pendingToolTexts.push(`工具 ${m.name || ''} 返回：\n${m.content || ''}`);
      continue;
    }
    flushTools();
    if (m.role === 'assistant') {
      const textParts = [];
      if (typeof m.content === 'string' && m.content.trim()) textParts.push(m.content.trim());
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          textParts.push(`<tool_call>${JSON.stringify({ name: tc.function?.name, arguments: safeJsonParse(tc.function?.arguments) ?? {} })}</tool_call>`);
        }
      } else if (m.function_call?.name) {
        textParts.push(`<tool_call>${JSON.stringify({ name: m.function_call.name, arguments: safeJsonParse(m.function_call.arguments) ?? {} })}</tool_call>`);
      }
      out.push({ role: 'assistant', content: textParts.join('\n') || '…' });
    } else {
      out.push({ role: m.role, content: String(m.content || '') });
    }
  }
  flushTools();
  return out;
}

async function fetchJson(url, options, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, signal = null) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`请求模型接口超时（超过 ${Math.round(timeoutMs / 1000)} 秒）`)), timeoutMs);
  const onParentAbort = () => controller.abort(signal.reason || new Error('已取消'));
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); throw new Error('已取消'); }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }
  try {
    const res = await fetchImpl(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 错误体 */ }
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

export async function listModels(config, { fetchImpl = fetch, signal = null } = {}) {
  const { modelsUrl } = normalizeBaseUrl(config?.baseUrl);
  if (!modelsUrl) throw new Error('请先填写 API 地址');
  const res = await fetchJson(modelsUrl, {
    method: 'GET',
    headers: authHeaders(config.apiKey),
  }, fetchImpl, 15_000, signal);
  if (!res.ok) {
    const rawMsg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
    const msg = scrubSecret(rawMsg, config.apiKey).slice(0, 200);
    throw new Error(`获取模型列表失败：${msg}`);
  }
  if (!res.json || typeof res.json !== 'object') throw new Error('模型列表接口未返回有效 JSON，请检查 API 地址');
  const rawList = Array.isArray(res.json.data) ? res.json.data
    : Array.isArray(res.json.models) ? res.json.models
    : Array.isArray(res.json) ? res.json : [];
  const models = [...new Set(rawList.map(item => typeof item === 'string' ? item : item?.id || item?.name).filter(Boolean))];
  return { ok: true, models };
}

export async function testConnection(config, { fetchImpl = fetch, signal = null } = {}) {
  const { chatUrl } = normalizeBaseUrl(config?.baseUrl);
  if (!chatUrl) throw new Error('请先填写 API 地址');
  if (!config?.model) throw new Error('请先填写或选择模型名称');
  const started = Date.now();
  const body = {
    model: config.model,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 16,
    temperature: 0,
    stream: false,
  };
  const res = await fetchJson(chatUrl, {
    method: 'POST',
    headers: authHeaders(config.apiKey),
    body: JSON.stringify(body),
  }, fetchImpl, 30_000, signal);
  if (!res.ok) {
    const rawMsg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
    const msg = scrubSecret(rawMsg, config.apiKey).slice(0, 240);
    throw new Error(`连接失败（HTTP ${res.status}）：${msg}`);
  }
  const message = res.json?.choices?.[0]?.message;
  if (!res.json || !Array.isArray(res.json.choices) || !message) {
    throw new Error('接口返回的不是有效的 OpenAI Chat Completions JSON，请检查 API 地址');
  }
  const { text } = extractThinkingAndText(message.content ?? '', message.reasoning_content ?? '');
  return { ok: true, latencyMs: Date.now() - started, model: res.json.model || config.model, reply: text.slice(0, 80) };
}

function summarizeToolResult(name, result) {
  if (result?.ok === false) return `失败：${result.error || '未知错误'}`;
  if (name === 'get_git_changes') {
    if (result.noChanges) return 'Git 工作区无 C/H 源码改动';
    return `发现 ${result.changedFiles?.length || 0} 个文件、${result.changedFunctions?.length || 0} 个变更函数`;
  }
  if (name === 'find_symbols') {
    const summary = result.matches
      ? `找到 ${result.matches.length} 项匹配`
      : `画布 ${result.canvasRoots?.length || 0} 个入口，工程 ${result.tasks?.length || 0} 个任务`;
    return Array.isArray(result.suggestedLabels) ? `${summary}，${result.suggestedLabels.length} 条建议标签` : summary;
  }
  if (name === 'read_function') return `已读 ${result.name || result.id} (${result.file}:${result.startLine}-${result.endLine})`;
  if (name === 'add_to_canvas') {
    const parts = [`已加入画布（${result.addedCount ?? result.roots?.length ?? 0} 项）`];
    if (result.bookmarks?.length) parts.push(`已创建 ${result.bookmarks.length} 个书签`);
    if (result.ambiguous?.length) parts.push(`${result.ambiguous.length} 个重名待确认`);
    if (result.notFound?.length) parts.push(`${result.notFound.length} 个未找到`);
    return parts.join('，');
  }
  if (name === 'apply_labels') return `已写入 ${result.applied || 0} 条标签`;
  return '完成';
}

/** 运行直连模型的工具调用闭环，支持自动从标准 tools 平滑降级到旧版纯对话模式。 */
export async function runAiAgent({
  config,
  prompt,
  history = [],
  context = {},
  executeTool,
  onEvent = () => {},
  fetchImpl = fetch,
  signal = null,
  maxSteps = MAX_AGENT_STEPS,
}) {
  const { chatUrl } = normalizeBaseUrl(config?.baseUrl);
  if (!chatUrl) throw new Error('尚未配置模型 API 地址，请先在「直连 API」中填写');
  if (!config?.model) throw new Error('尚未配置模型名称，请先在「直连 API」中填写或拉取模型');
  const userText = String(prompt || '').trim();
  if (!userText) throw new Error('请输入要执行的任务');

  let activeMode = config.toolMode === 'prompt' ? 'prompt' : 'tools';
  const cleanHistory = (Array.isArray(history) ? history : [])
    .filter(m => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim())
    .slice(-8)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

  let messages = [
    { role: 'system', content: buildSystemPrompt(context, activeMode === 'prompt') },
    ...cleanHistory,
    { role: 'user', content: userText },
  ];
  const allThoughts = [];
  const toolLog = [];
  let switchedToPrompt = false;
  let reasoningDegraded = false;
  const reasoningPayload = buildReasoningPayload(config.reasoningEffort);
  const requestDefaults = {
    model: config.model,
    temperature: config.temperature ?? 0.2,
    ...(config.maxTokens > 0 ? { max_tokens: config.maxTokens } : {}),
    stream: false,
  };

  let step = 0;
  for (; step < maxSteps; step++) {
    if (signal?.aborted) throw new Error('已取消');
    onEvent({ type: 'status', text: step === 0 ? '正在思考并选择工具…' : `正在整合结果（第 ${step + 1} 步）…` });
    const reqBody = {
      ...requestDefaults,
      messages,
      ...(reasoningDegraded ? {} : reasoningPayload),
      ...(activeMode === 'tools' ? { tools: openAiToolsPayload(), tool_choice: 'auto' } : {}),
    };

    const res = await fetchJson(chatUrl, {
      method: 'POST',
      headers: authHeaders(config.apiKey),
      body: JSON.stringify(reqBody),
    }, fetchImpl, DEFAULT_TIMEOUT_MS, signal);

    if (!res.ok) {
      if (!reasoningDegraded && Object.keys(reasoningPayload).length > 0 && isReasoningUnsupportedError(res.status, res.text)) {
        reasoningDegraded = true;
        onEvent({ type: 'fallback', text: '接口不支持思考等级参数，已自动按默认模式继续' });
        step--;
        continue;
      }
      if (config.toolMode === 'auto' && activeMode === 'tools' && !switchedToPrompt && isToolUnsupportedError(res.status, res.text)) {
        switchedToPrompt = true;
        activeMode = 'prompt';
        // 保留已执行的工具结果并转换为纯对话格式，绝不丢弃历史导致重复执行写工具。
        messages = convertMessagesToPromptMode(messages, context);
        onEvent({ type: 'fallback', text: '接口不支持标准 tools / role:tool，已自动切换为旧版纯对话兼容模式' });
        step--;
        continue;
      }
      const rawMsg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
      const msg = scrubSecret(rawMsg, config.apiKey).slice(0, 260);
      throw new Error(`模型接口报错（HTTP ${res.status}）：${msg}`);
    }

    const choice = res.json?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error('模型返回格式异常：缺少 choices[0].message');

    const { thinking, text } = extractThinkingAndText(msg.content ?? '', msg.reasoning_content ?? msg.reasoning ?? msg.thinking ?? '');
    if (thinking) {
      allThoughts.push(thinking);
      onEvent({ type: 'thinking', step: step + 1, text: thinking });
    }

    // 解析三种形态的工具调用：标准 tool_calls / 旧版 function_call / 纯文本 <tool_call>
    let calls = [];
    let callStyle = 'none';
    let boundedToolCalls = null;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      callStyle = 'tool_calls';
      const usedIds = new Set();
      boundedToolCalls = [];
      for (const [idx, tc] of msg.tool_calls.slice(0, 6).entries()) {
        const name = tc?.function?.name;
        if (!name) continue;
        let id = typeof tc.id === 'string' && tc.id.trim() ? tc.id.trim() : `call_${step}_${idx}`;
        if (usedIds.has(id)) id = `${id}_${idx}`;
        usedIds.add(id);
        const argsStr = typeof tc.function?.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {});
        boundedToolCalls.push({
          id,
          type: tc.type || 'function',
          function: { name, arguments: argsStr },
        });
        calls.push({
          id,
          name,
          arguments: safeJsonParse(tc.function?.arguments) ?? {},
        });
      }
    } else if (msg.function_call?.name) {
      callStyle = 'function_call';
      calls = [{
        id: `fn_${step}`,
        name: msg.function_call.name,
        arguments: safeJsonParse(msg.function_call.arguments) ?? {},
      }];
    } else if (activeMode === 'prompt' || config.toolMode === 'auto') {
      // 标准 tools 模式下仅接受显式 <tool_call> 标签，绝不把正文里的 JSON 示例当工具执行。
      const parsed = parsePromptToolCalls(text, TOOL_NAME_SET, { tagOnly: activeMode === 'tools' });
      if (parsed.length) {
        callStyle = 'prompt';
        calls = parsed.slice(0, 6).map((c, idx) => ({ id: `prompt_${step}_${idx}`, ...c }));
      }
    }

    if (!calls.length) {
      if (!text) {
        step++;
        break;
      }
      const result = { ok: true, answer: text, thinking: allThoughts.join('\n\n'), toolLog, modeUsed: activeMode };
      onEvent({ type: 'done', ...result });
      return result;
    }

    if (signal?.aborted) throw new Error('已取消');

    const ask = calls.find(call => call.name === 'ask_user');
    if (ask) {
      const question = String(ask.arguments?.question || text || '请确认你的需求').trim() || '请确认你的需求';
      const rawOptions = ask.arguments?.options;
      const options = Array.isArray(rawOptions)
        ? rawOptions.map(option => ({
          label: String(option?.label ?? '').trim(),
          description: String(option?.description ?? '').trim(),
        })).filter(option => option.label).slice(0, 6)
        : [];
      const allowCustom = ask.arguments?.allowCustom !== false;
      const thinking = allThoughts.join('\n\n');
      onEvent({ type: 'question', question, options, allowCustom, thinking });
      return { ok: true, awaitingUser: true, question, options, allowCustom, answer: question, thinking, toolLog, modeUsed: activeMode };
    }

    // 把模型本轮输出加入历史（确保 tool_calls 数量与后续 role:tool 回复一一对应）
    if (callStyle === 'tool_calls' && activeMode === 'tools') {
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: boundedToolCalls });
    } else if (callStyle === 'function_call' && activeMode === 'tools') {
      messages.push({ role: 'assistant', content: msg.content ?? null, function_call: msg.function_call });
    } else {
      messages.push({ role: 'assistant', content: text || JSON.stringify(calls) });
    }

    const promptResults = [];
    for (const call of calls) {
      if (signal?.aborted) throw new Error('已取消');
      onEvent({ type: 'tool_start', name: call.name, arguments: call.arguments });
      let output;
      try {
        if (!TOOL_NAME_SET.has(call.name)) output = { ok: false, error: `未知工具：${call.name}` };
        else output = await executeTool(call.name, call.arguments || {});
      } catch (err) {
        output = { ok: false, error: String(err?.message || err) };
      }
      const summary = summarizeToolResult(call.name, output);
      toolLog.push({ name: call.name, arguments: call.arguments, ok: output?.ok !== false, summary });
      onEvent({ type: 'tool_end', name: call.name, ok: output?.ok !== false, summary });

      const clipped = clipToolOutput(output, 12000);
      if (callStyle === 'tool_calls' && activeMode === 'tools') {
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: clipped });
      } else if (callStyle === 'function_call' && activeMode === 'tools') {
        messages.push({ role: 'function', name: call.name, content: clipped });
      } else {
        promptResults.push(`工具 ${call.name} 返回：\n${clipped}`);
      }
    }

    if (callStyle === 'prompt' || activeMode !== 'tools') {
      messages.push({
        role: 'user',
        content: `${promptResults.join('\n\n')}\n请根据以上工具结果继续下一步；若画布已完成，直接用简明中文总结结果，不要再输出工具调用。`,
      });
    }
  }

  let answer = '';
  if (toolLog.length > 0 && !signal?.aborted) {
    let summaryMessage;
    try {
      const res = await fetchJson(chatUrl, {
        method: 'POST',
        headers: authHeaders(config.apiKey),
        body: JSON.stringify({
          ...requestDefaults,
          ...(reasoningDegraded ? {} : reasoningPayload),
          messages: [...messages, { role: 'user', content: '请用 2-4 句简明中文总结以上已完成的操作结果，不要再调用工具。' }],
        }),
      }, fetchImpl, 15_000, signal);
      if (res.ok) summaryMessage = res.json?.choices?.[0]?.message;
    } catch {
      // 总结请求失败时使用已记录的工具结果。
    }
    if (summaryMessage) {
      const { thinking, text } = extractThinkingAndText(
        summaryMessage.content ?? '',
        summaryMessage.reasoning_content ?? summaryMessage.reasoning ?? summaryMessage.thinking ?? '',
      );
      if (thinking) {
        allThoughts.push(thinking);
        onEvent({ type: 'thinking', step: step + 1, text: thinking });
      }
      answer = text;
    }
  }
  answer ||= toolLog.length
    ? `已完成 ${toolLog.length} 步操作：${toolLog.map(t => t.summary).join('；')}。如需继续，请发下一条指令。`
    : '未能直接完成该请求，请补充更明确的函数名或关键词。';
  const result = { ok: true, answer, thinking: allThoughts.join('\n\n'), toolLog, modeUsed: activeMode };
  onEvent({ type: 'done', ...result });
  return result;
}
