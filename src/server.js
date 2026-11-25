import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { execFile, fork } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { loadModel, stats, subgraph, search, dataflowOf, rebuildIndex } from './core/index.js';
import { decodeSource, sourceDecoder } from './core/source-files.js';
import { isFlowchartFunction } from './core/flowchart.js';
import { dataflowFor, sharedVariables, listGlobals } from './core/dataflow.js';
import { comparisonDataflow, comparisonGlobals } from './core/compare.js';
import { compareGitProject, inspectGitRepo, quickGitDirtySummary, watchGitProject } from './core/git-compare.js';
import { pairDataflow, comparisonPairDataflow } from './core/pair-dataflow.js';
import { CHANGE_STATES, statusOverrides, comparisonStatus, statusSummary } from './core/comparison-status.js';
import { exportXlsx } from './core/export-xlsx.js';
import { exportHtml, publicNode } from './core/export.js';
import { exportSvg } from './core/export-svg.js';
import { callSequence, callNumbers } from './core/call-sequence.js';
import { needsCounterAnalysis, projectTasks, taskPeriods, withTaskPeriods } from './core/task-periods.js';
import { traceToTasks } from './core/task-trace.js';
import { readChangeQuery, changesPage } from './core/mcp-changes.js';
import { analysisJob, analysisModel } from './core/analysis-jobs.js';
import { createMcpServer } from './mcp.js';
import {
  DEFAULT_AI_CONFIG,
  compactConversation,
  listModels as listAiModels,
  normalizeAiConfig,
  publicAiConfig,
  runAiAgent,
  sanitizeSuggestions,
  testConnection as testAiConnection,
} from './core/ai-agent.js';
import { normalizeExpansions } from './core/expansion.js';
import { openStore, fingerprintFiles, importLegacyOverlay, cacheKey, resolveGroupMode } from './core/store.js';
import { collectOrphans as collectOrphansOf, countOrphans } from './core/orphans.js';
import { getParser, listParsers, resolveParserForTarget } from './core/parsers/registry.js';
import { fileKey, findCompileCommands } from './core/parsers/clang-config.js';
import { scheduleConfig } from './core/tcu-schedule.js';
import { applyDataflow, diffParserModels } from './core/parsers/ir.js';
import {
  LABEL_PRESETS,
  normalizeLabel,
  normalizeLabels,
  nextConnNumber,
  LABELS_MAX,
  LABEL_MAX_TEXT,
  LABEL_NOTE_MAX,
  CONN_PREFIX,
} from './core/labels.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, '../web');
const OUT = path.resolve(__dirname, '../out');

// 静态文件二次校验用：解析软链后的真实根目录
let REAL_WEB = WEB;
try {
  REAL_WEB = fs.realpathSync(WEB);
} catch {
  /* web 目录不存在时保持原值，静态请求统一 404 */
}

const target = process.argv[2] || 'samples/tcu';
const PORT = Number(process.argv[3] || 5173);

// ---- 会话状态（可切换工程）----
// 这些绑定在切工程时整体替换。处理器都在请求到达时才读它们，
// 所以用 let + 重新赋值就够，不必把每个 handler 都改成传参。
let root = '';
let ROOT_LABEL = '';
let MODEL = null;
let S = null;
let PROJECT = null;
let overlay = { nodes: {}, edges: {}, notes: [], deleted: { nodes: {}, edges: {} }, layout: {} };
// 工程切换互斥：openTarget 里有 await，不挡的话两个切换请求会交错改写上面这批变量
let switching = false;
let sessionRevision = 0;
let COMPARISON = null;
let comparisonPreview = null;
let comparisonRequest = 0;
let comparisonBase = null;
const readSnapshots = new WeakMap();
let latestSnapshotRequest = 0;
let gitWatch;
const comparisonMetadata = ({ macroChanges, macroDetails, changePoints, impactIds }) =>
  ({ macroChanges, macroDetails, changePoints, impactIds });
const comparisonItem = ({ change, reasons, locations, impact, context, macroImpact, macroNames,
  periodImpact, periodBefore, periodAfter, periods, impactRole, impactChainIds }) =>
  ({ change, reasons, locations, impact, context, macroImpact, macroNames,
    periodImpact, periodBefore, periodAfter, periods, impactRole, impactChainIds });
const comparisonInfo = () => COMPARISON ? {
  id: COMPARISON.id, projectPath: COMPARISON.projectPath, projectName: PROJECT.name,
  beforePath: COMPARISON.beforePath, afterPath: COMPARISON.afterPath, git: COMPARISON.git || null,
  summary: COMPARISON.summary, warnings: COMPARISON.warnings, ...comparisonMetadata(COMPARISON),
  totalNodes: COMPARISON.totalNodes,
  mappings: COMPARISON.mappings,
  manualStatusCount: COMPARISON.statusOverrides.nodes.size + COMPARISON.statusOverrides.edges.size,
} : null;

// 页面当前视图状态（入口 / 深度 / 选中）：前端上报，AI 通过 cg_page 工具读取，
// 用来对齐「用户正在看什么」，AI 组图时也会同步更新这里。
let pageState = null;
const reviewingPage = page => !!page?.reviewing || Number(page?.at) > 0;
const savedViewKey = () => 'ui.last-view.' + PROJECT.id;
function latestPage() {
  return COMPARISON ? COMPARISON.composedPage || { roots: COMPARISON.roots, up: 0, down: 0 }
    : store.getSetting(savedViewKey());
}
const reviewWriteResult = () => reviewingPage(pageState)
  ? { updatedWhileReviewing: true, reviewNote: '已写入最新画布，退出回看即可查看' }
  : {};

// 单库多工程：所有状态按 project_id 隔离，见 docs/superpowers/specs/2026-10-22-persistence-design.md
const store = openStore();
const modelCacheKeys = new WeakMap();
const analysisPending = new WeakMap();
const configuredParser = () => store.getSetting('parser.active', 'builtin');
const scanRootFor = target => fs.statSync(target, { throwIfNoEntry: false })?.isFile() ? path.dirname(target) : target;
const compileCommandsKey = scanRoot => 'parser.compileCommandsPath.' + fileKey(path.resolve(scanRoot));
const parserOptionsFor = (id, scanRoot = scanRootFor(root)) => id === 'clang-ast'
  ? { compileCommandsPath: store.getSetting(compileCommandsKey(scanRoot)) } : {};
const parserInfo = () => ({ id: MODEL.parserId, name: MODEL.parserName });
let parserFallback = null;
async function compareProjects(...args) {
  const comparison = await analysisJob('compare', () => args);
  for (const model of [comparison.model, comparison.beforeModel, comparison.afterModel]) rebuildIndex(model);
  return comparison;
}

function analyzeTasks(model, opts = {}) {
  return analysisJob('task', state => {
    const previous = state.index?.deref();
    state.index = new WeakRef(model._index);
    return { ...opts, model: previous === model._index ? undefined : analysisModel(model) };
  });
}

// Electron 停止服务时断开 IPC，让服务先终止正在扫描源码的子进程。
if (process.connected) process.once('disconnect', () => process.exit(0));

/** 变量/数据流查询或失效标注检查需要 AST 时再构建；完成后升级磁盘缓存。 */
async function ensureAnalysis(model) {
  if (model._df) return;
  if (analysisPending.has(model)) return analysisPending.get(model);
  const pending = (async () => {
    const df = await analysisJob('dataflow', () => analysisModel({
      ...model, variables: model.variables.filter(variable => !variable.manual),
    }));
    const parser = getParser(model.parserId);
    if (!parser || parser.id === 'builtin' || parser.buildDataflow) {
      // 线程返回后投影到当前模型，保留期间用户新增的手工节点和关系。
      // 数据流线程的输入只包含源码符号，期间删掉的规划变量也不会被重新加回。
      applyDataflow(model, df);
      rebuildIndex(model);
    }
    model._df = df;
    if (model === MODEL) S = stats(model);
    const key = modelCacheKeys.get(model);
    if (key && !model._df?.failedFiles) {
      void store.putCachedModelAsync(key, model).then(r => {
        if (!r.cached) console.log(`[缓存] 未缓存变量分析：${r.reason}`);
      }).catch(err => console.warn('[缓存] 变量分析缓存写入失败：', err.message));
    }
  })();
  analysisPending.set(model, pending);
  try { await pending; } finally { analysisPending.delete(model); }
}

// ---- 界面偏好：范围下拉（向下 / 向上层数）----
// 聚焦查找允许 0–20 层，保存到全局 setting 表，跨重启、跨工程生效。
const validDepth = (v) => Number.isInteger(v) && v >= 0 && v <= 20;
const NAME_MODES = ['alias', 'target'];
const macroNameDefault = () => store.getSetting('ui.macroNameMode', 'alias') === 'target' ? 'target' : 'alias';
function withMacroName(node, viewOverlay, defaultMode) {
  if (!node.headerSymbol) return node;
  const override = viewOverlay.nodes?.[node.id]?.nameMode;
  const nameModeOverride = NAME_MODES.includes(override) ? override : null;
  const nameMode = nameModeOverride || defaultMode;
  return { ...node, nameModeOverride, nameMode,
    displayName: nameMode === 'target' ? node.targetNames.join(' / ') : node.name };
}

// ---- MCP 权限（AI 访问）：环境变量 CALLGRAPH_MCP > 库设置 mcp.access > 默认 readonly ----
const MCP_LEVELS = ['off', 'readonly', 'readwrite'];
function mcpAccess() {
  const env = String(process.env.CALLGRAPH_MCP || '').toLowerCase();
  if (MCP_LEVELS.includes(env)) return env;
  const saved = store.getSetting('mcp.access', null);
  if (MCP_LEVELS.includes(saved)) return saved;
  return 'readonly';
}

// ---- 改动推送（SSE）----
// 写操作落库后广播给所有打开的页面（web/lib/live.js 监听），
// 让 AI 通过 MCP 改的标注 / 删除 / 布局即时反映到界面上，不用手动刷新。
const sseClients = new Set();
function writeSse(res, payload) {
  // 慢客户端断线后自动重连，并核对服务端的最新画布版本。
  if (res.destroyed || res.writableLength > 1024 * 1024) {
    sseClients.delete(res);
    res.destroy();
    return;
  }
  res.write(payload);
}

// 心跳：SSE 连接长时间无数据时可能被中间层掐掉，定时发注释行保活，也顺便探活死连接
const sseHeartbeat = setInterval(() => {
  for (const res of sseClients) {
    try {
      writeSse(res, ': ping\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 25000);
sseHeartbeat.unref?.();

/** 广播一条 change 事件；单个连接写失败只摘掉它，不影响其他页面 */
function broadcastChange(op, actor, extra = {}) {
  if (!sseClients.size) return;
  const payload = `event: change\ndata: ${JSON.stringify({ op, actor, ts: Date.now(), projectId: PROJECT?.id, ...extra })}\n\n`;
  for (const res of sseClients) {
    try {
      writeSse(res, payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

function startGitWatch(projectPath, projectId) {
  gitWatch?.abort();
  gitWatch = new AbortController();
  return watchGitProject(projectPath, gitWatch.signal, () => {
    broadcastChange('git.changed', 'system', { projectId, comparisonId: COMPARISON?.id || null });
  }).catch((err) => console.warn('[Git 监听]', err.message));
}

// 旧版 out/overlay.json 一次性导入：成功后改名留底，不删原文件。
// 只在用「默认库」时执行——CALLGRAPH_DB 显式指定的多半是测试/E2E 的临时库，
// 让它去消费并改名真实文件，等于把用户的历史数据搬进一个马上被删掉的库。
const LEGACY_OVERLAY = path.join(OUT, 'overlay.json');
function migrateLegacy(project) {
  if (process.env.CALLGRAPH_DB || !fs.existsSync(LEGACY_OVERLAY)) return;
  try {
    const legacy = JSON.parse(fs.readFileSync(LEGACY_OVERLAY, 'utf8'));
    const r = importLegacyOverlay(store, project.id, legacy);
    if (r.imported) {
      fs.renameSync(LEGACY_OVERLAY, path.join(OUT, `overlay.imported-${Date.now()}.json`));
      console.log(
        `[迁移] 旧 overlay 已导入：标注 ${r.annotations} / 删除节点 ${r.deletedNodes} / 删除边 ${r.deletedEdges}`
      );
    }
  } catch (err) {
    console.warn('[迁移] 旧 overlay 导入失败，原文件保留：', err.message);
  }
}

function scanInProcess(target, scan, options) {
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(new URL('./core/scan-model.js', import.meta.url)), [], {
      execArgv: [],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      serialization: 'advanced',
      windowsHide: true,
    });
    let result;
    const stop = () => child.kill();
    process.once('exit', stop);
    const timer = setTimeout(() => {
      stop();
      reject(new Error('源码扫描超时'));
    }, 300_000);
    child.once('message', (message) => { result = message; });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      process.off('exit', stop);
      if (code === 0 && result?.model) resolve(result.model);
      else reject(new Error(result?.error || `源码扫描中断（${signal || code}）`));
    });
    child.send({ target, scan, options }, (error) => {
      if (!error) return;
      stop();
      reject(error);
    });
  });
}

async function loadTargetModel(abs, isFile, parserId, parserOptions) {
  const t0 = performance.now();
  const parser = resolveParserForTarget(isFile ? abs : abs + path.sep, parserId);
  const status = parser.available(parserOptions);
  if (!status.ok) throw new Error(status.reason || `解析器不可用：${parser.id}`);
  // 解析缓存：源码没动过就直接反序列化模型，省掉整轮词法 + 语法分析。
  // .dot / .gv 走另一套模型（没有文件清单），不参与缓存。
  const isDot = parser.id === 'dot';
  const scanRoot = isFile ? path.dirname(abs) : abs;
  const focus = isFile ? path.relative(path.dirname(abs), abs).replace(/\\/g, '/') : '';
  const scan = isDot ? null : await analysisJob('scan', () => scanRoot);
  const parserKey = parser.cacheKey?.(scanRoot, parserOptions, status) ?? parser.id + ':2';
  const key = scan && !scan.warnings.length ? cacheKey(scan.files, focus, parserKey) : '';
  const scanMs = performance.now() - t0;

  const readAt = performance.now();
  let model = key ? await store.getCachedModelAsync(key) : null;
  const fromCache = !!model;
  const cacheReadMs = performance.now() - readAt;
  const parseAt = performance.now();
  if (model) {
    model.root = isFile ? path.dirname(abs) : abs;
    model.parserId = parser.id;
    model.parserName = parser.name;
    if (focus) model.focusFile = focus;
    rebuildIndex(model);
  } else if (parser.id === 'builtin' || parser.id === 'clang-ast') {
    model = rebuildIndex(await scanInProcess(abs, scan, { parserId: parser.id, parserOptions }));
  } else {
    model = await loadModel(abs, scan, { parserId: parser.id, parserOptions });
  }
  const analyzeMs = performance.now() - parseAt;

  // 首屏只需要调用关系；变量清单/数据流由 ensureAnalysis 按需构建。
  const saveAt = performance.now();
  modelCacheKeys.set(model, key);
  if (key && !fromCache && !model.warnings.length && !model._df?.failedFiles) {
    try {
      const r = await store.putCachedModelAsync(key, model);
      if (!r.cached) console.log(`[缓存] 未缓存：${r.reason}`);
    } catch (error) {
      console.warn('[缓存] 解析缓存写入失败：', error.message);
    }
  }
  const cacheWriteMs = performance.now() - saveAt;
  const loadMs = Math.round(performance.now() - t0);
  model.elapsedMs = loadMs;
  if (scan) console.log(`[耗时] 文件清单 ${Math.round(scanMs)}ms / 缓存读取 ${Math.round(cacheReadMs)}ms / ${fromCache ? '索引重建' : '源码分析'} ${Math.round(analyzeMs)}ms / 缓存写入 ${Math.round(cacheWriteMs)}ms`);
  return { model, fromCache, loadMs };
}

const manualNodesKey = (projectId) => `manual.nodes.${projectId}`;

function sanitizeManualFile(raw) {
  const s = String(raw || '').replace(/\\/g, '/').trim().replace(/^\/+/, '');
  if (!s || s.length > 512 || /[\x00-\x1f]/.test(s)) return '';
  if (s.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return '';
  return s;
}

function sanitizeManualName(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 160 || s.includes('::') || /[\x00-\x1f]/.test(s)) return '';
  return s;
}

function loadManualNodes(projectId) {
  const raw = store.getSetting(manualNodesKey(projectId), []);
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const kind = item.kind === 'var' ? 'var' : item.kind === 'fn' ? 'fn' : null;
    const file = sanitizeManualFile(item.file);
    const name = sanitizeManualName(item.name);
    if (!kind || !file || !name) continue;
    const id = kind === 'var' ? `var::${file}::${name}` : `${file}::${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind,
      file,
      name,
      typeText: kind === 'var' ? String(item.typeText || '').trim().slice(0, 120) : '',
    });
  }
  return out;
}

function saveManualNodes(projectId, list) {
  store.setSetting(manualNodesKey(projectId), list);
}

function toManualModelNode(item) {
  if (item.kind === 'var') {
    return {
      id: item.id,
      kind: 'var',
      name: item.name,
      file: item.file,
      line: 0,
      typeText: item.typeText || '',
      isStatic: true,
      isConst: false,
      manual: true,
      params: [],
    };
  }
  return {
    id: item.id,
    kind: 'fn',
    name: item.name,
    file: item.file,
    line: 0,
    isStatic: false,
    manual: true,
    params: [],
    calls: [],
    varAccess: [],
  };
}

function injectManualNodeIntoModel(model, item) {
  if (!model || model._index?.byId?.has(item.id) || model._df?.byId?.has(item.id)) return null;
  const node = toManualModelNode(item);
  if (!model.files.some((f) => f.rel === item.file)) {
    model.files.push({ rel: item.file, isHeader: /\.h$/i.test(item.file), bytes: 0, manual: true });
  }
  if (item.kind === 'var') {
    model.variables = model.variables || [];
    model.variables.push(node);
    if (model._df) {
      model._df.defs.push(node);
      model._df.byId.set(node.id, node);
    }
  } else {
    model.functions = model.functions || [];
    model.functions.push(node);
  }
  return node;
}

function applyManualNodes(model, projectId, list = loadManualNodes(projectId)) {
  if (!model) return;
  const hadManual = Boolean(
    model.functions?.some((n) => n.manual) ||
    model.variables?.some((v) => v.manual) ||
    model.files?.some((f) => f.manual)
  );
  if (!list.length && !hadManual) return;
  if (hadManual) {
    model.functions = (model.functions || []).filter((n) => !n.manual);
    model.variables = (model.variables || []).filter((v) => !v.manual);
    model.files = (model.files || []).filter((f) => !f.manual);
    if (model._df) {
      model._df.defs = (model._df.defs || []).filter((d) => !d.manual);
      for (const [k, d] of [...(model._df.byId || [])]) {
        if (d?.manual) model._df.byId.delete(k);
      }
    }
    rebuildIndex(model);
  }
  let injected = false;
  for (const item of list) {
    if (injectManualNodeIntoModel(model, item)) injected = true;
  }
  if (injected) rebuildIndex(model);
}

// ---- 流程图持久化缓存 + 有变更函数默认预加载保存 ----
const FLOWCHART_CACHE_MAX = 40;
const flowchartMemCache = new Map(); // projectId -> Map<entryKey, { hash, savedAt, data }>
const gitBeforeSnapshotByProject = new Map(); // projectId -> { beforeModel, beforePath }

function loadProjectFlowchartCache(projectId) {
  let mem = flowchartMemCache.get(projectId);
  if (!mem) {
    mem = new Map();
    const saved = store.getSetting(`flowchart.cache.${projectId}`, {});
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [k, v] of Object.entries(saved)) {
        if (v && typeof v === 'object' && typeof v.hash === 'string' && v.data?.ok) {
          mem.set(k, v);
        }
      }
    }
    flowchartMemCache.set(projectId, mem);
  }
  return mem;
}

function saveProjectFlowchartCache(projectId, mem) {
  // 限制单工程缓存条数（按 savedAt 保留最新 N 条）
  if (mem.size > FLOWCHART_CACHE_MAX) {
    const entries = [...mem.entries()].sort((a, b) => (b[1].savedAt || 0) - (a[1].savedAt || 0)).slice(0, FLOWCHART_CACHE_MAX);
    mem.clear();
    for (const [k, v] of entries) mem.set(k, v);
  }
  const obj = Object.fromEntries(mem.entries());
  try {
    store.setSetting(`flowchart.cache.${projectId}`, obj);
  } catch (err) {
    console.warn('[流程图缓存] 写入失败：', err.message);
  }
}

const execFileAsync = promisify(execFile);

/** 仅读取单个文件在 Git HEAD 下的源码，用于普通模式下对已修改函数做逐块流程图差分（避免全库重解析）。 */
async function readGitHeadFileText(projectRoot, relFile) {
  if (!projectRoot || !relFile || relFile.includes('..')) return null;
  const rel = String(relFile).replace(/\\/g, '/').replace(/^\/+/, '');
  try {
    const { stdout: prefixOut } = await execFileAsync(
      'git', ['-c', 'core.quotePath=false', '-C', projectRoot, 'rev-parse', '--show-prefix'],
      { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000, windowsHide: true }
    );
    const prefix = prefixOut.replace(/\r?\n$/, '');
    const { stdout: buf } = await execFileAsync(
      'git', ['-c', 'core.quotePath=false', '-C', projectRoot, 'show', `HEAD:${prefix}${rel}`],
      { encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 8 * 1024 * 1024, timeout: 8000, windowsHide: true }
    );
    return decodeSource(buf);
  } catch {
    return null;
  }
}

async function getOrBuildFlowchart(projectId, model, fn, opts = {}) {
  const { version = 'after', expandMacros = false, fnChange = 'existing', otherModel = null, otherFn = null,
    persist = true, signal, ...flowOptions } = opts;
  const entryKey = `${fn.id}|${version}|${expandMacros ? 1 : 0}`;
  const cache = loadProjectFlowchartCache(projectId);
  let hit;
  const { hash, data } = await analysisJob('flowchart', state => {
    const previous = state.indexes || [];
    const models = [model, otherFn ? otherModel : null].map((item, i) => {
      if (!item) return null;
      if (previous[i]?.deref() === item._index) return undefined;
      const { root, parserId, files, includes, functions, externals, edges, headerSymbols, _sourceFiles, _sourceBuffers } = item;
      return analysisModel({ root, parserId, files, includes, functions, externals, edges, headerSymbols, _sourceFiles, _sourceBuffers });
    });
    state.indexes = [model, otherFn ? otherModel : null].map(item => item && new WeakRef(item._index));
    hit = cache.get(entryKey);
    return { models, id: fn.id, opts: { version, expandMacros, fnChange, ...flowOptions }, cachedHash: hit?.hash };
  }, { signal });
  if (!data) return { ...hit.data, fn: { ...hit.data.fn, hasBefore: !!opts.hasBefore, hasAfter: !!opts.hasAfter }, cached: true };
  cache.set(entryKey, { hash, savedAt: Date.now(), data });
  if (persist) saveProjectFlowchartCache(projectId, cache);
  return data;
}

function prewarmChangedFlowcharts(projectId, model, fnEntries, beforeModel = null, beforeSourceRoot = null, sourceRoot) {
  if (!projectId || !model || !Array.isArray(fnEntries) || !fnEntries.length) return;
  if (beforeModel && !COMPARISON && PROJECT?.id === projectId) {
    gitBeforeSnapshotByProject.clear();
    gitBeforeSnapshotByProject.set(projectId, { beforeModel, beforePath: beforeSourceRoot || null });
  }
  const list = fnEntries.slice(0, 25);
  setImmediate(async () => {
    let dirty = false;
    for (const item of list) {
      if (switching || PROJECT?.id !== projectId || (COMPARISON?.afterModel || MODEL) !== model) break;
      const fn = model._index?.byId?.get(item.id);
      if (!isFlowchartFunction(fn)) continue;
      const otherFn = beforeModel?._index?.byId?.get(item.id) || null;
      try {
        const result = await getOrBuildFlowchart(projectId, model, fn, {
          version: 'after',
          expandMacros: false,
          hasBefore: isFlowchartFunction(otherFn),
          hasAfter: true,
          fnChange: item.change || 'modified',
          otherModel: otherFn ? beforeModel : null,
          otherFn,
          otherSourceRoot: beforeSourceRoot || undefined,
          sourceRoot,
          persist: false,
        });
        dirty ||= !result.cached;
      } catch {
        /* 单个函数预生成失败不影响主流程 */
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (dirty) saveProjectFlowchartCache(projectId, loadProjectFlowchartCache(projectId));
  });
}

function manualNodesMap(list) {
  return Object.fromEntries((list || []).map((item) => [item.id, item]));
}

function variableConflicts(model, { id, file, name }) {
  const get = (key) => model._df?.byId?.get(key) ?? model._index?.byId?.get(key);
  return [get(id), get(`var::${name}`), ...(model.variables || []).filter((v) =>
    v.name === name && (v.file === file || !v.isStatic))].filter(Boolean);
}

/** 将已由同文件源码实现的规划变量及其存档绑定迁移到真实符号。 */
function reconcileManualVariables(model, projectId, list, savedPage) {
  const bindings = new Map();
  for (const item of list) {
    if (item.kind !== 'var') continue;
    const implementation = variableConflicts(model, item).find((v) =>
      !v.manual && !v.isExtern && v.file === item.file);
    if (implementation) bindings.set(item.id, implementation.id);
  }
  if (!bindings.size) return { list, page: savedPage };

  const nodeId = (id) => bindings.get(id) ?? id;
  const nodeIds = (ids) => [...new Set(ids.map(nodeId))];
  const edgeId = (id) => {
    const match = /^(.+?)->(.+?)(:-?\d+)?$/.exec(id);
    return match ? `${nodeId(match[1])}->${nodeId(match[2])}${match[3] || ''}` : id;
  };
  const remapKeys = (entries, idFor) => {
    const result = new Map();
    for (const [key, data] of Object.entries(entries || {})) {
      const id = idFor(key);
      if (id === key) continue;
      result.set(id, data);
    }
    for (const [key, data] of Object.entries(entries || {})) {
      if (idFor(key) !== key) continue;
      const old = result.get(key);
      result.set(key, isPlainObject(old) && isPlainObject(data) ? { ...old, ...data } : data);
    }
    return Object.fromEntries(result);
  };
  const remapPage = (page) => page && {
    ...page,
    roots: nodeIds(page.roots || []),
    vars: nodeIds(page.vars || []),
    ...(page.hiddenVars && { hiddenVars: nodeIds(page.hiddenVars) }),
    ...(page.expansions && { expansions: normalizeExpansions(page.expansions.map((scope) =>
      ({ ...scope, root: nodeId(scope.root) }))) }),
    ...(page.selected && { selected: nodeId(page.selected) }),
    ...(page.selectedEdge && { selectedEdge: edgeId(page.selectedEdge) }),
  };

  const live = store.loadOverlay(projectId);
  const layout = new Map();
  const slots = Object.entries(live.layout).map(([key, slot]) => {
    const mode = key.lastIndexOf('::');
    const roots = nodeIds(key.slice(0, mode).split('+')).join('+');
    return { key, id: roots + key.slice(mode), slot };
  });
  for (const { id, slot } of [...slots.filter((entry) => entry.id !== entry.key),
    ...slots.filter((entry) => entry.id === entry.key)]) {
    const prior = layout.get(id);
    const edges = new Map();
    for (const edge of [...(prior?.manual || []), ...(slot.manual || [])]) {
      const from = nodeId(edge.from), to = nodeId(edge.to);
      if (from !== to) edges.set(edgeKeyOf({ from, to, line: 0 }), { from, to });
    }
    layout.set(id, {
      nodes: { ...prior?.nodes, ...remapKeys(slot.nodes, nodeId) },
      edges: { ...prior?.edges, ...remapKeys(slot.edges, edgeId) },
      manual: [...edges.values()],
    });
  }
  const next = {
    ...live,
    nodes: remapKeys(live.nodes, nodeId),
    edges: remapKeys(live.edges, edgeId),
    deleted: {
      nodes: remapKeys(live.deleted.nodes, nodeId),
      edges: remapKeys(live.deleted.edges, edgeId),
    },
    layout: Object.fromEntries(layout),
  };
  const remaining = list.filter((item) => !bindings.has(item.id));
  const page = remapPage(savedPage);
  store.replaceOverlay(projectId, next);
  saveManualNodes(projectId, remaining);
  for (const bookmark of store.listBookmarks(projectId)) {
    const updated = remapPage(bookmark);
    if (JSON.stringify(updated) !== JSON.stringify(bookmark)) store.saveBookmark(projectId, updated);
  }
  return { list: remaining, page, overlay: { ...next, manualNodes: manualNodesMap(remaining) } };
}

/** 加载完成后整体切换会话，工程标注仍以 project_id 为准。 */
async function openTarget(targetPath, { first = false, selection, refreshCurrent } = {}) {
  const abs = path.resolve(targetPath);
  const entry = await fs.promises.stat(abs).catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!entry) throw new Error(`路径不存在：${abs}`);
  const isFile = entry.isFile();
  const label = path.basename(isFile ? path.dirname(abs) : abs) || abs;
  const parserId = selection?.parserId ?? configuredParser();
  console.log(`[加载] ${abs}`);
  let loaded, fallback = null;
  try {
    loaded = await loadTargetModel(abs, isFile, parserId, selection?.parserOptions ?? parserOptionsFor(parserId, isFile ? path.dirname(abs) : abs));
  } catch (error) {
    if (selection || parserId === 'builtin' || (isFile && /\.(dot|gv)$/i.test(abs))) throw error;
    fallback = `${parserId} 加载失败，已回退到内置快速解析：${error.message}`;
    console.warn(`[解析器] ${fallback}`);
    loaded = await loadTargetModel(abs, isFile, 'builtin', {});
  }
  const { model, fromCache, loadMs } = loaded;
  // 同工程刷新期间照常接受写入。先在局部构建模型，发布前再检查会话并读最新存档。
  if (refreshCurrent) {
    refreshCurrent();
    if (model.source !== 'dot' && loadManualNodes(PROJECT.id).some(item => item.kind === 'var')) {
      await ensureAnalysis(model);
      refreshCurrent();
    }
  }
  const project = store.upsertProject({
    path: abs,
    name: label,
    fingerprint: fingerprintFiles(model.files),
  });
  if (first) migrateLegacy(project);

  const list = loadManualNodes(project.id);
  if (!refreshCurrent && model.source !== 'dot' && list.some((item) => item.kind === 'var')) await ensureAnalysis(model);
  const pageKey = 'ui.last-view.' + project.id;
  const reconciled = store.transaction(() => {
    const savedPage = store.getSetting(pageKey);
    const result = reconcileManualVariables(model, project.id, list, savedPage);
    if (result.overlay) {
      if (result.page) store.setSetting(pageKey, result.page);
      store.appendEvent(project.id, {
        op: 'manual.variable.bind', actor: 'system',
        after: { ...result.overlay, ...(result.page && { view: viewSnapshot(result.page) }) },
      });
    }
    return result;
  });
  applyManualNodes(model, project.id, reconciled.list);
  const st = stats(model);

  const ov = store.loadOverlay(project.id);
  ov.deleted = ov.deleted || { nodes: {}, edges: {} };
  ov.deleted.nodes = ov.deleted.nodes || {};
  ov.deleted.edges = ov.deleted.edges || {};

  if (selection) store.transaction(() => {
    store.setSetting('parser.active', selection.parserId);
    if (selection.parserId === 'clang-ast') store.setSetting(compileCommandsKey(model.root), selection.parserOptions.compileCommandsPath);
  });
  if (!refreshCurrent) sessionRevision++;
  root = abs;
  ROOT_LABEL = project.name;
  MODEL = model;
  parserFallback = fallback;
  S = st;
  if (PROJECT?.id !== project.id) gitBeforeSnapshotByProject.clear();
  PROJECT = project;
  COMPARISON = null;
  overlay = ov;
  if (!refreshCurrent) pageState = null;
  else if (!reviewingPage(pageState)) pageState = reconciled.page;

  // 已有数据但还没钉过起点时，补一条 baseline：
  // 没有它，时间轴只能从空状态开始回放，迁移/导入之前的数据就找不回来了
  if (!store.hasAnchor(project.id)) {
    store.appendEvent(project.id, { op: 'baseline', target: 'open', after: { ...ov, manualNodes: manualNodesMap(reconciled.list) }, actor: 'system' });
  }

  console.log(
    `[就绪] 文件 ${st.files} / 函数 ${st.functions} / 边 ${st.edges} / 宏 ${st.macros} / 耗时 ${loadMs}ms${
      fromCache ? '（解析缓存）' : ''
    }`
  );
  console.log(`[存储] ${store.file} · 工程 #${project.id} ${project.isNew ? '(新建)' : ''}`);
  // Git 监听异步安装，不阻塞切换工程接口返回；同时后台预热已有变更标记的函数流程图
  if (refreshCurrent) return { project, stats: st };
  void startGitWatch(abs, project.id);
  const prewarmEntries = Object.entries(ov.nodes || {})
    .filter(([, data]) => data && ['modified', 'added'].includes(data.change))
    .map(([id, data]) => ({ id, change: data.change }));
  if (prewarmEntries.length) prewarmChangedFlowcharts(project.id, model, prewarmEntries);
  return { project, stats: st };
}

let liveRefresh;
function refreshLiveProject() {
  const revision = sessionRevision;
  if (liveRefresh?.revision === revision) return liveRefresh.pending;
  const refresh = { revision };
  liveRefresh = refresh;
  refresh.pending = openTarget(root, { refreshCurrent() {
    if (switching || sessionRevision !== revision) throw new Error('工程或比较会话已切换，请重试');
  } }).then(result => {
    comparisonPreview = null;
    return result;
  }).finally(() => {
    if (liveRefresh === refresh) liveRefresh = null;
  });
  return refresh.pending;
}

/** 重新从库里载入 overlay 到内存镜像（清理孤儿标注后用） */
function reloadOverlay() {
  const ov = store.loadOverlay(PROJECT.id);
  ov.deleted = ov.deleted || { nodes: {}, edges: {} };
  ov.deleted.nodes = ov.deleted.nodes || {};
  ov.deleted.edges = ov.deleted.edges || {};
  overlay = ov;
  return ov;
}

/**
 * 找出库里指向「已经不存在的函数 / 连线」的条目。
 * 判定规则在 core/orphans.js，那边能直接拿真实模型写单测。
 */
async function collectOrphans() {
  const model = MODEL;
  const project = PROJECT;
  const comparison = COMPARISON;
  if (switching) return null;
  // 先读库里是否有可检查目标：空库直接返回，避免打开工程面板时对即将离开的旧工程做全量数据流分析。
  const targets = store.listAllTargets(project.id);
  if (!targets.annotations.length && !targets.deleted.length && !targets.layouts.length) {
    return { annotations: [], deleted: [], layoutSlots: [], layoutNodes: [] };
  }
  const needsCAnalysis = !comparison && model.source !== 'dot';
  if (needsCAnalysis) await ensureAnalysis(model);
  if (switching || model !== MODEL || project !== PROJECT || comparison !== COMPARISON) return null;
  if (needsCAnalysis && model._df?.failedFiles) throw new Error('变量索引不完整，无法安全清理标注；请检查源码读取或解析错误，重新打开工程后重试');
  return collectOrphansOf(model, targets);
}

/** 只取 patch 里涉及到的键，事件里存增量而不是全量，避免时间轴被坐标淹没 */
const pickKeys = (obj, keys) => {
  const out = {};
  for (const k of keys) out[k] = obj && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null;
  return out;
};




/** 与前端 edgeKey 保持一致 */
const edgeKeyOf = (e) => `${e.from}->${e.to}:${e.line}`;

const ANNOTATION_OPS = new Set(['node.annotate', 'edge.annotate']);
const hasAnnotationValue = (value) => Array.isArray(value) ? value.length > 0 :
  typeof value === 'string' ? value.trim().length > 0 : value != null;

const stringArray = (value) => Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [];

function viewSnapshot(view) {
  const groupMode = resolveGroupMode(view.groupMode, view.group);
  return {
    roots: stringArray(view.roots),
    expansions: normalizeExpansions(view.expansions),
    up: Math.max(0, Number(view.up) || 0),
    down: Math.max(0, Number(view.down) || 0),
    group: groupMode !== 'flat', groupMode,
    vars: stringArray(view.vars),
    hiddenVars: stringArray(view.hiddenVars),
    empty: !!view.empty,
  };
}

function currentViewSnapshot() {
  const page = !COMPARISON && (pageState && !reviewingPage(pageState) ? pageState : latestPage());
  return page ? viewSnapshot(page) : undefined;
}

function emptyCanvasView(groupMode = 'file') {
  return { nodes: [], edges: [], groups: [], containers: [], width: 480, height: 260,
    root: null, roots: [], expansions: [], empty: true, groupMode, projectId: PROJECT.id };
}

/** 从持久化状态比较，避免仅因 updatedAt 改变产生事件。调用方负责事务和广播。 */
function writeAnnotation(kind, target, patch, actor) {
  const { updatedAt, ...previous } = store.getAnnotation(PROJECT.id, kind, target);
  const next = { ...previous, ...patch };
  for (const key of Object.keys(next)) if (next[key] === null) delete next[key];
  if (isDeepStrictEqual(previous, next)) return null;
  // 完整标注只含短文本和标签。保留未改字段，便于区分部分清除和清空整条标注。
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const annotation = store.setAnnotation(PROJECT.id, kind, target, patch);
  store.appendEvent(PROJECT.id, {
    op: `${kind}.annotate`, target, actor,
    before: pickKeys(previous, keys), after: { ...pickKeys(next, keys), view: currentViewSnapshot() },
  });
  return annotation;
}

function timelineEvent({ before, after, ...event }, withPayload) {
  if (ANNOTATION_OPS.has(event.op)) {
    const brief = event.brief = {};
    const { view, ...data } = after || {};
    for (const key of ['note', 'tag', 'change', 'nameMode']) {
      if (hasAnnotationValue(data[key])) brief[key] = String(data[key]).slice(0, key === 'note' ? 80 : 40);
    }
    if (data.color) brief.color = 1;
    const labels = normalizeLabels(data.labels ?? data.label);
    if (Object.hasOwn(data, 'labels') || Object.hasOwn(data, 'label')) {
      brief.labels = labels.map((label) => label.text).filter(Boolean);
    }
    if (Object.values(before || {}).some(hasAnnotationValue) &&
        !Object.values(data).some(hasAnnotationValue)) brief.cleared = true;
  } else if (event.op === 'view.compose') {
    event.brief = { count: after?.count, roots: after?.rootCount, reason: after?.reason || '' };
  }
  return withPayload ? { ...event, before, after } : event;
}

const callRank = { direct: 3, macro: 2, fnptr: 1 };
const callLabelOrder = (text) => Number(/^コール順(\d+)$/.exec(text)?.[1]);
const mcpSourceEdgeIndexes = new WeakMap();

function indexSourceEdges(edges) {
  const exact = new Map();
  const pairs = new Map();
  for (const edge of edges) {
    const key = edgeKeyOf(edge);
    if (!exact.has(key)) exact.set(key, edge);
    const pair = `${edge.from}->${edge.to}`;
    // 普通画布将变量读写合并到行号 0；同时接受模型查询返回的真实行号。
    if (edge.kind === 'var') exact.set(pair + ':0', edge);
    const prev = pairs.get(pair);
    if (!prev || (callRank[edge.kind] ?? 0) > (callRank[prev.kind] ?? 0)) pairs.set(pair, edge);
  }
  return { exact, pairs };
}

function sourceEdgeIndex(model) {
  const edges = model.edges;
  // 数据流分析重建边数组时，新的引用会自动触发索引重建。
  if (!mcpSourceEdgeIndexes.has(edges)) {
    mcpSourceEdgeIndexes.set(edges, indexSourceEdges([...edges, ...(model.headerEdges || [])]));
  }
  return mcpSourceEdgeIndexes.get(edges);
}

function mcpEdgeIndex() {
  const source = sourceEdgeIndex(MODEL);
  const manual = new Map();
  for (const slot of Object.values(overlay.layout || {})) {
    for (const edge of slot?.manual || []) {
      if (!MODEL._index.byId.has(edge?.from) || !MODEL._index.byId.has(edge?.to)) continue;
      const entry = { from: edge.from, to: edge.to, line: 0, kind: 'manual' };
      manual.set(edgeKeyOf(entry), entry);
    }
  }
  const exact = key => source.exact.get(key) || manual.get(key);
  const notDeleted = (e) => e && !overlay.deleted.edges[canvasEdgeKey(e)] && !overlay.deleted.edges[edgeKeyOf(e)];
  const resolvePair = (pair) => {
    const candidate = source.pairs.get(pair);
    if (notDeleted(candidate)) return candidate;
    // 默认候选被删时，从源码边里找同端点未删的边
    const [from, to] = pair.split('->');
    const live = [...(MODEL.edges || []), ...(MODEL.headerEdges || [])]
      .find((e) => e.from === from && e.to === to && notDeleted(e));
    if (live) return live;
    const man = manual.get(`${pair}:0`);
    if (notDeleted(man)) return man;
    return candidate || man;
  };
  return { exact, resolve: key => exact(key) || resolvePair(key) };
}

// 普通图上同一函数和变量之间只有一条读写线。沿用前端的键以兼容已保存的标注。
const canvasEdgeKey = edge => edge.kind === 'var' ? `${edge.from}->${edge.to}:0` : edgeKeyOf(edge);

function annotationEdgeKey(edges, edge, model) {
  const canvasKey = canvasEdgeKey(edge);
  if (edge.kind !== 'var' || edges?.[canvasKey]) return canvasKey;
  // 旧版 MCP 可能已经在真实行号保存备注和标签。读写都复用同一条记录。
  const source = edge.line === 0 ? sourceEdgeIndex(model).exact.get(canvasKey) : edge;
  const sourceKey = source && edgeKeyOf(source);
  return sourceKey && edges?.[sourceKey] ? sourceKey : canvasKey;
}

function normalizeAiLabel(raw) {
  if (!isPlainObject(raw) || !['task', 'call', 'conn'].includes(raw.preset)) {
    throw new Error('标签 preset 必须是 task / call / conn');
  }
  const { preset, order, note, num, id, dx, dy } = raw;
  for (const key of ['border', 'color']) {
    const supplied = typeof raw[key] === 'string' ? raw[key].toUpperCase() : raw[key];
    if (supplied !== undefined && supplied !== LABEL_PRESETS[preset][key]) {
      throw new Error(`${preset} 标签的 ${key} 由预设决定，请省略自定义配色`);
    }
  }
  let { text } = raw;
  if (text !== undefined && (typeof text !== 'string' || text.length > LABEL_MAX_TEXT)) {
    throw new Error(`标签文字最多 ${LABEL_MAX_TEXT} 字`);
  }
  if (note !== undefined && (typeof note !== 'string' || note.length > LABEL_NOTE_MAX)) {
    throw new Error(`标签依据最多 ${LABEL_NOTE_MAX} 字`);
  }
  if (preset === 'task' && !text?.trim()) throw new Error('TASK 标签需要非空文字');
  if (preset === 'call') {
    const textOrder = callLabelOrder(text?.trim());
    const n = order === undefined ? textOrder : order;
    if (!Number.isSafeInteger(n) || n <= 0 || (text !== undefined && textOrder !== n)) {
      throw new Error('调用顺序须为正整数 order 或 コール順N 文字，两者并用时须一致');
    }
    text = `コール順${n}`;
  }
  // 复用预设配色，保留原有的标签标识和位置；コール順（call）标签不附带注释说明。
  const cleanNote = preset === 'call' ? undefined : note;
  return { preset, text, ...(cleanNote === undefined ? {} : { note: cleanNote }), ...(num === undefined ? {} : { num }), id, dx, dy };
}

function checkAiCallOrders(index, updates) {
  const pending = new Map();
  for (const [key, labels] of updates) {
    const edge = index.exact(key);
    if (!edge) continue;
    for (const label of labels || []) {
      const order = callLabelOrder(label.text);
      if (!Number.isSafeInteger(order) || order < 1) continue;
      const id = JSON.stringify([edge.from, order]);
      if (pending.has(id)) throw new Error(`${edge.from} 的 ${label.text} 重复`);
      pending.set(id, key);
    }
  }
  if (!pending.size) return;
  for (const [key, annotation] of Object.entries(overlay.edges)) {
    if (updates.has(key)) continue;
    const edge = index.resolve(key);
    if (!edge || (edge.kind === 'var' && key !== annotationEdgeKey(overlay.edges, edge, MODEL)) ||
        updates.has(canvasEdgeKey(edge)) || overlay.deleted.edges[key] || overlay.deleted.edges[canvasEdgeKey(edge)] ||
        overlay.deleted.nodes[edge.from] || overlay.deleted.nodes[edge.to]) continue;
    for (const label of normalizeLabels(annotation.labels ?? annotation.label)) {
      if (pending.has(JSON.stringify([edge.from, callLabelOrder(label.text)]))) {
        throw new Error(`${edge.from} 的 ${label.text} 已用于 ${key}`);
      }
    }
  }
}

function getMcpChangeSnapshot(snapshotId) {
  if (COMPARISON && snapshotId === COMPARISON.id) return { id: COMPARISON.id, comparison: COMPARISON };
  const snapshot = readSnapshots.get(MODEL);
  if (snapshot && snapshot.id === snapshotId && snapshot.revision === sessionRevision) return snapshot;
  throw new Error('查询快照已失效，请重新调用 cg_changes');
}

async function readMcpChanges(q, req, { bypassMcpAccess = false, forceGit = false,
  sessionCurrent = () => currentSession(req) } = {}) {
  const query = readChangeQuery(q);
  const hasRefs = q.has('baseRef') || q.has('targetRef');
  let snapshot, requestId;
  if (!forceGit && (q.has('snapshotId') || COMPARISON)) {
    snapshot = getMcpChangeSnapshot(q.get('snapshotId') ?? COMPARISON.id);
    const git = snapshot.comparison.git;
    if (hasRefs && (!git || ['baseRef', 'targetRef'].some(k => q.has(k) && q.get(k) !== git[k]))) {
      throw new Error('指定的 Git 引用与当前比较快照不符');
    }
  } else {
    requestId = ++latestSnapshotRequest;
    const model = MODEL;
    if (model.parserId === 'dot') throw new Error('Git 源码变更查询需要打开 C 工程');
    const projectPath = COMPARISON?.projectPath || model.root;
    const comparison = await compareGitProject(projectPath, {
      baseRef: q.get('baseRef') ?? undefined, targetRef: q.get('targetRef') ?? undefined,
    }, { parserId: model.parserId, parserOptions: parserOptionsFor(model.parserId, projectPath), runComparison: compareProjects,
      allowEmptyRefresh: !!query.id, deferUnchangedAnalysis: true });
    if (!sessionCurrent() || MODEL !== model || (!bypassMcpAccess && mcpAccess() === 'off')) throw new Error('工程或访问权限已改变');
    if (requestId !== latestSnapshotRequest) throw new Error('较新的 Git 查询已开始，请使用最新查询的快照');
    snapshot = { id: randomUUID(), comparison, revision: sessionRevision };
  }
  if (query.id && snapshot.comparison.analyze) {
    // 空差分列表无需重建全图；只有随后查询函数上下文时才解析当时保存的源码。
    snapshot.pending ??= snapshot.comparison.analyze();
    try {
      const analyzed = await snapshot.pending;
      if (!sessionCurrent() || (!bypassMcpAccess && mcpAccess() === 'off')) throw new Error('工程或访问权限已改变');
      getMcpChangeSnapshot(snapshot.id);
      snapshot.comparison = analyzed;
    } finally { delete snapshot.pending; }
  }
  const result = changesPage(snapshot.comparison, query);
  if (requestId !== undefined) readSnapshots.set(MODEL, snapshot);
  return { ok: true, source: !forceGit && COMPARISON ? 'active-comparison' : 'git', snapshotId: snapshot.id,
    comparisonId: !forceGit ? (COMPARISON?.id ?? null) : null, ...result };
}

// 比较的合并图含两个版本的边；在一个确定版本内回溯，防止拼出从未存在的路径。
function traceContext(id, version = null) {
  if (version != null && (!COMPARISON || !['before', 'after'].includes(version))) {
    throw new Error('version 仅在比较模式下可选 before 或 after');
  }
  if (!COMPARISON) return { model: MODEL, traceVersion: 'current' };
  const deleted = !COMPARISON.afterModel._index.byId.has(id) && COMPARISON.beforeModel._index.byId.has(id);
  const traceVersion = version ?? (deleted ? 'before' : 'after');
  return { model: COMPARISON[traceVersion + 'Model'], traceVersion };
}

async function readMcpSource(q) {
  const id = q.get('id');
  if (q.has('id') === ['file', 'startLine', 'endLine'].some((key) => q.has(key))) {
    throw new Error('请传函数 id，或同时传 file、startLine、endLine');
  }
  const comparison = COMPARISON;
  const activeModel = MODEL;
  const { model, traceVersion } = traceContext(id, q.get('version'));
  const fn = id ? model._index.byId.get(id) : null;
  if (q.has('id') && (!fn?.endLine || fn.external || fn.kind === 'var')) {
    throw new Error(`无法找到函数源码：${id}`);
  }
  const file = fn?.file ?? q.get('file');
  const startLine = fn?.line ?? Number(q.get('startLine'));
  const requestedEndLine = fn?.endLine ?? Number(q.get('endLine'));
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(requestedEndLine) ||
      startLine < 1 || requestedEndLine < startLine) {
    throw new Error('行范围需要 1 起始的整数，且 endLine 不小于 startLine');
  }
  if (!model.files?.some((entry) => entry.rel === file)) {
    throw new Error('只允许读取当前工程内已索引的源码相对路径');
  }
  let source = await model._sourceBuffers?.getAsync(file);
  if (!source) {
    const realRoot = await fs.promises.realpath(model.root);
    const realFile = await fs.promises.realpath(model._sourceFiles?.get(file) ?? path.join(realRoot, file));
    const roots = [realRoot, comparison?.beforePath, comparison?.afterPath].filter(Boolean);
    const withinRoots = roots.some(root => {
      const rel = path.relative(root, realFile);
      return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
    });
    if (!withinRoots || !(await fs.promises.stat(realFile)).isFile()) {
      throw new Error('源码文件必须位于当前工程或对照目录内');
    }
    source = await fs.promises.readFile(realFile);
  }
  const decoder = sourceDecoder(source, q.get('encoding') ?? 'auto', { fatal: true });
  let decoded;
  try { decoded = decoder.decode(source.subarray(decoder.bomLength)); }
  catch { throw new Error(`${file} 含无效的 ${decoder.encoding} 字节，请核对原文件编码`); }
  const lines = decoded.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  if (startLine > lines.length) throw new Error('起始行超出源码文件范围');
  const endLine = Math.min(requestedEndLine, startLine + 249, lines.length);
  if (fn && !comparison) await ensureAnalysis(model);
  if (switching || COMPARISON !== comparison || activeModel !== MODEL) {
    throw new Error('工程已切换，请重新调用');
  }
  return {
    ok: true, id: fn?.id ?? null, name: fn?.name ?? null, file, startLine, endLine,
    requestedEndLine, truncated: endLine < requestedEndLine, sourceEncoding: decoder.encoding,
    source: lines.slice(startLine - 1, endLine).join('\n'),
    taskPeriods: fn ? taskPeriods(model).get(id) || [] : [],
    traceVersion, ...(fn ? traceToTasks(model, id) : {}),
    calls: fn ? (model._index.outAdj.get(id) || []).filter((edge) => edge.kind !== 'var')
      .map((edge) => ({ ...edge, edgeKey: edgeKeyOf(edge) })) : [],
    varAccess: fn?.varAccess || [],
  };
}

function normalizePathPrefixes(raw) {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' && raw.trim() ? [raw] : [];
  return [...new Set(arr.map((s) => String(s || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()).filter(Boolean))];
}

function fileMatchesPathPrefix(filePath, prefix) {
  const norm = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  if (!norm || !prefix) return false;
  return norm === prefix || norm.startsWith(prefix + '/') || norm.includes('/' + prefix + '/');
}

function fileOfNodeId(model, id) {
  const node = model?._index?.byId?.get(id);
  if (node?.file) return node.file;
  const raw = String(id || '');
  const parts = raw.split('::');
  if (parts[0] === 'var') return parts.length >= 3 ? parts[1] : '';
  return parts.length >= 2 ? parts[0] : '';
}

function chainMatchesPathFilters(model, chain, targetSet, includePaths, excludePaths) {
  const files = (chain.path || []).map((fnId) => ({ fnId, file: fileOfNodeId(model, fnId) }));
  if (excludePaths.length) {
    // 任一上游节点（或非目标本身节点）命中排除路径，整条支路排除
    if (files.some(({ fnId, file }) => !targetSet.has(fnId) && excludePaths.some((p) => fileMatchesPathPrefix(file, p)))) {
      return false;
    }
  }
  if (includePaths.length) {
    // 只要整条上游链路中存在命中 includePaths 的节点，即保留（共通改动函数自动保留）
    if (!files.some(({ file }) => includePaths.some((p) => fileMatchesPathPrefix(file, p)))) {
      return false;
    }
  }
  return true;
}

function fallbackCallerPaths(model, id, isNode, includePaths, excludePaths) {
  const maxNodes = 25; // 目标函数和最多 24 个上游调用者
  const maxDepth = 6;
  const matches = file => includePaths.some(prefix => fileMatchesPathPrefix(file, prefix));
  const queue = [{ id, path: [], matched: !includePaths.length || matches(fileOfNodeId(model, id)) }];
  const seenMatched = new Set([id]), seenUnmatched = new Set([id]);
  const retained = new Set([id]), roots = new Set();

  for (let qi = 0; qi < queue.length && retained.size < maxNodes; qi++) {
    const current = queue[qi];
    if (current.path.length >= maxDepth) continue;
    const path = [current, ...current.path];
    for (const edge of model._index.inAdj.get(current.id) || []) {
      const caller = edge.from;
      if (edge.kind === 'var' || edge.headerReference || !isNode(caller) || overlay.deleted.edges[edgeKeyOf(edge)]) continue;
      const file = fileOfNodeId(model, caller);
      if (excludePaths.some(prefix => fileMatchesPathPrefix(file, prefix))) continue;
      const matched = current.matched || matches(file);
      const seen = matched ? seenMatched : seenUnmatched;
      if (seen.has(caller) || path.some(step => step.id === caller)) continue;
      const next = { id: caller, path, matched };
      if (matched) {
        // 只有完整链路命中所选目录后才占用名额，共通中间函数随链路一起保留。
        const newNodes = Number(!retained.has(caller)) + path.filter(step => !retained.has(step.id)).length;
        if (retained.size + newNodes > maxNodes) continue;
        retained.add(caller);
        for (const step of path) {
          retained.add(step.id);
          roots.delete(step);
        }
        roots.add(next);
      }
      seen.add(caller);
      queue.push(next);
      if (retained.size === maxNodes) break;
    }
  }
  return [...roots].map(root => [root.id, ...root.path.map(step => step.id)]);
}

function collectNewlyReferencedVarsAndSources(gitModel, liveModel, fnIds, hidden, pathFilter) {
  const functions = new Set(fnIds);
  const refs = new Map();
  const sources = new Set();
  const visible = id => !hidden[id] && liveModel._index.byId.has(id) &&
    !pathFilter?.excludePaths?.some(prefix => fileMatchesPathPrefix(fileOfNodeId(liveModel, id), prefix));
  const outgoing = gitModel?._index?.outAdj;
  const edges = outgoing ? fnIds.flatMap(id => outgoing.get(id) || []) : gitModel?.edges || [];
  for (const edge of edges) {
    if (edge.kind !== 'var' || edge.change !== 'added' || !functions.has(edge.from) || hidden[edge.from] || !visible(edge.to)) continue;
    if (!refs.has(edge.to)) {
      const { id, name, file, line } = liveModel._index.byId.get(edge.to);
      refs.set(id, { id, name, file, line, via: edge.via, usedBy: [], writers: [] });
    }
    const ref = refs.get(edge.to);
    if (ref.via !== edge.via) ref.via = '读写';
    if (!ref.usedBy.includes(edge.from)) ref.usedBy.push(edge.from);
  }
  for (const ref of refs.values()) {
    const writers = liveModel._df?.writers?.get(ref.id) ?? (gitModel._index?.inAdj?.get(ref.id) ?? gitModel.edges)
      .filter(e => e.to === ref.id && e.kind === 'var' && e.change !== 'deleted' && ['写', '读写'].includes(e.via)).map(e => e.from);
    for (const id of writers) {
      if (!visible(id) || functions.has(id) || ref.writers.includes(id)) continue;
      if (!sources.has(id) && sources.size >= 18) continue;
      sources.add(id);
      ref.writers.push(id);
      if (ref.writers.length === 6) break;
    }
  }
  return { varIds: [...refs.keys()], sourceWriterIds: [...sources], newlyReferencedVars: [...refs.values()] };
}

function changedFunctionScope(model, comparison, changes, isNode, pathFilter = null, { fallbackCallers = false } = {}) {
  const taskRoots = new Set(), functionIds = new Set(changes), variableIds = new Set();
  const untracedIds = [], untracedVersions = [], omittedRelationTargets = new Set();
  const includePaths = normalizePathPrefixes(pathFilter?.includePaths);
  const excludePaths = normalizePathPrefixes(pathFilter?.excludePaths);
  const targetSet = new Set(changes);
  const sides = comparison
    ? [['after', comparison.afterModel], ['before', comparison.beforeModel]]
    : [['current', model]];
  for (const id of new Set(changes)) {
    let reached = false;
    // 两侧独立寻路。比较图中存在的边可能分属不同版本。
    for (const [version, side] of sides) {
      if (!side._index.byId.has(id)) continue;
      const trace = traceToTasks(side, id, { limit: 81 });
      if (trace.traceTruncated) throw new Error('入口过多，请按版本分页选链，分批传 functionIds 和 changedFunctionIds: []');
      if (!trace.totalTasks) untracedVersions.push({ id, version });
      for (const chain of trace.upstreamChains) {
        if ((includePaths.length || excludePaths.length) &&
            !chainMatchesPathFilters(side, chain, targetSet, includePaths, excludePaths)) {
          continue;
        }
        reached = true;
        taskRoots.add(chain.taskId);
        for (const fn of chain.path) {
          if (!isNode(fn)) throw new Error('入口路径包含已隐藏或无效的函数：' + fn);
          functionIds.add(fn);
        }
        const hidden = chain.edges.find(edge => overlay.deleted.edges[edge.edgeKey]);
        if (hidden) throw new Error('入口路径包含已隐藏的调用线：' + hidden.edgeKey);
      }
      // AI 组图场景：若修改函数的上游没有正式 TASK/ISR 入口，自动沿直接调用关系回溯上级调用者（最多 6 层），避免只放孤立叶子函数。
      if (fallbackCallers && !reached) {
        for (const chainPath of fallbackCallerPaths(side, id, isNode, includePaths, excludePaths)) {
          reached = true;
          taskRoots.add(chainPath[0]);
          for (const fn of chainPath) functionIds.add(fn);
        }
      }
    }
    if (!reached) untracedIds.push(id);
    if (!comparison) continue;
    for (const adjacency of [model._index.inAdj, model._index.outAdj]) {
      for (const edge of adjacency.get(id) || []) {
        if (edge.change !== 'added' && edge.change !== 'deleted') continue;
        const other = edge.from === id ? edge.to : edge.from;
        if (excludePaths.length && excludePaths.some((p) => fileMatchesPathPrefix(fileOfNodeId(model, other), p))) continue;
        if (!isNode(other) || overlay.deleted.edges[edgeKeyOf(edge)]) omittedRelationTargets.add(other);
        else if (model._index.byId.get(other).kind === 'var') variableIds.add(other);
        else functionIds.add(other);
      }
    }
  }
  return { taskRoots, functionIds, variableIds,
    details: { untracedIds, untracedVersions, omittedRelationTargets: [...omittedRelationTargets] } };
}

function composeMcpView(p, { chatClientId } = {}) {
  // 所有检查在切换画布前完成，失败时不改变工程、预览或时间轴。
  const comparison = p.snapshotId === undefined ? COMPARISON : getMcpChangeSnapshot(p.snapshotId).comparison;
  const entering = comparison && !COMPARISON;
  const switchingComparison = comparison && comparison !== COMPARISON;
  if (entering && p.mode !== 'replace') throw new Error('首次按 Git 快照组图请使用 replace 打开比较');
  if (switchingComparison && !comparison.model) throw new Error('该 Git 快照没有源码变更');
  const model = comparison?.model || MODEL;
  const sourceOverlay = switchingComparison ? comparisonBase?.overlay ?? overlay : overlay;
  const isNode = (id) => typeof id === 'string' && !id.startsWith('ext::') &&
    !model._index.byId.get(id)?.external && !sourceOverlay.deleted.nodes[id] && model._index.byId.has(id);
  const isFn = (id) => {
    const node = model._index.byId.get(id);
    return isNode(id) && node.kind !== 'var' && !node.headerSymbol;
  };
  const ids = (value, key) => {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
      throw new Error(`${key} 必须是函数或变量 ID 数组`);
    }
    return value;
  };
  const { mode, up = 0, selected = null } = p;
  let roots = ids(p.roots === undefined ? [] : p.roots, 'roots');
  let functions = ids(p.functionIds === undefined ? [] : p.functionIds, 'functionIds');
  const changes = p.changedFunctionIds === undefined
    ? [...roots, ...functions].filter(id => ['modified', 'added', 'deleted'].includes(
      comparison ? model._index.byId.get(id)?.change : overlay.nodes[id]?.change))
    : ids(p.changedFunctionIds, 'changedFunctionIds');
  const down = p.down ?? (p.functionIds === undefined && !changes.length ? 1 : 0);
  let vars = ids(p.vars === undefined ? [] : p.vars, 'vars');
  if (!['replace', 'add'].includes(mode)) throw new Error('mode 必须是 replace 或 add');
  if (roots.length + functions.length + (p.changedFunctionIds?.length || 0) > 80 || !roots.length && !functions.length && !changes.length) {
    throw new Error('每次提交 1–80 个函数，请筛选核心调用链');
  }
  if (![up, down].every((n) => Number.isInteger(n) && n >= 0 && n <= 5)) {
    throw new Error('up 和 down 必须是 0–5 的整数');
  }
  if (p.reason !== undefined && (typeof p.reason !== 'string' || p.reason.length > 240)) {
    throw new Error('reason 必须是最多 240 字的文字');
  }
  const invalid = new Set([
    ...[...roots, ...functions, ...changes].filter((id) => !isFn(id)),
    ...vars.filter((id) => !isNode(id) || model._index.byId.get(id).kind !== 'var'),
    ...(p.selected !== undefined && !isNode(selected) ? [selected] : []),
  ]);
  if (invalid.size) throw Object.assign(new Error(`以下 ID 无效、类型不符、为外部节点或已隐藏：${[...invalid].join('、')}`),
    { invalidIds: [...invalid] });

  const pathFilter = (p.includePaths?.length || p.excludePaths?.length)
    ? { includePaths: p.includePaths, excludePaths: p.excludePaths }
    : null;
  const scope = changedFunctionScope(model, comparison, changes, isNode, pathFilter, { fallbackCallers: Boolean(p.fallbackCallers) });
  if (changes.length) {
    roots = [...new Set([...scope.taskRoots, ...roots])];
    const rootSet = new Set(roots);
    functions = [...new Set([...functions, ...scope.functionIds])].filter(id => !rootSet.has(id));
    if (roots.length + functions.length > 80) throw new Error('入口路径与变更关系涉及超过 80 个函数，请分批选链，显式传 changedFunctionIds: [] 与所选 functionIds');
    vars = [...new Set([...vars, ...scope.variableIds])];
  }
  const key = savedViewKey();
  const before = latestPage();
  let prior = mode === 'add' ? before : null;
  if (prior && switchingComparison) {
    prior = {
      ...before,
      roots: (before.roots || []).filter(isNode),
      expansions: (before.expansions || []).filter(({ root }) => isNode(root)),
      vars: (before.vars || []).filter(isNode),
      hiddenVars: (before.hiddenVars || []).filter(isNode),
      selected: isNode(before.selected) ? before.selected : null,
    };
  }
  const keepRoots = Boolean(prior?.roots?.length);
  const allRoots = keepRoots ? prior.roots : [...new Set(roots)];
  if (!allRoots.length) allRoots.push(functions[0]);
  // 保留画布入口和全局深度，追加入口用各自的局部深度。
  const existing = new Set([...allRoots, ...(prior?.expansions || []).map(scope => scope.root)]);
  const addedScopes = keepRoots ? [...new Set(roots)].filter(root => !existing.has(root)).map(root => ({ root, up, down })) : [];
  const expansions = normalizeExpansions([
    ...(prior?.expansions || []), ...addedScopes,
    ...[...(keepRoots ? [] : allRoots.slice(1)), ...functions].map((root) => ({ root, up: 0, down: 0 })),
  ]);
  const page = {
    projectId: PROJECT.id, roots: allRoots, expansions,
    up: keepRoots ? prior.up : roots.length ? up : 0,
    down: keepRoots ? prior.down : roots.length ? down : 0,
    group: before?.group ?? true,
    groupMode: resolveGroupMode(before?.groupMode, before?.group),
    vars: [...new Set([...(prior?.vars || []), ...vars])],
    hiddenVars: (prior?.hiddenVars || []).filter((id) => !vars.includes(id)),
    selected: selected ?? prior?.selected ?? null,
    selectedEdge: null, ctxBox: null, cam: prior?.cam ?? null, at: 0, reviewing: false, ts: Date.now(),
  };
  const reason = p.reason?.trim() ?? '';
  if (comparison) {
    const visible = [...new Set([...allRoots, ...expansions.map(scope => scope.root), ...page.vars])];
    if (visible.length > 600) throw new Error('比较画布最多支持 600 个显式选择的节点');
    if (switchingComparison) {
      const nextStats = stats(model);
      const nextOverlay = structuredClone(sourceOverlay);
      const next = { ...comparison, id: p.snapshotId, statusOverrides: { nodes: new Map(), edges: new Map() }, totalNodes: model._index.byId.size };
      comparisonBase ??= { MODEL, S, overlay, pageState };
      COMPARISON = next;
      MODEL = model;
      S = nextStats;
      overlay = nextOverlay;
      comparisonPreview = null;
      sessionRevision++;
    }
    page.comparisonId = COMPARISON.id;
    page.revision = (COMPARISON.composedPage?.revision ?? 0) + 1;
    COMPARISON.roots = visible;
    COMPARISON.composedPage = page;
    pageState = page;
    broadcastChange(switchingComparison ? 'project.switch' : 'view.compose', 'ai', {
      project: PROJECT.name, projectId: PROJECT.id, page, reason, ...(switchingComparison && chatClientId ? { chatClientId } : {}),
    });
    return { ok: true, page, ...scope.details, eventId: null };
  }
  store.transaction(() => {
    page.revision = store.appendEvent(PROJECT.id, {
      op: 'view.compose', actor: 'ai', target: roots[0] || functions[0], before,
      after: { ...page, count: roots.length + functions.length, rootCount: roots.length, reason, view: viewSnapshot(page) },
    });
    store.setSetting(key, page);
  });
  const review = reviewWriteResult();
  if (!review.updatedWhileReviewing) pageState = page;
  broadcastChange('view.compose', 'ai', { page, reason });
  return { ok: true, page, ...scope.details, ...review, eventId: page.revision };
}

function applyMcpTaskLabels({ items, merge = true }) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 200 || typeof merge !== 'boolean') {
    throw new Error('items 需要 1–200 条标签，merge 必须是布尔值');
  }
  const index = mcpEdgeIndex();
  const updates = new Map();
  const presetsByEdge = new Map();
  const occupied = Object.values(overlay.edges).flatMap((o) => normalizeLabels(o.labels ?? o.label));
  for (const item of items) {
    const edge = index.resolve(item?.edgeKey);
    if (!edge) throw new Error(`找不到实际连线：${item?.edgeKey}`);
    const label = normalizeAiLabel(item);
    const key = annotationEdgeKey(overlay.edges, edge, MODEL);
    if (!updates.has(key)) {
      const current = overlay.edges[key];
      updates.set(key, merge ? normalizeLabels(current?.labels ?? current?.label) : []);
      presetsByEdge.set(key, new Set());
    }
    const touched = presetsByEdge.get(key);
    if (touched.has(label.preset)) throw new Error(`同一连线不得重复提交 ${label.preset} 标签：${key}`);
    touched.add(label.preset);
    const labels = updates.get(key);
    const current = overlay.edges[key];
    const old = normalizeLabels(current?.labels ?? current?.label).find((entry) => entry.preset === label.preset);
    const replacement = { ...label, id: old?.id, dx: old?.dx, dy: old?.dy };
    if (label.preset === 'conn') replacement.num = old?.num ?? nextConnNumber(occupied);
    const next = normalizeLabel(replacement);
    occupied.push(next);
    const position = labels.findIndex((entry) => entry.preset === label.preset);
    const remaining = labels.filter((entry) => entry.preset !== label.preset);
    remaining.splice(position < 0 ? remaining.length : position, 0, next);
    updates.set(key, remaining);
  }
  for (const [key, labels] of updates) {
    if (labels.length > LABELS_MAX) throw new Error(`一条连线最多 ${LABELS_MAX} 条标签：${key}`);
    updates.set(key, normalizeLabels(labels));
  }
  checkAiCallOrders(index, updates);
  const stored = store.transaction(() => [...updates].map(([target, labels]) => {
    const after = { labels, label: null };
    const annotation = writeAnnotation('edge', target, after, 'ai');
    return [target, annotation];
  }).filter(([, annotation]) => annotation));
  for (const [target, annotation] of stored) overlay.edges[target] = annotation;
  if (stored.length) broadcastChange('labels.apply', 'ai', { edgeKeys: stored.map(([target]) => target), projectId: PROJECT.id });
  return { ok: true, edgeKeys: [...updates.keys()] };
}

/**
 * 函数/变量框自定义底色的白名单：就是 CHANGE_FILL 的四个值
 * （既存/変更/追加/削除；渲染副本在 web/lib/state.js 与 src/core/export-svg.js，改这里时同步）。
 * 框色是既定的颜色规则，外部写入（MCP / 脚本）不允许引入规则外的颜色。
 */
const NODE_COLORS = ['#CCFFCC', '#FFFF99', '#FFCCFF', '#BFBFBF'];

/** 命中白名单则归一成大写返回，否则 null */
function matchNodeColor(v) {
  if (typeof v !== 'string') return null;
  return NODE_COLORS.find((x) => x.toLowerCase() === v.trim().toLowerCase()) || null;
}

function buildFileTree(model) {
  const root = { name: ROOT_LABEL, type: 'dir', path: '', children: new Map() };
  const fileNodes = new Map();
  const symbols = [...model.functions, ...(model.headerSymbols || [])];
  const files = new Set([...model.files.map((f) => f.rel), ...symbols.map((n) => n.file)]);
  for (const rel of files) {
    const parts = String(rel).split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isFile = i === parts.length - 1;
      if (!cur.children.has(name)) {
        cur.children.set(name, {
          name,
          type: isFile ? 'file' : 'dir',
          path: parts.slice(0, i + 1).join('/'),
          children: isFile ? null : new Map(),
          functions: isFile ? [] : undefined,
        });
      }
      cur = cur.children.get(name);
      if (isFile) fileNodes.set(rel, cur);
    }
  }
  for (const fn of symbols) {
    fileNodes.get(fn.file)?.functions.push({ id: fn.id, name: fn.name, line: fn.line, ...(fn.manual ? { manual: true } : {}) });
  }
  const toObj = (n) => ({
    name: n.name,
    type: n.type,
    path: n.path,
    functions: n.functions,
    children: n.children ? [...n.children.values()].map(toObj) : undefined,
  });
  return toObj(root);
}

const MIME = {  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const json = (res, obj, code = 200) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
};

const bad = (res, msg) => json(res, { ok: false, error: msg }, 400);

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * 书签事件的载荷：把一份书签摊平成「能完整重建它」的最小集合。
 * 时间轴的 before/after 都用它——漏字段的话事件就是有损的，
 * 以后想「恢复到删掉书签之前」会还原出一个缺深度 / vars 的残本。
 */
const bookmarkEventPayload = (b) => ({
  name: b.name,
  roots: b.roots || [],
  up: b.up,
  down: b.down,
  group: !!b.group,
  ...(b.groupMode === 'period' && { groupMode: b.groupMode }),
  vars: b.vars || [],
  expansions: b.expansions || [],
});

function saveBookmarkWithEvent(data, actor = 'user') {
  return store.transaction(() => {
    const prev = store.findBookmark(PROJECT.id, data.name);
    const result = store.saveBookmark(PROJECT.id, data);
    store.appendEvent(PROJECT.id, {
      op: 'bookmark.save', actor, target: result.bookmark.name,
      before: prev ? bookmarkEventPayload(prev) : null,
      after: bookmarkEventPayload(result.bookmark),
    });
    return result;
  });
}

/** 本机来源白名单：Electron / 浏览器都用 127.0.0.1 或 localhost 打开 */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * 写接口守卫：拒绝跨站来源与非 JSON 请求。
 * Origin 为空时放行（curl、同源导航不带 Origin）；跨站带 application/json 的请求
 * 会先触发预检，这里不回应预检，浏览器侧根本发不出来，415 再兜住 text/plain 表单提交。
 */
/** 全局配置写守卫（如 AI API 配置）：校验本机来源与 JSON 类型，不因工程切换/AI 刷新锁死全局配置保存。 */
function guardLocalJson(req, res) {
  const origin = req.headers.origin;
  if (origin && !LOCAL_ORIGIN.test(origin)) {
    json(res, { ok: false, error: 'forbidden origin' }, 403);
    return false;
  }
  const type = String(req.headers['content-type'] || '')
    .split(';')[0]
    .trim()
    .toLowerCase();
  if (type !== 'application/json') {
    json(res, { ok: false, error: 'unsupported media type' }, 415);
    return false;
  }
  return true;
}

function guardWrite(req, res) {
  if (!guardLocalJson(req, res)) return false;
  if (!currentSession(req) || (req.headers['x-callgraph-project'] !== undefined &&
      Number(req.headers['x-callgraph-project']) !== PROJECT.id)) {
    json(res, { ok: false, error: '工程正在切换或请求所属工程已改变，请刷新后重试' }, 409);
    return false;
  }
  return true;
}

function currentSession(req, allowSwitch = false) {
  const expected = req.headers['x-callgraph-session'];
  return req.sessionRevision === sessionRevision &&
    (expected === undefined || Number(expected) === sessionRevision) && (!switching || allowSwitch);
}

function sessionConflict(res) {
  return json(res, { ok: false, error: '工程已切换，请刷新后重试' }, 409);
}

function responseSignal(res) {
  const controller = new AbortController();
  const closed = () => { if (!res.writableEnded) controller.abort(); };
  if (res.destroyed) closed();
  else res.once('close', closed);
  return controller.signal;
}

/**
 * 读取 JSON body：Buffer 分片收集（多字节字符不会跨片被截断）+ 体积上限 + 顶层结构校验。
 * 失败时响应已写好，调用方只需 catch 掉拒绝。
 */
function readJson(req, res, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (code, msg, drain = false) => {
      if (done) return;
      done = true;
      json(res, { ok: false, error: msg }, code);
      if (drain) {
        // 继续排空入站数据再断开：带着未读数据直接 destroy 会发 RST，客户端可能收不到 413
        req.resume();
        const timer = setTimeout(() => req.destroy(), 2000);
        timer.unref?.();
        req.on('end', () => {
          clearTimeout(timer);
          if (!req.destroyed) req.destroy();
        });
      }
      reject(new Error(msg));
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) return fail(413, '请求体过大', true);
      chunks.push(c);
    });
    req.on('error', () => fail(400, '读取请求体失败'));
    req.on('aborted', () => fail(400, '请求已中断'));
    req.on('end', () => {
      if (done) return;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail(400, 'body 不是合法 JSON');
      }
      if (!isPlainObject(parsed)) return fail(400, 'body 必须是 JSON 对象');
      if (!currentSession(req, req.switchRequest)) {
        return fail(409, '工程已切换，请刷新后重试');
      }
      done = true;
      resolve(parsed);
    });
  });
}

/**
 * 流式回传文件：打开失败时若还没发头就回 500，已发头则直接断开，
 * 避免 ReadStream 的 error 事件没人接导致进程退出。
 */
function sendFile(res, file, headers) {
  const rs = fs.createReadStream(file);
  rs.on('error', (err) => {
    console.error(`[文件] 读取失败 ${file}:`, err.message);
    if (!res.headersSent) json(res, { ok: false, error: '文件读取失败' }, 500);
    else res.destroy();
  });
  rs.once('open', () => {
    res.writeHead(200, headers);
    rs.pipe(res);
  });
  res.on('close', () => rs.destroy());
}

/**
 * 布局存档按「入口函数 + 布局模式」隔离。
 * 不同入口的子图节点集合与文件框位置完全不同，绝对坐标不可跨视图复用，
 * 否则会出现函数节点脱离所属文件框、散落到框外的问题。
 */
const layoutKey = (rootId, mode) => `${rootId || ''}::${mode}`;

// 旧存档的外部占位节点若已有真实定义，优先绑定到生产源码。
function remapLegacyExt(id, model) {
  if (typeof id !== 'string' || !id.startsWith('ext::')) return id;
  const list = model._index?.byName?.get(id.slice(5));
  if (!list?.length) return null;
  const prod = list.find((f) => !/(^|\/)(tests?|unit|stubs?|mocks?|host|sim)(\/|_|-)/i.test(f.file));
  return (prod || list[0]).id;
}

const remapLayoutRoot = (root, model) => root.split('+').map((id) => remapLegacyExt(id, model) ?? id).join('+');

function legacyManualKeys(layout, root, mode, model) {
  const suffix = `::${mode}`;
  const canonicalKey = layoutKey(root, mode);
  return Object.keys(layout).filter((key) => key !== canonicalKey && key.endsWith(suffix) &&
    layout[key]?.manual?.length && layoutKey(remapLayoutRoot(key.slice(0, -suffix.length), model), mode) === canonicalKey);
}

const CALL_KINDS = new Set(['direct', 'macro', 'fnptr']);

function previewRecommendations(root, model, comparison, hiddenNodes, nodes, edges) {
  const sourceModel = comparison ? (comparison.afterModel._index.byId.has(root)
    ? comparison.afterModel : comparison.beforeModel) : model;
  const periods = taskPeriods(sourceModel);
  const { byId, inAdj, outAdj } = sourceModel._index;
  const nodeInfo = (id) => {
    const fn = byId.get(id);
    return fn ? { id, name: fn.name, file: fn.file, line: fn.line } : { id, name: id };
  };
  const candidate = (id) => ({ ...nodeInfo(id), taskPeriods: periods.get(id) || [] });
  // 预览只附第一页，入口较多时通过 trace-to-task 续查完整路径。
  const trace = traceToTasks(sourceModel, root);
  const taskChains = trace.upstreamChains.flatMap(({ path, taskId }, i) => {
    const task = trace.upstreamTasks[i];
    const nodes = path.map(nodeInfo);
    return task.periods.map(({ us, source }) => ({ taskId, taskName: task.name, us, source, path, nodes }));
  });
  const isRealFn = (id) => !id.startsWith('ext::') && !byId.get(id)?.external;
  const directCalls = (outAdj.get(root) || []).filter(e => CALL_KINDS.has(e.kind) && isRealFn(e.to));
  const numbers = callNumbers(callSequence(sourceModel, root));
  const callees = [...new Set(directCalls.map(e => e.to))].map(id => ({
    ...candidate(id), callNumbers: numbers.get(id) || [],
  })).sort((a, b) => (parseInt(a.callNumbers[0], 10) || Infinity) - (parseInt(b.callNumbers[0], 10) || Infinity));
  const callers = [...new Set((inAdj.get(root) || []).filter(e => CALL_KINDS.has(e.kind) && isRealFn(e.from)).map(e => e.from))].slice(0, 8);
  const siblings = callers.flatMap(callerId => {
    const orders = callNumbers(callSequence(sourceModel, callerId));
    const target = orders.get(root);
    if (!target?.length) return [];
    return [...orders].filter(([id]) => id !== root && isRealFn(id)).map(([id, callNumbers]) => {
      const position = parseInt(callNumbers.at(-1), 10) < parseInt(target[0], 10) ? 'before'
        : parseInt(callNumbers[0], 10) > parseInt(target.at(-1), 10) ? 'after' : 'same';
      return { ...candidate(id), callerId, callerName: nodeInfo(callerId).name, callNumbers, position };
    });
  });
  return {
    target: { id: root, name: model._index.byId.get(root)?.name || root, taskPeriods: periods.get(root) || [] },
    taskChains, taskChainTotal: trace.totalTasks, taskChainNextOffset: trace.nextOffset,
    callSequence: { callees, siblings }, hiddenIds: Object.keys(hiddenNodes),
    // 周边建议沿用预览节点与边的精简协议，周期和序号单独返回。
    relatedPeriods: nodes.filter(node => periods.has(node.id)).map(node => [node.id, periods.get(node.id)]),
    edgeOrders: edges.map(callOrderForEdges(model, comparison)),
  };
}

function callOrderForEdges(model, comparison, visibleNodes = null) {
  const orders = new Map();
  return (e) => {
    if (!CALL_KINDS.has(e.kind) || e.headerReference) return undefined;
    const version = comparison && !e.versions?.includes('after') ? 'before' : 'after';
    const orderKey = version + ':' + e.from;
    if (!orders.has(orderKey)) {
      const source = comparison ? comparison[version + 'Model'] : model;
      orders.set(orderKey, callNumbers(callSequence(source, e.from), visibleNodes));
    }
    return orders.get(orderKey).get(e.to);
  };
}

async function buildView(
  rootIds,
  up,
  down,
  group = true,
  dfNode = null,
  varSel = {},
  // 时间轴回看时传历史 overlay：视图构建逻辑完全复用，只是输入换了一份
  viewOverlay = overlay,
  previous = null
) {
  const projectId = PROJECT.id;
  const revision = sessionRevision;
  const model = MODEL;
  const assertCurrent = () => {
    if (revision !== sessionRevision) throw new Error('工程已切换，请刷新后重试');
  };
  const layoutElk = (...args) => analysisJob('layout', () => args, { signal: varSel.signal });
  const requestedRoots = Array.isArray(rootIds) ? rootIds : rootIds ? [rootIds] : [];
  const mustAnalyzeForView = Boolean(varSel.want?.length || dfNode || requestedRoots.some((id) => id?.startsWith('var::')));
  const needCounter = Boolean((requestedRoots.length || varSel.expansions?.length) && needsCounterAnalysis(model));
  if (!COMPARISON && (mustAnalyzeForView || (needCounter && (varSel.groupMode === 'period' || (model.files?.length || 0) <= 40)))) {
    await ensureAnalysis(model);
    assertCurrent();
  } else if (!COMPARISON && needCounter && !model._df) {
    // 大工程首帧恢复普通视图时异步预热全工程数据流分析，避免冷启动卡顿数秒。
    void ensureAnalysis(model).catch(() => {});
  }
  // 多个入口各自取子图，并将旧占位入口迁移为工程内定义。
  const roots = requestedRoots.map((id) => remapLegacyExt(id, model)).filter(Boolean);
  const perRoot = Math.max(120, Math.floor(600 / Math.max(1, roots.length)));
  const nodeMap = new Map();
  const edgeList = [];
  const seenEdge = new Set();
  let truncated = false;
  const cleanExpansions = normalizeExpansions((varSel.expansions || [])
    .map((s) => ({ ...s, root: remapLegacyExt(s.root, model) }))
    .filter((s) => model._index.byId.has(s.root) && model._index.byId.get(s.root).kind !== 'var'));
  const scopes = [...roots.map((root) => ({ root, up, down })), ...cleanExpansions];
  for (const scope of scopes) {
    const part = subgraph(model, scope.root, { up: scope.up, down: scope.down,
      maxNodes: perRoot, includeVariables: !!COMPARISON });
    truncated ||= part.truncated;
    for (const n of part.nodes) if (!nodeMap.has(n.id)) nodeMap.set(n.id, n);
    for (const e of part.edges) {
      const k = `${e.from}|${e.to}|${e.line}|${e.kind}`;
      if (seenEdge.has(k)) continue;
      seenEdge.add(k);
      edgeList.push(e);
    }
  }
  const g = {
    root: roots[0] || null,
    roots,
    nodes: [...nodeMap.values()],
    edges: edgeList,
  };
  const recommendations = (nodes, edges) => g.root ? {
    recommendations: previewRecommendations(g.root, model, COMPARISON, viewOverlay.deleted.nodes, nodes, edges),
  } : {};
  // 局部范围补当前已显示节点之间的关系，不带入邻接函数。
  const allowedIds = new Set(nodeMap.keys());
  for (const scope of cleanExpansions) {
    const part = subgraph(model, scope.root, { up: 1, down: 1, maxNodes: 600, includeVariables: !!COMPARISON, allowedIds });
    for (const e of part.edges) {
      const k = `${e.from}|${e.to}|${e.line}|${e.kind}`;
      if (!seenEdge.has(k)) { seenEdge.add(k); edgeList.push(e); }
    }
  }
  truncated ||= g.nodes.length > 600;
  if (g.nodes.length > 600) {
    g.nodes = g.nodes.slice(0, 600);
  }
  // 过滤用户删掉的函数与连线。文件框 / 目录容器是从节点推导出来的，
  // 所以某个文件或目录里的函数被删空时，对应层级会自动消失
  const wantVars = new Set(varSel.want || []);
  const skipVars = new Set(varSel.skip || []);

  let alive = g.nodes.filter((n) => !viewOverlay.deleted.nodes[n.id] &&
    !(viewOverlay !== overlay && n.manual && !viewOverlay.manualNodes?.[n.id]));
  // 时间轴回看：补回当时存在但后来被永久删除的手工函数
  if (viewOverlay !== overlay && viewOverlay.manualNodes) {
    const presentIds = new Set(alive.map((n) => n.id));
    const wantedIds = new Set([...roots, ...(varSel.expansions || []).map((s) => s.root)]);
    for (const [id, entry] of Object.entries(viewOverlay.manualNodes)) {
      if (entry.kind !== 'fn' || !wantedIds.has(id) || presentIds.has(id) || viewOverlay.deleted.nodes[id]) continue;
      alive.push(toManualModelNode(entry));
      presentIds.add(id);
    }
  }
  // 右侧面板里被取消勾选的全局变量：连节点带边一起去掉
  if (skipVars.size) alive = alive.filter((n) => !(n.kind === 'var' && skipVars.has(n.id)));
  const aliveIds = new Set(alive.map((n) => n.id));
  let viewEdges = g.edges.filter(
    (e) =>
      aliveIds.has(e.from) &&
      aliveIds.has(e.to) &&
      !viewOverlay.deleted.edges[edgeKeyOf(e)] &&
      !(e.kind === 'var' && (skipVars.has(e.to) || skipVars.has(e.from)))
  );
  let clean = alive.map(({ bodyTokens, ...rest }) => rest);
  // 右侧面板里勾选的全局变量：补节点 + 视图内函数对它的引用边
  if (wantVars.size) {
    const ids = new Set(clean.map((n) => n.id));
    const df = model._df;
    for (const id of wantVars) {
      if (ids.has(id) || skipVars.has(id) || viewOverlay.deleted.nodes[id]) continue;
      const indexed = model._index.byId.get(id);
      const histManual = viewOverlay !== overlay ? viewOverlay.manualNodes?.[id] : null;
      const rawDef = df?.byId.get(id) || (indexed?.kind === 'var' ? indexed : null);
      const def = (viewOverlay !== overlay && rawDef?.manual && !histManual)
        ? null
        : rawDef || (histManual?.kind === 'var' ? toManualModelNode(histManual) : null);
      if (!def) continue;
      clean.push({
        ...(COMPARISON ? def : {}),
        id,
        name: def.name,
        kind: 'var',
        file: def.file,
        line: def.line,
        typeText: def.typeText,
        isStatic: !!def.isStatic,
        isConst: !!def.isConst,
        ...(def.manual ? { manual: true } : {}),
        params: [],
      });
      ids.add(id);
    }
    // 引用关系：视图内的函数 → 该变量（AST 索引里记着每个变量的写者/读者）
    const seen = new Set(viewEdges.filter((e) => e.kind === 'var').map((e) => `${e.from}|${e.to}`));
    const varEdgeOf = new Map(); // fnId|varId → edge，读写合并成一条
    const pushVarEdge = (fnId, varId, via) => {
      if (!ids.has(fnId) || !ids.has(varId)) return;
      const k = `${fnId}|${varId}`;
      const prev = varEdgeOf.get(k);
      if (prev) {
        if (prev.via !== via) prev.via = '读写';
        return;
      }
      if (seen.has(k)) return;
      seen.add(k);
      const def = (df && df.byId.get(varId)) || model._index.byId.get(varId);
      const edge = {
        from: fnId,
        to: varId,
        callee: def ? def.name : varId,
        kind: 'var',
        line: 0,
        via,
      };
      varEdgeOf.set(k, edge);
      viewEdges.push(edge);
    };
    if (df) {
      for (const id of wantVars) {
        for (const fnId of df.writers.get(id) || []) pushVarEdge(fnId, id, '写');
        for (const fnId of df.readers.get(id) || []) pushVarEdge(fnId, id, '读');
      }
    } else {
      for (const e of model.edges) {
        if (e.kind !== 'var' || !wantVars.has(e.to)) continue;
        pushVarEdge(e.from, e.to, e.via || '变量');
      }
    }
  }

  if (!clean.length) {
    if (varSel.preview) return { nodes: [], edges: [], projectId, truncated, ...recommendations([], []),
      ...(COMPARISON ? { comparison: comparisonInfo() } : {}) };
    const groupMode = varSel.groupMode || (group ? 'file' : 'flat');
    const emptyLayout = previous ? await layoutElk([], [], { group, groupMode, rootLabel: ROOT_LABEL, previous })
      : emptyCanvasView(groupMode);
    assertCurrent();
    return { ...emptyLayout, root: g.root, roots, groupMode,
      empty: true, projectId, expansions: cleanExpansions, comparison: COMPARISON ? { ...comparisonInfo(), shownNodes: 0, truncated } : null };
  }

  // 数据流（按需展开）：把相关的函数也拉进视图，否则只有连线看不到两端
  if (dfNode) {
    const flows = dataflowOf(model, dfNode);
    const ids = new Set(clean.map((n) => n.id));
    for (const f of flows) {
      for (const id of [f.from, f.to]) {
        if (ids.has(id) || viewOverlay.deleted.nodes[id]) continue;
        const fn = model._index.byId.get(id);
        if (!fn) continue;
        const { bodyTokens, ...rest } = fn;
        clean.push(rest);
        ids.add(id);
      }
    }
    for (const f of flows) {
      if (!ids.has(f.from) || !ids.has(f.to)) continue;
      viewEdges.push({
        from: f.from,
        to: f.to,
        callee: f.varName,
        kind: 'dataflow',
        line: 0,
        via: f.varName,
      });
    }
  }

  // 只恢复手工关系，旧固定坐标和折线不再参与排版。
  const mode = group ? 'group' : 'flat';
  const layout = viewOverlay.layout || {};
  const layoutRoot = roots.join('+');
  const manual = layout[layoutKey(layoutRoot, mode)]?.manual;
  const byId = new Map(clean.map((n) => [n.id, n]));
  // 比较模式的 roots 是「保留+选中」的合集，和存手工关系时的原视图槽位键对不上；
  // 改为从全部槽位按「两端都在当前图上」找回，按端点对去重，保证手工关系仍可见。
  const manualPool = COMPARISON
    ? Object.values(layout).flatMap((s) => s?.manual || [])
    : manual?.length ? manual : legacyManualKeys(layout, layoutRoot, mode, model).flatMap((key) => layout[key].manual);
  const seenManual = new Set();
  for (const m of manualPool) {
    const mk = `${m.from}\u0000${m.to}`;
    if (seenManual.has(mk)) continue;
    seenManual.add(mk);
    if (!byId.has(m.from) || !byId.has(m.to) || viewOverlay.deleted.edges[edgeKeyOf({ ...m, line: 0 })]) continue;
    // 已有同向行号 0 边（如合并后的变量读写边）时不重复注入手工边，避免边键冲突。
    if (viewEdges.some((e) => e.from === m.from && e.to === m.to && e.line === 0)) continue;
    viewEdges.push({ from: m.from, to: m.to, callee: byId.get(m.to).name,
      kind: 'manual', line: 0, via: '手动', manual: true });
  }
  if (COMPARISON) {
    const ids = new Set(clean.map((n) => n.id));
    viewEdges = [...model.edges, ...(model.headerEdges || []).map((e) => ({ ...e, change: 'existing' })),
      ...viewEdges.filter((e) => e.manual)].filter((e) => ids.has(e.from) && ids.has(e.to));
  }
  viewEdges = viewEdges.filter((e) => !viewOverlay.deleted.edges[edgeKeyOf(e)])
    .map((e) => COMPARISON ? comparisonStatus(e, COMPARISON.statusOverrides.edges, e.comparisonKey || edgeKeyOf(e))
      : { ...e, change: viewOverlay.edges?.[annotationEdgeKey(viewOverlay.edges, e, model)]?.change || 'existing' });
  if (COMPARISON) clean = clean.map((n) => comparisonStatus(n, COMPARISON.statusOverrides.nodes, n.id));
  const macroNameMode = macroNameDefault();
  clean = clean.map((n) => withMacroName(n, viewOverlay, macroNameMode));
  if (varSel.preview) return {
    nodes: clean.map((n) => ({ id: n.id, name: n.name, file: n.file, line: n.line, kind: n.kind,
      ...(COMPARISON ? comparisonItem(n) : {}) })),
    edges: viewEdges.map(({ from, to, kind, line, change }) => ({ from, to, kind, line, change })),
    projectId,
    truncated,
    ...(COMPARISON ? { comparison: comparisonInfo() } : {}),
    ...recommendations(clean, viewEdges),
  };
  clean = withTaskPeriods(clean, model, COMPARISON).map(publicNode);
  const visibleNodes = new Set(clean.map((n) => n.id));
  const getCallOrder = callOrderForEdges(model, COMPARISON, visibleNodes);
  for (const e of viewEdges) {
    const numbers = getCallOrder(e);
    if (numbers) e.callNumbers = numbers;
  }
  const groupMode = varSel.groupMode || (group ? 'file' : 'flat');
  const laid = await layoutElk(clean, viewEdges, { group, groupMode, rootLabel: ROOT_LABEL, previous });
  assertCurrent();

  // 合并标注 + 变更状态
  for (const n of laid.nodes) {
    const ov = viewOverlay.nodes?.[n.id];
    if (ov) Object.assign(n, { note: ov.note, color: COMPARISON ? undefined : ov.color, tag: ov.tag });
    // 既存 / 変更 / 追加 / 削除，前端据此决定背景色与线框样式
    n.change = COMPARISON ? n.change || 'existing' : (ov && ov.change) || 'existing';
    n.kind = n.kind === 'var' ? 'var' : 'fn';
  }
  for (const e of laid.edges) {
    const ov = viewOverlay.edges?.[COMPARISON ? edgeKeyOf(e) : annotationEdgeKey(viewOverlay.edges, e, model)];
    // 原有 / 新增 / 删除
    e.change = COMPARISON ? e.change || 'existing' : (ov && ov.change) || 'existing';
    // 连线标签（一线可多条）：统一在这里规整，前端与导出拿到的都是干净数据。
    // 旧库存的是单条 label，读出来同样归成数组；e.label 保留为首条做兼容
    const labels = normalizeLabels(ov ? ov.labels ?? ov.label : null);
    if (labels.length) {
      e.labels = labels;
      e.label = labels[0];
    }
  }
  return { ...laid, root: g.root, roots, groupMode, expansions: cleanExpansions, truncated, layoutEngine: 'elk', projectId, macroNameMode,
    ...(!roots.length && !cleanExpansions.length ? { empty: true } : {}),
    comparison: COMPARISON ? { ...comparisonInfo(), shownNodes: laid.nodes.length, truncated } : null };
}

// ---- MCP（AI 访问）----
// 工具桥接到进程内 HTTP（打自己的 127.0.0.1），与 UI 走同一路径：
// 校验、事件记录、持久化全部复用，时间轴里 actor=ai 可区分 AI 改动。
const mcp = createMcpServer({
  // 端口传 0 时由系统分配，listen 之后才知道真实端口，这里必须惰性取
  baseUrl: () => `http://127.0.0.1:${server.address().port}`,
  getAccess: mcpAccess,
  writeOut: async (name, buf, expected) => {
    if (expected !== sessionRevision || switching) throw new Error('工程已切换，请重新调用');
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, name);
    fs.writeFileSync(file, buf);
    return file;
  },
});

/** /mcp 专用 body 读取：JSON-RPC 允许顶层数组（批量），不能复用只认对象的 readJson */
function readRawBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        return reject(new Error('请求体过大'));
      }
      chunks.push(c);
    });
    req.on('error', () => reject(new Error('读取请求体失败')));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

await openTarget(target, { first: true });

// 回调是 async：/mcp 端点里要 await body 读取；其他端点不受影响（同步 return 路径不变）
export const server = http.createServer(async (req, res) => {
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/i.test(req.headers.host || '')) {
    return json(res, { ok: false, error: 'forbidden host' }, 403);
  }
  // 请求体可能稍后才读完，工程身份必须在进入请求时固定。
  req.projectId = PROJECT.id;
  req.sessionRevision = sessionRevision;
  // 畸形请求目标（如 "//["）会让 new URL 抛异常，必须挡在 try 内，
  // 否则异常冒泡成未捕获异常，整个进程退出
  let u;
  try {
    u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    req.switchRequest = ['/api/switch', '/api/compare', '/api/compare/apply', '/api/compare/exit',
      '/api/parsers', '/api/parsers/diff'].includes(u.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }

  try {
    if (req.method === 'GET' && req.headers['x-callgraph-session'] !== undefined && !currentSession(req)) {
      return sessionConflict(res);
    }
    if (req.method === 'GET' && ['/api/export/xlsx', '/api/export/html'].includes(u.pathname) &&
        ((req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site')) {
      return json(res, { ok: false, error: 'forbidden origin' }, 403);
    }
    if (COMPARISON && ((req.method === 'POST' && /^\/api\/(overlay|delete|layout|orphans\/purge|bookmarks|session|restore|labels|mcp-task-labels)/.test(u.pathname)) ||
        u.pathname === '/api/session/export')) {
      return json(res, { ok: false, error: '比较视图仅供查看，请退出比较后编辑普通工程' }, 409);
    }
    // MCP Streamable HTTP 端点。无会话模式：不返回 Mcp-Session-Id，
    // 客户端每次 POST 都独立处理；GET/DELETE 没有对应的流 / 会话，统一 405。
    if (u.pathname === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
        return res.end(JSON.stringify({ error: '只支持 POST' }));
      }
      // 与其他写端点同一道守卫：拒绝跨站来源与非 JSON 请求。
      // 少了这一步，任意网页都能用 text/plain 的「简单请求」（不触发预检）跨站调用工具，
      // 在 readwrite 权限下等于把改标注 / 删节点的能力开放给整个互联网。
      if (!guardWrite(req, res)) return;
      let raw;
      try {
        raw = await readRawBody(req);
      } catch (err) {
        return json(res, { jsonrpc: '2.0', id: null, error: { code: -32700, message: String(err.message || err) } }, 400);
      }
      if (!currentSession(req)) return sessionConflict(res);
      const r = await mcp.handlePost(raw, req.projectId, req.sessionRevision);
      if (r.body === null) {
        res.writeHead(202);
        return res.end();
      }
      return json(res, r.body, r.status);
    }

    // MCP / AI 权限设置：UI 的「AI 访问」面板读写这里
    if (u.pathname === '/api/mcp-config') {
      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        return readJson(req, res)
          .then((p) => {
            if (!MCP_LEVELS.includes(p.level)) return bad(res, 'level 必须是 off / readonly / readwrite');
            // 环境变量锁定时库里照写，但运行权限不跟——让调用方能拿到明确反馈
            const env = String(process.env.CALLGRAPH_MCP || '').toLowerCase();
            if (MCP_LEVELS.includes(env)) {
              return json(res, {
                ok: false,
                error: `环境变量 CALLGRAPH_MCP=${env} 优先于界面设置，如需从界面控制请清掉该变量`,
                level: env,
                source: 'env',
              });
            }
            store.setSetting('mcp.access', p.level);
            json(res, { ok: true, level: p.level, source: 'setting' });
          })
          .catch(() => {});
      }
      const env = String(process.env.CALLGRAPH_MCP || '').toLowerCase();
      const level = mcpAccess();
      const source = MCP_LEVELS.includes(env) ? 'env' : store.getSetting('mcp.access', null) ? 'setting' : 'default';
      return json(res, { level, source });
    }

    // ---- 内置直连 OpenAI 兼容模型（本地 27B / 旧版接口均可） ----
    if (u.pathname === '/api/ai/config') {
      const saved = normalizeAiConfig({}, store.getSetting('ai.llm.config', DEFAULT_AI_CONFIG));
      if (req.method === 'POST') {
        if (!guardLocalJson(req, res)) return;
        let p;
        try { p = await readJson(req, res); } catch { return; }
        try {
          const next = normalizeAiConfig(p, saved);
          store.setSetting('ai.llm.config', next);
          return json(res, { ok: true, config: publicAiConfig(next) });
        } catch (err) {
          return bad(res, err.message);
        }
      }
      return json(res, { ok: true, config: publicAiConfig(saved) });
    }

    if (u.pathname === '/api/ai/models' && req.method === 'POST') {
      if (!guardLocalJson(req, res)) return;
      let p;
      try { p = await readJson(req, res); } catch { return; }
      try {
        const saved = normalizeAiConfig({}, store.getSetting('ai.llm.config', DEFAULT_AI_CONFIG));
        const cfg = normalizeAiConfig(p, saved);
        return json(res, await listAiModels(cfg, { signal: responseSignal(res) }));
      } catch (err) {
        return bad(res, err.message);
      }
    }

    if (u.pathname === '/api/ai/test' && req.method === 'POST') {
      if (!guardLocalJson(req, res)) return;
      let p;
      try { p = await readJson(req, res); } catch { return; }
      try {
        const saved = normalizeAiConfig({}, store.getSetting('ai.llm.config', DEFAULT_AI_CONFIG));
        const cfg = normalizeAiConfig(p, saved);
        return json(res, await testAiConnection(cfg, { signal: responseSignal(res) }));
      } catch (err) {
        return bad(res, err.message);
      }
    }

    if (u.pathname === '/api/ai/chats') {
      const chatKey = `ai.chats.${PROJECT.id}`;
      const sanitizeChats = (raw) => {
        const list = Array.isArray(raw?.threads) ? raw.threads : [];
        const threads = [];
        const seen = new Set();
        for (const item of list.slice(0, 30)) {
          if (!item || typeof item !== 'object') continue;
          const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 64) : '';
          if (!id || seen.has(id)) continue;
          seen.add(id);
          const title = String(item.title || '新对话').trim().slice(0, 80) || '新对话';
          const customTitle = Boolean(item.customTitle);
          const updatedAt = Number(item.updatedAt) || Date.now();
          const messages = (Array.isArray(item.messages) ? item.messages : []).slice(-80)
            .filter((m) => m && ['user', 'assistant'].includes(m.role))
            .map((m) => ({
              role: m.role,
              text: String(m.text || '').slice(0, 8000),
              ...(m.role === 'assistant' && Array.isArray(m.suggestions) ? { suggestions: sanitizeSuggestions(m.suggestions) } : {}),
              ...(typeof m.thinking === 'string' && m.thinking ? { thinking: m.thinking.slice(0, 4000) } : {}),
              ...(Array.isArray(m.tools) && m.tools.length ? {
                tools: m.tools.slice(0, 20).map((tl) => ({
                  name: String(tl?.name || '').slice(0, 64),
                  ok: tl?.ok !== false,
                  summary: String(tl?.summary || '').slice(0, 240),
                  ...(typeof tl?.digest === 'string' && tl.digest ? { digest: tl.digest.slice(0, 600) } : {}),
                })),
              } : {}),
              ...(Array.isArray(m.questionOptions) && m.questionOptions.length ? {
                questionOptions: m.questionOptions.slice(0, 8).map((opt) => ({
                  label: String(opt?.label || '').slice(0, 120),
                  ...(opt?.description ? { description: String(opt.description).slice(0, 240) } : {}),
                })).filter((opt) => opt.label),
                ...(Number.isInteger(m.questionSelected) && m.questionSelected >= 0 ? { questionSelected: m.questionSelected } : {}),
                ...(m.allowCustom === false ? { allowCustom: false } : {}),
              } : {}),
              ...(m.metrics && typeof m.metrics === 'object' ? {
                metrics: {
                  promptTokens: Number(m.metrics.promptTokens) || 0,
                  completionTokens: Number(m.metrics.completionTokens) || 0,
                  totalTokens: Number(m.metrics.totalTokens) || 0,
                  contextEstTokens: Number(m.metrics.contextEstTokens) || 0,
                  contextWindow: Number(m.metrics.contextWindow) || 32768,
                  tokPerSec: Number(m.metrics.tokPerSec) || 0,
                  elapsedMs: Number(m.metrics.elapsedMs) || 0,
                  estimated: Boolean(m.metrics.estimated),
                },
              } : {}),
              ...(m.isSummary ? { isSummary: true } : {}),
              ...(m.error ? { error: true } : {}),
            }));
          threads.push({ id, title, ...(customTitle ? { customTitle: true } : {}), updatedAt, messages });
        }
        const activeId = typeof raw?.activeId === 'string' && seen.has(raw.activeId)
          ? raw.activeId : (threads[0]?.id || '');
        return { activeId, threads };
      };
      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        let p;
        try { p = await readJson(req, res, 4 * 1024 * 1024); } catch { return; }
        if (p?.projectId != null && Number(p.projectId) !== PROJECT.id) {
          return json(res, { ok: false, error: '工程已切换，请刷新对话列表' }, 409);
        }
        const clean = sanitizeChats(p);
        store.setSetting(chatKey, clean);
        return json(res, { ok: true, projectId: PROJECT.id, projectName: PROJECT.name, ...clean });
      }
      const saved = sanitizeChats(store.getSetting(chatKey, { activeId: '', threads: [] }));
      return json(res, { ok: true, projectId: PROJECT.id, projectName: PROJECT.name, ...saved });
    }

    if (u.pathname === '/api/ai/compact' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      let p;
      try { p = await readJson(req, res, 4 * 1024 * 1024); } catch { return; }
      if (p?.projectId != null && Number(p.projectId) !== PROJECT.id) {
        return json(res, { ok: false, error: '工程已切换，请刷新对话列表' }, 409);
      }
      try {
        const saved = normalizeAiConfig({}, store.getSetting('ai.llm.config', DEFAULT_AI_CONFIG));
        const compacted = await compactConversation({
          config: saved,
          messages: Array.isArray(p?.messages) ? p.messages : [],
          signal: responseSignal(res),
        });
        return json(res, compacted);
      } catch (err) {
        return bad(res, String(err?.message || err));
      }
    }

    if (u.pathname === '/api/ai/chat' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      let p;
      try { p = await readJson(req, res); } catch { return; }
      if (!currentSession(req)) return sessionConflict(res);
      const saved = normalizeAiConfig({}, store.getSetting('ai.llm.config', DEFAULT_AI_CONFIG));
      let cfg;
      try { cfg = normalizeAiConfig(p.config || {}, saved); } catch (err) { return bad(res, err.message); }
      const prompt = String(p.prompt || '').trim();
      if (!prompt) return bad(res, '请输入要执行的任务');

      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      res.flushHeaders?.();
      const abort = new AbortController();
      const cancel = () => { if (!res.writableEnded) abort.abort(new Error('用户已取消')); };
      req.on('close', cancel);
      res.on('close', cancel);
      const sendEvent = (ev) => {
        if (res.writableEnded || res.destroyed) return;
        if (res.writableLength > 1024 * 1024) {
          cancel();
          res.destroy();
          return;
        }
        res.write(JSON.stringify(ev) + '\n');
      };

      const chatProjectId = PROJECT.id;
      let expectedSession = sessionRevision;
      const sameSession = () => !switching && PROJECT?.id === chatProjectId && sessionRevision === expectedSession;
      const sessionCurrent = () => !abort.signal.aborted && sameSession();
      const assertActive = () => {
        if (abort.signal.aborted) throw new Error('已取消');
        if (!sameSession()) {
          throw new Error('工程或比较会话已切换，请重试');
        }
      };

      const resolveSymbols = (model, rawList, kind, matchPath) => {
        const resolved = [];
        const seen = new Set();
        const ambiguous = [];
        const notFound = [];
        const items = Array.isArray(rawList) ? rawList : typeof rawList === 'string' && rawList.trim() ? [rawList] : [];
        for (const raw of items) {
          const text = String(raw || '').trim();
          if (!text) continue;
          const clean = kind === 'fn' ? text.replace(/\(\s*\)$/, '').trim() : text;
          const exact = model._index.byId.get(clean);
          const validExact = exact && !exact.external && !overlay.deleted.nodes[exact.id] &&
            (kind === 'var' ? exact.kind === 'var' : exact.kind !== 'var' && !exact.headerSymbol);
          if (validExact) {
            if (!seen.has(exact.id)) { seen.add(exact.id); resolved.push(exact.id); }
            continue;
          }
          if (kind === 'var') {
            const prefixed = model._index.byId.get('var::' + clean);
            if (prefixed && prefixed.kind === 'var' && !overlay.deleted.nodes[prefixed.id]) {
              if (!seen.has(prefixed.id)) { seen.add(prefixed.id); resolved.push(prefixed.id); }
              continue;
            }
            let byName = (model.variables || []).filter(v => !overlay.deleted.nodes[v.id] &&
              (v.name === clean || v.name.toLowerCase() === clean.toLowerCase()));
            if (byName.length > 1 && matchPath) byName = byName.filter(matchPath);
            if (byName.length === 1) {
              if (!seen.has(byName[0].id)) { seen.add(byName[0].id); resolved.push(byName[0].id); }
            } else if (byName.length > 1) {
              ambiguous.push({ query: text, candidates: byName.slice(0, 8).map(v => v.id) });
            } else notFound.push(text);
          } else {
            let matches = (model._index.byName.get(clean) || []).filter(n => !n.external && !overlay.deleted.nodes[n.id]);
            if (!matches.length) {
              const lower = clean.toLowerCase();
              matches = (model.functions || []).filter(n => !n.external && !overlay.deleted.nodes[n.id] && n.name.toLowerCase() === lower);
            }
            if (matches.length > 1 && matchPath) matches = matches.filter(matchPath);
            if (matches.length === 1) {
              if (!seen.has(matches[0].id)) { seen.add(matches[0].id); resolved.push(matches[0].id); }
            } else if (matches.length > 1) {
              ambiguous.push({ query: text, candidates: matches.slice(0, 8).map(n => n.id) });
            } else notFound.push(text);
          }
        }
        return { resolved, ambiguous, notFound };
      };

      const collectCanvasLabelContext = async (model, page) => {
        const roots = (page?.roots || []).map((id) => remapLegacyExt(id, model)).filter((id) => model._index.byId.has(id));
        const expansions = normalizeExpansions((page?.expansions || [])
          .map((s) => ({ ...s, root: remapLegacyExt(s.root, model) }))
          .filter((s) => model._index.byId.has(s.root) && model._index.byId.get(s.root).kind !== 'var'));
        const scopes = [
          ...roots.map((r) => ({ root: r, up: Number(page?.up) || 0, down: Number(page?.down) || 0 })),
          ...expansions,
        ];
        const nodeIds = new Set();
        const edgeMap = new Map();
        const perRoot = Math.max(120, Math.floor(600 / Math.max(1, roots.length)));
        for (const scope of scopes) {
          const part = subgraph(model, scope.root, { up: scope.up, down: scope.down, maxNodes: perRoot, includeVariables: false });
          for (const n of part.nodes) {
            if (!overlay.deleted.nodes[n.id] && n.kind !== 'var') nodeIds.add(n.id);
          }
          for (const e of part.edges) {
            if (e.kind === 'var' || overlay.deleted.edges[edgeKeyOf(e)]) continue;
            if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
            const k = edgeKeyOf(e);
            if (!edgeMap.has(k)) edgeMap.set(k, e);
          }
        }
        for (const id of nodeIds) {
          for (const e of model._index.outAdj.get(id) || []) {
            if (e.kind === 'var' || e.headerReference || !nodeIds.has(e.to) || overlay.deleted.edges[edgeKeyOf(e)]) continue;
            const k = edgeKeyOf(e);
            if (!edgeMap.has(k)) edgeMap.set(k, e);
          }
        }
        if (!nodeIds.size) {
          return { canvasNodeCount: 0, canvasEdges: [], suggestedLabels: [], commentTasks: [] };
        }
        const detected = model.parserId === 'dot' ? { suggestions: [], tasks: [] }
          : await analyzeTasks(model, { onlyIds: nodeIds });
        assertActive();
        const canvasEdges = [...edgeMap.values()].slice(0, 60).map((e) => {
          const key = annotationEdgeKey(overlay.edges, e, model);
          const existing = normalizeLabels(overlay.edges?.[key]?.labels ?? overlay.edges?.[key]?.label);
          return {
            from: e.from,
            to: e.to,
            line: e.line,
            labels: existing.map((l) => ({ preset: l.preset, text: l.text })),
          };
        });
        const suggestedLabels = [];
        for (const s of detected.suggestions || []) {
          if (!edgeMap.has(s.edgeKey)) continue;
          const key = annotationEdgeKey(overlay.edges, { from: s.from, to: s.to, line: s.line }, model);
          const existing = normalizeLabels(overlay.edges?.[key]?.labels ?? overlay.edges?.[key]?.label);
          if (existing.some((l) => l.preset === s.preset)) continue;
          const orderMatch = s.preset === 'call' ? /^コール順(\d+)$/.exec(s.text) : null;
          suggestedLabels.push({
            from: s.from,
            to: s.to,
            line: s.line,
            preset: s.preset,
            text: s.text,
            ...(orderMatch ? { order: Number(orderMatch[1]) } : {}),
            evidence: s.evidence,
          });
        }
        return {
          canvasNodeCount: nodeIds.size,
          canvasEdges,
          suggestedLabels: suggestedLabels.slice(0, 60),
          commentTasks: (detected.tasks || []).filter((t) => t.period).slice(0, 20),
        };
      };

      // 将 Git 改动的函数按调用链、上游 TASK 及共享全局变量做连通分量拆分，互不关联的独立改动分到不同书签。
      const splitChangedGroups = (model, fnIds, varIds = []) => {
        const list = [...new Set(fnIds)].filter((id) => model._index?.byId?.has(id));
        if (list.length <= 1) {
          return list.length ? [{
            index: 1,
            fnIds: list,
            varIds: [...new Set(varIds)],
            taskIds: [],
            taskNames: [],
            name: `Git改动: ${list[0].split('::').pop()}`,
          }] : [];
        }
        const parent = new Map(list.map((id) => [id, id]));
        const find = (x) => {
          let r = x;
          while (parent.get(r) !== r) r = parent.get(r);
          while (parent.get(x) !== r) { const nx = parent.get(x); parent.set(x, r); x = nx; }
          return r;
        };
        const unite = (a, b) => {
          const ra = find(a), rb = find(b);
          if (ra !== rb) parent.set(rb, ra);
        };
        const fnSet = new Set(list);
        const touchOwner = new Map(); // shared node/var/task -> first fnId
        const claim = (token, fnId) => {
          const prev = touchOwner.get(token);
          if (prev) unite(prev, fnId);
          else touchOwner.set(token, fnId);
        };
        const tasksByFn = new Map();
        const df = model._df;
        for (const id of list) {
          claim(`fn:${id}`, id);
          for (const e of model._index.outAdj.get(id) || []) {
            if (e.kind !== 'var' && fnSet.has(e.to)) unite(id, e.to);
          }
          for (const e of model._index.inAdj.get(id) || []) {
            if (e.kind !== 'var' && fnSet.has(e.from)) unite(id, e.from);
          }
          const fnTasks = new Set();
          try {
            const trace = traceToTasks(model, id, { limit: 30 });
            for (const chain of trace.upstreamChains || []) {
              if (chain.taskId) fnTasks.add(chain.taskId);
              for (const nodeId of chain.path || []) claim(`fn:${nodeId}`, id);
            }
          } catch { /* ignore trace errors */ }
          // 也向上回溯最多 4 层直接调用者，避免同属一个非标准命名入口（如注释标周期函数）的改动被误拆
          {
            const q = [{ node: id, depth: 0 }];
            const seenUp = new Set([id]);
            for (let qi = 0; qi < q.length; qi++) {
              const { node, depth } = q[qi];
              if (depth >= 4) continue;
              for (const e of model._index.inAdj.get(node) || []) {
                if (e.kind === 'var' || seenUp.has(e.from)) continue;
                seenUp.add(e.from);
                claim(`fn:${e.from}`, id);
                q.push({ node: e.from, depth: depth + 1 });
              }
            }
          }
          tasksByFn.set(id, fnTasks);
          if (df?.fnAccess?.has(id)) {
            const acc = df.fnAccess.get(id);
            for (const vid of [...(acc.reads?.keys() || []), ...(acc.writes?.keys() || [])]) {
              claim(`var:${vid}`, id);
            }
          }
        }
        const grouped = new Map();
        for (const id of list) {
          const r = find(id);
          if (!grouped.has(r)) grouped.set(r, { fnIds: [], taskIds: new Set(), varIds: new Set() });
          const g = grouped.get(r);
          g.fnIds.push(id);
          for (const tid of tasksByFn.get(id) || []) g.taskIds.add(tid);
        }
        // 把变更的全局变量分配到读写它的分组中；若无归属则挂到第一组
        const groupList = [...grouped.values()];
        for (const vid of new Set(varIds)) {
          let placed = false;
          const peers = new Set([...(df?.readers?.get(vid) || []), ...(df?.writers?.get(vid) || [])]);
          for (const g of groupList) {
            if (g.fnIds.some((fid) => peers.has(fid)) || [...g.taskIds].some((tid) => peers.has(tid))) {
              g.varIds.add(vid);
              placed = true;
            }
          }
          if (!placed && groupList[0]) groupList[0].varIds.add(vid);
        }
        groupList.sort((a, b) => b.fnIds.length - a.fnIds.length || a.fnIds[0].localeCompare(b.fnIds[0]));
        const usedNames = new Set();
        return groupList.map((g, idx) => {
          const taskIds = [...g.taskIds];
          const taskNames = taskIds.map((id) => id.split('::').pop());
          const leadId = g.fnIds[0];
          const leadFn = leadId.split('::').pop();
          const leadFile = fileOfNodeId(model, leadId);
          const dirParts = leadFile.split('/').filter(Boolean);
          const scopeTag = dirParts.length > 1 ? dirParts[0] : (dirParts[0] ? dirParts[0].replace(/\.[^.]+$/, '') : '');
          const periodMatch = taskNames.map((n) => /(\d+\s*(?:ms|us|s))/i.exec(n)?.[1]).find(Boolean);
          const headParts = [scopeTag, leadFn].filter(Boolean);
          let baseName = headParts.join(' · ');
          if (periodMatch && !baseName.toLowerCase().includes(periodMatch.toLowerCase())) {
            baseName += ` (${periodMatch})`;
          } else if (g.fnIds.length > 1) {
            baseName += ` (+${g.fnIds.length - 1})`;
          }
          baseName = (baseName || `改动模块 ${idx + 1}`).slice(0, 56);
          let finalName = baseName;
          let seq = 2;
          while (usedNames.has(finalName)) finalName = `${baseName.slice(0, 50)} #${seq++}`;
          usedNames.add(finalName);
          return {
            index: idx + 1,
            name: finalName,
            fnIds: g.fnIds,
            varIds: [...g.varIds],
            taskIds,
            taskNames,
          };
        });
      };

      // 检测改动/目标函数的上游调用链是否横跨多个车型/目录前缀（兼容任意嵌套深度，如 z145/ 或 src/z145/ 与 src/z144/），便于 AI 提前询问筛选。
      const summarizeVehicleBranches = (model, fnIds) => {
        const targetSet = new Set(fnIds);
        const dirSegsOf = (file) => {
          const parts = String(file || '').replace(/\\/g, '/').split('/').filter(Boolean);
          return parts.length > 1 ? parts.slice(0, -1) : [];
        };
        const collectedNodes = []; // { id, file, segs, isTask }
        const seenNode = new Set();
        for (const id of targetSet) {
          if (!model._index?.byId?.has(id)) continue;
          try {
            const trace = traceToTasks(model, id, { limit: 60 });
            for (const chain of trace.upstreamChains || []) {
              for (const nodeId of chain.path || []) {
                if (targetSet.has(nodeId) || seenNode.has(nodeId)) continue;
                seenNode.add(nodeId);
                const file = fileOfNodeId(model, nodeId);
                collectedNodes.push({ id: nodeId, file, segs: dirSegsOf(file), isTask: nodeId === chain.taskId });
              }
            }
          } catch { /* ignore */ }
          // 同时向上回溯最多 6 层直接调用者，确保非标准命名（无正式 TASK）的多车型上游分支也能被发现
          const queue = [{ node: id, depth: 0 }];
          const visited = new Set([id]);
          for (let qi = 0; qi < queue.length; qi++) {
            const { node, depth } = queue[qi];
            if (depth >= 6) continue;
            for (const e of model._index.inAdj.get(node) || []) {
              if (e.kind === 'var' || visited.has(e.from)) continue;
              visited.add(e.from);
              if (!targetSet.has(e.from) && !seenNode.has(e.from)) {
                seenNode.add(e.from);
                const file = fileOfNodeId(model, e.from);
                collectedNodes.push({ id: e.from, file, segs: dirSegsOf(file), isTask: false });
              }
              queue.push({ node: e.from, depth: depth + 1 });
            }
          }
        }
        const dirLists = [
          ...[...targetSet].map((id) => dirSegsOf(fileOfNodeId(model, id))),
          ...collectedNodes.map((n) => n.segs),
        ].filter((segs) => segs.length > 0);
        if (!dirLists.length) return [];
        // 计算所有涉及文件的最长公共目录前缀（例如 src/ 或 app/ecu/），取其后的首级分叉目录作为车型/分支前缀
        let commonLen = dirLists[0].length;
        for (let i = 1; i < dirLists.length; i++) {
          let k = 0;
          while (k < commonLen && k < dirLists[i].length && dirLists[i][k].toLowerCase() === dirLists[0][k].toLowerCase()) k++;
          commonLen = k;
        }
        const branchKeyOf = (segs) => {
          if (segs.length <= commonLen) return '';
          return segs.slice(0, commonLen + 1).join('/');
        };
        const targetKeys = new Set([...targetSet].map((id) => branchKeyOf(dirSegsOf(fileOfNodeId(model, id)))).filter(Boolean));
        const byPrefix = new Map();
        for (const item of collectedNodes) {
          const pref = branchKeyOf(item.segs);
          if (!pref || targetKeys.has(pref)) continue;
          if (!byPrefix.has(pref)) byPrefix.set(pref, { prefix: pref, taskIds: new Set(), sampleFunctions: new Set(), chainCount: 0 });
          const entry = byPrefix.get(pref);
          if (item.isTask) entry.taskIds.add(item.id);
          else entry.sampleFunctions.add(item.id);
          entry.chainCount++;
        }
        const branches = [...byPrefix.values()]
          .map((b) => ({
            prefix: b.prefix,
            taskIds: [...b.taskIds].slice(0, 12),
            sampleFunctions: [...b.sampleFunctions].slice(0, 8),
            chainCount: b.chainCount,
          }))
          .sort((a, b) => b.chainCount - a.chainCount || a.prefix.localeCompare(b.prefix));
        return branches.length > 1 ? branches : [];
      };

      const executeAiTool = async (name, args) => {
        assertActive();
        if (name === 'get_git_changes') {
          const q = new URLSearchParams({ limit: '80' });
          if (args.baseRef) q.set('baseRef', String(args.baseRef));
          if (args.targetRef) q.set('targetRef', String(args.targetRef));
          const wantsWorktree = !args.baseRef && !args.targetRef;
          const forceGit = Boolean(COMPARISON && (
            (wantsWorktree && COMPARISON.git?.targetRef !== 'WORKTREE') ||
            (args.baseRef && COMPARISON.git?.baseRef !== String(args.baseRef)) ||
            (args.targetRef && COMPARISON.git?.targetRef !== String(args.targetRef))
          ));
          if (forceGit && wantsWorktree) {
            q.set('baseRef', 'HEAD');
            q.set('targetRef', 'WORKTREE');
          }
          const result = await readMcpChanges(q, req, { bypassMcpAccess: true, forceGit, sessionCurrent });
          assertActive();
          const snap = getMcpChangeSnapshot(result.snapshotId);
          const allNodes = result.nodes || [];
          const changedFiles = (snap?.comparison?.git?.changedFiles || []).slice(0, 40);
          const changedFunctions = allNodes.filter(c => c.kind !== 'var').slice(0, 40).map(c => ({
            id: c.id, name: c.name, file: c.file, line: c.line, change: c.change,
          }));
          const changedVars = allNodes.filter(c => c.kind === 'var').slice(0, 30).map(c => ({
            id: c.id, name: c.name, file: c.file, line: c.line, change: c.change,
          }));
          const groupModel = snap?.comparison?.afterModel || snap?.comparison?.model || MODEL;
          if (snap.comparison.model) await ensureAnalysis(groupModel);
          assertActive();
          const { newlyReferencedVars } = collectNewlyReferencedVarsAndSources(snap.comparison.model, groupModel,
            changedFunctions.map(f => f.id), overlay.deleted.nodes);
          const groups = changedFunctions.length > 1
            ? splitChangedGroups(groupModel, changedFunctions.map(f => f.id), changedVars.map(v => v.id))
            : [];
          const pathBranches = changedFunctions.length
            ? summarizeVehicleBranches(groupModel, changedFunctions.map((f) => f.id))
            : [];
          return {
            ok: true,
            source: result.source,
            snapshotId: result.snapshotId,
            noChanges: !allNodes.length && !(result.edges?.length) && !changedFiles.length,
            changedFiles,
            changedFunctions,
            changedVars,
            newlyReferencedVars: newlyReferencedVars.slice(0, 20),
            ...(pathBranches.length > 1 ? { pathBranches } : {}),
            ...(groups.length > 1 ? {
              isolatedGroupCount: groups.length,
              isolatedGroups: groups.map((g) => ({
                index: g.index,
                name: g.name,
                functions: g.fnIds.slice(0, 12),
                vars: [...new Set([...g.varIds, ...newlyReferencedVars.filter(v => v.usedBy.some(id => g.fnIds.includes(id))).map(v => v.id)])]
                  .map((id) => id.replace(/^var::/, '')),
                tasks: g.taskIds.slice(0, 8),
              })),
            } : {}),
            total: result.total ?? allNodes.length,
          };
        }
        if (name === 'trace_upstream') {
          const rawFns = Array.isArray(args.functions) ? args.functions : (args.name ? [args.name] : []);
          const { resolved, ambiguous, notFound } = resolveSymbols(MODEL, rawFns, 'fn');
          if (!resolved.length) {
            return {
              ok: false,
              error: ambiguous.length ? '函数名在多个路径下重名，请指定完整「文件::函数名」或先按目录过滤' : '未找到指定函数',
              ambiguous,
              notFound,
            };
          }
          const limit = Math.max(1, Math.min(60, Number(args.limit) || 40));
          const traces = resolved.slice(0, 15).map((id) => {
            const tr = traceToTasks(MODEL, id, { limit });
            return {
              id,
              upstreamTasks: (tr.upstreamTasks || []).slice(0, 20).map((t) => ({ id: t.id, name: t.name, file: t.file, kind: t.kind })),
              chains: (tr.upstreamChains || []).slice(0, 20).map((c) => ({ taskId: c.taskId, path: c.path })),
              totalTasks: tr.totalTasks || 0,
            };
          });
          const pathBranches = summarizeVehicleBranches(MODEL, resolved);
          return {
            ok: true,
            functions: resolved,
            traces,
            ...(pathBranches.length > 1 ? { pathBranches } : {}),
            ambiguous,
            notFound,
          };
        }
        if (name === 'remove_from_canvas') {
          if (COMPARISON) return { ok: false, error: '当前处于比较视图（只读），退出比较后才能局部移除节点' };
          const excludePaths = normalizePathPrefixes(args.excludePaths);
          const rawFns = Array.isArray(args.functions) ? args.functions : [];
          if (!excludePaths.length && !rawFns.length) {
            return { ok: false, error: '请提供要移除的 functions 或 excludePaths（例如 ["z144"]）' };
          }
          const removeIdSet = new Set();
          for (const raw of rawFns) {
            const clean = String(raw || '').trim().replace(/\(\s*\)$/, '');
            if (!clean) continue;
            if (MODEL._index.byId.has(clean)) {
              removeIdSet.add(clean);
            } else {
              for (const fn of MODEL._index.byName.get(clean) || []) removeIdSet.add(fn.id);
            }
          }
          const shouldRemove = (id) => removeIdSet.has(id) ||
            (excludePaths.length > 0 && excludePaths.some((pref) => fileMatchesPathPrefix(fileOfNodeId(MODEL, id), pref)));

          const key = savedViewKey();
          const before = latestPage();
          if (!before || (!(before.roots?.length) && !(before.expansions?.length))) {
            return { ok: false, error: '当前画布为空，没有可移除的节点' };
          }
          // 展开当前画布实际可见节点，确保通过 up/down 带进来的被排除车型节点也能彻底去掉。
          const visibleFnIds = new Set();
          const baseRoots = (before.roots || []).map((id) => remapLegacyExt(id, MODEL)).filter((id) => MODEL._index.byId.has(id));
          const baseExps = normalizeExpansions((before.expansions || [])
            .map((s) => ({ ...s, root: remapLegacyExt(s.root, MODEL) }))
            .filter((s) => MODEL._index.byId.has(s.root)));
          const scopes = [
            ...baseRoots.map((r) => ({ root: r, up: Number(before.up) || 0, down: Number(before.down) || 0 })),
            ...baseExps,
          ];
          const perRoot = Math.max(120, Math.floor(600 / Math.max(1, baseRoots.length)));
          for (const scope of scopes) {
            const part = subgraph(MODEL, scope.root, { up: scope.up, down: scope.down, maxNodes: perRoot, includeVariables: false });
            for (const n of part.nodes) {
              if (!overlay.deleted.nodes[n.id] && n.kind !== 'var') visibleFnIds.add(n.id);
            }
          }
          const removedIds = [...visibleFnIds].filter(shouldRemove);
          if (!removedIds.length) {
            return { ok: true, removedCount: 0, removed: [], remainingCount: visibleFnIds.size, note: '当前画布上没有匹配该条件的函数' };
          }
          const keptIds = [...visibleFnIds].filter((id) => !shouldRemove(id));
          const keptRoots = baseRoots.filter((id) => !shouldRemove(id));
          const nextRoots = keptRoots.length ? keptRoots : keptIds.slice(0, 1);
          const nextRootSet = new Set(nextRoots);
          const nextExpansions = normalizeExpansions(
            keptIds.filter((id) => !nextRootSet.has(id)).map((r) => ({ root: r, up: 0, down: 0 }))
          );
          const nextVars = (before.vars || []).filter((vid) => !shouldRemove(vid));
          const reason = typeof args.reason === 'string' && args.reason.trim()
            ? args.reason.trim().slice(0, 240)
            : (excludePaths.length ? `AI 移除路径 ${excludePaths.join(', ')}` : 'AI 移除指定函数');
          const nextPage = {
            ...before,
            projectId: PROJECT.id,
            roots: nextRoots,
            expansions: nextExpansions,
            up: 0,
            down: 0,
            vars: nextVars,
            empty: !nextRoots.length && !nextExpansions.length,
            selected: before.selected && !shouldRemove(before.selected) ? before.selected : null,
            selectedEdge: null,
            at: 0,
            reviewing: false,
            ts: Date.now(),
          };
          store.transaction(() => {
            nextPage.revision = store.appendEvent(PROJECT.id, {
              op: 'view.compose',
              actor: 'ai',
              target: nextRoots[0] || removedIds[0],
              before,
              after: { ...nextPage, count: keptIds.length, rootCount: nextRoots.length, reason, view: viewSnapshot(nextPage) },
            });
            store.setSetting(key, nextPage);
          });
          const review = reviewWriteResult();
          if (!review.updatedWhileReviewing) pageState = nextPage;
          broadcastChange('view.compose', 'ai', { page: nextPage, reason });
          return {
            ok: true,
            removedCount: removedIds.length,
            removed: removedIds.slice(0, 30),
            remainingCount: keptIds.length,
            roots: nextRoots.slice(0, 20),
            ...review,
          };
        }
        if (name === 'find_symbols') {
          const query = String(args.query || '').trim();
          const kind = ['fn', 'var', 'all'].includes(args.kind) ? args.kind : 'all';
          const limit = Math.max(1, Math.min(50, Number(args.limit) || 20));
          const activeModel = MODEL;
          if (!query) {
            const tasks = activeModel.parserId === 'dot' ? [] : projectTasks(activeModel).slice(0, 20).map(t => ({
              id: t.id, name: t.name, kind: t.kind, periodUs: t.us,
            }));
            const page = latestPage();
            const labelCtx = await collectCanvasLabelContext(activeModel, page);
            return {
              ok: true,
              project: PROJECT.name,
              canvasRoots: (page?.roots || []).slice(0, 20),
              tasks,
              ...labelCtx,
            };
          }
          const matches = [];
          if (kind !== 'var') {
            for (const fn of search(activeModel, query)) {
              if (overlay.deleted.nodes[fn.id]) continue;
              matches.push({ id: fn.id, name: fn.name, kind: 'fn', file: fn.file, line: fn.line, fanIn: fn.fanIn, fanOut: fn.fanOut });
              if (matches.length >= limit) break;
            }
          }
          if (kind !== 'fn' && matches.length < limit) {
            if (!COMPARISON && activeModel.source !== 'dot') {
              await ensureAnalysis(activeModel);
              assertActive();
            }
            const vars = COMPARISON ? comparisonGlobals(COMPARISON) : await listGlobals(activeModel);
            assertActive();
            const lower = query.toLowerCase();
            for (const v of vars) {
              if (overlay.deleted.nodes[v.id]) continue;
              if (!v.name.toLowerCase().includes(lower) && !v.id.toLowerCase().includes(lower)) continue;
              matches.push({ id: v.id, name: v.name, kind: 'var', file: v.file, line: v.line, writers: v.writers?.length || 0, readers: v.readers?.length || 0 });
              if (matches.length >= limit) break;
            }
          }
          return { ok: true, query, matches, total: matches.length };
        }
        if (name === 'read_function') {
          const target = String(args.name || args.id || '').trim();
          const { resolved, ambiguous, notFound } = resolveSymbols(MODEL, [target], 'fn');
          if (!resolved.length) {
            return { ok: false, error: ambiguous.length ? '函数名重名，请改用候选中的完整「文件::函数名」' : `未找到函数：${target}`, ambiguous, notFound };
          }
          const q = new URLSearchParams({ id: resolved[0] });
          if (['auto', 'cp932', 'utf-8'].includes(args.encoding)) q.set('encoding', args.encoding);
          const src = await readMcpSource(q);
          assertActive();
          const fnNode = MODEL._index.byId.get(resolved[0]);
          const headerInfo = fnNode ? await analyzeTasks(MODEL, { headerId: fnNode.id }) : { comment: '', period: null };
          assertActive();
          const lines = String(src.source || '').split('\n');
          const kept = [];
          let chars = 0;
          let clipped = false;
          for (const line of lines) {
            if (kept.length >= 120 || chars + line.length + 1 > 8000) { clipped = true; break; }
            kept.push(line);
            chars += line.length + 1;
          }
          return {
            ok: true,
            id: src.id,
            name: src.name,
            file: src.file,
            startLine: src.startLine,
            endLine: kept.length ? src.startLine + kept.length - 1 : src.startLine,
            truncated: Boolean(src.truncated || clipped),
            sourceEncoding: src.sourceEncoding,
            ...(headerInfo.comment ? { headerComment: headerInfo.comment.slice(0, 1200) } : {}),
            ...(headerInfo.period ? { commentPeriod: headerInfo.period } : {}),
            source: clipped ? kept.join('\n') + '\n/* ... */' : kept.join('\n'),
            taskPeriods: src.taskPeriods,
            upstreamTasks: src.upstreamTasks?.slice(0, 12) || [],
            calls: (src.calls || []).slice(0, 25).map(c => ({ to: c.to, callee: c.callee, line: c.line })),
            varAccess: (src.varAccess || []).slice(0, 25),
          };
        }
        if (name === 'add_to_canvas') {
          const includeTasks = args.includeTasks !== false;
          const includePaths = normalizePathPrefixes(args.includePaths);
          const excludePaths = normalizePathPrefixes(args.excludePaths);
          const up = Math.max(0, Math.min(3, Math.trunc(Number(args.up) || 0)));
          const down = Math.max(0, Math.min(3, Math.trunc(Number(args.down) || 0)));
          const reason = typeof args.reason === 'string' ? args.reason.slice(0, 240) : '';
          let targetModel = MODEL;
          let defaultFnIds = [];
          let defaultVarIds = [];
          let snapshotId;
          let gitComparison = null;
          const detectedNodeChanges = new Map();
          const detectedAddedEdges = [];

          const custom = Array.isArray(args.groups);
          if (custom && (args.groups.length < 2 || args.groups.some(g => !g || typeof g.name !== 'string' || !g.name.trim() ||
              !Array.isArray(g.functions) || !g.functions.length || (g.vars !== undefined && !Array.isArray(g.vars))))) {
            return { ok: false, error: '请给至少两个分组分别指定书签名和函数列表' };
          }
          if (args.fromGit || args.snapshotId || (custom && COMPARISON)) {
            const needFreshWorktree = args.snapshotId || !COMPARISON || (args.fromGit && COMPARISON.git?.targetRef !== 'WORKTREE');
            if (needFreshWorktree) {
              let snap = null;
              if (typeof args.snapshotId === 'string' && args.snapshotId.trim()) {
                try { snap = getMcpChangeSnapshot(args.snapshotId.trim()); } catch (err) {
                  if (!args.fromGit) throw err;
                }
              }
              if (!snap) {
                const q = new URLSearchParams({ limit: '80', baseRef: 'HEAD', targetRef: 'WORKTREE' });
                const gitRes = await readMcpChanges(q, req, { bypassMcpAccess: true, forceGit: Boolean(COMPARISON), sessionCurrent });
                assertActive();
                snap = getMcpChangeSnapshot(gitRes.snapshotId);
              }
              if (!snap.comparison.model) {
                return { ok: false, error: '当前 Git 工作区没有未提交的 C/H 代码改动' };
              }
              gitComparison = snap.comparison;
              if (COMPARISON) snapshotId = snap.id;
              targetModel = snap.comparison.model;
            }
            gitComparison ??= COMPARISON;
            const hidden = (snapshotId ? comparisonBase?.overlay ?? overlay : overlay).deleted.nodes;
            const directFns = (targetModel.functions || []).filter(n => !n.external && !hidden[n.id] && n.change !== 'existing');
            const impactFns = directFns.length ? directFns : (targetModel.functions || []).filter(n => !n.external && !hidden[n.id] && (n.impact || n.macroImpact || n.periodImpact));
            defaultFnIds = impactFns.slice(0, 40).map(n => n.id);
            defaultVarIds = (targetModel.variables || []).filter(v => !hidden[v.id] && v.change !== 'existing').slice(0, 20).map(v => v.id);
            for (const n of [...(targetModel.functions || []), ...(targetModel.variables || [])]) {
              if (['modified', 'added', 'deleted'].includes(n.change)) detectedNodeChanges.set(n.id, n.change);
            }
            for (const e of targetModel.edges || []) {
              if (e.change === 'added') detectedAddedEdges.push(e);
            }
            // 普通画布要从同一份工作区源码解析调用边；符号 ID 未变时，调用和数据流也可能已更新。
            if (!COMPARISON && gitComparison) {
              assertActive();
              await refreshLiveProject();
              assertActive();
              targetModel = MODEL;
              defaultFnIds = defaultFnIds.filter((id) => MODEL._index?.byId?.has(id));
            }
          }
          const groupModel = gitComparison?.afterModel || COMPARISON?.afterModel || MODEL;
          if (defaultVarIds.length || args.vars?.length || args.groups?.some(g => g.vars?.length) ||
              gitComparison?.model?.edges.some(e => e.kind === 'var' && e.change === 'added')) {
            if (!COMPARISON && MODEL.source !== 'dot') await ensureAnalysis(MODEL);
            if (groupModel !== MODEL) await ensureAnalysis(groupModel);
            assertActive();
          }
          defaultVarIds = defaultVarIds.filter(id => targetModel._index.byId.has(id));

          assertActive();
          const hasExplicitFns = Array.isArray(args.functions) && args.functions.length > 0;
          const hasExplicitVars = Array.isArray(args.vars) && args.vars.length > 0;
          const filterByPath = (ids) => ids.filter((id) => {
            const file = fileOfNodeId(targetModel, id);
            if (excludePaths.length && excludePaths.some((p) => fileMatchesPathPrefix(file, p))) return false;
            return true;
          });
          const resolveGroupSymbols = (items, kind) => {
            const res = resolveSymbols(targetModel, items, kind, node =>
              !excludePaths.some(prefix => fileMatchesPathPrefix(node.file, prefix)) &&
              (!includePaths.length || includePaths.some(prefix => fileMatchesPathPrefix(node.file, prefix))));
            res.resolved = filterByPath(res.resolved);
            return res;
          };
          const explicitGroups = [];
          for (const g of args.groups || []) {
            const fns = resolveGroupSymbols(g.functions, 'fn'), vars = resolveGroupSymbols(g.vars, 'var');
            if (!fns.resolved.length || fns.ambiguous.length || vars.ambiguous.length || fns.notFound.length || vars.notFound.length) {
              return { ok: false, error: '分组符号无法确定：' + g.name, ambiguous: [...fns.ambiguous, ...vars.ambiguous],
                notFound: [...fns.notFound, ...vars.notFound] };
            }
            const name = g.name.trim().slice(0, 60);
            if (explicitGroups.some(group => group.name === name)) return { ok: false, error: '分组书签名称重复：' + name };
            explicitGroups.push({ name, fnIds: fns.resolved, varIds: vars.resolved, taskNames: [] });
          }
          const fnRes = hasExplicitFns ? resolveGroupSymbols(args.functions, 'fn') : { resolved: filterByPath(defaultFnIds), ambiguous: [], notFound: [] };
          const varRes = hasExplicitVars ? resolveGroupSymbols(args.vars, 'var') : { resolved: filterByPath(defaultVarIds), ambiguous: [], notFound: [] };
          let actualFnIds = custom ? [...new Set(explicitGroups.flatMap(g => g.fnIds))] : fnRes.resolved.slice(0, 80);
          const varIds = custom ? [...new Set(explicitGroups.flatMap(g => g.varIds))] : varRes.resolved.slice(0, 40);
          // 支持仅追加全局变量到已有画布
          const currentPage = latestPage();
          const pureVars = !actualFnIds.length && varIds.length > 0 && !args.fromGit && (currentPage?.roots?.length > 0);
          if (!actualFnIds.length && !pureVars) {
            return {
              ok: false,
              error: fnRes.ambiguous.length ? '函数名重名，请改用完整「文件::函数名」或传入 includePaths 指定车型目录'
                : varIds.length ? '当前画布为空，添加变量时请同时指定至少一个相关函数'
                : '未匹配到可加入画布的函数',
              ambiguous: [...fnRes.ambiguous, ...varRes.ambiguous],
              notFound: [...fnRes.notFound, ...varRes.notFound],
            };
          }
          const mode = custom ? 'replace' : args.mode === 'replace' || args.mode === 'add'
            ? args.mode
            : (args.fromGit || (typeof args.bookmarkName === 'string' && args.bookmarkName.trim()) ? 'replace' : 'add');
          // 安全拦截：检测到共通/修改函数的上游横跨多个车型或目录分支（如 z145 与 z144）且未指定筛选时，先让 AI 询问用户再入图。
          if (!COMPARISON && includeTasks && !pureVars && !includePaths.length && !excludePaths.length && !args.includeAllBranches) {
            const branches = summarizeVehicleBranches(groupModel, actualFnIds);
            if (branches.length > 1) {
              return {
                ok: false,
                needsVehicleChoice: true,
                pathBranches: branches,
                error: `检测到上游调用链涉及 ${branches.length} 个不同车型/目录分支（${branches.map((b) => b.prefix).join('、')}），请先用 ask_user 询问用户需要保留哪些分支，再传入 includePaths / excludePaths 或 includeAllBranches:true 重试。`,
              };
            }
          }
          const splitGroups = custom ? explicitGroups : (!COMPARISON && !pureVars && args.fromGit && args.splitByGroup !== false && !hasExplicitFns && actualFnIds.length > 1)
            ? splitChangedGroups(groupModel, actualFnIds, varIds)
            : [];
          const grouped = splitGroups.length > 1;
          const scopes = grouped ? splitGroups : [{ name: '', fnIds: actualFnIds, varIds }];
          const pathFilter = { includePaths, excludePaths };
          const hidden = (snapshotId ? comparisonBase?.overlay ?? overlay : overlay).deleted.nodes;
          const isNode = id => targetModel._index.byId.has(id) && !hidden[id] && !targetModel._index.byId.get(id).external;
          const assignedFns = new Set(actualFnIds);
          for (const g of scopes) {
            const refs = collectNewlyReferencedVarsAndSources(gitComparison?.model, COMPARISON ? groupModel : MODEL, g.fnIds, hidden, pathFilter);
            g.varIds = [...new Set([...g.varIds, ...refs.varIds])];
            g.sourceWriterIds = refs.sourceWriterIds.filter(id => !assignedFns.has(id));
            if (!grouped) continue;
            const withinGroup = id => !assignedFns.has(id) || g.fnIds.includes(id);
            const trace = includeTasks ? changedFunctionScope(groupModel, null, g.fnIds, isNode, pathFilter, { fallbackCallers: true }) : null;
            const roots = [...(trace?.taskRoots || [])].filter(withinGroup);
            g.roots = roots.length ? roots : g.fnIds;
            g.functions = [...new Set([...(trace?.functionIds || g.fnIds), ...g.sourceWriterIds])]
              .filter(id => withinGroup(id) && !g.roots.includes(id));
            if (g.roots.length + g.functions.length > 80) return { ok: false, error: '分组超过 80 个函数：' + g.name };
          }
          const active = scopes[0];
          const activeGroup = grouped ? active : null;
          const activeFnsForCanvas = active.fnIds;
          const activeVarsForCanvas = active.varIds;
          const composePayload = pureVars
            ? { mode, roots: currentPage.roots.slice(0, 1), changedFunctionIds: [], vars: varIds, up: 0, down: 0, reason: reason || 'AI 加入全局变量到画布' }
            : {
              mode,
              ...(snapshotId ? { snapshotId } : {}),
              ...(includePaths.length ? { includePaths } : {}),
              ...(excludePaths.length ? { excludePaths } : {}),
              ...(grouped ? { roots: active.roots, functionIds: active.functions, changedFunctionIds: [] }
                : includeTasks ? { changedFunctionIds: activeFnsForCanvas, functionIds: active.sourceWriterIds, fallbackCallers: true }
                : { roots: activeFnsForCanvas, functionIds: active.sourceWriterIds, changedFunctionIds: [] }),
              vars: activeVarsForCanvas,
              up: custom ? 0 : up,
              down: custom ? 0 : down,
              reason: reason || (activeGroup ? `AI 按独立模块拆图（当前：${activeGroup.name}）` : args.fromGit ? 'AI 加入 Git 改动链路' : 'AI 加入函数到画布'),
            };
          let composed;
          let fallbackNote = '';
          const composeOptions = { chatClientId: req.headers['x-callgraph-client'] };
          try {
            composed = composeMcpView(composePayload, composeOptions);
          } catch (err) {
            if (includeTasks && !pureVars && /80|入口过多/.test(err.message)) {
              actualFnIds = activeFnsForCanvas.slice(0, 40);
              composed = composeMcpView({
                mode,
                ...(snapshotId ? { snapshotId } : {}),
                roots: actualFnIds,
                functionIds: active.sourceWriterIds,
                changedFunctionIds: [],
                vars: activeVarsForCanvas,
                up: Math.min(up, 1),
                down: Math.min(down, 1),
                reason: reason || 'AI 加入函数到画布',
              }, composeOptions);
              fallbackNote = '上游入口链超过 80 个函数，已直接加入前 40 个目标函数本体';
            } else throw err;
          }
          // 此处同步组图已经完成，只有本工具引发的比较切换可以更新对话的会话版本。
          if (snapshotId && COMPARISON?.id === snapshotId) expectedSession = sessionRevision;
          // 多个相互隔离的改动自动拆分为多个书签视图（或用户显式指定 bookmarkName 时保存书签）
          const createdBookmarks = [];
          const allGroupCanvasIds = new Set([
            ...(composed.page.roots || []),
            ...(composed.page.expansions || []).map((s) => s.root),
          ]);
          if (grouped) {
            const groupMode = composed.page.groupMode || 'file';
            store.transaction(() => {
              for (const g of splitGroups) {
                const bmRoots = g.roots, bmVars = g.varIds;
                const bmExpansions = normalizeExpansions([...bmRoots.slice(1), ...g.functions].map(root => ({ root, up: 0, down: 0 })));
                const bmName = !custom && includePaths.length && !g.name.toLowerCase().includes(includePaths[0])
                  ? `${includePaths.join('+')} · ${g.name}`.slice(0, 60)
                  : g.name;
                for (const id of [...bmRoots, ...bmExpansions.map((s) => s.root)]) allGroupCanvasIds.add(id);
                const savedBm = saveBookmarkWithEvent({
                  name: bmName,
                  roots: bmRoots,
                  up: composed.page.up,
                  down: composed.page.down,
                  group: composed.page.group ?? true,
                  groupMode,
                  vars: bmVars,
                  expansions: bmExpansions,
                }, 'ai');
                createdBookmarks.push({
                  id: savedBm.bookmark?.id ?? null,
                  name: bmName,
                  functions: g.fnIds.map((id) => id.split('::').pop()),
                  vars: bmVars.map((id) => id.replace(/^var::/, '')),
                  tasks: g.taskNames,
                });
              }
            });
          } else if (!COMPARISON && typeof args.bookmarkName === 'string' && args.bookmarkName.trim()) {
            const bmName = args.bookmarkName.trim().slice(0, 60);
            try {
              const savedBm = saveBookmarkWithEvent({
                name: bmName,
                roots: composed.page.roots || [],
                up: composed.page.up ?? 0,
                down: composed.page.down ?? 0,
                group: composed.page.group ?? true,
                groupMode: composed.page.groupMode || 'file',
                vars: composed.page.vars || [],
                expansions: composed.page.expansions || [],
              }, 'ai');
              createdBookmarks.push({ id: savedBm.bookmark?.id ?? null, name: bmName });
            } catch { /* ignore */ }
          }
          if (createdBookmarks.length) broadcastChange('bookmark.save', 'ai', { projectId: PROJECT.id });
          // 组图成功后再仅对本次选入画布/书签的变更节点与新增连线写入变更分类（避免未选节点或报错时误写标注）。
          if (!COMPARISON && args.fromGit && (detectedNodeChanges.size || detectedAddedEdges.length)) {
            const scopedNodeIds = new Set([...allGroupCanvasIds, ...actualFnIds, ...scopes.flatMap(g => g.varIds), ...(composed.page.vars || [])]);
            store.transaction(() => {
              overlay.nodes = overlay.nodes || {};
              overlay.edges = overlay.edges || {};
              for (const [id, ch] of detectedNodeChanges) {
                if (!scopedNodeIds.has(id) || !MODEL._index?.byId?.has(id)) continue;
                const prevColor = overlay.nodes?.[id]?.color;
                const patch = prevColor ? { change: ch } : { change: ch, color: null };
                const merged = writeAnnotation('node', id, patch, 'ai');
                if (merged) overlay.nodes[id] = merged;
              }
              const edgeIdx = sourceEdgeIndex(MODEL);
              for (const e of detectedAddedEdges) {
                if (!scopedNodeIds.has(e.from) || !scopedNodeIds.has(e.to)) continue;
                const live = edgeIdx.exact.get(edgeKeyOf(e)) || edgeIdx.pairs.get(`${e.from}->${e.to}`);
                if (!live) continue;
                const key = annotationEdgeKey(overlay.edges, live, MODEL);
                const merged = writeAnnotation('edge', key, { change: 'added' }, 'ai');
                if (merged) overlay.edges[key] = merged;
              }
            });
          }
          // 自动将画布上可达的 TASK 周期（含函数头注释中的周期）以线段标签（TASK:xms）形式标出，替代函数左上角角标。
          let autoTaskLabels = 0;
          if (!COMPARISON && includeTasks) {
            try {
              const labelModel = MODEL;
              const detected = await analyzeTasks(labelModel, { onlyIds: allGroupCanvasIds });
              assertActive();
              const taskItems = [];
              const seenEdge = new Set();
              for (const s of detected.suggestions || []) {
                if (s.kind !== 'task' || !allGroupCanvasIds.has(s.from) || !allGroupCanvasIds.has(s.to)) continue;
                if (seenEdge.has(s.edgeKey)) continue;
                const existingLabels = normalizeLabels(overlay.edges?.[s.edgeKey]?.labels ?? overlay.edges?.[s.edgeKey]?.label);
                if (existingLabels.some((l) => l.preset === 'task')) continue;
                seenEdge.add(s.edgeKey);
                taskItems.push({ edgeKey: s.edgeKey, preset: 'task', text: s.text });
              }
              if (taskItems.length && MODEL === labelModel) {
                const applied = applyMcpTaskLabels({ items: taskItems, merge: true });
                autoTaskLabels = applied.edgeKeys?.length || 0;
              }
            } catch { /* 自动 TASK 线段标签不影响主组图结果 */ }
          }
          // 后台为有变更的函数预生成并保存流程图（带修改前后颜色对比）
          if (sessionCurrent() && !COMPARISON && gitComparison) {
            const changedEntries = actualFnIds
              .filter((id) => ['modified', 'added'].includes(detectedNodeChanges.get(id)))
              .map((id) => ({ id, change: detectedNodeChanges.get(id) }));
            if (changedEntries.length) {
              prewarmChangedFlowcharts(PROJECT.id, MODEL, changedEntries, gitComparison.beforeModel, gitComparison.beforePath);
            }
          }
          return {
            ok: true,
            editable: !COMPARISON,
            addedCount: new Set([...actualFnIds, ...scopes.flatMap(g => [...g.varIds, ...g.sourceWriterIds])]).size,
            autoTaskLabels,
            ...(createdBookmarks.length ? { bookmarks: createdBookmarks, activeBookmark: createdBookmarks[0].name } : {}),
            roots: composed.page.roots.slice(0, 30),
            vars: composed.page.vars.slice(0, 20),
            resolved: actualFnIds,
            ambiguous: [...fnRes.ambiguous, ...varRes.ambiguous],
            notFound: [...fnRes.notFound, ...varRes.notFound],
            untracedIds: composed.untracedIds || [],
            ...(composed.updatedWhileReviewing ? { updatedWhileReviewing: true, reviewNote: composed.reviewNote } : {}),
            ...(fallbackNote ? { note: fallbackNote } : {}),
          };
        }
        if (name === 'apply_labels') {
          if (COMPARISON) return { ok: false, error: '当前处于比较视图（只读），退出比较后才能写入标签' };
          let rawItems = Array.isArray(args.items) ? args.items : [];
          if (!rawItems.length && args.autoDetect) {
            const model = MODEL;
            const labelCtx = await collectCanvasLabelContext(model, latestPage());
            if (MODEL !== model) return { ok: false, error: '源码已刷新，请重新检测标签' };
            rawItems = labelCtx.suggestedLabels;
            if (!rawItems.length) {
              return { ok: true, applied: 0, edgeKeys: [], note: '当前画布上没有缺失的 TASK 或 コール順 候选标签' };
            }
          }
          if (!rawItems.length) return { ok: false, error: 'items 不能为空（或传 autoDetect: true 自动补全当前画布标签）' };
          const items = [];
          const seenEdgePreset = new Set();
          for (const item of rawItems) {
            const from = resolveSymbols(MODEL, [item.from], 'fn');
            const to = resolveSymbols(MODEL, [item.to], 'fn');
            if (!from.resolved.length || !to.resolved.length) {
              return {
                ok: false,
                error: `无法解析连线端点：${item.from} -> ${item.to}`,
                ambiguous: [...from.ambiguous, ...to.ambiguous],
                notFound: [...from.notFound, ...to.notFound],
              };
            }
            const lineSuffix = Number.isInteger(Number(item.line)) && Number(item.line) > 0 ? `:${Number(item.line)}` : '';
            const edgeKey = `${from.resolved[0]}->${to.resolved[0]}${lineSuffix}`;
            const dedupeKey = `${edgeKey}|${item.preset}`;
            if (seenEdgePreset.has(dedupeKey)) continue;
            seenEdgePreset.add(dedupeKey);
            items.push({
              edgeKey,
              preset: item.preset,
              ...(item.text !== undefined ? { text: String(item.text) } : {}),
              ...(item.order !== undefined ? { order: Number(item.order) } : {}),
              ...(item.preset !== 'call' && item.note !== undefined ? { note: String(item.note) } : {}),
            });
          }
          assertActive();
          const applied = applyMcpTaskLabels({ items, merge: true });
          return { ok: true, applied: applied.edgeKeys?.length || 0, edgeKeys: applied.edgeKeys || [], ...reviewWriteResult() };
        }
        return { ok: false, error: `未知工具：${name}` };
      };

      try {
        const gitInfo = MODEL.parserId === 'dot' ? null : await quickGitDirtySummary(COMPARISON?.projectPath || root).catch(() => null);
        assertActive();
        const tasks = MODEL.parserId === 'dot' ? [] : projectTasks(MODEL).slice(0, 10).map(t => t.name);
        const sanitizeUiContext = (raw) => {
          if (!raw || typeof raw !== 'object') return null;
          const sanitizeNode = (n) => (!n || typeof n !== 'object' ? null : {
            kind: 'node',
            id: String(n.id || '').slice(0, 200),
            name: String(n.name || '').slice(0, 120),
            nodeKind: n.nodeKind === 'var' || n.kind === 'var' ? 'var' : 'fn',
            file: String(n.file || '').slice(0, 200),
            line: Number(n.line) || 0,
            change: String(n.change || 'existing').slice(0, 32),
          });
          const sanitizeEdge = (e) => (!e || typeof e !== 'object' ? null : {
            kind: 'edge',
            edgeKey: String(e.edgeKey || '').slice(0, 320),
            from: String(e.from || '').slice(0, 200),
            to: String(e.to || '').slice(0, 200),
            fromName: String(e.fromName || '').slice(0, 120),
            toName: String(e.toName || '').slice(0, 120),
            line: Number(e.line) || 0,
            edgeKind: String(e.edgeKind || 'direct').slice(0, 32),
            change: String(e.change || 'existing').slice(0, 32),
            labels: (Array.isArray(e.labels) ? e.labels : []).slice(0, 8).map((l) => ({
              preset: String(l?.preset || '').slice(0, 24),
              text: String(l?.text || '').slice(0, 80),
              ...(l?.note ? { note: String(l.note).slice(0, 120) } : {}),
            })),
          });
          const sanitizeFile = (f) => (!f || typeof f !== 'object' ? null : {
            kind: 'file',
            path: String(f.path || '').slice(0, 240),
            containerKind: f.containerKind === 'dir' ? 'dir' : 'file',
            label: String(f.label || '').slice(0, 120),
          });
          if (raw.kind === 'node') {
            const node = sanitizeNode(raw);
            return node ? { ...node, selectedNode: node } : null;
          }
          if (raw.kind === 'edge') {
            const edge = sanitizeEdge(raw);
            return edge ? { ...edge, selectedEdge: edge } : null;
          }
          if (raw.kind === 'file') {
            const file = sanitizeFile(raw);
            return file ? { ...file, selectedFile: file } : null;
          }
          const out = {};
          if (raw.selectedNode) out.selectedNode = sanitizeNode(raw.selectedNode);
          if (raw.selectedEdge) out.selectedEdge = sanitizeEdge(raw.selectedEdge);
          if (raw.selectedFile) out.selectedFile = sanitizeFile(raw.selectedFile);
          return Object.keys(out).length ? out : null;
        };
        const uiContext = sanitizeUiContext(p.uiContext);
        const context = {
          projectName: PROJECT.name,
          fnCount: MODEL.functions?.length || 0,
          varCount: MODEL.variables?.length || 0,
          canvasRoots: (latestPage()?.roots || []).slice(0, 12),
          isGitRepo: Boolean(gitInfo?.isRepo),
          gitDirtyFiles: gitInfo?.isRepo ? gitInfo.dirtyFiles : [],
          tasks,
          ...(uiContext ? { uiContext } : {}),
        };
        await runAiAgent({
          config: cfg,
          prompt,
          history: p.history || [],
          context,
          executeTool: executeAiTool,
          onEvent: sendEvent,
          signal: abort.signal,
        });
      } catch (err) {
        sendEvent({ type: 'error', error: String(err?.message || err) });
      } finally {
        req.off('close', cancel);
        res.off('close', cancel);
        if (!res.writableEnded) res.end();
      }
      return;
    }

    if (u.pathname === '/api/flowchart' && req.method === 'GET') {
      const { origin, host } = req.headers;
      if ((origin && (!LOCAL_ORIGIN.test(origin) || new URL(origin).host !== host.toLowerCase())) ||
          ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) {
        return json(res, { ok: false, error: 'forbidden origin' }, 403);
      }
      const base = MODEL, comparison = COMPARISON, project = PROJECT;
      const q = u.searchParams;
      const changed = () => !currentSession(req) || COMPARISON !== comparison || PROJECT.id !== project.id ||
        (q.has('projectId') && q.get('projectId') !== String(project.id)) ||
        (q.has('comparisonId') && q.get('comparisonId') !== (comparison?.id ?? ''));
      const conflict = () => json(res, { ok: false, error: '工程或比较版本已切换，请重新选择函数' }, 409);
      if (changed()) return conflict();
      const id = q.get('id');
      const version = q.get('version') ?? 'after';
      const expand = q.get('expandMacros') ?? '0';
      if (!id?.trim() || !['before', 'after'].includes(version) || !['0', '1'].includes(expand)) {
        return bad(res, '请传入有效的函数 ID、version 和 expandMacros');
      }
      const gitBefore = !comparison ? gitBeforeSnapshotByProject.get(project.id) : null;
      const beforeModel = comparison?.beforeModel || gitBefore?.beforeModel || null;
      const beforeRoot = comparison?.beforePath || gitBefore?.beforePath || undefined;
      const afterModel = comparison?.afterModel || base;
      const afterRoot = comparison?.afterPath || undefined;
      const model = version === 'before' ? beforeModel : afterModel;
      const otherModel = version === 'before' ? afterModel : beforeModel;
      const fn = model?._index?.byId?.get(id);
      if (!fn) return json(res, { ok: false, error: '此版本找不到该函数' }, 404);
      if (!isFlowchartFunction(fn)) return bad(res, '该节点没有可生成流程图的函数定义');
      const otherFn = otherModel?._index?.byId?.get(id) || null;
      const fnChange = comparison
        ? (comparisonStatus(comparison.model?._index?.byId?.get(id) || fn, comparison.statusOverrides.nodes, id)?.change || 'existing')
        : (overlay.nodes?.[id]?.change || 'existing');
      let otherSourceText = null;
      if (!comparison && version === 'after' && fnChange === 'modified' && !isFlowchartFunction(otherFn) && model.root) {
        otherSourceText = await readGitHeadFileText(model.root, fn.file);
        if (changed()) return conflict();
      }
      try {
        const result = await getOrBuildFlowchart(project.id, model, fn, {
          version, expandMacros: expand === '1',
          hasBefore: isFlowchartFunction(beforeModel?._index?.byId?.get(id)),
          hasAfter: isFlowchartFunction(afterModel?._index?.byId?.get(id)),
          sourceRoot: version === 'before' ? beforeRoot : afterRoot,
          fnChange,
          otherModel: isFlowchartFunction(otherFn) ? otherModel : null,
          otherFn: isFlowchartFunction(otherFn) ? otherFn : null,
          otherSourceText,
          otherSourceRoot: version === 'before' ? afterRoot : beforeRoot,
          signal: responseSignal(res),
        });
        return changed() ? conflict() : json(res, result);
      } catch (err) {
        return changed() ? conflict() : bad(res, err.message);
      }
    }

    if (['/api/source', '/api/mcp-changes'].includes(u.pathname) && req.method === 'GET') {
      if ((req.headers.origin && !LOCAL_ORIGIN.test(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') {
        return json(res, { ok: false, error: 'forbidden origin' }, 403);
      }
      if (mcpAccess() === 'off') return json(res, { ok: false, error: 'MCP 已禁用' }, 403);
      if (!currentSession(req) || (req.headers['x-callgraph-project'] !== undefined &&
          Number(req.headers['x-callgraph-project']) !== PROJECT.id)) {
        return json(res, { ok: false, error: '工程已切换，请重新调用' }, 409);
      }
      try {
        const source = u.pathname === '/api/source' ? await readMcpSource(u.searchParams) : await readMcpChanges(u.searchParams, req);
        if (!currentSession(req)) return sessionConflict(res);
        if (mcpAccess() === 'off') return json(res, { ok: false, error: 'MCP 已禁用' }, 403);
        return json(res, source);
      } catch (err) {
        if (!currentSession(req)) return sessionConflict(res);
        if (mcpAccess() === 'off') return json(res, { ok: false, error: 'MCP 已禁用' }, 403);
        return bad(res, err.message);
      }
    }

    if (['/api/mcp-compose', '/api/mcp-task-labels'].includes(u.pathname) && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      let payload;
      try { payload = await readJson(req, res); } catch { return; }
      if (mcpAccess() !== 'readwrite') return json(res, { ok: false, error: '需要 MCP 读写权限' }, 403);
      try {
        const needsVars = u.pathname === '/api/mcp-compose'
          ? (Array.isArray(payload.vars) && payload.vars.length) || (typeof payload.selected === 'string' && payload.selected.startsWith('var::'))
          : Array.isArray(payload.items) && payload.items.some(item => typeof item?.edgeKey === 'string' && item.edgeKey.includes('->var::'));
        if (needsVars && !COMPARISON && payload.snapshotId === undefined && MODEL.source !== 'dot') {
          await ensureAnalysis(MODEL);
          if (!currentSession(req)) return sessionConflict(res);
        }
        if (mcpAccess() !== 'readwrite') return json(res, { ok: false, error: '需要 MCP 读写权限' }, 403);
        return json(res, u.pathname === '/api/mcp-compose' ? composeMcpView(payload) : applyMcpTaskLabels(payload));
      } catch (err) {
        if (err.invalidIds) return json(res, { ok: false, error: err.message, invalidIds: err.invalidIds }, 400);
        return bad(res, err.message);
      }
    }

    // SSE 推送通道：页面（web/lib/live.js）连上后接收写操作广播。
    // 只 GET；跨站页面虽然读不到无 CORS 头的流，还是显式拒掉，不白占连接。
    if (u.pathname === '/api/stream') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'GET' });
        return res.end(JSON.stringify({ ok: false, error: '只支持 GET' }));
      }
      const origin = req.headers.origin;
      if (origin && !LOCAL_ORIGIN.test(origin)) {
        return json(res, { ok: false, error: 'forbidden origin' }, 403);
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n'); // 断开后浏览器自动重连的间隔
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      return;
    }

    // 页面当前视图状态：前端上报（POST）/ AI 经 cg_page 读取（GET）。
    // 当前页供 MCP 读取；最近的正常视图按工程保存，不广播、不进时间轴。
    if (u.pathname === '/api/page') {
      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        return readJson(req, res)
          .then((p) => {
            if (p.projectId != null && p.projectId !== PROJECT.id) return json(res, { ok: false, error: '工程已切换' }, 409);
            if (p.comparisonId !== undefined && p.comparisonId !== (COMPARISON?.id ?? null)) return sessionConflict(res);
            const key = 'ui.last-view.' + PROJECT.id;
            const revision = COMPARISON ? COMPARISON.composedPage?.revision ?? 0 : store.getSetting(key)?.revision ?? 0;
            const reviewing = Number(p.at) > 0;
            if (!reviewing && (!COMPARISON || COMPARISON.composedPage) && p.revision !== undefined && p.revision !== revision) {
              return json(res, { ok: false, error: '已有新版画布，旧视图未保存' }, 409);
            }
            const str = (v) => (typeof v === 'string' ? v : null);
            pageState = {
              ...viewSnapshot(p),
              projectId: PROJECT.id,
              ...(COMPARISON ? { comparisonId: COMPARISON.id } : {}),
              selected: str(p.selected),
              selectedEdge: str(p.selectedEdge),
              reviewing,
              at: Math.max(0, Number(p.at) || 0),
              ts: Date.now(),
              revision,
            };
            if ((pageState.roots.length || pageState.expansions.length || p.empty === true) && !pageState.reviewing) {
              const cam = p.cam && [p.cam.x, p.cam.y, p.cam.k].every(Number.isFinite) && p.cam.k > 0 ? p.cam : null;
              const ctxBox = p.ctxBox && ['file', 'dir'].includes(p.ctxBox.kind) && typeof p.ctxBox.id === 'string' ? p.ctxBox : null;
              const saved = { ...pageState, cam, ctxBox };
              if (!COMPARISON) store.setSetting(key, saved);
              else if (COMPARISON.composedPage) COMPARISON.composedPage = saved;
            }
            json(res, { ok: true });
          })
          .catch((err) => { if (!res.headersSent) bad(res, err.message); });
      }
      return json(res, {
        page: u.searchParams.has('saved') ? COMPARISON ? COMPARISON.composedPage || null : store.getSetting('ui.last-view.' + PROJECT.id) : pageState,
        project: PROJECT ? { id: PROJECT.id, name: PROJECT.name, path: root } : null,
        comparisonId: COMPARISON?.id ?? null,
        hint: pageState
          ? undefined
          : '还没有页面连上来过：打开应用页面后，这里会返回用户当前正在看的视图',
      });
    }

    if (u.pathname === '/api/view-event' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      let p;
      try { p = await readJson(req, res); } catch { return; }
      if (p.projectId != null && p.projectId !== PROJECT.id) return json(res, { ok: false, error: '工程已切换' }, 409);
      if (COMPARISON || pageState?.reviewing || p.reviewing === true || Number(p.at) > 0) {
        return json(res, { ok: true, ignored: true });
      }
      if (p.revision !== undefined && p.revision !== (store.getSetting('ui.last-view.' + PROJECT.id)?.revision ?? 0)) {
        return json(res, { ok: false, error: '已有新版画布，旧视图未保存' }, 409);
      }
      if (!['view.snapshot', 'view.clear'].includes(p.op) || !isPlainObject(p.view)) {
        return bad(res, '画布事件需要 view.snapshot 或 view.clear，以及视图参数');
      }
      let view;
      try { view = viewSnapshot(p.view); } catch (err) { return bad(res, err.message); }
      if (p.label !== undefined && typeof p.label !== 'string') return bad(res, 'label 必须是文字');
      const label = p.label?.trim() ?? '';
      const latest = store.latestEventId(PROJECT.id);
      if (isDeepStrictEqual(view, store.viewAt(PROJECT.id, latest))) {
        return json(res, { ok: true, deduplicated: true });
      }
      const eventId = store.appendEvent(PROJECT.id, {
        op: p.op, actor: 'user', target: label || view.roots[0] || '', after: { view },
        ctx: label ? { label } : null,
      });
      broadcastChange(p.op, 'user');
      return json(res, { ok: true, eventId });
    }

    // 自动挑入口函数（/api/view 与 /api/export/svg 共用）：优先入度为 0 的函数
    function pickEntryId() {
      if (!MODEL.functions.length) return null;
      const pool = MODEL.focusFile ? MODEL.functions.filter((f) => f.file === MODEL.focusFile) : MODEL.functions;
      const deg = (id) => (MODEL._index.outAdj.get(id) || []).length;
      const entries = pool
        .filter((f) => !(MODEL._index.inAdj.get(f.id) || []).length)
        .sort((a, b) => deg(b.id) - deg(a.id));
      return (entries[0] || [...pool].sort((a, b) => deg(b.id) - deg(a.id))[0] || MODEL.functions[0]).id;
    }

    // 服务端 SVG 导出：与界面「导出 SVG」同款样式，但由后端按当前视图数据直接生成，
    // MCP 与脚本都可调用（前端导出仍走浏览器侧，那条路能带上交互时的最新分组）
    if (u.pathname === '/api/export/svg' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then(async (p) => {
          const rootId = typeof p.root === 'string' && p.root ? p.root : pickEntryId();
          if (!rootId) return bad(res, '工程里没有函数，无从导出');
          const up = Math.max(0, Number(p.up ?? 0) || 0);
          const down = Math.max(0, Number(p.down ?? 3) || 3);
          const groupMode = resolveGroupMode(p.groupMode, p.group);
          // 导出与屏幕统一使用 ELK 排版。
          const view = await buildView([rootId], up, down, groupMode !== 'flat', null, { groupMode, signal: responseSignal(res) }, overlay);
          if (!currentSession(req)) return sessionConflict(res);
          if (!view.nodes || !view.nodes.length) return bad(res, '视图为空：入口函数不存在或全被删除');
          const svg = exportSvg(view, { title: PROJECT.name + ' / ' + rootId });
          let name = typeof p.out === 'string' ? p.out.trim() : '';
          if (!name) name = `view-${randomUUID()}.svg`;
          if (/[\\/]|\.\./.test(name)) return bad(res, 'out 只能是 out/ 下的文件名');
          if (!/\.svg$/i.test(name)) name += '.svg';
          fs.mkdirSync(OUT, { recursive: true });
          const file = path.join(OUT, name);
          fs.writeFileSync(file, svg, 'utf8');
          json(res, { ok: true, path: file, bytes: Buffer.byteLength(svg), nodes: view.nodes.length, edges: view.edges.length });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    if (u.pathname === '/api/parsers' && req.method === 'GET') {
      const scanRoot = fs.statSync(root, { throwIfNoEntry: false })?.isFile() ? path.dirname(root) : root;
      const parsers = listParsers().map((parser) => {
        const options = parserOptionsFor(parser.id);
        const status = parser.available(options);
        const database = parser.id === 'clang-ast' && findCompileCommands(scanRoot, options.compileCommandsPath);
        return { id: parser.id, name: parser.name, available: status.ok, reason: status.reason || null,
          hasCompileCommands: !!(database && fs.statSync(database, { throwIfNoEntry: false })?.isFile()) };
      });
      return json(res, { ok: true, active: MODEL.parserId, configured: configuredParser(), parsers, fallbackReason: parserFallback });
    }

    if (u.pathname === '/api/parsers' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      switching = true;
      try {
        const { parserId, compileCommandsPath } = await readJson(req, res);
        if (!getParser(parserId) || typeof parserId !== 'string') return bad(res, '未知解析器');
        const isDot = fs.statSync(root).isFile() && /\.(dot|gv)$/i.test(root);
        if (isDot !== (parserId === 'dot')) return bad(res, '所选解析器与当前工程文件类型不匹配');
        if (compileCommandsPath !== undefined && (parserId !== 'clang-ast' ||
            (compileCommandsPath !== null && (typeof compileCommandsPath !== 'string'
              || !compileCommandsPath.trim() || compileCommandsPath.includes('\0'))))) {
          return bad(res, 'compileCommandsPath 必须是 Clang 编译数据库的文件路径');
        }
        const parserOptions = parserOptionsFor(parserId);
        if (compileCommandsPath !== undefined) parserOptions.compileCommandsPath = compileCommandsPath &&
          path.resolve(scanRootFor(root), compileCommandsPath);
        const { stats: st } = await openTarget(root, { selection: { parserId, parserOptions } });
        comparisonPreview = null;
        comparisonBase = null;
        broadcastChange('project.switch', 'user', { project: ROOT_LABEL, projectId: PROJECT.id, clientId: req.headers['x-callgraph-client'] });
        return json(res, { ok: true, active: MODEL.parserId, configured: configuredParser(), parser: parserInfo(), stats: st,
          warnings: MODEL.warnings });
      } catch (error) {
        if (!res.headersSent) return json(res, { ok: false, error: error.message }, 400);
      } finally { switching = false; }
      return;
    }

    if (u.pathname === '/api/parsers/diff' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      try {
        const { other, parserId = MODEL.parserId } = await readJson(req, res);
        if (typeof parserId !== 'string' || typeof other !== 'string' || !getParser(parserId) || !getParser(other)
            || parserId === other || [parserId, other].includes('dot') || MODEL.parserId === 'dot') {
          return bad(res, '请选择两个不同的源码解析器');
        }
        const targetPath = root;
        const isFile = (await fs.promises.stat(targetPath)).isFile();
        const { model: a } = await loadTargetModel(targetPath, isFile, parserId, parserOptionsFor(parserId, scanRootFor(targetPath)));
        const { model: b } = await loadTargetModel(targetPath, isFile, other, parserOptionsFor(other, scanRootFor(targetPath)));
        await Promise.all([ensureAnalysis(a), ensureAnalysis(b)]);
        if (!currentSession(req)) return sessionConflict(res);
        return json(res, { ok: true, a: parserId, b: other, ...diffParserModels(a, b),
          warnings: { a: a.warnings, b: b.warnings }, failedFiles: { a: a._df.failedFiles, b: b._df.failedFiles } });
      } catch (error) {
        if (!res.headersSent) return json(res, { ok: false, error: error.message }, 400);
      }
      return;
    }

    if (u.pathname === '/api/stats') {
      const tasks = () => COMPARISON ? [
        ...projectTasks(COMPARISON.beforeModel).map(task => ({ ...task, version: 'before' })),
        ...projectTasks(COMPARISON.afterModel).map(task => ({ ...task, version: 'after' })),
      ] : projectTasks(MODEL);
      if (u.searchParams.get('summary') === '1') {
        const { cycleGroups, selfLoops, ...stats } = S;
        return json(res, u.searchParams.get('tasks') === '1'
          ? { stats, parser: parserInfo(), projectId: PROJECT.id, tasks: tasks() } : { stats, parser: parserInfo() });
      }
      return json(res, {
        stats: S,
        parser: parserInfo(),
        projectId: PROJECT.id, tasks: tasks(),
        scheduleWarnings: COMPARISON ? [COMPARISON.beforeModel, COMPARISON.afterModel].flatMap(m => scheduleConfig(m).warnings)
          : scheduleConfig(MODEL).warnings,
        root,
        macros: MODEL.macros
          .filter((m) => m.raw && m.raw.trim())
          .map((m) => ({
            name: m.name,
            params: m.params,
            raw: m.raw,
            file: m.file,
            line: m.line,
            cond: m.cond,
          })),
        fnptrTables: MODEL.fnptrTables,
        files: MODEL.files,
        cycles: S.cycleGroups,
        deleted: {
          nodes: Object.keys(overlay.deleted.nodes).length,
          edges: Object.keys(overlay.deleted.edges).length,
        },
      });
    }

    if (u.pathname === '/api/tree') {
      return json(res, buildFileTree(MODEL));
    }

    // 当前工程身份：前端用它显示工程名、判断是否需要提示「代码已变更」
    if (u.pathname === '/api/project') {
      const fp = fingerprintFiles(MODEL.files);
      return json(res, {
        id: PROJECT.id,
        name: PROJECT.name,
        path: root,
        focusFile: MODEL.focusFile || null,
        fingerprint: fp,
        scannedFingerprint: PROJECT.prevFingerprint || PROJECT.fingerprint,
        changed: !!PROJECT.prevFingerprint && PROJECT.prevFingerprint !== fp,
        db: store.file,
        parser: parserInfo(),
        parserFallback,
        comparison: comparisonInfo(),
      });
    }

    // 最近打开的工程列表，供启动页选择
    if (u.pathname === '/api/projects') {
      return json(
        res,
        store.listProjects(50).map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          pinned: !!p.pinned,
          openedAt: p.opened_at,
          fingerprint: p.fingerprint,
          current: p.id === PROJECT.id,
        }))
      );
    }

    // 管理最近工程：重命名仅改显示名，移出列表不删除源码或存档。
    if (['/api/projects/rename', '/api/projects/remove'].includes(u.pathname) && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      try {
        const p = await readJson(req, res);
        if (!Number.isSafeInteger(p.id) || !store.getProject(p.id)) return bad(res, '工程不存在');
        if (u.pathname.endsWith('/rename')) {
          const project = store.renameProject(p.id, p.name);
          if (p.id === PROJECT.id) { PROJECT.name = project.name; ROOT_LABEL = project.name; }
          return json(res, { ok: true, project: { id: project.id, name: project.name } });
        }
        store.removeProject(p.id);
        return json(res, { ok: true });
      } catch (err) {
        if (!res.headersSent) return bad(res, String(err.message || err));
      }
      return;
    }

    if (u.pathname === '/api/git/status' && req.method === 'GET') {
      return json(res, await inspectGitRepo(COMPARISON?.projectPath || root));
    }
    if (u.pathname === '/api/compare' && req.method !== 'POST') return json(res, { comparison: comparisonInfo() });
    if (u.pathname === '/api/compare/status' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      const p = await readJson(req, res);
      if (!COMPARISON || p.comparisonId !== COMPARISON.id) return json(res, { ok: false, error: '比较已切换，请刷新后重试' }, 409);
      if (p.actor === 'ai') return bad(res, 'AI 请读取比较自动判定，人工状态调整仅供用户使用');
      if (p.change !== null && !CHANGE_STATES.includes(p.change)) return bad(res, '状态必须是未修改、修改、新增、删除，或恢复自动判断');
      const isNode = typeof p.nodeId === 'string';
      const isEdge = typeof p.edgeId === 'string';
      if (isNode === isEdge) return bad(res, '必须指定一个节点或连线');
      let target = isNode ? MODEL._index.byId.get(p.nodeId) : MODEL.edges.find((e) => (e.comparisonKey || edgeKeyOf(e)) === p.edgeId);
      if (!target && isEdge) {
        const header = (MODEL.headerEdges || []).find((e) => edgeKeyOf(e) === p.edgeId);
        if (header) target = { ...header, change: 'existing' };
      }
      if (!target && isEdge) {
        for (const slot of Object.values(overlay.layout || {})) {
          const manual = (slot.manual || []).find((e) => edgeKeyOf({ ...e, line: 0 }) === p.edgeId);
          if (manual) { target = { ...manual, line: 0, kind: 'manual', change: 'existing' }; break; }
        }
      }
      if (!target) return bad(res, '对象不在当前比较中');
      const id = isNode ? p.nodeId : p.edgeId;
      const overrides = COMPARISON.statusOverrides[isNode ? 'nodes' : 'edges'];
      if (p.change === null) overrides.delete(id); else overrides.set(id, p.change);
      COMPARISON.summary = statusSummary(COMPARISON);
      broadcastChange('comparison.status', p.actor === 'ai' ? 'ai' : 'user', { comparisonId: COMPARISON.id });
      return json(res, { ok: true, target: comparisonStatus(target, overrides, id), comparison: comparisonInfo() });
    }
    if (u.pathname === '/api/compare/cancel' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      const p = await readJson(req, res);
      if (comparisonPreview?.id === p.previewId) comparisonPreview = null;
      return json(res, { ok: true });
    }
    if (['/api/compare', '/api/compare/apply', '/api/compare/exit'].includes(u.pathname) && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      const activate = u.pathname !== '/api/compare';
      if (activate) switching = true;
      try {
        const p = await readJson(req, res);
        if (u.pathname.endsWith('/exit')) {
          if (COMPARISON && comparisonBase) {
            sessionRevision++;
            ({ MODEL, S, overlay, pageState } = comparisonBase);
            COMPARISON = null;
            comparisonBase = null;
          }
          comparisonPreview = null;
        } else if (u.pathname.endsWith('/apply')) {
          if (p.actor === 'ai' && (Object.keys(p.statusOverrides ?? {}).length || p.resetStatusIds?.length)) {
            return bad(res, 'AI 请使用比较自动判定，人工状态调整仅供用户使用');
          }
          const preview = comparisonPreview;
          if (!preview || p.previewId !== preview.id || preview.model !== MODEL || preview.projectId !== PROJECT.id) {
            return json(res, { ok: false, error: '比较预览已失效，请重新解析' }, 409);
          }
          const ids = (value, name) => {
            if (!Array.isArray(value) || value.length > 600 || value.some((id) => typeof id !== 'string')) throw new Error(`${name} 必须是最多 600 项的标识数组`);
            return [...new Set(value)];
          };
          const selected = ids(p.selectedIds, '选择项');
          if (!selected.length && !preview.refresh) throw new Error('请至少选择一个函数或变量');
          if (selected.some((id) => !preview.candidateIds.has(id))) throw new Error('选择项不在本次比较结果中');
          const comparison = preview.comparison;
          const statuses = { nodes: statusOverrides(p.statusOverrides, preview.candidateIds), edges: new Map() };
          if (preview.refresh) {
            const resetIds = new Set(ids(p.resetStatusIds || [], '恢复自动判定项'));
            for (const [id, status] of COMPARISON.statusOverrides.nodes) {
              if (comparison.model._index.byId.has(id) && !resetIds.has(id) && !statuses.nodes.has(id)) {
                statuses.nodes.set(id, status);
              }
            }
            const edgeIds = new Set([...comparison.model.edges, ...(comparison.model.headerEdges || [])]
              .map(edge => edge.comparisonKey || edgeKeyOf(edge)));
            for (const slot of Object.values(overlay.layout || {})) {
              for (const edge of slot.manual || []) {
                if (comparison.model._index.byId.has(edge.from) && comparison.model._index.byId.has(edge.to)) {
                  edgeIds.add(edgeKeyOf({ ...edge, line: 0 }));
                }
              }
            }
            for (const [id, status] of COMPARISON.statusOverrides.edges) {
              if (edgeIds.has(id)) statuses.edges.set(id, status);
            }
          }
          const retained = ids(p.retainIds || [], '保留项').filter((id) => MODEL._index.byId.has(id) && comparison.model._index.byId.has(id));
          const roots = [...new Set([...retained, ...selected])];
          if (roots.length > 600) throw new Error('保留与选择的节点合计超过 600 个，请减少选择');
          const nextStats = stats(comparison.model);
          const nextOverlay = structuredClone(overlay);
          const chosen = new Set(selected);
          for (const id of selected) delete nextOverlay.deleted.nodes[id];
          for (const edge of comparison.model.edges) if (chosen.has(edge.from) || chosen.has(edge.to)) delete nextOverlay.deleted.edges[edgeKeyOf(edge)];
          if (!comparisonBase) comparisonBase = { MODEL, S, overlay, pageState };
          sessionRevision++;
          COMPARISON = { ...comparison, roots, statusOverrides: statuses, id: randomUUID(), previousComparisonId: COMPARISON?.id,
            totalNodes: comparison.model._index.byId.size };
          COMPARISON.summary = statusSummary(COMPARISON);
          MODEL = comparison.model;
          ROOT_LABEL = PROJECT.name;
          S = nextStats; pageState = null;
          // 原图的标注、手工关系仍可见；主动选择的对象允许重新入图。
          overlay = nextOverlay;
          comparisonPreview = null;
          // 进入比较视图后，后台预生成并保存有变更函数的流程图（带修改前后对比色）
          const changedFlowTargets = [...(COMPARISON.afterModel?.functions || [])]
            .filter((n) => {
              const merged = COMPARISON.model?._index?.byId?.get(n.id);
              const st = merged ? comparisonStatus(merged, COMPARISON.statusOverrides.nodes, n.id).change : 'existing';
              return ['modified', 'added'].includes(st);
            })
            .map((n) => ({
              id: n.id,
              change: comparisonStatus(COMPARISON.model._index.byId.get(n.id), COMPARISON.statusOverrides.nodes, n.id).change,
            }));
          if (changedFlowTargets.length) {
            prewarmChangedFlowcharts(PROJECT.id, COMPARISON.afterModel, changedFlowTargets,
              COMPARISON.beforeModel, COMPARISON.beforePath, COMPARISON.afterPath);
          }
        } else {
          const requestId = ++comparisonRequest;
          const model = MODEL;
          const projectPath = COMPARISON?.projectPath || root;
          const git = COMPARISON?.git;
          const refresh = p.mode === 'git' && p.refresh === true && git?.targetRef === 'WORKTREE' &&
            p.baseRef === git.baseRef && p.targetRef === git.targetRef && (p.includeUntracked !== false) === git.includeUntracked;
          const parserOpts = { parserId: MODEL.parserId, parserOptions: parserOptionsFor(MODEL.parserId) };
          const comparison = p.mode === 'git'
            ? await compareGitProject(projectPath, { baseRef: p.baseRef, targetRef: p.targetRef, includeUntracked: p.includeUntracked },
              { ...parserOpts, allowEmptyRefresh: refresh, runComparison: compareProjects })
            : await compareProjects(projectPath, p.beforePath, p.afterPath, parserOpts);
          if (!currentSession(req) || MODEL !== model || requestId !== comparisonRequest) return sessionConflict(res);
          const candidates = (comparison.git?.noSourceChanges ? [] : [...comparison.model.functions, ...comparison.model.variables])
            .filter((n) => !n.external)
            .map((n) => ({ id: n.id, name: n.name, file: n.file, line: n.line, kind: n.kind, ...comparisonItem(n) }));
          comparisonPreview = comparison.model ? { id: randomUUID(), projectId: PROJECT.id, model: MODEL, comparison,
            refresh, candidateIds: new Set(candidates.map((n) => n.id)) } : null;
          return json(res, { ok: true, preview: { id: comparisonPreview?.id ?? null, projectId: PROJECT.id, refresh,
            summary: comparison.summary, warnings: comparison.warnings, mappings: comparison.mappings, candidates,
            git: comparison.git || null, ...comparisonMetadata(comparison),
            statusOverrides: refresh ? Object.fromEntries(COMPARISON.statusOverrides.nodes) : undefined,
            validRetainIds: comparison.model ? [...comparison.model._index.byId.keys()] : [] } });
        }
        broadcastChange('project.switch', p.actor === 'ai' ? 'ai' : 'user', { project: ROOT_LABEL, projectId: PROJECT.id, clientId: req.headers['x-callgraph-client'] });
        return json(res, { ok: true, comparison: comparisonInfo(), roots: COMPARISON?.roots || [] });
      } catch (err) {
        if (!res.headersSent) return json(res, { ok: false, error: String(err.message || err) }, 400);
      } finally { if (activate) switching = false; }
      return;
    }

    // 切换工程：重新解析目标并整体替换会话状态，前端拿到新统计后重载数据即可
    if (u.pathname === '/api/switch' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      // openTarget 里有 await（重建数据流索引），期间第二个切换请求会插进来
      // 交错改写 MODEL / PROJECT / overlay——A 工程的标注就可能写进 B 的 project_id。
      // 这里用一把简单的锁：切换期间再来的请求直接 409，让前端等上一次完成。
      switching = true;
      try {
        const p = await readJson(req, res);
        let targetPath = typeof p.path === 'string' ? p.path : '';
        if (!targetPath && p.id !== undefined) {
          const pr = store.getProject(Number(p.id));
          if (!pr) return bad(res, '工程不存在');
          targetPath = pr.path;
        }
        if (!targetPath) return bad(res, 'id 或 path 必须给一个');
        const { project, stats: st } = await openTarget(targetPath);
        comparisonPreview = null;
        comparisonBase = null;
        // 打开着的页面整体重载：跨工程没有任何状态可保留。
        broadcastChange('project.switch', p.actor === 'ai' ? 'ai' : 'user', { project: project.name, projectId: PROJECT.id, clientId: req.headers['x-callgraph-client'] });
        json(res, {
          ok: true,
          project: { id: project.id, name: project.name, path: root },
          parser: parserInfo(), parserFallback,
          stats: st,
        });
      } catch (err) {
        if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 400);
      } finally {
        switching = false;
      }
      return;
    }

    // 孤儿标注：库里指向已不存在的函数 / 连线的条目
    if (u.pathname === '/api/orphans') {
      const o = await collectOrphans();
      if (!o) return json(res, { ok: false, error: '工程已切换，请刷新后重试' }, 409);
      return json(res, { ...o, total: countOrphans(o) });
    }

    if (u.pathname === '/api/orphans/purge' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then(async (p) => {
          const o = await collectOrphans();
          if (!o || !currentSession(req)) return sessionConflict(res);
          const total = countOrphans(o);
          if (!total) return json(res, { ok: true, removed: 0 });
          // dry=1 只看会删什么，不动库——批量删除前先让用户能预览
          if (p.dry) return json(res, { ok: true, removed: 0, wouldRemove: total, detail: o });
          const removed = store.transaction(() => {
            const removed = store.purgeTargets(PROJECT.id, o);
            store.appendEvent(PROJECT.id, {
              op: 'orphan.purge',
              target: 'orphans',
              after: o,
              actor: p.actor === 'ai' ? 'ai' : 'user',
            });
            return removed;
          });
          reloadOverlay();
          broadcastChange('orphan.purge', p.actor === 'ai' ? 'ai' : 'user');
          json(res, { ok: true, removed: total, detail: removed });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    // 书签：把「入口集合 + 深度 + 模式」存成名字，一键跳回
    if (u.pathname === '/api/bookmarks') {
      if (req.method === 'GET') return json(res, { list: store.listBookmarks(PROJECT.id) });
      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        readJson(req, res)
          .then((p) => {
            try {
              // 状态 + 事件同一个事务：崩溃时要么都进库、要么都不进，
              // 不会出现「书签改了但时间轴没记」这种回放对不上的状态
              const r = saveBookmarkWithEvent(p);
              json(res, { ok: true, ...r });
            } catch (err) {
              bad(res, String(err.message || err));
            }
          })
          .catch((err) => {
            if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
          });
        return;
      }
    }

    if (u.pathname === '/api/bookmarks/rename' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then((p) => {
          const id = Number(p.id);
          if (!Number.isFinite(id) || id <= 0) return bad(res, 'id 必须是正整数');
          try {
            const result = store.transaction(() => {
              const prev = store.listBookmarks(PROJECT.id).find((b) => b.id === id);
              const bookmark = store.renameBookmark(PROJECT.id, id, p.name);
              if (!bookmark) throw new Error('找不到该书签');
              store.appendEvent(PROJECT.id, {
                op: 'bookmark.save',
                target: bookmark.name,
                before: prev ? bookmarkEventPayload(prev) : null,
                after: bookmarkEventPayload(bookmark),
              });
              return bookmark;
            });
            json(res, { ok: true, bookmark: result });
          } catch (err) {
            bad(res, String(err.message || err));
          }
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    if (u.pathname === '/api/bookmarks/delete' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then((p) => {
          const id = Number(p.id);
          if (!Number.isFinite(id) || id <= 0) return bad(res, 'id 必须是正整数');
          const ok = store.transaction(() => {
            const gone = store.listBookmarks(PROJECT.id).find((b) => b.id === id);
            const ok = store.deleteBookmark(PROJECT.id, id);
            // 删掉的整份内容进 before，将来要按事件重建才不至于只剩个名字
            if (ok) {
              store.appendEvent(PROJECT.id, {
                op: 'bookmark.delete',
                target: gone?.name || `#${id}`,
                before: gone ? bookmarkEventPayload(gone) : null,
              });
            }
            return ok;
          });
          json(res, { ok, removed: ok ? 1 : 0 });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    // 导出会话：标注 + 删除记录 + 手工布局 + 书签 + 操作历史，打成单个 .cgx
    if (u.pathname === '/api/session/export') {
      const withEvents = u.searchParams.get('events') !== '0';
      const eventsTotal = store.countEvents(PROJECT.id);
      const payload = {
        format: 'tcu-callgraph-session',
        version: 1,
        exportedAt: new Date().toISOString(),
        project: {
          name: PROJECT.name,
          path: root,
          fingerprint: fingerprintFiles(MODEL.files),
          functions: S.functions,
          edges: S.edges,
        },
        overlay: store.loadOverlay(PROJECT.id),
        manualNodes: loadManualNodes(PROJECT.id),
        bookmarks: store.listBookmarks(PROJECT.id),
        events: withEvents ? store.dumpEvents(PROJECT.id, 5000) : [],
        eventsTotal,
        eventsTruncated: withEvents && eventsTotal > 5000,
      };
      // 中文工程名不能直接塞进 header：HTTP 头是 latin1，Node 会抛
      // ERR_INVALID_CHAR，导出直接 500。按 RFC 5987 给一份 ASCII 兜底名 +
      // 一份 UTF-8 名（现代浏览器优先用 filename*）。
      const safe = String(PROJECT.name || 'session').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_') || 'session';
      const ascii = safe.replace(/[^\x20-\x7e]/g, '_') || 'session';
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${ascii}.cgx"; filename*=UTF-8''${encodeURIComponent(`${safe}.cgx`)}`,
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify(payload, null, 1));
    }

    // 导入会话：合并标注 / 删除记录 / 布局 / 书签。
    // 事件不导入——历史是每台机器自己的，混进来会打乱回放的先后顺序
    if (u.pathname === '/api/session/import' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res, 32 * 1024 * 1024)
        .then(async (p) => {
          if (!p || p.format !== 'tcu-callgraph-session') return bad(res, '不是 .cgx 会话文件');
          if (Number(p.version) > 1) return bad(res, `会话文件版本 ${p.version} 高于当前支持的 1`);
          if (p.overlay !== undefined && !isPlainObject(p.overlay)) return bad(res, 'overlay 必须是对象');
          if (p.bookmarks !== undefined && !Array.isArray(p.bookmarks)) return bad(res, 'bookmarks 必须是数组');

          if (MODEL.source !== 'dot' && Array.isArray(p.manualNodes) && p.manualNodes.some((item) => item?.kind === 'var')) {
            await ensureAnalysis(MODEL);
            if (!currentSession(req)) return sessionConflict(res);
          }

          const ov = p.overlay || {};
          const nodes = isPlainObject(ov.nodes) ? ov.nodes : {};
          const edges = isPlainObject(ov.edges) ? ov.edges : {};
          const layoutSlots = isPlainObject(ov.layout) ? ov.layout : {};
          const delNodes = Object.keys(isPlainObject(ov.deleted?.nodes) ? ov.deleted.nodes : {});
          const delEdges = Object.keys(isPlainObject(ov.deleted?.edges) ? ov.deleted.edges : {});

          // 整段导入放一个事务：半路失败不留半份数据，也不会出现
          // 「标注进来了、事件没记」导致回放和现状对不上
          const result = store.transaction(() => {
            let annotations = 0;
            for (const [id, data] of Object.entries(nodes)) {
              // 值必须是对象：字符串/数字会变成 {...'abc'} 这种垃圾写进库
              if (!isPlainObject(data)) continue;
              // 会话文件是外部来源：框色不在固定四色内就丢弃，与标签规整同一思路
              if (data.color !== undefined && data.color !== null && !matchNodeColor(data.color)) {
                delete data.color;
              }
              store.setAnnotation(PROJECT.id, 'node', id, data);
              annotations++;
            }
            for (const [k, data] of Object.entries(edges)) {
              if (!isPlainObject(data)) continue;
              // 会话文件是外部来源：标签同样要过一遍规整，
              // 别把别人手改的颜色 / 超长文字写进库（多标签数组与旧版单条都收，落库统一成 labels）
              if (data.labels !== undefined) {
                data.labels = data.labels === null ? null : normalizeLabels(data.labels);
                data.label = null;
              } else if (data.label !== undefined) {
                const one = data.label === null ? null : normalizeLabel(data.label);
                data.label = null;
                data.labels = one ? [one] : null;
              }
              if (data.color !== undefined && data.color !== null && !matchNodeColor(data.color)) {
                delete data.color;
              }
              store.setAnnotation(PROJECT.id, 'edge', k, data);
              annotations++;
            }

            if (delNodes.length || delEdges.length) {
              store.setDeleted(PROJECT.id, { nodes: delNodes, edges: delEdges });
            }

            let layout = 0;
            for (const [key, slot] of Object.entries(layoutSlots)) {
              const idx = key.lastIndexOf('::');
              if (idx < 0 || !isPlainObject(slot)) continue;
              store.saveLayout(PROJECT.id, key.slice(0, idx), key.slice(idx + 2), {
                nodes: isPlainObject(slot.nodes) ? slot.nodes : {},
                edges: isPlainObject(slot.edges) ? slot.edges : {},
                manual: Array.isArray(slot.manual) ? slot.manual : [],
              });
              layout++;
            }

            let bookmarks = 0;
            for (const b of p.bookmarks || []) {
              try {
                if (!isPlainObject(b)) continue;
                store.saveBookmark(PROJECT.id, b);
                bookmarks++;
              } catch {
                /* 单条书签不合法不影响整体导入 */
              }
            }

            let importedManual = 0;
            if (Array.isArray(p.manualNodes)) {
              const mergedMap = new Map(loadManualNodes(PROJECT.id).map((item) => [item.id, item]));
              for (const rawItem of p.manualNodes) {
                if (!isPlainObject(rawItem)) continue;
                const kind = rawItem.kind === 'var' ? 'var' : rawItem.kind === 'fn' ? 'fn' : null;
                const file = sanitizeManualFile(rawItem.file);
                const name = sanitizeManualName(rawItem.name);
                if (!kind || !file || !name) continue;
                const id = kind === 'var' ? `var::${file}::${name}` : `${file}::${name}`;
                mergedMap.set(id, {
                  id,
                  kind,
                  file,
                  name,
                  typeText: kind === 'var' ? String(rawItem.typeText || '').trim().slice(0, 120) : '',
                });
                importedManual++;
              }
              saveManualNodes(PROJECT.id, [...mergedMap.values()]);
            }

            const pageKey = 'ui.last-view.' + PROJECT.id;
            const beforePage = store.getSetting(pageKey);
            const reconciled = reconcileManualVariables(MODEL, PROJECT.id, loadManualNodes(PROJECT.id), beforePage);
            if (reconciled.overlay && reconciled.page) store.setSetting(pageKey, reconciled.page);

            // 代码版本对不上时标注可能挂不到节点上，返回给前端提示
            const fp = fingerprintFiles(MODEL.files);
            const sameCode = !p.project?.fingerprint || p.project.fingerprint === fp;

            // 事件必须带**导入后的全量状态**：回放靠它把这一刻整体覆盖回来。
            // 只记几个计数的话，at=这一刻 重放出来是导入前的样子，restore 还会把导入的东西抹掉。
            store.appendEvent(PROJECT.id, {
              op: 'session.import',
              target: p.project?.name || 'session',
              after: {
                ...store.loadOverlay(PROJECT.id),
                manualNodes: manualNodesMap(reconciled.list),
                ...(reconciled.overlay && reconciled.page && { view: viewSnapshot(reconciled.page) }),
                summary: { annotations, layout, bookmarks, manualNodes: importedManual, sameCode },
              },
            });

            return { annotations, layout, bookmarks, manualNodes: importedManual, delNodes, delEdges, sameCode, reconciled };
          });

          applyManualNodes(MODEL, PROJECT.id, result.reconciled.list);
          if (result.reconciled.overlay && result.reconciled.page) pageState = result.reconciled.page;
          S = stats(MODEL);
          reloadOverlay();
          broadcastChange('session.import', 'user');
          json(res, {
            ok: true,
            sameCode: result.sameCode,
            from: p.project?.name || '',
            imported: {
              annotations: result.annotations,
              layout: result.layout,
              bookmarks: result.bookmarks,
              deleted: result.delNodes.length + result.delEdges.length,
            },
          });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    // 时间轴：分页 + 过滤。默认只回 brief，不回完整载荷
    if (u.pathname === '/api/events') {
      // 用 Number.isFinite 兜住 limit=abc 这种输入：Math.max(1, NaN) 还是 NaN，
      // 一路传进 SQL 的 LIMIT 会变成 datatype mismatch（500）
      const rawLimit = Number(u.searchParams.get('limit') ?? 50);
      const limit = Math.min(200, Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 50));
      const beforeId = Number(u.searchParams.get('before') || 0) || 0;
      const ops = (u.searchParams.get('ops') || '').split(',').filter(Boolean);
      const query = (u.searchParams.get('q') || '').trim();
      const withPayload = u.searchParams.get('detail') === '1';
      // 多取一条用来判断还有没有下一页，避免 count 和分页对不上
      const rows = store.listEventsPage(PROJECT.id, { limit: limit + 1, beforeId, ops, q: query, withPayload: true });
      const hasMore = rows.length > limit;
      return json(res, {
        latest: store.latestEventId(PROJECT.id),
        total: store.countEvents(PROJECT.id, { ops, q: query }),
        hasMore,
        events: rows.slice(0, limit).map((event) => timelineEvent(event, withPayload)),
      });
    }

    // 恢复到此：把历史某一刻的状态整体写回，并追加一条 restore_point 事件
    if (u.pathname === '/api/restore' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then(async (p) => {
          const at = Number(p.eventId);
          if (!Number.isFinite(at) || at <= 0) return bad(res, 'eventId 必须是正整数');
          const latest = store.latestEventId(PROJECT.id);
          if (at > latest) return bad(res, 'eventId 超出范围');
          let restored = store.overlayAt(PROJECT.id, at);
          let restoredView = store.viewAt(PROJECT.id, at);
          let restoredPage;
          // 覆盖状态与记 restore_point 必须同事务：否则中途崩溃会留下
          // 「状态已回退、时间轴上却看不出发生过恢复」的库，后续回放全乱
          let restoredManualList = Object.values(restored.manualNodes || {}).filter((item) => item && item.id && item.file && item.name);
          if (MODEL.source !== 'dot' && restoredManualList.some((item) => item.kind === 'var')) {
            await ensureAnalysis(MODEL);
            if (!currentSession(req)) return sessionConflict(res);
          }
          const eventId = store.transaction(() => {
            store.replaceOverlay(PROJECT.id, restored);
            saveManualNodes(PROJECT.id, restoredManualList);
            const reconciled = reconcileManualVariables(MODEL, PROJECT.id, restoredManualList, restoredView);
            if (reconciled.overlay) {
              restored = reconciled.overlay;
              restoredManualList = reconciled.list;
              restoredView = reconciled.page;
            }
            const eventId = store.appendEvent(PROJECT.id, {
              op: 'restore_point',
              target: `event#${at}`,
              after: restoredView ? { ...restored, view: restoredView } : restored,
              actor: p.actor === 'ai' ? 'ai' : 'user',
            });
            if (restoredView) {
              restoredPage = { ...restoredView, projectId: PROJECT.id, selected: null, selectedEdge: null,
                reviewing: false, at: 0, ts: Date.now(), revision: eventId };
              store.setSetting('ui.last-view.' + PROJECT.id, restoredPage);
            }
            return eventId;
          });
          // 同步内存镜像，后续请求直接读到恢复后的状态
          applyManualNodes(MODEL, PROJECT.id, restoredManualList);
          S = stats(MODEL);
          if (restoredPage) pageState = restoredPage;
          overlay.nodes = restored.nodes;
          overlay.edges = restored.edges;
          overlay.deleted = restored.deleted;
          overlay.layout = restored.layout;
          broadcastChange('restore_point', p.actor === 'ai' ? 'ai' : 'user');
          json(res, { ok: true, eventId, ...(restoredView ? { restoredView } : {}) });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    if (u.pathname === '/api/search') {
      const q = u.searchParams.get('q') || '';
      const list = search(MODEL, q, 40);
      return json(
        res,
        list.map((f) => ({
          id: f.id,
          name: f.name,
          file: f.file,
          line: f.line,
          isStatic: f.isStatic,
          inCount: (MODEL._index.inAdj.get(f.id) || []).length,
          outCount: (MODEL._index.outAdj.get(f.id) || []).length,
        }))
      );
    }

    if (u.pathname === '/api/view') {
      res.setHeader('X-Callgraph-Session', String(req.sessionRevision));
      const at = Number(u.searchParams.get('at') || 0);
      let emptyRequested = u.searchParams.get('empty') === '1';
      let useSnapshot = u.searchParams.get('useSnapshot') === '1';
      let previous = null;
      let expansions = [];
      let bodyRoots = null;
      let bodyVars = null, bodyHiddenVars = null;
      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        let body;
        try { body = await readJson(req, res); } catch { return; }
        emptyRequested ||= body.empty === true;
        useSnapshot ||= body.useSnapshot === true;
        try { expansions = normalizeExpansions(body.expansions); } catch (err) { return bad(res, err.message); }
        if (body.projectId != null && body.projectId !== PROJECT.id) return json(res, { error: '工程已切换，请重试' }, 409);
        if (body.roots !== undefined) {
          if (!Array.isArray(body.roots) || body.roots.length > 600 || body.roots.some((id) => typeof id !== 'string')) return bad(res, 'roots 必须是最多 600 项的标识数组');
          bodyRoots = body.roots;
        }
        for (const key of ['vars', 'hiddenVars']) if (body[key] !== undefined &&
          (!Array.isArray(body[key]) || body[key].some((id) => typeof id !== 'string'))) return bad(res, `${key} 必须是标识数组`);
        bodyVars = body.vars;
        bodyHiddenVars = body.hiddenVars;
        if (body.previous == null && !expansions.length && !bodyRoots?.length && !bodyVars?.length &&
            !bodyHiddenVars?.length && !u.searchParams.has('root') && !u.searchParams.has('roots') &&
            !emptyRequested && !(at > 0 && useSnapshot)) {
          return bad(res, '缺少增量布局、局部展开或入口参数');
        }
        previous = body.previous;
        if (previous != null) {
          for (const snapshot of [previous, previous.layoutSlots].filter(item => item != null)) {
            const rect = n => n && typeof n.id === 'string' &&
              [n.x, n.y, n.w, n.h].every(Number.isFinite) && n.w > 0 && n.h > 0;
            if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.edges) ||
                !Array.isArray(snapshot.groups) || !Array.isArray(snapshot.containers) ||
                ![snapshot.width, snapshot.height].every(Number.isFinite) ||
                ![...snapshot.nodes, ...snapshot.groups, ...snapshot.containers].every(rect)) {
              return bad(res, '增量布局数据无效');
            }
            const ids = new Set(snapshot.nodes.map(n => n.id));
            if (!snapshot.edges.every(e => e && ids.has(e.from) && ids.has(e.to) &&
                Array.isArray(e.points) && e.points.length >= 2 &&
                e.points.every(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) {
              return bad(res, '增量布局连线无效');
            }
          }
          const sameComparison = previous.comparisonId === COMPARISON?.id ||
            (COMPARISON && previous.comparisonId === COMPARISON.previousComparisonId);
          if (previous.projectId !== PROJECT.id || !sameComparison) return json(res, { error: '增量布局不属于当前工程或比较会话' }, 409);
        }
      }
      const rootsParam = u.searchParams.get('roots');
      const rootId = u.searchParams.get('root');
      const roots = bodyRoots || (rootsParam
        ? rootsParam.split(',').filter(Boolean)
        : rootId
        ? [rootId]
        : []);
      const up = Number(u.searchParams.get('up') ?? 1);
      const down = Number(u.searchParams.get('down') ?? 1);
      const groupMode = resolveGroupMode(u.searchParams.get('groupMode'), u.searchParams.get('group') !== '0');
      const group = groupMode !== 'flat';
      const prevMode = previous && (previous.groupMode || ((previous.groups.length || previous.layoutSlots?.groups?.length) ? 'file' : 'flat'));
      if (previous && prevMode !== groupMode) previous = null;
      const df = u.searchParams.get('df') || null;
      const split = (k) => (u.searchParams.get(k) ? u.searchParams.get(k).split(',').filter(Boolean) : []);
      const varSel = { want: bodyVars || split('vars'), skip: bodyHiddenVars || split('novars'), expansions,
        groupMode, preview: u.searchParams.get('preview') === '1', signal: responseSignal(res) };
      // 时间轴回看：at=<eventId> 时用重放出来的历史状态，而不是当前状态
      if (COMPARISON && at > 0) return bad(res, '比较视图不支持回看普通工程历史');
      const reviewSnapshot = at > 0 && useSnapshot ? store.viewAt(PROJECT.id, at) : undefined;
      const withReviewSnapshot = (view) => reviewSnapshot === undefined ? view : { ...view, reviewSnapshot };
      const viewOverlay = at > 0 ? store.overlayAt(PROJECT.id, at) : overlay;
      if (reviewSnapshot) {
        const histRoots = reviewSnapshot.empty ? [] : reviewSnapshot.roots;
        const histVars = { want: reviewSnapshot.vars || [], skip: reviewSnapshot.hiddenVars || [],
          expansions: reviewSnapshot.empty ? [] : reviewSnapshot.expansions || [], groupMode: reviewSnapshot.groupMode, signal: varSel.signal };
        if (!histRoots?.length && !histVars.expansions.length && !histVars.want.length) {
          return json(res, withReviewSnapshot(emptyCanvasView(reviewSnapshot.groupMode)));
        }
        const view = await buildView(histRoots, reviewSnapshot.up, reviewSnapshot.down, reviewSnapshot.group,
          null, histVars, viewOverlay);
        return json(res, withReviewSnapshot(view));
      }
      if (emptyRequested && !roots.length && !expansions.length && !varSel.want.length) {
        return json(res, withReviewSnapshot({
          ...emptyCanvasView(groupMode), ...(COMPARISON ? { comparison: comparisonInfo() } : {}),
        }));
      }
      if (!roots.length) {
        if (COMPARISON) return json(res, await buildView(COMPARISON.roots, 0, 0, group, null, varSel, viewOverlay, previous));
        if (expansions.length) {
          return json(res, withReviewSnapshot(await buildView([], up, down, group, df, varSel, viewOverlay, previous)));
        }
        if (emptyRequested) {
          return json(res, withReviewSnapshot(await buildView([], up, down, group, df, varSel, viewOverlay, previous)));
        }
        if (!MODEL.functions.length && !MODEL.headerSymbols?.length) {
          if (varSel.want.length) {
            return json(res, withReviewSnapshot(await buildView([], up, down, group, df, varSel, viewOverlay, previous)));
          }
          return json(res, withReviewSnapshot(emptyCanvasView(groupMode)));
        }
        // 默认：入度为 0 的入口函数（如 main / ISR）；单文件模式优先该文件
        const pool = MODEL.focusFile
          ? [...MODEL.functions, ...(MODEL.headerSymbols || [])].filter((f) => f.file === MODEL.focusFile)
          : MODEL.functions.length ? MODEL.functions : MODEL.headerSymbols;
        const deg = (id) => (MODEL._index.outAdj.get(id) || []).length;
        const entries = pool
          .filter((f) => !(MODEL._index.inAdj.get(f.id) || []).length)
          .sort((a, b) => deg(b.id) - deg(a.id));
        const pick = entries[0] || [...pool].sort((a, b) => deg(b.id) - deg(a.id))[0] || MODEL.functions[0] || MODEL.headerSymbols?.[0];
        return json(
          res,
          withReviewSnapshot(await buildView([pick.id], up, down, group, df, varSel, viewOverlay, previous))
        );
      }
      return json(res, withReviewSnapshot(await buildView(roots, up, down, group, df, varSel, viewOverlay, previous)));
    }

    if (u.pathname === '/api/trace-to-task' && req.method === 'GET') {
      if (!currentSession(req) || (req.headers['x-callgraph-project'] !== undefined &&
          Number(req.headers['x-callgraph-project']) !== PROJECT.id)) return sessionConflict(res);
      const q = u.searchParams, id = q.get('id');
      const offset = Number(q.get('offset') ?? 0), limit = Number(q.get('limit') ?? 32);
      if (!id || !Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        return bad(res, '需要节点 id，offset 为非负整数，limit 为 1 至 100 的整数');
      }
      let context;
      try { context = traceContext(id, q.get('version')); } catch (err) { return bad(res, err.message); }
      if (!context.model._index.byId.has(id)) return json(res, { ok: false, error: '此版本找不到该节点' }, 404);
      return json(res, { ok: true, id, traceVersion: context.traceVersion, ...traceToTasks(context.model, id, { offset, limit }) });
    }

    if (u.pathname === '/api/node') {
      const id = u.searchParams.get('id');
      const fn = MODEL._index.byId.get(id);
      if (!fn) return json(res, { error: 'not found' }, 404);
      const { model: traceModel, traceVersion } = traceContext(id);
      const getCallOrder = callOrderForEdges(MODEL, COMPARISON);
      const detailEdge = (e) => ({
        ...(COMPARISON ? comparisonStatus(e, COMPARISON.statusOverrides.edges, e.comparisonKey || edgeKeyOf(e))
          : { ...e, change: overlay.edges?.[annotationEdgeKey(overlay.edges, e, MODEL)]?.change || 'existing' }),
        callNumbers: getCallOrder(e),
      });
      const chain = new Set(fn.impactChainIds);
      return json(res, {
        node: publicNode(COMPARISON ? comparisonStatus(fn, COMPARISON.statusOverrides.nodes, id) : fn),
        traceVersion, ...traceToTasks(traceModel, id),
        callSequence: callSequence(COMPARISON?.afterModel || MODEL, id),
        ...(COMPARISON ? { previousCallSequence: callSequence(COMPARISON.beforeModel, id),
          changePoints: COMPARISON.changePoints.filter(point => chain.has(point.id)),
          macroDetails: COMPARISON.macroDetails.filter(macro => chain.has(macro.id)) } : {}),
        hidden: !COMPARISON && !!overlay.deleted.nodes[id],
        inEdges: (fn.headerSymbol ? (MODEL.headerEdges || []).filter((e) => e.to === id) : MODEL._index.inAdj.get(id) || [])
          .map(detailEdge),
        outEdges: (fn.headerSymbol ? (MODEL.headerEdges || []).filter((e) => e.from === id) : MODEL._index.outAdj.get(id) || [])
          .map(detailEdge),
        overlay: overlay.nodes?.[id] || {},
      });
    }

    if (u.pathname === '/api/dataflow/pair') {
      if (req.method !== 'POST') return json(res, { error: '只支持 POST' }, 405);
      if (!guardWrite(req, res)) return;
      let body;
      try { body = await readJson(req, res); } catch { return; }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          ![body.a, body.b].every(id => typeof id === 'string' && id.length > 0 && id.length <= 2048) || body.a === body.b) {
        return bad(res, '请选择两个不同的函数或变量');
      }
      const model = MODEL, comparison = COMPARISON, projectId = PROJECT.id;
      if (body.projectId !== projectId || body.comparisonId !== comparison?.id) return json(res, { error: '工程或比较会话已切换，请重新选择' }, 409);
      if (!comparison) await ensureAnalysis(model);
      if (!currentSession(req)) return sessionConflict(res);
      if (![body.a, body.b].every(id => model._index.byId.has(id))) return bad(res, '所选函数或变量不存在');
      const result = await (comparison ? comparisonPairDataflow(comparison, body.a, body.b) : pairDataflow(model, body.a, body.b));
      if (!currentSession(req)) return sessionConflict(res);
      return json(res, { ...result, projectId, comparisonId: comparison?.id });
    }

    // 数据流：按需分析，不在扫描阶段做
    if (u.pathname === '/api/dataflow') {
      const fnId = u.searchParams.get('fn');
      const dir = u.searchParams.get('dir') || 'out';
      if (!fnId) return json(res, { error: 'missing fn' }, 400);
      if (!MODEL._index) return json(res, { error: '该视图不支持数据流分析' }, 400);
      const comparison = COMPARISON, model = MODEL;
      if (!comparison) await ensureAnalysis(model);
      if (!currentSession(req)) return sessionConflict(res);
      return (comparison ? comparisonDataflow(comparison, fnId, dir) : dataflowFor(model, fnId, dir))
        .then((r) => {
          if (!currentSession(req)) return sessionConflict(res);
          if (!comparison && r.fn) r.fn.taskPeriods = taskPeriods(model).get(r.fn.id) || [];
          return json(res, r);
        })
        .catch((err) => {
          console.error('[数据流]', err);
          json(res, { ok: false, error: String(err.message || err) }, 500);
        });
    }

    if (u.pathname === '/api/vars') {
      if (COMPARISON) return json(res, { list: comparisonGlobals(COMPARISON) });
      const model = MODEL;
      await ensureAnalysis(model);
      if (!currentSession(req)) return sessionConflict(res);
      return listGlobals(model)
        .then((list) => currentSession(req) ? json(res, { list }) : sessionConflict(res))
        .catch((err) => json(res, { ok: false, error: String(err.message || err) }, 500));
    }

    if (u.pathname === '/api/shared-vars') {
      if (COMPARISON) {
        const records = [];
        for (const [version, m] of [['before', COMPARISON.beforeModel], ['after', COMPARISON.afterModel]]) {
          records.push(...(await sharedVariables(m)).map((v) => ({ ...v, version })));
        }
        return json(res, { list: records });
      }
      const model = MODEL;
      await ensureAnalysis(model);
      if (!currentSession(req)) return sessionConflict(res);
      return sharedVariables(model)
        .then((list) => currentSession(req) ? json(res, { list }) : sessionConflict(res))
        .catch((err) => json(res, { ok: false, error: String(err.message || err) }, 500));
    }

    if (u.pathname === '/api/export/xlsx') {
      // 随机文件名：并发导出不会互相覆盖，也不会读到别人写了一半的文件
      const out = path.join(OUT, `callgraph-${randomUUID()}.xlsx`);
      res.on('close', () => fs.unlink(out, () => {}));
      exportXlsx(MODEL, out);
      return sendFile(res, out, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="callgraph.xlsx"',
        'Cache-Control': 'no-store',
      });
    }

    if (u.pathname === '/api/export/html') {
      const rootId = u.searchParams.get('root');
      const up = Number(u.searchParams.get('up') ?? 1);
      const down = Number(u.searchParams.get('down') ?? 1);
      if (!rootId) return json(res, { error: 'missing root' }, 400);
      const model = MODEL, revision = sessionRevision;
      if (!COMPARISON && needsCounterAnalysis(model)) {
        await ensureAnalysis(model);
        if (revision !== sessionRevision || MODEL !== model) return sessionConflict(res);
      }
      const g = subgraph(MODEL, rootId, { up, down, maxNodes: 600 });
      if (COMPARISON) {
        g.nodes = g.nodes.map((n) => comparisonStatus(n, COMPARISON.statusOverrides.nodes, n.id));
        g.edges = g.edges.map((e) => comparisonStatus(e, COMPARISON.statusOverrides.edges, e.comparisonKey || edgeKeyOf(e)));
      }
      g.nodes = g.nodes.map((n) => withMacroName(n, overlay, macroNameDefault()));
      g.nodes = withTaskPeriods(g.nodes, MODEL, COMPARISON);
      const getCallOrder = callOrderForEdges(MODEL, COMPARISON);
      g.edges = g.edges.map(e => ({ ...e, callNumbers: getCallOrder(e) }));
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      const outAdj = new Map();
      const inAdj = new Map();
      for (const e of g.edges) {
        if (!outAdj.has(e.from)) outAdj.set(e.from, []);
        outAdj.get(e.from).push(e);
        if (!inAdj.has(e.to)) inAdj.set(e.to, []);
        inAdj.get(e.to).push(e);
      }
      const tmp = {
        ...MODEL,
        functions: g.nodes,
        edges: g.edges,
        _index: { byId, byName: new Map(), outAdj, inAdj },
      };
      const out = path.join(OUT, `view-${randomUUID()}.html`);
      res.on('close', () => fs.unlink(out, () => {}));
      await exportHtml(tmp, out, { root: g.root });
      return sendFile(res, out, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="callgraph.html"',
        'Cache-Control': 'no-store',
      });
    }

    if (u.pathname === '/api/manual-nodes' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      if (COMPARISON) return json(res, { ok: false, error: '比较视图仅供查看' }, 409);
      let body;
      try { body = await readJson(req, res); } catch { return; }
      if (!isPlainObject(body)) return bad(res, '请求体必须是对象');
      const kind = body.kind === 'var' ? 'var' : body.kind === 'fn' ? 'fn' : null;
      if (!kind) return bad(res, 'kind 必须是 fn 或 var');
      const file = sanitizeManualFile(body.file);
      if (!file) return bad(res, '文件路径无效');
      if (!MODEL.files.some((f) => f.rel === file && !f.manual)) {
        return bad(res, '请选择工程内已有的源码文件');
      }
      const name = sanitizeManualName(body.name);
      if (!name) return bad(res, '名称不能为空且不能包含 ::');
      const typeText = kind === 'var' ? String(body.typeText || '').trim().slice(0, 120) : '';
      const change = body.change == null ? 'existing' : String(body.change);
      if (!['existing', 'modified', 'added', 'deleted'].includes(change)) return bad(res, 'change 不合法');
      const id = kind === 'var' ? `var::${file}::${name}` : `${file}::${name}`;
      if (kind === 'var' && !MODEL._df && MODEL.source !== 'dot') {
        const model = MODEL;
        await ensureAnalysis(model);
        if (!currentSession(req) || MODEL !== model) return sessionConflict(res);
      }
      const globalVarConflict = kind === 'var' && variableConflicts(MODEL, { id, file, name }).length;
      if (MODEL._index?.byId?.has(id) || MODEL._df?.byId?.has(id) || globalVarConflict) {
        return json(res, { ok: false, error: `该文件中已存在同名${kind === 'var' ? '变量' : '函数'}：${name}` }, 409);
      }
      const list = loadManualNodes(PROJECT.id);
      if (list.some((item) => item.id === id)) {
        return json(res, { ok: false, error: `该文件中已存在同名${kind === 'var' ? '变量' : '函数'}：${name}` }, 409);
      }
      const entry = { id, kind, file, name, typeText };
      const node = injectManualNodeIntoModel(MODEL, entry);
      if (!node) return json(res, { ok: false, error: '无法添加该手工节点' }, 409);
      rebuildIndex(MODEL);
      store.transaction(() => {
        saveManualNodes(PROJECT.id, [...list, entry]);
        // 清理可能残留的旧同名节点标注，确保新建手工节点状态干净
        store.deleteAnnotation(PROJECT.id, 'node', id);
        if (overlay.nodes) delete overlay.nodes[id];
        if (change !== 'existing') {
          const merged = writeAnnotation('node', id, { change }, 'user');
          if (merged) {
            overlay.nodes = overlay.nodes || {};
            overlay.nodes[id] = merged;
          }
        }
        store.appendEvent(PROJECT.id, {
          op: 'manual.node.add',
          target: id,
          after: { ...entry, change },
          actor: 'user',
        });
      });
      S = stats(MODEL);
      broadcastChange('manual.node.add', 'user', { target: id });
      return json(res, { ok: true, node: { ...publicNode(node), change } });
    }

    if (u.pathname === '/api/manual-nodes/delete' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      if (COMPARISON) return json(res, { ok: false, error: '比较视图仅供查看' }, 409);
      let body;
      try { body = await readJson(req, res); } catch { return; }
      const id = typeof body?.id === 'string' ? body.id.trim() : '';
      if (!id) return bad(res, '缺少节点 id');
      const list = loadManualNodes(PROJECT.id);
      const existing = list.find((item) => item.id === id);
      if (!existing) return json(res, { ok: false, error: '找不到该手工节点' }, 404);
      const nextList = list.filter((item) => item.id !== id);
      // 仅移除 manual: true 的手工节点，绝不误删后来在源码中实现的同名真实函数/变量。
      MODEL.functions = (MODEL.functions || []).filter((n) => !(n.id === id && n.manual));
      MODEL.variables = (MODEL.variables || []).filter((n) => !(n.id === id && n.manual));
      if (MODEL._df) {
        MODEL._df.defs = MODEL._df.defs.filter((d) => !(d.id === id && d.manual));
        if (MODEL._df.byId.get(id)?.manual) MODEL._df.byId.delete(id);
      }
      if (MODEL.files.some((f) => f.rel === existing.file && f.manual) &&
          !MODEL.functions.some((f) => f.file === existing.file) &&
          !MODEL.variables.some((v) => v.file === existing.file)) {
        MODEL.files = MODEL.files.filter((f) => !(f.rel === existing.file && f.manual));
      }
      rebuildIndex(MODEL);
      const keptSourceSymbol = Boolean(MODEL._index?.byId?.has(id) || MODEL._df?.byId?.has(id));
      store.transaction(() => {
        saveManualNodes(PROJECT.id, nextList);
        if (!keptSourceSymbol) {
          for (const [k, slot] of Object.entries(overlay.layout || {})) {
            if (!slot?.manual?.length) continue;
            const filtered = slot.manual.filter((m) => m.from !== id && m.to !== id);
            if (filtered.length !== slot.manual.length) {
              const sep = k.lastIndexOf('::');
              const rootKey = sep >= 0 ? k.slice(0, sep) : k;
              const mode = sep >= 0 && k.slice(sep + 2) === 'flat' ? 'flat' : 'group';
              overlay.layout[k] = store.saveLayout(PROJECT.id, rootKey, mode, { manual: filtered });
            }
          }
          store.deleteAnnotation(PROJECT.id, 'node', id);
          if (overlay.nodes) delete overlay.nodes[id];
          store.setDeleted(PROJECT.id, 'node', id, false);
          delete overlay.deleted.nodes[id];
        }
        store.appendEvent(PROJECT.id, {
          op: 'manual.node.delete',
          target: id,
          before: existing,
          after: { keptSourceSymbol },
          actor: 'user',
        });
      });
      S = stats(MODEL);
      broadcastChange('manual.node.delete', 'user', { target: id });
      return json(res, { ok: true, id, keptSourceSymbol });
    }

    if (u.pathname === '/api/layout' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then((patch) => {
          if (patch.nodes !== undefined && !isPlainObject(patch.nodes)) return bad(res, 'nodes 必须是对象');
          if (patch.edges !== undefined && !isPlainObject(patch.edges)) return bad(res, 'edges 必须是对象');
          if (patch.manual !== undefined && !Array.isArray(patch.manual)) return bad(res, 'manual 必须是数组');
          if (patch.addManual !== undefined && !Array.isArray(patch.addManual)) return bad(res, 'addManual 必须是数组');
          if (patch.removeManual !== undefined && !Array.isArray(patch.removeManual)) return bad(res, 'removeManual 必须是数组');
          const mode = patch.mode === 'group' ? 'group' : 'flat';
          const rootId = remapLayoutRoot(String(patch.root || ''), MODEL);
          const key = layoutKey(rootId, mode);
          const hasManualOp = patch.manual !== undefined || patch.addManual !== undefined || patch.removeManual !== undefined;
          const migrated = patch.clear || hasManualOp
            ? legacyManualKeys(overlay.layout || {}, rootId, mode, MODEL) : [];
          const slot = store.transaction(() => {
            const before = store.getLayout(PROJECT.id, rootId, mode);
            let nextManual = patch.manual;
            if (nextManual === undefined && (patch.addManual !== undefined || patch.removeManual !== undefined)) {
              const merged = [];
              const seen = new Set();
              const removed = new Set((patch.removeManual || []).map((m) => `${m?.from}\u0000${m?.to}`));
              const legacy = migrated.flatMap((key) => overlay.layout[key].manual);
              for (const m of [...legacy, ...(before.manual || []), ...(patch.addManual || [])]) {
                if (!m || typeof m.from !== 'string' || typeof m.to !== 'string') continue;
                const mk = `${m.from}\u0000${m.to}`;
                if (removed.has(mk) || seen.has(mk)) continue;
                seen.add(mk);
                merged.push({ from: m.from, to: m.to });
              }
              nextManual = merged;
            }
            const slot = store.saveLayout(PROJECT.id, rootId, mode, {
              nodes: patch.nodes,
              edges: patch.edges,
              manual: nextManual,
              clear: !!patch.clear,
            });
            // 手工线是整组替换，清空旧别名的连线以免之后又被回退读取。
            for (const legacyKey of migrated) {
              store.saveLayout(PROJECT.id, legacyKey.slice(0, -mode.length - 2), mode, { manual: [] });
            }
            // 事件只存增量：nodeIds 是被写过的键，before 是它们原来的值
            store.appendEvent(PROJECT.id, {
              op: patch.clear ? 'layout.clear' : 'layout.save',
              target: key,
              before: {
                nodes: pickKeys(before.nodes, Object.keys(patch.nodes || {})),
                edges: pickKeys(before.edges, Object.keys(patch.edges || {})),
                manual: nextManual ? before.manual : undefined,
              },
              after: { nodes: patch.nodes || {}, edges: patch.edges || {}, manual: nextManual,
                clearedLegacyManual: migrated.length ? migrated : undefined, view: currentViewSnapshot() },
              actor: patch.actor === 'ai' ? 'ai' : 'user',
            });
            return slot;
          });
          overlay.layout = overlay.layout || {};
          overlay.layout[key] = slot;
          for (const legacyKey of migrated) overlay.layout[legacyKey].manual = [];
          broadcastChange(patch.clear ? 'layout.clear' : 'layout.save', patch.actor === 'ai' ? 'ai' : 'user');
          json(res, { ok: true });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    if (u.pathname === '/api/overlay' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then(async (patch) => {
          if (!isPlainObject(patch.data)) return bad(res, 'data 必须是对象');
          if (Object.keys(patch.data).some((key) => !['note', 'color', 'tag', 'change', 'nameMode', 'label', 'labels'].includes(key))) return bad(res, 'data 包含不支持的字段');
          if (patch.data.change !== undefined && ![null, 'existing', 'modified', 'added', 'deleted'].includes(patch.data.change)) return bad(res, 'change 不合法');
          if (patch.data.nameMode !== undefined && patch.data.nameMode !== null && !NAME_MODES.includes(patch.data.nameMode)) return bad(res, 'nameMode 必须是 alias / target，或 null（跟随设置）');
          if (patch.nodeId !== undefined && typeof patch.nodeId !== 'string') return bad(res, 'nodeId 必须是字符串');
          if (patch.edgeKey !== undefined && typeof patch.edgeKey !== 'string') return bad(res, 'edgeKey 必须是字符串');
          const ai = patch.actor === 'ai';
          let aiEdges;
          if (ai) {
            if (mcpAccess() !== 'readwrite') return json(res, { ok: false, error: '需要 MCP 读写权限' }, 403);
            if (!!patch.nodeId === !!patch.edgeKey) return bad(res, 'nodeId 与 edgeKey 必须二选一');
            if (Object.hasOwn(patch.data, 'color')) return bad(res, 'AI 标注请用 change 分类，节点与连线的颜色由分类决定');
            if (patch.edgeKey && patch.data.change === 'modified') return bad(res, '连线 change 只能是 existing / added / deleted，或 null 清除');
            if (patch.edgeKey && patch.data.nameMode !== undefined) return bad(res, 'nameMode 只用于节点');
            if (!MODEL._df && MODEL.source !== 'dot' && (patch.nodeId?.startsWith('var::') || patch.edgeKey?.includes('->var::'))) {
              await ensureAnalysis(MODEL);
              if (!currentSession(req)) return sessionConflict(res);
              if (mcpAccess() !== 'readwrite') return json(res, { ok: false, error: '需要 MCP 读写权限' }, 403);
            }
            if (patch.nodeId && !MODEL._index.byId.has(patch.nodeId)) return bad(res, `找不到节点：${patch.nodeId}`);
            // 历史数据可能用独立的底色覆盖分类；明确改变分类时一并恢复按分类着色。
            if (patch.nodeId && patch.data.change !== undefined) patch.data.color = null;
            if (patch.edgeKey) {
              aiEdges = mcpEdgeIndex();
              const edge = aiEdges.resolve(patch.edgeKey);
              if (!edge) return bad(res, `找不到实际连线：${patch.edgeKey}`);
              patch.edgeKey = annotationEdgeKey(overlay.edges, edge, MODEL);
            }
          } else if (patch.edgeKey?.includes('->var::')) {
            const edge = sourceEdgeIndex(MODEL).exact.get(patch.edgeKey);
            if (edge?.kind === 'var') patch.edgeKey = annotationEdgeKey(overlay.edges, edge, MODEL);
          }
          // 连线标签（一线可多条）：
          //   data.labels = 数组 → 整组替换（先读现有再合并提交，空数组=清空）
          //   data.label  = 旧版单条 → null 清空全部 / 对象则整组替换成这一条
          // 写入时同步把旧字段 label 清掉，回放（键级合并）才不会残留两份。
          if (patch.data.labels !== undefined || patch.data.label !== undefined) {
            if (ai && (!patch.edgeKey || (patch.data.labels !== undefined && patch.data.label !== undefined))) {
              return bad(res, '连线标签必须指定 edgeKey，且 label 与 labels 只能传一个');
            }
            let incoming = null; // 最终的整组标签；undefined 表示不动
            if (patch.data.labels !== undefined) {
              if (patch.data.labels !== null) {
                if (!Array.isArray(patch.data.labels)) return bad(res, 'labels 必须是数组或 null');
                if (patch.data.labels.length > LABELS_MAX) {
                  return bad(res, `一条连线最多 ${LABELS_MAX} 条标签`);
                }
                incoming = patch.data.labels;
              }
            } else if (patch.data.label !== null) {
              incoming = [patch.data.label];
            }
            if (incoming) {
              if (ai) {
                try {
                  incoming = incoming.map(normalizeAiLabel);
                  checkAiCallOrders(aiEdges, new Map([[patch.edgeKey, incoming]]));
                } catch (err) { return bad(res, err.message); }
              }
              // 结合点缺编号时替外部写入补全库最小未占用值
              //（界面会算好 num 传上来；MCP / 脚本通常只给 preset，
              //  不补的话每条都归一成 1，同一画面里全重号）。
              // 必须在 normalizeLabels 之前做：归一后 num 永远有值，分不清「没给」
              const used = Object.values(overlay.edges || {})
                .flatMap((o) => normalizeLabels(o ? o.labels ?? o.label : null));
              for (let i = 0; i < incoming.length; i++) {
                const rawItem = incoming[i];
                if (rawItem && rawItem.preset === 'conn' && !Number.isFinite(Number(rawItem.num))) {
                  const num = nextConnNumber(used);
                  incoming[i] = { ...rawItem, num };
                  used.push(incoming[i]);
                }
              }
              const given = incoming.length;
              incoming = normalizeLabels(incoming);
              if (given > 0 && !incoming.length) return bad(res, 'labels 里没有可用的标签');
              if (incoming && !incoming.length) incoming = null; // 空组等同清空
            }
            patch.data.labels = incoming; // null=清空；数组=新的一组
            patch.data.label = null; // 旧字段永远不再单独存在
          }
          // 框底色只收固定四色（与 CHANGE_FILL 一致，大小写不敏感），
          // 传 null 清除自定义色、回落 change 分类的颜色。界面没有自由取色入口，
          // 这条主要约束 MCP / 脚本——AI 不能往既定配色规则里塞任意颜色。
          if (patch.data.color !== undefined && patch.data.color !== null) {
            const hit = matchNodeColor(patch.data.color);
            if (!hit) {
              return bad(
                res,
                `color 只能是固定四色：${NODE_COLORS.join(' / ')}（既存/変更/追加/削除），` +
                  '传 null 清除。按规则改框色建议直接用 change 分类'
              );
            }
            patch.data.color = hit;
          }
          overlay.nodes = overlay.nodes || {};
          overlay.edges = overlay.edges || {};
          const kind = patch.nodeId ? 'node' : patch.edgeKey ? 'edge' : null;
          const targetId = patch.nodeId || patch.edgeKey || null;
          if (!kind) return bad(res, 'nodeId 或 edgeKey 必须给一个');
          const bucket = kind === 'node' ? overlay.nodes : overlay.edges;
          const actor = ai ? 'ai' : 'user';
          const merged = store.transaction(() => writeAnnotation(kind, targetId, patch.data, actor));
          if (merged) {
            bucket[targetId] = merged;
            broadcastChange(`${kind}.annotate`, actor, { target: targetId });
          }
          json(res, { ok: true });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    // 自动检测 TASK / コール順：扫当前工程模型出建议清单（不落库），
    // 界面面板勾选应用 / AI 经 cg_detect_tasks 读取后自己 cg_annotate
    if (u.pathname === '/api/detect-tasks') {
      const model = MODEL;
      const result = await analyzeTasks(model, { from: u.searchParams.get('from') });
      return MODEL === model && currentSession(req) ? json(res, result) : sessionConflict(res);
    }

    // 结合点编号模式：fixed=固定（删除不前移，新增从空缺号+下一号里挑）
    // / renumber=重排（删除后当前画面的结合点自动紧凑成 1..n）。存 setting 表。
    if (u.pathname === '/api/labels/config') {      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        return readJson(req, res)
          .then((p) => {
            if (p.mode !== 'fixed' && p.mode !== 'renumber') return bad(res, 'mode 必须是 fixed / renumber');
            store.setSetting('labels.conn.mode', p.mode);
            json(res, { ok: true, mode: p.mode });
          })
          .catch(() => {});
      }
      const mode = store.getSetting('labels.conn.mode', 'fixed');
      return json(res, { mode: mode === 'renumber' ? 'renumber' : 'fixed' });
    }

    // 界面偏好：范围下拉的向下 / 向上层数。不是工程数据、不进时间轴，
    // 回看模式下也允许改（改的只是「下次打开时的默认范围」）。
    if (u.pathname === '/api/ui-prefs') {
      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        return readJson(req, res)
          .then((p) => {
            const hasDepth = p.down !== undefined || p.up !== undefined;
            const hasName = p.macroNameMode !== undefined;
            if (!hasDepth && !hasName) return bad(res, '缺少界面偏好');
            const down = p.down == null || p.down === '' ? NaN : Number(p.down);
            const up = p.up == null || p.up === '' ? NaN : Number(p.up);
            if (hasDepth && !validDepth(down)) return bad(res, 'down 必须是 0–20 的整数');
            if (hasDepth && !validDepth(up)) return bad(res, 'up 必须是 0–20 的整数');
            if (hasName && !NAME_MODES.includes(p.macroNameMode)) return bad(res, 'macroNameMode 必须是 alias / target');
            store.transaction(() => {
              if (hasDepth) store.setSetting('ui.depth', { down, up });
              if (hasName) store.setSetting('ui.macroNameMode', p.macroNameMode);
            });
            json(res, { ok: true, ...(hasDepth ? { down, up } : {}), macroNameMode: macroNameDefault() });
          })
          .catch(() => {});
      }
      const saved = store.getSetting('ui.depth', null) || {};
      return json(res, {
        down: validDepth(saved.down) ? saved.down : 1,
        up: validDepth(saved.up) ? saved.up : 1,
        macroNameMode: macroNameDefault(),
      });
    }

    // 结合点重排：items = [{edgeKey, id, num}]。前端在删除结合点后按
    // 「当前画面全部结合点升序 → 1..n」算出差异项提交，这里一个事务 + 一条事件写回，
    // 回放走 store.applyEvent 的 labels.renumber 分支。
    if (u.pathname === '/api/labels/renumber' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then((p) => {
          if (!Array.isArray(p.items)) return bad(res, 'items 必须是数组');
          const items = [];
          for (const it of p.items) {
            if (!isPlainObject(it) || typeof it.edgeKey !== 'string' || typeof it.id !== 'string') {
              return bad(res, 'items 每项要带 edgeKey 与 id');
            }
            const num = Number(it.num);
            if (!Number.isInteger(num) || num < 1 || num > 999) return bad(res, 'num 必须是 1..999 的整数');
            items.push({ edgeKey: it.edgeKey, id: it.id, num });
          }
          if (!items.length) return json(res, { ok: true, changed: 0 });
          let applied = 0;
          store.transaction(() => {
            const before = {};
            const after = {};
            for (const it of items) {
              const ov = store.getAnnotation(PROJECT.id, 'edge', it.edgeKey);
              const labels = normalizeLabels(ov ? ov.labels ?? ov.label : null);
              const target = labels.find((l) => l.id === it.id && l.preset === 'conn');
              if (!target) continue; // 目标已不存在：跳过这一项，别让整次重排失败
              before[it.edgeKey] = labels;
              target.num = it.num;
              target.text = CONN_PREFIX + it.num;
              after[it.edgeKey] = labels;
              store.setAnnotation(PROJECT.id, 'edge', it.edgeKey, { labels, label: null });
              const live = { ...(overlay.edges[it.edgeKey] || {}), labels, label: null };
              for (const k of Object.keys(live)) if (live[k] === null) delete live[k];
              overlay.edges[it.edgeKey] = live;
              applied++;
            }
            if (Object.keys(after).length) {
              store.appendEvent(PROJECT.id, {
                op: 'labels.renumber',
                target: null,
                before,
                after,
                actor: p.actor === 'ai' ? 'ai' : 'user',
              });
            }
          });
          if (applied) broadcastChange('labels.renumber', p.actor === 'ai' ? 'ai' : 'user');
          json(res, { ok: true, changed: applied });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    // 删除 / 恢复函数与连线：只记录 id，不改动源码
    if (u.pathname === '/api/delete' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then((p) => {
          let nodeIds = p.nodes === undefined ? [] : p.nodes;
          let edgeKeys = p.edges === undefined ? [] : p.edges;
          // 必须是字符串数组：否则 for...of 会把字符串按字符拆开写进 overlay
          if (!Array.isArray(nodeIds) || nodeIds.some((x) => typeof x !== 'string')) {
            return bad(res, 'nodes 必须是字符串数组');
          }
          if (!Array.isArray(edgeKeys) || edgeKeys.some((x) => typeof x !== 'string')) {
            return bad(res, 'edges 必须是字符串数组');
          }
          if (p.clear) {
            // 一次性恢复所有被删除的函数与连线
            store.transaction(() => {
              store.clearDeleted(PROJECT.id);
              const view = currentViewSnapshot();
              store.appendEvent(PROJECT.id, {
                op: 'delete.clear', after: view ? { view } : null, actor: p.actor === 'ai' ? 'ai' : 'user',
              });
            });
            overlay.deleted = { nodes: {}, edges: {} };
            broadcastChange('delete.clear', p.actor === 'ai' ? 'ai' : 'user');
            return json(res, { ok: true, nodes: 0, edges: 0 });
          }
          const restore = !!p.restore;
          if (restore) {
            nodeIds = nodeIds.filter((id) => Object.hasOwn(overlay.deleted.nodes, id));
            edgeKeys = edgeKeys.filter((key) => Object.hasOwn(overlay.deleted.edges, key));
            if (!nodeIds.length && !edgeKeys.length) return json(res, { ok: true, nodes: 0, edges: 0 });
          }
          const counts = store.transaction(() => {
            const counts = store.setDeleted(PROJECT.id, { nodes: nodeIds, edges: edgeKeys }, restore);
            store.appendEvent(PROJECT.id, {
              op: restore ? 'delete.restore' : 'delete',
              target: nodeIds.length === 1 && !edgeKeys.length ? nodeIds[0] : null,
              // 回放要区分节点和边，不能只留一个拼接字符串
              after: { nodes: nodeIds, edges: edgeKeys, view: currentViewSnapshot() },
              actor: p.actor === 'ai' ? 'ai' : 'user',
            });
            return counts;
          });
          for (const id of nodeIds) {
            if (restore) delete overlay.deleted.nodes[id];
            else overlay.deleted.nodes[id] = 1;
          }
          for (const k of edgeKeys) {
            if (restore) delete overlay.deleted.edges[k];
            else overlay.deleted.edges[k] = 1;
          }
          broadcastChange(restore ? 'delete.restore' : 'delete', p.actor === 'ai' ? 'ai' : 'user');
          json(res, { ok: true, nodes: counts.nodes, edges: counts.edges });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    // 共享路由模块（浏览器端动态重路由用）
    if (u.pathname === '/core/routing.js' || u.pathname === '/core/layout-metrics.js') {
      return sendFile(res, path.join(__dirname, 'core', path.basename(u.pathname)), {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }

    // 连线标签的纯数据/几何：前后端共用一份，避免两套规则漂移
    if (u.pathname === '/core/labels.js') {
      return sendFile(res, path.join(__dirname, 'core', 'labels.js'), {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
    }

    // 静态文件
    const p = u.pathname === '/' ? '/index.html' : u.pathname;
    // 先按相对路径判定，再 realpath 二次校验：前者挡住 ../，后者挡住软链逃逸
    const rel = path.relative(WEB, path.resolve(WEB, '.' + p));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    let file;
    try {
      file = fs.realpathSync(path.join(WEB, rel));
    } catch {
      res.writeHead(404);
      return res.end('not found');
    }
    if (file !== REAL_WEB && !file.startsWith(REAL_WEB + path.sep)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      st = null;
    }
    if (st && st.isFile()) {
      const ext = path.extname(file);
      const headers = {
        'Content-Type': MIME[ext] || 'application/octet-stream',
      };
      // 页面 CSP：源码里的函数名/文件名会进 DOM，禁掉内联脚本与外链加载
      if (ext === '.html') {
        headers['Content-Security-Policy'] =
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
        headers['X-Content-Type-Options'] = 'nosniff';
      }
      return sendFile(res, file, headers);
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    if (res.destroyed) return;
    console.error(err);
    json(res, { error: String(err) }, 500);
  }
});

// 只接受本机连接：原本不传 host 会绑到 0.0.0.0，同网段可直接读写用户的布局存档
server.on('clientError', (err, socket) => {
  if (!socket.destroyed) socket.destroy();
});
server.on('close', () => {
  gitWatch?.abort();
  clearInterval(sseHeartbeat);
  store.close();
});

server.once('listening', () => {
  const actual = server.address().port;
  console.log(`[服务] http://localhost:${actual}`);
  if (process.send) process.send({ ready: true, port: actual });
});

if (PORT === 0) {
  // 系统分配的端口可能是 Fetch 禁用的 6000。直接绑定高位动态端口，避开探测后再绑定的竞态。
  for (let attempt = 1; ; attempt++) {
    server.listen(randomInt(49152, 65536), '127.0.0.1');
    try {
      await once(server, 'listening');
      break;
    } catch (err) {
      // Windows 的保留端口也可能返回 EACCES。绑定失败可直接重试，close 会关闭数据库。
      if (attempt >= 32 || !['EADDRINUSE', 'EACCES'].includes(err.code)) throw err;
    }
  }
}

// 兜底：任何漏网的未捕获异常只记日志，避免 Electron 侧只看到「exited with 1」
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err && err.stack ? err.stack : err);
});

server.on('error', (err) => {
  console.error('[服务] 启动失败：', err.message);
  process.exitCode = 1;
});

if (PORT !== 0) server.listen(PORT, '127.0.0.1');
