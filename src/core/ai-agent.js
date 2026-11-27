/**
 * 内置直连 OpenAI 兼容模型代理：
 * - 零新依赖，直接调用本地或远程 /v1/chat/completions（兼容 Ollama / vLLM / LM Studio / llama.cpp / 旧版中转）。
 * - 面向通用大模型（不绑定单一模型家族），提供精炼、语义明确的工具集与结构化证据注入。
 * - 自动兼容旧版 OpenAI 接口：支持标准 tool_calls、旧版 function_call，以及不传 tools / role:"tool" 的纯对话工具调用回退。
 */

import { SUPPORTED_LANGS } from '../../web/lib/message-catalog.js';
import { aiTranslator } from './ai-messages.js';
import { MAX_CODE_ATTACHMENT_CHARS, sanitizeCodeAttachments } from '../../web/lib/ai-code-attachments.js';

const VALID_TOOL_MODES = new Set(['auto', 'tools', 'prompt']);
const VALID_REASONING_EFFORTS = new Set(['default', 'off', 'low', 'medium', 'high']);
const MAX_AGENT_STEPS = 24;
const DEFAULT_TIMEOUT_MS = 180_000;
const SSE_TRAILER_TIMEOUT_MS = 1_000;
const MAX_SSE_FRAME_CHARS = 4 * 1024 * 1024;
const SSE_FRAME_SEPARATOR = /(?:\r\n|\r(?!\n)|\n){2}/;

export const DEFAULT_AI_CONFIG = {
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: '',
  apiKey: '',
  toolMode: 'auto',
  reasoningEffort: 'default',
  temperature: 0.2,
  maxTokens: 8192,
  contextWindow: 32768,
  subagentEnabled: true,
  subagentMaxConcurrency: 2,
  subagentMaxSteps: 6,
};

function validContextWindow(value) {
  return Number.isInteger(value) && value >= 4096 && value <= 1048576;
}

function clampInt(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
}

/** 兼容用户填写 http://host:port、.../v1、.../v1/chat/completions（含查询参数）三种形式。 */
export function normalizeBaseUrl(raw, tr = aiTranslator()) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { baseUrl: '', chatUrl: '', modelsUrl: '' };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(tr('api.invalidUrl'));
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(tr('api.protocol'));
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

export function normalizeAiConfig(raw = {}, existing = DEFAULT_AI_CONFIG, tr = aiTranslator(raw.language)) {
  const prev = { ...DEFAULT_AI_CONFIG, ...(existing || {}) };
  const baseUrlInput = raw.baseUrl !== undefined ? String(raw.baseUrl || '').trim() : prev.baseUrl;
  const nextNorm = baseUrlInput ? normalizeBaseUrl(baseUrlInput, tr).baseUrl : '';
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
    : Math.max(0, Math.min(65536, Math.trunc(Number(raw.maxTokens) || 0)));
  const requestedWindow = Number(raw.contextWindow);
  const contextWindow = validContextWindow(requestedWindow) ? requestedWindow : prev.contextWindow;
  const subagentEnabled = raw.subagentEnabled !== undefined ? Boolean(raw.subagentEnabled) : Boolean(prev.subagentEnabled);
  const subagentMaxConcurrency = raw.subagentMaxConcurrency === undefined
    ? clampInt(prev.subagentMaxConcurrency, DEFAULT_AI_CONFIG.subagentMaxConcurrency, 1, 3)
    : clampInt(raw.subagentMaxConcurrency, DEFAULT_AI_CONFIG.subagentMaxConcurrency, 1, 3);
  const subagentMaxSteps = raw.subagentMaxSteps === undefined
    ? clampInt(prev.subagentMaxSteps, DEFAULT_AI_CONFIG.subagentMaxSteps, 2, 12)
    : clampInt(raw.subagentMaxSteps, DEFAULT_AI_CONFIG.subagentMaxSteps, 2, 12);
  return {
    baseUrl: nextNorm,
    model,
    apiKey,
    toolMode,
    reasoningEffort,
    temperature,
    maxTokens,
    contextWindow,
    subagentEnabled,
    subagentMaxConcurrency,
    subagentMaxSteps,
  };
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
    contextWindow: c.contextWindow,
    subagentEnabled: Boolean(c.subagentEnabled),
    subagentMaxConcurrency: clampInt(c.subagentMaxConcurrency, DEFAULT_AI_CONFIG.subagentMaxConcurrency, 1, 3),
    subagentMaxSteps: clampInt(c.subagentMaxSteps, DEFAULT_AI_CONFIG.subagentMaxSteps, 2, 12),
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
  if (output?.action === 'inspect' && Array.isArray(output.nodes)) {
    const { nodes, groups, containers, edges, ...summary } = output;
    const clipped = { ...summary, truncated: true, nodes: [], groups: [], containers: [], edges: [] };
    let remaining = maxChars - JSON.stringify(clipped).length;
    for (const [key, items] of Object.entries({ nodes, groups, containers, edges })) {
      for (const item of items || []) {
        const size = JSON.stringify(item).length + (clipped[key].length ? 1 : 0);
        if (size > remaining) break;
        clipped[key].push(item);
        remaining -= size;
      }
    }
    return JSON.stringify(clipped);
  }
  // 裁剪工具结果时保留车型选择所需的目录前缀。
  const vehicleChoice = {
    ...(output?.needsVehicleChoice === true ? { needsVehicleChoice: true } : {}),
    ...(Array.isArray(output?.pathBranches) ? {
      pathBranches: output.pathBranches.map(branch => ({ prefix: typeof branch === 'string' ? branch : branch?.prefix })),
    } : {}),
  };
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    const clone = { ...output, ...vehicleChoice, truncated: true };
    if (typeof clone.source === 'string' && clone.source.length > 2000) {
      const budget = Math.max(800, maxChars - (text.length - clone.source.length) - 120);
      clone.source = clone.source.slice(0, budget) + '\n/* ...truncated */';
      text = JSON.stringify(clone);
      if (text.length <= maxChars) return text;
    }
    for (const key of Object.keys(clone)) {
      if (key === 'pathBranches') continue;
      if (Array.isArray(clone[key]) && clone[key].length > 12) {
        clone[key] = clone[key].slice(0, 12);
      } else if (typeof clone[key] === 'string' && clone[key].length > 1000) {
        clone[key] = clone[key].slice(0, 1000) + '…';
      }
    }
    text = JSON.stringify(clone);
    if (text.length <= maxChars) return text;
  }
  const preview = {
    ok: output?.ok !== false,
    truncated: true,
    ...vehicleChoice,
  };
  const budget = Math.max(200, maxChars - JSON.stringify(preview).length - 120);
  return JSON.stringify({ ...preview, preview: text.slice(0, budget) });
}

/** 直连模型可用的画布工具。 */
const buildToolDefinitions = tr => [
  {
    name: 'get_git_changes',
    description: tr('tool.get_git_changes'),
    parameters: {
      type: 'object',
      properties: {
        baseRef: { type: 'string', description: tr('tool.get_git_changes.baseRef') },
        targetRef: { type: 'string', description: tr('tool.get_git_changes.targetRef') },
      },
    },
  },
  {
    name: 'inspect_build_config',
    description: tr('tool.inspect_build_config'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['scan', 'summarize_cproject', 'read'], description: tr('tool.inspect_build_config.action') },
        file: { type: 'string', description: tr('tool.inspect_build_config.file') },
        startLine: { type: 'integer', description: tr('tool.inspect_build_config.startLine') },
        endLine: { type: 'integer', description: tr('tool.inspect_build_config.endLine') },
        query: { type: 'string', description: tr('tool.inspect_build_config.query') },
        encoding: { type: 'string', enum: ['auto', 'cp932', 'utf-8'], description: tr('tool.inspect_build_config.encoding') },
      },
    },
  },
  {
    name: 'find_symbols',
    description: tr('tool.find_symbols'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: tr('tool.find_symbols.query') },
        kind: { type: 'string', enum: ['all', 'fn', 'var'], description: tr('tool.find_symbols.kind') },
        limit: { type: 'integer', description: tr('tool.find_symbols.limit') },
      },
    },
  },
  {
    name: 'read_function',
    description: tr('tool.read_function'),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: tr('tool.read_function.name') },
        names: { type: 'array', maxItems: 6, items: { type: 'string' }, description: tr('tool.read_function.names') },
        encoding: { type: 'string', enum: ['auto', 'cp932', 'utf-8'], description: tr('tool.read_function.encoding') },
      },
    },
  },
  {
    name: 'read_source',
    description: tr('tool.read_source'),
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: tr('tool.read_source.file') },
        startLine: { type: 'integer', description: tr('tool.read_source.startLine') },
        endLine: { type: 'integer', description: tr('tool.read_source.endLine') },
        query: { type: 'string', description: tr('tool.read_source.query') },
        paths: { type: 'array', items: { type: 'string' }, description: tr('tool.read_source.paths') },
        encoding: { type: 'string', enum: ['auto', 'cp932', 'utf-8'], description: tr('tool.read_source.encoding') },
        limit: { type: 'integer', description: tr('tool.read_source.limit') },
      },
    },
  },
  {
    name: 'inspect_indirect_calls',
    description: tr('tool.inspect_indirect_calls'),
    parameters: {
      type: 'object',
      properties: {
        function: { type: 'string', description: tr('tool.inspect_indirect_calls.function') },
        table: { type: 'string', description: tr('tool.inspect_indirect_calls.table') },
        limit: { type: 'integer', description: tr('tool.inspect_indirect_calls.limit') },
      },
    },
  },
  {
    name: 'add_call_edge',
    description: tr('tool.add_call_edge'),
    parameters: {
      type: 'object',
      properties: {
        edges: {
          type: 'array',
          minItems: 1,
          maxItems: 40,
          description: tr('tool.add_call_edge.edges'),
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: tr('tool.add_call_edge.from') },
              to: { type: 'string', description: tr('tool.add_call_edge.to') },
              line: { type: 'integer', description: tr('tool.add_call_edge.line') },
              via: { type: 'string', description: tr('tool.add_call_edge.via') },
              reason: { type: 'string', description: tr('tool.add_call_edge.edgeReason') },
            },
            required: ['from', 'to'],
          },
        },
        addToCanvas: { type: 'boolean', description: tr('tool.add_call_edge.addToCanvas') },
        includeTasks: { type: 'boolean', description: tr('tool.add_call_edge.includeTasks') },
        remove: { type: 'boolean', description: tr('tool.add_call_edge.remove') },
        reason: { type: 'string', description: tr('tool.add_call_edge.reason') },
      },
      required: ['edges'],
    },
  },
  {
    name: 'add_to_canvas',
    description: tr('tool.add_to_canvas'),
    parameters: {
      type: 'object',
      properties: {
        functions: { type: 'array', items: { type: 'string' }, description: tr('tool.add_to_canvas.functions') },
        vars: { type: 'array', items: { type: 'string' }, description: tr('tool.add_to_canvas.vars') },
        fromGit: { type: 'boolean', description: tr('tool.add_to_canvas.fromGit') },
        snapshotId: { type: 'string', description: tr('tool.add_to_canvas.snapshotId') },
        includePaths: { type: 'array', items: { type: 'string' }, description: tr('tool.add_to_canvas.includePaths') },
        excludePaths: { type: 'array', items: { type: 'string' }, description: tr('tool.add_to_canvas.excludePaths') },
        includeAllBranches: { type: 'boolean', description: tr('tool.add_to_canvas.includeAllBranches') },
        mode: { type: 'string', enum: ['add', 'replace'], description: tr('tool.add_to_canvas.mode') },
        splitByGroup: { type: 'boolean', description: tr('tool.add_to_canvas.splitByGroup') },
        groups: { type: 'array', minItems: 2, items: { type: 'object', required: ['name', 'functions'], properties: {
          name: { type: 'string' }, functions: { type: 'array', minItems: 1, items: { type: 'string' } },
          vars: { type: 'array', items: { type: 'string' } },
        } }, description: tr('tool.add_to_canvas.groups') },
        bookmarkName: { type: 'string', description: tr('tool.add_to_canvas.bookmarkName') },
        includeTasks: { type: 'boolean', description: tr('tool.add_to_canvas.includeTasks') },
        up: { type: 'integer', description: tr('tool.add_to_canvas.up') },
        down: { type: 'integer', description: tr('tool.add_to_canvas.down') },
        reason: { type: 'string', description: tr('tool.add_to_canvas.reason') },
      },
    },
  },
  {
    name: 'apply_labels',
    description: tr('tool.apply_labels'),
    parameters: {
      type: 'object',
      properties: {
        autoDetect: { type: 'boolean', description: tr('tool.apply_labels.autoDetect') },
        items: {
          type: 'array',
          description: tr('tool.apply_labels.labels'),
          items: {
            type: 'object',
            properties: {
              from: { type: 'string', description: tr('tool.apply_labels.from') },
              to: { type: 'string', description: tr('tool.apply_labels.to') },
              line: { type: 'integer', description: tr('tool.apply_labels.line') },
              preset: { type: 'string', enum: ['task', 'call', 'conn', 'free'], description: tr('tool.apply_labels.preset') },
              text: { type: 'string', description: tr('tool.apply_labels.text') },
              order: { type: 'integer', description: tr('tool.apply_labels.order') },
              note: { type: 'string', description: tr('tool.apply_labels.note') },
            },
            required: ['from', 'to', 'preset'],
          },
        },
      },
    },
  },
  {
    name: 'ask_user',
    description: tr('tool.ask_user'),
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: tr('tool.ask_user.question') },
        options: {
          type: 'array',
          description: tr('tool.ask_user.options'),
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: tr('tool.ask_user.label') },
              description: { type: 'string', description: tr('tool.ask_user.description') },
            },
            required: ['label'],
          },
        },
        allowCustom: { type: 'boolean', description: tr('tool.ask_user.allowCustom') },
      },
      required: ['question'],
    },
  },
  {
    name: 'trace_upstream',
    description: tr('tool.trace_upstream'),
    parameters: {
      type: 'object',
      properties: {
        functions: { type: 'array', items: { type: 'string' }, description: tr('tool.trace_upstream.functions') },
        direction: { type: 'string', enum: ['up', 'down', 'both'], description: tr('tool.trace_upstream.direction') },
        depth: { type: 'integer', minimum: 1, maximum: 6, description: tr('tool.trace_upstream.depth') },
        limit: { type: 'integer', description: tr('tool.trace_upstream.limit') },
      },
      required: ['functions'],
    },
  },
  {
    name: 'arrange_canvas',
    description: tr('tool.arrange_canvas'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'tidy', 'move_group', 'align_groups', 'move', 'align', 'reset'] },
        direction: { type: 'string', enum: ['LR', 'TB'], description: tr('tool.arrange_canvas.direction') },
        group: { type: 'string', description: tr('tool.arrange_canvas.group') },
        groups: { type: 'array', maxItems: 100, items: { type: 'string' }, description: tr('tool.arrange_canvas.groups') },
        groupGap: { type: 'number', minimum: 0, description: tr('tool.arrange_canvas.groupGap') },
        x: { type: 'number' },
        y: { type: 'number' },
        dx: { type: 'number' },
        dy: { type: 'number' },
        relativeTo: { type: 'string', description: tr('tool.arrange_canvas.relativeTo') },
        placement: { type: 'string', enum: ['right', 'left', 'below', 'above'] },
        moves: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: tr('tool.arrange_canvas.id') },
              x: { type: 'number' },
              y: { type: 'number' },
              dx: { type: 'number' },
              dy: { type: 'number' },
              relativeTo: { type: 'string', description: tr('tool.arrange_canvas.reference') },
              placement: { type: 'string', enum: ['right', 'left', 'below', 'above'] },
              gap: { type: 'number', minimum: 0 },
            },
            required: ['id'],
          },
        },
        nodes: { type: 'array', maxItems: 200, items: { type: 'string' } },
        axis: { type: 'string', enum: ['x', 'y'], description: tr('tool.arrange_canvas.axis') },
        distribute: { type: 'boolean' },
        gap: { type: 'number', minimum: 0, description: tr('tool.arrange_canvas.gap') },
        reason: { type: 'string', maxLength: 240 },
      },
      required: ['action'],
    },
  },
  {
    name: 'remove_from_canvas',
    description: tr('tool.remove_from_canvas'),
    parameters: {
      type: 'object',
      properties: {
        functions: { type: 'array', items: { type: 'string' }, description: tr('tool.remove_from_canvas.functions') },
        excludePaths: { type: 'array', items: { type: 'string' }, description: tr('tool.remove_from_canvas.excludePaths') },
        reason: { type: 'string', description: tr('tool.remove_from_canvas.reason') },
      },
    },
  },
  {
    name: 'inspect_dataflow',
    description: tr('tool.inspect_dataflow'),
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: tr('tool.inspect_dataflow.target') },
        peer: { type: 'string', description: tr('tool.inspect_dataflow.peer') },
        dir: { type: 'string', enum: ['in', 'out', 'both'], description: tr('tool.inspect_dataflow.dir') },
        maxPaths: { type: 'integer', minimum: 1, maximum: 20, description: tr('tool.inspect_dataflow.maxPaths') },
      },
      required: ['target'],
    },
  },
  {
    name: 'present_logic',
    description: tr('tool.present_logic'),
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: tr('tool.present_logic.root') },
        targets: { type: 'array', items: { type: 'string' }, description: tr('tool.present_logic.targets') },
        direction: { type: 'string', enum: ['up', 'down', 'both'], description: tr('tool.present_logic.direction') },
        depth: { type: 'integer', minimum: 1, maximum: 5, description: tr('tool.present_logic.depth') },
        includeDataflow: { type: 'boolean', description: tr('tool.present_logic.includeDataflow') },
        addToCanvas: { type: 'boolean', description: tr('tool.present_logic.addToCanvas') },
        mode: { type: 'string', enum: ['add', 'replace'], description: tr('tool.present_logic.mode') },
        title: { type: 'string', description: tr('tool.present_logic.title') },
        focusFilter: { type: 'array', items: { type: 'string' }, description: tr('tool.present_logic.focusFilter') },
      },
    },
  },
  {
    name: 'canvas_visual',
    description: tr('tool.canvas_visual'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['highlight', 'play_flow', 'lens', 'clear'], description: tr('tool.canvas_visual.action') },
        nodeIds: { type: 'array', items: { type: 'string' }, description: tr('tool.canvas_visual.nodeIds') },
        edgeKeys: { type: 'array', items: { type: 'string' }, description: tr('tool.canvas_visual.edgeKeys') },
        lens: { type: 'string', enum: ['default', 'dataflow', 'indirect', 'changes'], description: tr('tool.canvas_visual.lens') },
        label: { type: 'string', description: tr('tool.canvas_visual.label') },
      },
      required: ['action'],
    },
  },
  {
    name: 'diagnose_canvas',
    description: tr('tool.diagnose_canvas'),
    parameters: {
      type: 'object',
      properties: {
        check: { type: 'string', enum: ['all', 'orphans', 'indirect', 'labels', 'layout'], description: tr('tool.diagnose_canvas.check') },
      },
    },
  },
  {
    name: 'manage_bookmarks',
    description: tr('tool.manage_bookmarks'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'update', 'checkpoint', 'delete'], description: tr('tool.manage_bookmarks.action') },
        name: { type: 'string', description: tr('tool.manage_bookmarks.name') },
        id: { type: 'integer', description: tr('tool.manage_bookmarks.id') },
        checkpointName: { type: 'string', description: tr('tool.manage_bookmarks.checkpointName') },
      },
      required: ['action'],
    },
  },
  {
    name: 'run_subagent',
    description: tr('tool.run_subagent'),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          maxItems: 3,
          description: tr('tool.run_subagent.tasks'),
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: tr('tool.run_subagent.title') },
              goal: { type: 'string', description: tr('tool.run_subagent.goal') },
              seedSymbols: { type: 'array', items: { type: 'string' }, description: tr('tool.run_subagent.seedSymbols') },
            },
            required: ['title', 'goal'],
          },
        },
      },
      required: ['tasks'],
    },
  },
];

const toolsByLanguage = new Map(SUPPORTED_LANGS.map(lang => [lang, buildToolDefinitions(aiTranslator(lang))]));
export const AGENT_TOOLS = toolsByLanguage.get('zh-CN');
const KEEP_ALL_LABELS = new Set(SUPPORTED_LANGS.map(lang => aiTranslator(lang)('keepAll')));

export const SUBAGENT_READONLY_TOOLS = new Set([
  'find_symbols',
  'read_function',
  'read_source',
  'trace_upstream',
  'inspect_indirect_calls',
  'inspect_dataflow',
  'inspect_build_config',
  'get_git_changes',
  'diagnose_canvas',
]);

const TOOL_NAME_SET = new Set(AGENT_TOOLS.map(t => t.name));

function resolveAllowedToolDefs(allowedTools, language) {
  const definitions = toolsByLanguage.get(language) || AGENT_TOOLS;
  if (!allowedTools) return definitions;
  const set = allowedTools instanceof Set ? allowedTools : new Set(Array.isArray(allowedTools) ? allowedTools : []);
  return definitions.filter(t => set.has(t.name));
}

function tokenWeight(text) {
  let weight = 0;
  for (const char of String(text ?? '')) {
    weight += char.charCodeAt(0) <= 0x7f ? 28 : 120;
  }
  return weight;
}

export function estimateTokens(text) {
  return Math.ceil(tokenWeight(text) / 100);
}

const TOOL_SCHEMA_TOKENS = estimateTokens(JSON.stringify(openAiToolsPayload()));

export function estimateMessagesTokens(messages, includeTools = false, toolDefs = AGENT_TOOLS) {
  const schemaTokens = !includeTools
    ? 0
    : toolDefs === AGENT_TOOLS
      ? TOOL_SCHEMA_TOKENS
      : estimateTokens(JSON.stringify(openAiToolsPayload(toolDefs)));
  return messages.reduce((total, message) => {
    if (!Array.isArray(message.content)) return total + 4 + estimateTokens(JSON.stringify(message));
    let imageTokens = 0;
    const content = message.content.map(part => {
      if (part?.type !== 'image_url') return part;
      imageTokens += 600;
      return { type: 'image_url' };
    });
    return total + 4 + estimateTokens(JSON.stringify({ ...message, content })) + imageTokens;
  }, schemaTokens);
}

/** 仅裁剪 [start, end) 中的旧对话；移除提问时也移除它后面的回答。 */
function trimOldTurns(messages, start, end, excessTokens, excessCount = 0) {
  let freed = 0, count = 0;
  while (start + count < end) {
    const message = messages[start + count];
    if (freed >= excessTokens && count >= excessCount && !(count && message.role === 'assistant')) break;
    freed += estimateMessagesTokens([message]);
    count++;
  }
  if (count) messages.splice(start, count);
  return freed;
}

function openAiToolsPayload(toolDefs = AGENT_TOOLS) {
  return toolDefs.map(tool => ({
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

function formatUiContextSelections(ui, tr) {
  if (!ui || typeof ui !== 'object') return { multi: false, selections: [] };
  const selectedNode = ui.selectedNode ?? (ui.kind === 'node' ? ui : null);
  const selectedEdge = ui.selectedEdge ?? (ui.kind === 'edge' ? ui : null);
  const selectedFile = ui.selectedFile ?? (ui.kind === 'file' ? ui : null);
  const selectedPair = ui.selectedPair ?? (ui.kind === 'pair' ? ui : null);
  const selectedDataflow = ui.selectedDataflow ?? (ui.kind === 'dataflow' ? ui : null);
  const location = (file, line) => {
    if (!line) return file;
    return file ? `${file}:${line}` : tr('line', { line });
  };
  const formatSelection = (kind, item) => {
    if (!item) return '';
    if (kind === 'node') {
      const id = typeof item === 'string' ? item : item.id || item.name;
      const source = location(item.file ?? item.path, item.line ?? item.startLine);
      return `${item.nodeKind === 'var' ? tr('variable') : tr('node')} ${[id, source].filter(Boolean).join(tr('listSep'))}`;
    }
    if (kind === 'edge') {
      const { from, to, id, edgeKey, file, line, labels, label } = item;
      const endpoints = typeof item === 'string' ? item : from && to ? `${from} → ${to}` : '';
      const texts = (Array.isArray(labels) ? labels : [labels ?? label])
        .map(value => typeof value === 'string' ? value : value?.text).filter(Boolean);
      const tagText = texts.length ? tr('edgeTags', { tags: texts.join(tr('itemSep')) }) : '';
      return tr('edge', { value: [endpoints, edgeKey ?? id, location(file, line), tagText].filter(Boolean).join(tr('listSep')) });
    }
    if (kind === 'pair') {
      const fromLabel = item.fromId || item.fromName || '';
      const toLabel = item.toId || item.toName || '';
      if (!fromLabel || !toLabel) return '';
      const parts = [tr('pair', { from: fromLabel, to: toLabel })];
      const vis = Array.isArray(item.visiblePaths) ? item.visiblePaths.length : 0;
      const rw = Array.isArray(item.rwPaths) ? item.rwPaths.length : 0;
      const sharedVars = Array.isArray(item.sharedVars)
        ? item.sharedVars.slice(0, 6).map(v => v.name || v.id || v).filter(Boolean)
        : [];
      if (vis) parts.push(tr('visiblePaths', { n: vis }));
      if (rw) parts.push(tr('rwPaths', { n: rw }));
      if (sharedVars.length) parts.push(tr('sharedVars', { vars: sharedVars.join(tr('itemSep')) }));
      return parts.join(tr('listSep'));
    }
    if (kind === 'dataflow') {
      const target = item.targetId || item.targetName || item.id || item.name || '';
      if (!target) return '';
      const dirText = item.dir === 'in' ? tr('directionIn') : item.dir === 'both' ? tr('directionBoth') : tr('directionOut');
      const parts = [tr('flow', { target, dir: dirText })];
      if (Array.isArray(item.vars) && item.vars.length) {
        parts.push(tr('relatedVars', { vars: item.vars.slice(0, 6).map(v => v.name || v).join(tr('itemSep')) }));
      }
      if (Array.isArray(item.peers) && item.peers.length) {
        parts.push(tr('relatedFns', { names: item.peers.slice(0, 6).map(p => p.name || p).join(tr('itemSep')) }));
      }
      return parts.join(tr('listSep'));
    }
    if (kind !== 'file') return '';
    const file = typeof item === 'string' ? item : item.path || item.file;
    return file ? tr('file', { file }) : '';
  };
  if (ui.items?.length) {
    return {
      multi: true,
      selections: ui.items.map(item => formatSelection(item?.kind, item)).filter(Boolean),
    };
  }
  return {
    multi: false,
    selections: [
      formatSelection('node', selectedNode),
      formatSelection('edge', selectedEdge),
      formatSelection('pair', selectedPair),
      formatSelection('dataflow', selectedDataflow),
      formatSelection('file', selectedFile),
    ].filter(Boolean),
  };
}

function formatCodeAttachments(files, tr, maxChars = MAX_CODE_ATTACHMENT_CHARS * files.length) {
  if (!files.length) return [];
  const lines = [tr('attachmentHeader')];
  const perFile = Math.floor(maxChars / files.length);
  for (const file of files) {
    const range = file.endLine ? ` (L${file.startLine || 1}-L${file.endLine}${file.totalLines ? tr('totalLines', { n: file.totalLines }) : ''})` : '';
    lines.push(tr('attachmentName', { name: file.name, range }), file.content.slice(0, perFile));
    if (file.truncated || file.content.length > perFile) lines.push(tr('truncated'));
    lines.push(tr('end'));
  }
  return lines;
}

function buildTurnUserText(userText, uiContext, attachments, tr) {
  const sections = [];
  const { selections } = formatUiContextSelections(uiContext, tr);
  if (selections.length) {
    const multi = selections.length > 1;
    const header = multi
      ? tr('contextMulti', { n: selections.length })
      : tr('contextSingle');
    const body = selections.map((text, index) => (multi ? `${index + 1}. ${text}` : `- ${text}`)).join('\n');
    const contextParts = [
      '<current_turn_context scope="this-turn-only">',
      header,
      body,
    ];
    if (uiContext?.relationIntent && uiContext.relationIntent !== 'auto') {
      contextParts.push(tr('intent', { intent: tr('intent.' + uiContext.relationIntent) }));
    }
    if (typeof uiContext?.enrichment === 'string' && uiContext.enrichment.trim()) {
      contextParts.push(tr('evidence'), uiContext.enrichment.trim());
    }
    contextParts.push(
      tr('contextRule'),
      '</current_turn_context>',
    );
    sections.push(...contextParts);
  } else if (typeof uiContext?.enrichment === 'string' && uiContext.enrichment.trim()) {
    sections.push(
      '<current_turn_context scope="this-turn-only">',
      tr('evidence'),
      uiContext.enrichment.trim(),
      '</current_turn_context>',
    );
  }
  sections.push(...formatCodeAttachments(attachments, tr));
  if (!sections.length) return userText;
  sections.push('', tr('userQuestion'), userText);
  return sections.join('\n');
}

function buildSystemPrompt(context, promptToolMode, toolDefs = AGENT_TOOLS) {
  const tr = aiTranslator(context.language);
  const ctxLines = [
    tr('project', { name: context.projectName || tr('unnamed'), fn: context.fnCount ?? 0, vars: context.varCount ?? 0 }),
    tr('roots', { roots: context.canvasRoots?.join(', ') || tr('empty') }),
  ];
  if (context.gitDirtyFiles?.length) {
    ctxLines.push(tr('dirty', { count: context.gitDirtyFiles.length, files: context.gitDirtyFiles.slice(0, 15).join(', ') + (context.gitDirtyFiles.length > 15 ? '…' : '') }));
  } else if (context.isGitRepo) {
    ctxLines.push(tr('clean'));
  }
  if (context.tasks?.length) {
    ctxLines.push(tr('tasks', { tasks: context.tasks.slice(0, 10).join(', ') }));
  }

  const base = context.systemPromptOverride ? [context.systemPromptOverride] : [
    tr('role'),
    tr('language'),
    tr('principles'),
    tr('verify'),
    tr('git'),
    tr('present'),
    tr('analyze'),
    tr('labels'),
    tr('ambiguity'),
    tr('anchor'),
    tr('scope'),
    tr('indirect'),
    tr('finish'),
    '',
    tr('environment'),
    ...ctxLines,
  ];

  if (promptToolMode) {
    base.push(
      '',
      tr('toolFormat'),
      tr('toolExample'),
      tr('available'),
      ...toolDefs.map(t => `- ${t.name}: ${t.description} ${tr('parameters')}: ${JSON.stringify(t.parameters.properties)}`),
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
function convertMessagesToPromptMode(messages, context, toolDefs = AGENT_TOOLS) {
  const tr = aiTranslator(context.language);
  const out = [{ role: 'system', content: buildSystemPrompt(context, true, toolDefs) }];
  let pendingToolTexts = [];
  const flushTools = () => {
    if (!pendingToolTexts.length) return;
    out.push({
      role: 'user',
      content: `${pendingToolTexts.join('\n\n')}\n${tr('continue')}`,
    });
    pendingToolTexts = [];
  };
  for (let i = 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'tool' || m.role === 'function') {
      pendingToolTexts.push(`${tr('toolOutput', { name: m.name || '' })}\n${m.content || ''}`);
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
      out.push(m);
    }
  }
  flushTools();
  return out;
}

async function withResponseReader(body, signal, read) {
  signal.throwIfAborted();
  const reader = body.getReader();
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    void reader.cancel(signal.reason).catch(() => {});
    reader.releaseLock();
  };
  signal.addEventListener('abort', release, { once: true });
  try {
    const value = await read(reader);
    signal.throwIfAborted();
    return value;
  } finally {
    signal.removeEventListener('abort', release);
    release();
  }
}

async function readResponseText(res, signal) {
  if (!res.body?.getReader) return res.text();
  return withResponseReader(res.body, signal, async (reader) => {
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  });
}

async function fetchJson(url, options, fetchImpl, { timeoutMs = DEFAULT_TIMEOUT_MS, signal, readStream, tr }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const requestSignal = controller.signal;
  const onParentAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', onParentAbort, { once: true });

  let timer;
  const resetTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(tr('api.timeout', { n: Math.round(timeoutMs / 1000) }))), timeoutMs);
  };
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(requestSignal.reason);
    requestSignal.addEventListener('abort', onAbort, { once: true });
  });
  const request = async () => {
    const res = await fetchImpl(url, { ...options, signal: requestSignal });
    if (requestSignal.aborted) {
      void res.body?.cancel?.(requestSignal.reason).catch(() => {});
      requestSignal.throwIfAborted();
    }
    if (readStream && res.ok && /text\/event-stream/i.test(res.headers?.get('content-type') || '')) {
      resetTimeout();
      const json = await readStream(res.body, requestSignal, resetTimeout);
      return { ok: true, status: res.status, json };
    }
    const text = await readResponseText(res, requestSignal);
    requestSignal.throwIfAborted();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON 错误体 */ }
    return { ok: res.ok, status: res.status, text, json };
  };
  resetTimeout();
  try {
    // 自定义 fetch 或响应体即使未响应 AbortSignal，请求也能按时结束。
    return await Promise.race([aborted, request()]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
    requestSignal.removeEventListener('abort', onAbort);
  }
}

function normalizeLineBreaks(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
}

export function sanitizeSuggestions(items) {
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const rawLabel = item?.label ?? item?.title ?? item?.text;
    const rawPrompt = item?.prompt ?? item?.query ?? item?.message ?? item?.question;
    const label = typeof rawLabel === 'string' ? [...rawLabel.trim()].slice(0, 28).join('') : '';
    const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim().slice(0, 2000) : '';
    const draft = typeof item?.draft === 'string' ? item.draft.trim().slice(0, 2000) : '';
    if (label && (prompt || draft)) result.push({ label, ...(prompt ? { prompt } : { draft }) });
    if (result.length === 3) break;
  }
  return result;
}

// 暂存可能属于标签的尾部，直到下一段确认其用途。
function createContentReader(emit) {
  let pending = '';
  let channel = 'text';
  return (content, final = false) => {
    pending += content;
    while (pending) {
      const tags = channel === 'thinking' ? [['</think>', 'text']]
        : channel === 'tool' ? [['</tool_call>', 'text']]
        : channel === 'suggestions' ? [['</next_steps', 'text']]
          : [['<think>', 'thinking'], ['<tool_call', 'tool'], ['<next_steps', 'suggestions'], ['</next_steps', 'text']];
      const lower = pending.toLowerCase();
      const start = pending.indexOf('<');
      if (start !== 0) {
        const end = start < 0 ? pending.length : start;
        emit(channel, pending.slice(0, end));
        pending = pending.slice(end);
        continue;
      }
      const tag = tags.find(([marker]) => lower.startsWith(marker));
      if (tag) {
        const end = pending.indexOf('>', tag[0].length - 1);
        if (end < 0) {
          if (final) pending = '';
          return;
        }
        channel = tag[1];
        pending = pending.slice(end + 1);
      } else if (tags.some(([marker]) => marker.startsWith(lower))) {
        if (final) pending = '';
        return;
      } else {
        emit(channel, '<');
        pending = pending.slice(1);
      }
    }
  };
}

function readAnswer(raw) {
  let text = '';
  createContentReader((channel, delta) => { if (channel === 'text') text += delta; })(raw, true);
  const block = /<next_steps\s*>([\s\S]*?)<\/next_steps\s*>/i.exec(raw);
  const blockInner = block ? block[1].trim().replace(/^```(?:json)?\s*\r?\n?/i, '').replace(/\r?\n?```\s*$/, '').trim() : '';
  const suggestions = sanitizeSuggestions(blockInner && safeJsonParse(blockInner));
  // 提示词工具模式只解析建议块之外的工具指令。
  const toolText = raw.replace(/<next_steps\b[\s\S]*?(?:<\/next_steps\s*>|$)/gi, '');
  return { text: text.trim(), suggestions, toolText };
}

function mergeFunctionDelta(target, delta) {
  for (const field of ['name', 'arguments']) {
    if (typeof delta?.[field] === 'string') target[field] = (target[field] || '') + delta[field];
  }
}

async function readChatStream(body, signal, onDelta, onChunk, onProgress, tr) {
  const decoder = new TextDecoder();
  const calls = new Map();
  const legacyCall = {};
  const msg = { content: '', reasoning_content: '' };
  const pendingWhitespace = [];
  let emittedText = false;
  const readContent = createContentReader((channel, delta) => {
    signal.throwIfAborted();
    if (channel !== 'text') {
      if (channel === 'thinking') onDelta(channel, delta);
      return;
    }
    // 推迟发送尾部空白，跨数据块合并换行并丢弃正文的首尾空白。
    const visible = delta.trimEnd();
    if (!visible) {
      if (emittedText) pendingWhitespace.push(delta);
      return;
    }
    const text = emittedText ? pendingWhitespace.join('') + visible : visible.trimStart();
    pendingWhitespace.length = 0;
    if (visible.length < delta.length) pendingWhitespace.push(delta.slice(visible.length));
    emittedText = true;
    onDelta('text', normalizeLineBreaks(text));
  });
  let finishReason;
  let usage;
  let seenChoice = false;
  let done = false;
  let buffer = '';

  const consume = (frame) => {
    signal.throwIfAborted();
    if (frame.length > MAX_SSE_FRAME_CHARS) throw new Error(tr('api.frame'));
    const data = frame.split(/\r\n|[\r\n]/).filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
    if (!data) return;
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let chunk;
    try { chunk = JSON.parse(data); } catch { throw new Error(tr('api.sseJson')); }
    if (chunk?.error) throw new Error(chunk.error.message || tr('api.streamError'));
    usage = chunk?.usage ?? usage;
    const choice = chunk?.choices?.find((item, index) => item && (item.index ?? index) === 0);
    if (!choice) return;
    seenChoice = true;
    finishReason = choice.finish_reason || finishReason;
    const delta = choice.delta ?? {};
    const thoughts = [];
    const content = flattenContent(delta.content, thoughts);
    const reasoning = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    if (typeof reasoning === 'string' && reasoning) thoughts.unshift(reasoning);
    if (thoughts.length) {
      const text = thoughts.join('\n');
      msg.reasoning_content += text;
      onDelta('thinking', text);
    }
    msg.content += content;
    readContent(content);
    signal.throwIfAborted();
    for (const [index, part] of (delta.tool_calls || []).entries()) {
      const key = part.index ?? index;
      const call = calls.get(key) ?? { function: {} };
      if (part.id) call.id = part.id;
      if (part.type) call.type = part.type;
      mergeFunctionDelta(call.function, part.function);
      calls.set(key, call);
    }
    mergeFunctionDelta(legacyCall, delta.function_call);
    const hasDelta = content || thoughts.length || delta.function_call || delta.tool_calls?.length;
    if (hasDelta || choice.finish_reason) onProgress();
    if (hasDelta) {
      const toolDeltas = delta.tool_calls?.map(call => call.function) ?? [delta.function_call];
      const toolText = toolDeltas.map(fn => (fn?.name ?? '') + (fn?.arguments ?? '')).join('');
      onChunk(content + thoughts.join('') + toolText);
    }
  };

  if (!body) throw new Error(tr('api.noBody'));
  let trailerTimer;
  try {
    await withResponseReader(body, signal, async (reader) => {
      let trailerDeadline;
      while (!done) {
        signal.throwIfAborted();
        // finish_reason 后只短暂等候用量统计和 [DONE]，兼容不主动关闭连接的接口。
        if (finishReason && !trailerDeadline) {
          trailerDeadline = new Promise(resolve => {
            trailerTimer = setTimeout(() => resolve({ done: true }), SSE_TRAILER_TIMEOUT_MS);
          });
        }
        const pending = reader.read();
        const chunk = await (trailerDeadline ? Promise.race([pending, trailerDeadline]) : pending);
        signal.throwIfAborted();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary;
        while (!done && (boundary = SSE_FRAME_SEPARATOR.exec(buffer))) {
          consume(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary[0].length);
        }
        if (!done && buffer.length > MAX_SSE_FRAME_CHARS) throw new Error(tr('api.frame'));
      }
    });
  } finally {
    clearTimeout(trailerTimer);
  }
  if (!done && (buffer += decoder.decode()).trim()) consume(buffer);
  if (!seenChoice || (!done && !finishReason)) throw new Error(tr('api.interrupted'));
  readContent('', true);
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (finishReason !== 'length' && finishReason !== 'content_filter') {
    const functions = [...toolCalls.map(call => call.function), ...(Object.keys(legacyCall).length ? [legacyCall] : [])];
    if (functions.some(fn => !fn.name || (fn.arguments?.trim() && !safeJsonParse(fn.arguments)))) {
      throw new Error(tr('api.incomplete'));
    }
  }
  if (toolCalls.length) msg.tool_calls = toolCalls;
  if (legacyCall.name) msg.function_call = legacyCall;
  return { choices: [{ message: msg, finish_reason: finishReason }], usage };
}

function createMetrics(config, contextEstTokens, onEvent, onReport = null) {
  const startedAt = Date.now();
  let firstTokenAt = null;
  let lastReport = null;
  let completionEstimate = 0;
  const report = (usage, now = Date.now(), isFinal = false) => {
    const rawPrompt = usage?.prompt_tokens ?? usage?.input_tokens;
    const rawCompletion = usage?.completion_tokens ?? usage?.output_tokens;
    const promptTokens = Number.isFinite(rawPrompt) ? rawPrompt : contextEstTokens;
    const completionTokens = Number.isFinite(rawCompletion) ? rawCompletion : Math.ceil(completionEstimate / 100);
    const totalTokens = Number.isFinite(usage?.total_tokens) ? usage.total_tokens : promptTokens + completionTokens;
    const elapsedMs = now - startedAt;
    const generationMs = firstTokenAt !== null ? now - firstTokenAt : elapsedMs;
    const rateMs = isFinal && generationMs < 80 ? elapsedMs : generationMs;
    const tokPerSec = completionTokens > 0 && rateMs >= 80
      ? Math.round(completionTokens * 10000 / rateMs) / 10 : 0;
    const payload = {
      type: 'metrics',
      promptTokens,
      completionTokens,
      totalTokens,
      contextEstTokens,
      contextWindow: config.contextWindow,
      tokPerSec,
      elapsedMs,
      estimated: !Number.isFinite(rawPrompt) || !Number.isFinite(rawCompletion),
    };
    onReport?.(payload);
    onEvent(payload);
    lastReport = now;
  };
  return {
    chunk(text) {
      const now = Date.now();
      firstTokenAt ??= now;
      completionEstimate += tokenWeight(text);
      if (lastReport === null || now - lastReport >= 250) report(null, now, false);
    },
    finish(json) {
      const msg = json?.choices?.[0]?.message;
      if (firstTokenAt === null && msg) {
        completionEstimate = tokenWeight(JSON.stringify([
          msg.content, msg.reasoning_content ?? msg.reasoning ?? msg.thinking, msg.tool_calls ?? msg.function_call,
        ]));
      }
      report(json?.usage, Date.now(), true);
    },
  };
}

export async function listModels(config, { fetchImpl = fetch, signal = null, language } = {}) {
  const tr = aiTranslator(language);
  const { modelsUrl } = normalizeBaseUrl(config?.baseUrl, tr);
  if (!modelsUrl) throw new Error(tr('api.enterUrl'));
  const res = await fetchJson(modelsUrl, {
    method: 'GET',
    headers: authHeaders(config.apiKey),
  }, fetchImpl, { timeoutMs: 15_000, signal, tr });
  if (!res.ok) {
    const rawMsg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
    const msg = scrubSecret(rawMsg, config.apiKey).slice(0, 200);
    throw new Error(tr('api.listFail', { msg }));
  }
  if (!res.json || typeof res.json !== 'object') throw new Error(tr('api.listInvalid'));
  const rawList = Array.isArray(res.json.data) ? res.json.data
    : Array.isArray(res.json.models) ? res.json.models
    : Array.isArray(res.json) ? res.json : [];
  const models = [...new Set(rawList.map(item => typeof item === 'string' ? item : item?.id || item?.name).filter(Boolean))];
  return { ok: true, models };
}

export async function testConnection(config, { fetchImpl = fetch, signal = null, language } = {}) {
  const tr = aiTranslator(language);
  const { chatUrl } = normalizeBaseUrl(config?.baseUrl, tr);
  if (!chatUrl) throw new Error(tr('api.enterUrl'));
  if (!config?.model) throw new Error(tr('api.enterModel'));
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
  }, fetchImpl, { timeoutMs: 30_000, signal, tr });
  if (!res.ok) {
    const rawMsg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
    const msg = scrubSecret(rawMsg, config.apiKey).slice(0, 240);
    throw new Error(tr('api.connectFail', { code: res.status, msg }));
  }
  const message = res.json?.choices?.[0]?.message;
  if (!res.json || !Array.isArray(res.json.choices) || !message) {
    throw new Error(tr('api.invalidChat'));
  }
  const { text } = extractThinkingAndText(message.content ?? '', message.reasoning_content ?? '');
  return { ok: true, latencyMs: Date.now() - started, model: res.json.model || config.model, reply: text.slice(0, 80) };
}

function summarizeToolResult(name, result, tr) {
  if (result?.ok === false) return tr('failed', { error: result.error || tr('unknownError') });
  if (name === 'get_git_changes') {
    if (result.noChanges) return tr('gitClean');
    return tr('gitChanged', { files: result.changedFiles?.length || 0, functions: result.changedFunctions?.length || 0 });
  }
  if (name === 'inspect_build_config') {
    if (result.counts) {
      const c = result.counts;
      return tr('buildCounts', { projects: c.cprojects, make: c.makefiles, qac: c.qacFiles, perl: c.perlScripts });
    }
    if (result.file && Array.isArray(result.configurations)) {
      return tr('buildParsed', { file: result.file, n: result.configurations.length });
    }
    if (result.file && result.matches) return tr('fileMatched', { file: result.file, n: result.matches.length });
    if (result.file) return tr('fileReadBuild', { file: result.file, start: result.startLine, end: result.endLine });
    return tr('buildChecked');
  }
  if (name === 'find_symbols') {
    const summary = result.matches
      ? tr('matches', { n: result.matches.length })
      : tr('canvasStats', { roots: result.canvasRoots?.length || 0, tasks: result.tasks?.length || 0 });
    return Array.isArray(result.suggestedLabels) ? tr('suggestedLabels', { summary, n: result.suggestedLabels.length }) : summary;
  }
  if (name === 'read_function') {
    if (Array.isArray(result.items)) return tr('batchSource', { n: result.items.length });
    return tr('sourceReadFunction', { name: result.name || result.id, file: result.file, start: result.startLine, end: result.endLine });
  }
  if (name === 'read_source') {
    if (result.file) return tr('sourceRead', { file: result.file, start: result.startLine, end: result.endLine });
    return tr('sourceMatch', { n: result.matches?.length || 0 });
  }
  if (name === 'inspect_indirect_calls') {
    return tr('indirectFound', { calls: result.indirectCalls?.length || 0, tables: result.tables?.length || 0 });
  }
  if (name === 'inspect_dataflow') {
    if (result.peer) return tr('flowBetween', { a: result.targetName || result.target, b: result.peerName || result.peer, n: result.rwPaths?.length || 0 });
    return tr('flowSingle', { target: result.targetName || result.target, n: result.chains?.length || 0 });
  }
  if (name === 'present_logic') {
    return tr('walkthrough', { title: result.presentation?.title || result.title || tr('logicTitle'), steps: result.presentation?.steps?.length || 0, chains: result.chains?.length || 0 });
  }
  if (name === 'canvas_visual') {
    if (result.action === 'clear') return tr('highlightClear');
    if (result.action === 'play_flow') return tr('flowPlaying', { n: result.edgeKeys?.length || 0 });
    if (result.action === 'lens') return tr('lensSwitched', { lens: result.lens || 'default' });
    return tr('highlightCount', { n: result.nodeIds?.length || 0 });
  }
  if (name === 'diagnose_canvas') {
    const count = result.healthReport?.issues?.length ?? result.issues?.length ?? 0;
    return count ? tr('issuesCount', { count }) : tr('issuesNone');
  }
  if (name === 'manage_bookmarks') {
    if (result.action === 'list') return tr('bookmarkCount', { n: result.bookmarks?.length || 0 });
    if (result.action === 'checkpoint') return tr('checkpointMade', { name: result.checkpointName || tr('checkpoint') });
    return tr('bookmarkDone', { action: result.action });
  }
  if (name === 'run_subagent') {
    const count = Array.isArray(result.results) ? result.results.length : 0;
    const okCount = Array.isArray(result.results) ? result.results.filter(r => r.ok !== false).length : 0;
    return tr('subagentDone', { ok: okCount, count });
  }
  if (name === 'add_call_edge') {
    const list = Array.isArray(result.edges) ? result.edges : [];
    const preview = list.slice(0, 3).map(e => `${String(e.from).split('::').pop()}→${String(e.to).split('::').pop()}`).join(tr('itemSep'));
    return tr(result.removed ? 'edgesRemoved' : 'edgesAdded', {
      n: list.length || result.addedCount || 0, preview: preview ? tr('parenthesis', { value: preview + (list.length > 3 ? '…' : '') }) : '',
    });
  }
  if (name === 'add_to_canvas') {
    const names = Array.isArray(result.addedNames) ? result.addedNames.filter(Boolean) : [];
    const preview = names.length
      ? tr('namePreview', { names: names.slice(0, 6).join(tr('itemSep')), more: names.length > 6 ? tr('totalItems', { n: names.length }) : '' })
      : '';
    const parts = [tr('canvasAdded', { n: result.addedCount ?? result.roots?.length ?? 0, preview })];
    if (result.bookmarks?.length) parts.push(tr('bookmarksMade', { n: result.bookmarks.length }));
    if (result.ambiguous?.length) parts.push(tr('ambiguous', { n: result.ambiguous.length }));
    if (result.notFound?.length) parts.push(tr('notFound', { n: result.notFound.length }));
    return parts.join(tr('listSep'));
  }
  if (name === 'apply_labels') return tr('labelsWritten', { n: result.applied || 0 });
  if (name === 'arrange_canvas') {
    if (result.action === 'inspect') return tr('layoutInspected', { n: result.nodes?.length ?? 0 });
    if (result.action === 'reset') return tr('layoutReset');
    if (result.action === 'tidy') return tr('layoutTidied', { n: result.updatedCount });
    if (result.action === 'move_group' || result.action === 'align_groups') return tr('layoutGroup', { n: result.updatedCount });
    return tr('layoutMoved', { n: result.updatedCount });
  }
  if (name === 'remove_from_canvas') {
    const list = Array.isArray(result.removed) ? result.removed : [];
    const shortNames = list.map(id => String(id).split('::').pop()).filter(Boolean);
    const preview = shortNames.length ? tr('parenthesis', { value: shortNames.slice(0, 5).join(tr('itemSep')) + (shortNames.length > 5 ? '…' : '') }) : '';
    return tr('canvasRemoved', { n: list.length || (Number(result.removed) || 0), preview });
  }
  if (name === 'trace_upstream') return tr('traced', { n: Object.keys(result.pathBranches ?? {}).length });
  return tr('done');
}

const DIGEST_FIELDS = [
  'snapshotId', 'includePaths', 'excludePaths', 'includeAllBranches', 'functions', 'vars', 'fromGit', 'splitByGroup',
  'id', 'file', 'pathBranches', 'needsVehicleChoice', 'isolatedGroups', 'changedFunctions', 'changedFiles', 'changedVars',
  'roots', 'matches', 'upstreamChains', 'applied', 'removed', 'bookmarks', 'edgeKeys', 'error',
  'action', 'axis', 'updatedCount', 'positions', 'target', 'peer', 'direction', 'title',
];

export function summarizeToolDigest(name, args, result, tr = aiTranslator()) {
  const fields = DIGEST_FIELDS.flatMap(key => {
    const value = result?.[key] ?? args?.[key];
    if (value == null || (Array.isArray(value) && !value.length)) return [];
    const items = (Array.isArray(value) ? value : [value]).map(item => {
      if (item && typeof item === 'object') {
        return item.id ?? item.file ?? (item.name && item.functions
          ? [item.name, ...item.functions].join(' ') : JSON.stringify(item));
      }
      return String(item);
    });
    return [{ key, items }];
  });
  const header = String(name ?? '').slice(0, 60) + (result?.ok === false ? ' ' + tr('failedFlag') : '');
  const budget = Math.max(0, 500 - header.length - fields.reduce((sum, field) => sum + field.key.length + 2, 0));
  let remaining = budget;
  const values = fields.map(({ key, items }, index) => {
    const share = Math.floor(remaining / (fields.length - index));
    const full = items.join(', ');
    let value = full;
    if (full.length > share) {
      const fittingItems = [];
      let used = 0;
      for (const item of items) {
        const size = item.length + (fittingItems.length ? 2 : 0);
        if (used + size + 1 > share) break;
        fittingItems.push(item);
        used += size;
      }
      value = (fittingItems.join(', ') || full.slice(0, Math.max(0, share - 1))) + (share ? '…' : '');
    }
    remaining -= value.length;
    return key + '=' + value;
  });
  return [header, ...values].join(' ');
}

function stripThinkText(text) {
  return String(text ?? '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

function historyContent(message, maxLength = Infinity, maxAttachmentChars = 12_000, { isLatestAssistant = false, includeDetails = true, tr } = {}) {
  const rawText = stripThinkText(message.text ?? message.content ?? '');
  const selectionPrefix = message.role === 'user' && message.selectionSummary
    ? tr('historySelection', { value: String(message.selectionSummary).trim() })
    : '';
  const text = selectionPrefix && !/^\[(?:当时画布选中：|当時の選択：|Selection at the time: )/u.test(rawText)
    ? [selectionPrefix, rawText].filter(Boolean).join('\n')
    : rawText;
  const details = [];
  if (includeDetails && Array.isArray(message.tools)) {
    for (const tool of message.tools) {
      if (!tool?.name && !tool?.digest) continue;
      details.push(tool.digest || [summarizeToolDigest(tool.name, tool.arguments, tool, tr), tool.summary].filter(Boolean).join(' '));
    }
  }
  if ((includeDetails || isLatestAssistant) && Array.isArray(message.questionOptions) && message.questionOptions.length) {
    details.push(tr('historyOptions') + message.questionOptions.map(option => typeof option === 'string'
      ? option : [option?.label, option?.description].filter(Boolean).join(' ')).join(' / '));
  }
  const metadata = details.join('\n').slice(0, maxLength);
  const textBudget = metadata ? Math.max(0, maxLength - metadata.length - 1) : maxLength;
  const files = message.role === 'user' ? sanitizeCodeAttachments(message.attachedFiles) : [];
  return [text.slice(0, textBudget), metadata, ...formatCodeAttachments(files, tr, maxAttachmentChars)].filter(Boolean).join('\n');
}

export function buildModelHistory(history, maxLength = 4000, maxAttachmentChars = 12_000, tr = aiTranslator()) {
  const filtered = (Array.isArray(history) ? history : [])
    .filter(m => m && ['user', 'assistant'].includes(m.role));
  const lastAssistantIdx = filtered.findLastIndex(m => m.role === 'assistant');
  return filtered.map((m, idx) => {
    const isLatestAssistant = idx === lastAssistantIdx;
    const content = historyContent(m, maxLength, maxAttachmentChars, {
      isLatestAssistant, tr,
      includeDetails: false,
    });
    return { role: m.role, content };
  }).filter(m => m.content);
}

export async function compactConversation({ config, messages, language, fetchImpl = fetch, signal = null }) {
  const tr = aiTranslator(language);
  signal?.throwIfAborted();
  const beforeTokens = estimateMessagesTokens(messages);
  if (messages.length <= 4) {
    return { ok: true, compacted: false, messages, beforeTokens, afterTokens: beforeTokens, summary: '' };
  }
  const older = messages.slice(0, -4);
  const transcript = older.map(message => ({ role: message.role, content: historyContent(message, Infinity, 12_000, { tr }) }));
  const facts = [];
  const assistantNotes = [];
  for (const message of older) {
    const text = String(message.text ?? message.content ?? '').trim();
    if (message.role === 'user' || message.isSummary) {
      if (text) facts.push(message.isSummary ? text.replace(/^\[(?:上下文摘要|コンテキスト要約|Context summary)\]\n/u, '') : tr('userPrefix') + text);
    } else if (text) {
      assistantNotes.push(text.split(/(?<=[。！？\n])/u, 1)[0].slice(0, 180));
      const references = text.match(/[\p{L}\d_.:/\\-]+\.(?:c|h|cc|cpp|hpp|arxml|oil|json)(?:::[\w$]+)?|\b(?:z\d+|[\w.-]+(?:[/\\][\w.-]+)+)\b/giu);
      if (references?.length) facts.push(tr('filesPrefix') + [...new Set(references)].join(tr('itemSep')));
    }
    const structured = historyContent({ ...message, text: '' }, Infinity, 0, { tr });
    if (structured) facts.push(structured);
  }

  let modelSummary = '';
  if (config?.baseUrl && config?.model) {
    try {
      const { chatUrl } = normalizeBaseUrl(config.baseUrl, tr);
      const res = await fetchJson(chatUrl, {
        method: 'POST',
        headers: authHeaders(config.apiKey),
        body: JSON.stringify({
          model: config.model,
          stream: false,
          max_tokens: 768,
          messages: [
            { role: 'system', content: tr('compact') },
            { role: 'user', content: JSON.stringify(transcript) },
          ],
        }),
      }, fetchImpl, { timeoutMs: 8_000, signal, tr });
      if (res.ok) modelSummary = extractThinkingAndText(res.json?.choices?.[0]?.message?.content).text;
    } catch {
      signal?.throwIfAborted();
      // 模型不可用时，根据原记录生成结构化摘要。
    }
  }
  const notes = modelSummary || [...new Set(assistantNotes)].map(note => tr('assistantPrefix') + note).join('\n');
  const summary = [...new Set(facts), notes].filter(Boolean).join('\n') || tr('emptyHistory');
  const compacted = [{ role: 'assistant', text: tr('summaryHeader') + '\n' + summary, isSummary: true }, ...messages.slice(-4)];
  return { ok: true, compacted: true, summary, messages: compacted, beforeTokens, afterTokens: estimateMessagesTokens(compacted) };
}

/** 运行直连模型的工具调用闭环，支持自动从标准 tools 平滑降级到旧版纯对话模式。 */
export async function runAiAgent({
  config,
  prompt,
  images = [],
  attachments = [],
  history = [],
  context = {},
  executeTool,
  onEvent = () => {},
  fetchImpl = fetch,
  signal = null,
  maxSteps = MAX_AGENT_STEPS,
  allowedTools = null,
  systemPromptOverride = '',
  isSubagent = false,
  beforeDone = null,
}) {
  signal?.throwIfAborted();
  const tr = aiTranslator(context.language);
  const { chatUrl } = normalizeBaseUrl(config?.baseUrl, tr);
  if (!chatUrl) throw new Error(tr('noApi'));
  if (!config?.model) throw new Error(tr('noModel'));
  const userText = String(prompt || '').trim();
  if (!userText) throw new Error(tr('noPrompt'));

  // 同一轮对话固定使用启动时的配置，保存的新配置在下次请求生效。
  config = {
    ...config,
    contextWindow: validContextWindow(config.contextWindow) ? config.contextWindow : DEFAULT_AI_CONFIG.contextWindow,
  };
  const activeToolDefs = resolveAllowedToolDefs(
    allowedTools ?? (isSubagent ? SUBAGENT_READONLY_TOOLS : null), context.language,
  );
  const activeToolNames = new Set(activeToolDefs.map(t => t.name));
  const promptContext = systemPromptOverride ? { ...context, systemPromptOverride } : context;

  let activeMode = config.toolMode === 'prompt' ? 'prompt' : 'tools';
  const historyBudget = Math.floor(config.contextWindow * 0.65);
  const historyAttachmentChars = Math.min(MAX_CODE_ATTACHMENT_CHARS, Math.floor(historyBudget / 3));
  const cleanHistory = buildModelHistory(history, 4000, historyAttachmentChars, tr);
  trimOldTurns(cleanHistory, 0, cleanHistory.length, estimateMessagesTokens(cleanHistory) - historyBudget, cleanHistory.length - 20);
  const asksForExplanation = /为什么|为何|啥原因|什么原因|怎么(?:回事|没|不|会|连)|是不是|有没有|干嘛的|做什么|是什么|什么关系|含义|解释|说明一下|分析(?:一下|下)|看一下|帮我看|查一下|如何连接/u;
  const explaining = asksForExplanation.test(userText) ||
    /^(?:why\b|what\s+(?:is|are|does|do)\b|how\s+(?:does|do)\b|explain\b|describe\b)/i.test(userText);
  const editVerb = /(?:加入|加到|加上|添加到|放进|拉进|推上|画到|画出来|画一下|构图|组图|补齐|补全|补边|补上|连上|连起来|连线|连接|修复|修正|修改|修一下|改一下|改好|移除|删除|去掉|剔除|清理|清空|标注|打标|加标签|写标签|移动|挪到|对齐|排布|排版|排列|整理|重排|调整位置|重置|恢复布局|拆分|分组|替换|保存书签|存为书签|新建书签|加变量|加上游|加下游|展开|呈现|展示|导览|检查点)/u;
  // 一句解释中也可能出现“连接、删除”等动词。混合请求只接受另一条明确的操作指令。
  const hasEditIntent = explaining
    ? userText.split(/[，,。！？!?；;\n]|(?:然后|顺便|顺手|并且|并(?=把|将|请|帮我))/u).some(clause =>
      !asksForExplanation.test(clause) && /^(?:请|帮我|给我|直接|把|将|补齐|补全|补上|修复|删除|添加到|呈现)/u.test(clause.trim()) &&
      editVerb.test(clause) && !/不要|别|无需|不用/u.test(clause))
    : editVerb.test(userText);
  const hasProblemReport = /(?:有点问题|有问题|不对|错了|漏了|少了|缺了|没连上|没加上|乱了|重了|重叠|挤在一起)/u.test(userText);
  const readOnlyQuestion = explaining && !hasEditIntent;
  const hasSelectionContext = formatUiContextSelections(context.uiContext, tr).selections.length > 0;
  const unanchoredDeictic = !hasSelectionContext &&
    /(?:这个函数|这个变量|这条线|当前这个|上面那个|它(?:为什么|怎么|的|有|没|是|在))/u.test(userText) &&
    !/[A-Za-z_][A-Za-z0-9_]{2,}/u.test(userText);
  const isCanvasWriteTool = (call) =>
    ['add_to_canvas', 'remove_from_canvas', 'apply_labels', 'add_call_edge'].includes(call.name) ||
    (call.name === 'arrange_canvas' && call.arguments?.action !== 'inspect') ||
    (call.name === 'present_logic' && call.arguments?.addToCanvas !== false) ||
    (call.name === 'manage_bookmarks' && call.arguments?.action && call.arguments.action !== 'list');

  let imagesDegraded = false;
  const turnUserText = buildTurnUserText(userText, context.uiContext, attachments, tr);
  const userMessage = {
    role: 'user',
    content: images.length > 0 && !imagesDegraded
      ? [{ type: 'text', text: turnUserText }, ...images.map(img => ({
        type: 'image_url', image_url: { url: typeof img === 'string' ? img : img.dataUrl },
      }))]
      : turnUserText,
  };
  const degradeImages = (res) => {
    if (!images.length || imagesDegraded || ![400, 422].includes(res.status)) return false;
    const error = res.json?.error;
    const detail = [error?.param, error?.message, typeof error === 'string' ? error : null,
      res.json?.message, res.json?.detail].filter(Boolean);
    if (!/image|vision|multimodal|content.*string|expected.*string|unsupported/i.test(detail.length ? JSON.stringify(detail) : res.text)) return false;
    imagesDegraded = true;
    userMessage.content = turnUserText;
    onEvent({ type: 'fallback', text: tr('imageFallback') });
    return true;
  };
  let messages = [
    { role: 'system', content: buildSystemPrompt(promptContext, activeMode === 'prompt', activeToolDefs) },
    ...cleanHistory,
    userMessage,
  ];
  const allThoughts = [];
  const toolLog = [];
  const collectedChains = [];
  const seenChainIds = new Set();
  let latestPresentation = null;
  let latestHealthReport = null;
  let switchedToPrompt = false;
  let reasoningDegraded = false;
  let streamMode = 'stream_usage';
  let emptyThinkRetries = 0;
  let lastMetrics = null;
  const recordMetrics = (m) => { lastMetrics = m; };
  const reasoningPayload = buildReasoningPayload(config.reasoningEffort);
  const maxTokens = config.maxTokens ?? DEFAULT_AI_CONFIG.maxTokens;
  // 输出上限为 0 时由模型决定输出长度，至少留出一个生成 token。
  const inputBudget = config.contextWindow - Math.max(1, maxTokens);
  const fitRequestHistory = (request) => {
    const tokens = estimateMessagesTokens(request.messages, Boolean(request.tools), activeToolDefs);
    const turnStart = request.messages.indexOf(userMessage);
    // 只移除本轮之前的消息，保留附件全文和已执行工具的调用/返回配对。
    return tokens - trimOldTurns(request.messages, 1, turnStart, tokens - inputBudget);
  };
  const requestDefaults = {
    model: config.model,
    temperature: config.temperature ?? DEFAULT_AI_CONFIG.temperature,
    ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
  };
  const finish = async (answer, suggestions = []) => {
    signal?.throwIfAborted();
    const extra = typeof beforeDone === 'function' ? (await beforeDone({ toolLog, onEvent })) || {} : {};
    const result = {
      ok: true,
      answer: normalizeLineBreaks(answer).trim(),
      ...(suggestions.length ? { suggestions } : {}),
      ...(collectedChains.length ? { chains: collectedChains.slice(0, 12) } : {}),
      ...(latestPresentation ? { presentation: latestPresentation } : {}),
      ...(latestHealthReport ? { healthReport: latestHealthReport } : {}),
      ...(extra.changeset ? { changeset: extra.changeset } : {}),
      ...(Array.isArray(extra.subagents) && extra.subagents.length ? { subagents: extra.subagents } : {}),
      thinking: allThoughts.join('\n\n'),
      toolLog,
      modeUsed: activeMode,
      ...(lastMetrics ? { metrics: lastMetrics } : {}),
    };
    onEvent({ type: 'done', ...result });
    return result;
  };

  let step = 0;
  for (; step < maxSteps; step++) {
    signal?.throwIfAborted();
    onEvent({ type: 'status', text: step === 0 ? tr('thinking') : tr('integrating', { n: step + 1 }) });
    const reqBody = {
      ...requestDefaults,
      messages,
      ...(reasoningDegraded ? {} : reasoningPayload),
      ...(activeMode === 'tools' && activeToolDefs.length ? { tools: openAiToolsPayload(activeToolDefs), tool_choice: 'auto' } : {}),
      stream: streamMode !== 'sync',
      ...(streamMode === 'stream_usage' ? { stream_options: { include_usage: true } } : {}),
    };

    const inputTokens = fitRequestHistory(reqBody);
    if (inputTokens > inputBudget) {
      const reason = tr('budget', {
        tokens: inputTokens, budget: Math.max(0, inputBudget),
        scope: tr(attachments.length ? 'attachmentScope' : 'inputScope'),
      });
      if (!toolLog.length) throw new Error(reason);
      return await finish(`${reason}\n${tr('logPrefix')}${toolLog.map(tool => tool.summary).join(tr('stepSep'))}`);
    }
    const metrics = createMetrics(config, inputTokens, onEvent, recordMetrics);
    const res = await fetchJson(chatUrl, {
      method: 'POST',
      headers: authHeaders(config.apiKey),
      body: JSON.stringify(reqBody),
    }, fetchImpl, {
      signal, tr,
      readStream: (body, requestSignal, resetTimeout) => readChatStream(body, requestSignal,
        (channel, delta) => {
          if (channel !== 'tool') onEvent({ type: channel + '_delta', step: step + 1, delta });
        }, metrics.chunk, resetTimeout, tr),
    });
    signal?.throwIfAborted();

    if (!res.ok) {
      if ([400, 422].includes(res.status)) {
        const error = res.json?.error;
        const detail = error?.param || error?.message || res.text;
        if (streamMode === 'stream_usage' && /stream_options|include_usage/i.test(detail)) {
          streamMode = 'stream';
          step--;
          continue;
        }
        if (degradeImages(res)) {
          step--;
          continue;
        }
        if (streamMode !== 'sync' && /\bstream(?:ing)?\b/i.test(detail) && !/tools?|reasoning|thinking/i.test(detail)) {
          streamMode = 'sync';
          step--;
          continue;
        }
      }
      if (!reasoningDegraded && Object.keys(reasoningPayload).length > 0 && isReasoningUnsupportedError(res.status, res.text)) {
        reasoningDegraded = true;
        onEvent({ type: 'fallback', text: tr('fallbackReason') });
        step--;
        continue;
      }
      if (config.toolMode === 'auto' && activeMode === 'tools' && !switchedToPrompt && isToolUnsupportedError(res.status, res.text)) {
        switchedToPrompt = true;
        activeMode = 'prompt';
        // 保留已执行的工具结果并转换为纯对话格式，绝不丢弃历史导致重复执行写工具。
        messages = convertMessagesToPromptMode(messages, promptContext, activeToolDefs);
        onEvent({ type: 'fallback', text: tr('fallbackTools') });
        step--;
        continue;
      }
      const rawMsg = res.json?.error?.message || res.text || `HTTP ${res.status}`;
      const msg = scrubSecret(rawMsg, config.apiKey).slice(0, 260);
      throw new Error(tr('modelError', { code: res.status, msg }));
    }

    const choice = res.json?.choices?.[0];
    const msg = choice?.message;
    if (!msg) throw new Error(tr('missingResponse'));
    metrics.finish(res.json);
    const finishReason = choice.finish_reason;

    const { thinking, text: rawText } = extractThinkingAndText(msg.content ?? '', msg.reasoning_content ?? msg.reasoning ?? msg.thinking ?? '');
    const { text, suggestions, toolText } = readAnswer(rawText);
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
      const parsed = parsePromptToolCalls(toolText, activeToolNames, { tagOnly: activeMode === 'tools' });
      if (parsed.length) {
        callStyle = 'prompt';
        calls = parsed.slice(0, 6).map((c, idx) => ({ id: `prompt_${step}_${idx}`, ...c }));
      }
    }

    if (finishReason === 'length' || finishReason === 'content_filter') calls = [];
    if (!calls.length) {
      if (finishReason === 'length') {
        return await finish(text || tr('length'));
      }
      if (finishReason === 'content_filter') return await finish(text || tr('contentFilter'));
      if (!text && thinking && emptyThinkRetries < 1 && step + 1 < maxSteps) {
        emptyThinkRetries++;
        messages.push(
          { role: 'assistant', content: tr('thinkingPrefix') + thinking.slice(0, 400) },
          { role: 'user', content: tr('retry') },
        );
        continue;
      }
    }

    signal?.throwIfAborted();

    const ask = calls.find(call => call.name === 'ask_user');
    if (!calls.length) {
      return await finish(text || (thinking
        ? tr('reasonOnly')
        : finishReason === 'tool_calls' || finishReason === 'function_call'
          ? tr('emptyCall')
          : tr('emptyResponse')), suggestions);
    }

    if (ask && !isSubagent && activeToolNames.has('ask_user')) {
      const question = normalizeLineBreaks(String(ask.arguments?.question || text)).trim() || tr('confirm');
      const rawOptions = ask.arguments?.options;
      const parsedOptions = Array.isArray(rawOptions)
        ? rawOptions.map(option => ({
          label: String(option?.label ?? '').trim(),
          description: String(option?.description ?? '').trim(),
        })).filter(option => option.label)
        : [];
      const options = parsedOptions.some(option => KEEP_ALL_LABELS.has(option.label)) ? parsedOptions : parsedOptions.slice(0, 6);
      const allowCustom = ask.arguments?.allowCustom !== false;
      const thinking = allThoughts.join('\n\n');
      onEvent({ type: 'question', question, options, allowCustom, thinking, ...(lastMetrics ? { metrics: lastMetrics } : {}) });
      return {
        ok: true,
        awaitingUser: true,
        question,
        options,
        allowCustom,
        answer: question,
        thinking,
        toolLog,
        modeUsed: activeMode,
        ...(lastMetrics ? { metrics: lastMetrics } : {}),
      };
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
      signal?.throwIfAborted();
      onEvent({ type: 'tool_start', callId: call.id, name: call.name, arguments: call.arguments });
      signal?.throwIfAborted();
      let output;
      try {
        if (!activeToolNames.has(call.name)) {
          output = { ok: false, error: TOOL_NAME_SET.has(call.name) ? tr('unavailableTool', { name: call.name }) : tr('unknownTool', { name: call.name }) };
        } else if (!isSubagent && readOnlyQuestion && isCanvasWriteTool(call)) {
          output = {
            ok: false,
            blocked: true,
            error: tr('explainBlock'),
          };
        } else if (!isSubagent && (unanchoredDeictic || (hasProblemReport && !hasEditIntent && !hasSelectionContext)) && isCanvasWriteTool(call)) {
          output = {
            ok: false,
            blocked: true,
            error: tr('targetBlock'),
          };
        } else {
          output = await executeTool(call.name, call.arguments || {});
        }
      } catch (err) {
        output = { ok: false, error: String(err?.message || err) };
      }
      signal?.throwIfAborted();
      let cleanOutput = output;
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        const pushChain = (chain) => {
          if (!chain || typeof chain !== 'object') return;
          const cid = String(chain.id || `${chain.title || ''}:${(chain.steps || []).map(s => s.id).join('->')}`);
          if (seenChainIds.has(cid)) return;
          seenChainIds.add(cid);
          collectedChains.push(chain);
        };
        if (Array.isArray(output.chains)) {
          output.chains.forEach(pushChain);
          if (!isSubagent && output.chains.length) onEvent({ type: 'chains', chains: output.chains });
        }
        if (output.presentation && typeof output.presentation === 'object') {
          latestPresentation = output.presentation;
          if (!isSubagent) onEvent({ type: 'presentation', presentation: output.presentation });
        }
        if (output.healthReport && typeof output.healthReport === 'object') {
          latestHealthReport = output.healthReport;
          if (!isSubagent) onEvent({ type: 'health_report', report: output.healthReport });
        }
        if (output.canvasOverlay && typeof output.canvasOverlay === 'object' && !isSubagent) {
          onEvent({ type: 'canvas_overlay', ...output.canvasOverlay });
        }
        if (Array.isArray(output._events)) {
          for (const ev of output._events) {
            if (ev && typeof ev === 'object' && ev.type && !isSubagent) onEvent(ev);
          }
          const { _events, ...rest } = output;
          cleanOutput = rest;
        }
      }
      const summary = summarizeToolResult(call.name, cleanOutput, tr);
      const digest = summarizeToolDigest(call.name, call.arguments, cleanOutput, tr);
      const blocked = Boolean(cleanOutput?.blocked);
      toolLog.push({ name: call.name, arguments: call.arguments, ok: cleanOutput?.ok !== false, ...(blocked ? { blocked: true } : {}), summary, digest });
      onEvent({ type: 'tool_end', callId: call.id, name: call.name, ok: cleanOutput?.ok !== false, ...(blocked ? { blocked: true } : {}), summary, digest });

      const layoutBudget = Math.max(12000, Math.min(72000, config.contextWindow * 2));
      const clipped = clipToolOutput(cleanOutput, call.name === 'arrange_canvas' ? layoutBudget : 12000);
      if (callStyle === 'tool_calls' && activeMode === 'tools') {
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: clipped });
      } else if (callStyle === 'function_call' && activeMode === 'tools') {
        messages.push({ role: 'function', name: call.name, content: clipped });
      } else {
        promptResults.push(`${tr('toolOutput', { name: call.name })}\n${clipped}`);
      }
    }

    if (callStyle === 'prompt' || activeMode !== 'tools') {
      messages.push({
        role: 'user',
        content: `${promptResults.join('\n\n')}\n${tr('continue')}`,
      });
    }
  }

  signal?.throwIfAborted();
  let answer = '';
  if (toolLog.length > 0) {
    let summaryMessage;
    try {
      const request = {
        ...requestDefaults,
        stream: false,
        ...(reasoningDegraded ? {} : reasoningPayload),
        messages: [...messages, { role: 'user', content: tr('summarize') }],
      };
      let metrics, res;
      do {
        const inputTokens = fitRequestHistory(request);
        if (inputTokens > inputBudget) break;
        metrics = createMetrics(config, inputTokens, onEvent, recordMetrics);
        res = await fetchJson(chatUrl, {
          method: 'POST',
          headers: authHeaders(config.apiKey),
          body: JSON.stringify(request),
        }, fetchImpl, { timeoutMs: 15_000, signal, tr });
      } while (!res.ok && degradeImages(res));
      if (res?.ok) {
        summaryMessage = res.json?.choices?.[0]?.message;
        metrics.finish(res.json);
      }
    } catch {
      signal?.throwIfAborted();
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
    ? tr('maxStepsDone', { n: toolLog.length, steps: toolLog.map(t => t.summary).join(tr('stepSep')) })
    : tr('maxSteps');
  const parsed = readAnswer(answer);
  return await finish(parsed.text, parsed.suggestions);
}
