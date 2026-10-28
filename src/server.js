import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadModel, stats, subgraph, search, dataflowOf, scanSources, rebuildIndex } from './core/index.js';
import { layoutElk } from './core/layout-elk.js';
import { dataflowFor, sharedVariables, listGlobals, buildDataflowIndex } from './core/dataflow.js';
import { compareProjects, comparisonDataflow, comparisonGlobals } from './core/compare.js';
import { pairDataflow, comparisonPairDataflow } from './core/pair-dataflow.js';
import { CHANGE_STATES, statusOverrides, comparisonStatus, statusSummary } from './core/comparison-status.js';
import { exportXlsx } from './core/export-xlsx.js';
import { exportHtml } from './core/export.js';
import { exportSvg } from './core/export-svg.js';
import { detectTasks } from './core/detect-tasks.js';
import { createMcpServer } from './mcp.js';
import { normalizeExpansions } from './core/expansion.js';
import { openStore, fingerprintFiles, importLegacyOverlay, cacheKey } from './core/store.js';
import { collectOrphans as collectOrphansOf, countOrphans } from './core/orphans.js';
import {
  normalizeLabel,
  normalizeLabels,
  nextConnNumber,
  LABELS_MAX,
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
let COMPARISON = null;
let comparisonPreview = null;
let comparisonBase = null;
const comparisonInfo = () => COMPARISON ? {
  id: COMPARISON.id, projectPath: COMPARISON.projectPath, projectName: PROJECT.name,
  beforePath: COMPARISON.beforePath, afterPath: COMPARISON.afterPath,
  summary: COMPARISON.summary, warnings: COMPARISON.warnings, macroChanges: COMPARISON.macroChanges,
  totalNodes: COMPARISON.totalNodes,
  mappings: COMPARISON.mappings,
  manualStatusCount: COMPARISON.statusOverrides.nodes.size + COMPARISON.statusOverrides.edges.size,
} : null;

// 页面当前视图状态（入口 / 深度 / 选中）：前端上报，AI 通过 cg_page 工具读取，
// 用来对齐「用户正在看什么」。内存态、不落库、不进时间轴。
let pageState = null;

// 单库多工程：所有状态按 project_id 隔离，见 docs/superpowers/specs/2026-10-22-persistence-design.md
const store = openStore();
const modelCacheKeys = new WeakMap();
const analysisPending = new WeakMap();

/** 变量/数据流查询或失效标注检查需要 AST 时再构建；完成后升级磁盘缓存。 */
async function ensureAnalysis(model) {
  if (model._df) return;
  if (analysisPending.has(model)) return analysisPending.get(model);
  const pending = (async () => {
    await buildDataflowIndex(model);
    if (model === MODEL) S = stats(model);
    const key = modelCacheKeys.get(model);
    if (key && !model._df?.failedFiles) {
      try {
        const r = store.putCachedModel(key, model);
        if (!r.cached) console.log(`[缓存] 未缓存变量分析：${r.reason}`);
      } catch (err) {
        console.warn('[缓存] 变量分析缓存写入失败：', err.message);
      }
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

// 心跳：SSE 连接长时间无数据时可能被中间层掐掉，定时发注释行保活，也顺便探活死连接
const sseHeartbeat = setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': ping\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 25000);
sseHeartbeat.unref?.();

/** 广播一条 change 事件；单个连接写失败只摘掉它，不影响其他页面 */
function broadcastChange(op, actor, extra = {}) {
  if (!sseClients.size) return;
  const payload = `event: change\ndata: ${JSON.stringify({ op, actor, ts: Date.now(), ...extra })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
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

/**
 * 加载一个工程并切换会话状态。
 * 解析结果是纯派生的，切工程时整份重建；标注 / 布局从库里按 project_id 读。
 */
async function openTarget(targetPath, { first = false } = {}) {
  const abs = path.resolve(targetPath);
  let isFile = false;
  try {
    isFile = fs.statSync(abs).isFile();
  } catch {
    throw new Error(`路径不存在：${abs}`);
  }
  // 打开的根目录名：文件路径都是相对它的，所以要把这一层补进层级里。
  // 直接选了单个文件时，索引的是它所在目录，根名取目录名（否则会和文件框重名）
  const label = path.basename(isFile ? path.dirname(abs) : abs) || abs;

  console.log(`[加载] ${abs}`);
  const t0 = Date.now();

  // 解析缓存：源码没动过就直接反序列化模型，省掉整轮词法 + 语法分析。
  // .dot / .gv 走另一套模型（没有文件清单），不参与缓存。
  const isDot = isFile && /\.(dot|gv)$/i.test(abs);
  const scanRoot = isFile ? path.dirname(abs) : abs;
  const focus = isFile ? path.relative(path.dirname(abs), abs).replace(/\\/g, '/') : '';
  const key = isDot ? '' : cacheKey(scanSources(scanRoot), focus);

  let model = key ? store.getCachedModel(key) : null;
  const fromCache = !!model;
  if (model) {
    model.root = isFile ? path.dirname(abs) : abs;
    if (focus) model.focusFile = focus;
    rebuildIndex(model);
  } else {
    model = loadModel(abs);
  }

  // 首屏只需要调用关系；变量清单/数据流由 ensureAnalysis 按需构建。
  modelCacheKeys.set(model, key);
  if (key && !fromCache) {
    const r = store.putCachedModel(key, model);
    if (!r.cached) console.log(`[缓存] 未缓存：${r.reason}`);
  }
  const loadMs = Date.now() - t0;
  model.elapsedMs = loadMs;
  const st = stats(model);
  const project = store.upsertProject({
    path: abs,
    name: label,
    fingerprint: fingerprintFiles(model.files),
  });

  if (first) migrateLegacy(project);

  const ov = store.loadOverlay(project.id);
  ov.deleted = ov.deleted || { nodes: {}, edges: {} };
  ov.deleted.nodes = ov.deleted.nodes || {};
  ov.deleted.edges = ov.deleted.edges || {};

  root = abs;
  ROOT_LABEL = project.name;
  MODEL = model;
  S = st;
  PROJECT = project;
  COMPARISON = null;
  overlay = ov;
  pageState = null; // 旧工程的页面状态作废，前端重载后会重新上报

  // 已有数据但还没钉过起点时，补一条 baseline：
  // 没有它，时间轴只能从空状态开始回放，迁移/导入之前的数据就找不回来了
  if (!store.hasAnchor(project.id)) {
    store.appendEvent(project.id, { op: 'baseline', target: 'open', after: ov, actor: 'system' });
  }

  console.log(
    `[就绪] 文件 ${st.files} / 函数 ${st.functions} / 边 ${st.edges} / 宏 ${st.macros} / 耗时 ${loadMs}ms${
      fromCache ? '（解析缓存）' : ''
    }`
  );
  console.log(`[存储] ${store.file} · 工程 #${project.id} ${project.isNew ? '(新建)' : ''}`);
  return { project, stats: st };
}

await openTarget(target, { first: true });

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
  // 冷缓存只有词法索引，不能把尚未分析到的 typedef 变量误判成已删除。
  // 分析失败时直接拒绝检测/清理；等待期间切换了工程也不能使用旧结果。
  // 比较模型已由两侧完整索引合并，DOT/GV 也自带完整的图索引；
  // 两者都不能按 C 源码重新分析，完整性检查也只适用于 C 分析。
  const needsCAnalysis = !comparison && model.source !== 'dot';
  if (needsCAnalysis) await ensureAnalysis(model);
  if (switching || model !== MODEL || project !== PROJECT || comparison !== COMPARISON) return null;
  if (needsCAnalysis && model._df?.failedFiles) throw new Error('变量索引不完整，无法安全清理标注；请检查源码读取或解析错误，重新打开工程后重试');
  return collectOrphansOf(model, store.listAllTargets(project.id));
}

/** 只取 patch 里涉及到的键，事件里存增量而不是全量，避免时间轴被坐标淹没 */
const pickKeys = (obj, keys) => {
  const out = {};
  for (const k of keys) out[k] = obj && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : null;
  return out;
};




/** 与前端 edgeKey 保持一致 */
const edgeKeyOf = (e) => `${e.from}->${e.to}:${e.line}`;

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
    fileNodes.get(fn.file)?.functions.push({ id: fn.id, name: fn.name, line: fn.line });
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
  vars: b.vars || [],
  expansions: b.expansions || [],
});

/** 本机来源白名单：Electron / 浏览器都用 127.0.0.1 或 localhost 打开 */
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/**
 * 写接口守卫：拒绝跨站来源与非 JSON 请求。
 * Origin 为空时放行（curl、同源导航不带 Origin）；跨站带 application/json 的请求
 * 会先触发预检，这里不回应预检，浏览器侧根本发不出来，415 再兜住 text/plain 表单提交。
 */
function guardWrite(req, res) {
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
  if (switching || (req.headers['x-callgraph-project'] !== undefined &&
      Number(req.headers['x-callgraph-project']) !== PROJECT.id)) {
    json(res, { ok: false, error: '工程正在切换或请求所属工程已改变，请刷新后重试' }, 409);
    return false;
  }
  return true;
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
      if (req.projectId !== PROJECT.id || req.comparisonId !== COMPARISON?.id || (switching && !req.switchRequest)) {
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
  const model = MODEL;
  if (!COMPARISON && (varSel.want?.length || dfNode)) {
    await ensureAnalysis(model);
    if (model !== MODEL) throw new Error('工程已切换，请刷新后重试');
  }
  // 支持多个入口（文件树多选）：各自取子图后合并节点与边
  const roots = (Array.isArray(rootIds) ? rootIds : rootIds ? [rootIds] : []).filter(Boolean);
  const perRoot = Math.max(120, Math.floor(600 / Math.max(1, roots.length)));
  const nodeMap = new Map();
  const edgeList = [];
  const seenEdge = new Set();
  let truncated = false;
  const scopes = [...roots.map((root) => ({ root, up, down })), ...(varSel.expansions || [])];
  for (const scope of scopes) {
    const part = subgraph(MODEL, scope.root, { up: scope.up, down: scope.down,
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
  truncated ||= g.nodes.length > 600;
  if (g.nodes.length > 600) {
    g.nodes = g.nodes.slice(0, 600);
  }
  // 过滤用户删掉的函数与连线。文件框 / 目录容器是从节点推导出来的，
  // 所以某个文件或目录里的函数被删空时，对应层级会自动消失
  const wantVars = new Set(varSel.want || []);
  const skipVars = new Set(varSel.skip || []);

  let alive = g.nodes.filter((n) => !viewOverlay.deleted.nodes[n.id]);
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
  if (!clean.length) {
    return { nodes: [], edges: [], groups: [], containers: [], width: 480, height: 260, root: g.root, roots,
      empty: true, projectId, comparison: COMPARISON ? { ...comparisonInfo(), shownNodes: 0, truncated } : null };
  }
  // 右侧面板里勾选的全局变量：补节点 + 视图内函数对它的引用边
  if (wantVars.size) {
    const ids = new Set(clean.map((n) => n.id));
    const df = MODEL._df;
    for (const id of wantVars) {
      if (ids.has(id) || viewOverlay.deleted.nodes[id]) continue;
      const def = (df && df.byId.get(id)) || MODEL._index.byId.get(id);
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
      const def = (df && df.byId.get(varId)) || MODEL._index.byId.get(varId);
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
      for (const e of MODEL.edges) {
        if (e.kind !== 'var' || !wantVars.has(e.to)) continue;
        pushVarEdge(e.from, e.to, e.via || '变量');
      }
    }
  }

  // 数据流（按需展开）：把相关的函数也拉进视图，否则只有连线看不到两端
  if (dfNode) {
    const flows = dataflowOf(MODEL, dfNode);
    const ids = new Set(clean.map((n) => n.id));
    for (const f of flows) {
      for (const id of [f.from, f.to]) {
        if (ids.has(id) || viewOverlay.deleted.nodes[id]) continue;
        const fn = MODEL._index.byId.get(id);
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
  const slot = viewOverlay.layout?.[layoutKey(roots.join('+'), mode)] || {};
  const byId = new Map(clean.map((n) => [n.id, n]));
  // 比较模式的 roots 是「保留+选中」的合集，和存手工关系时的原视图槽位键对不上；
  // 改为从全部槽位按「两端都在当前图上」找回，按端点对去重，保证手工关系仍可见。
  const manualPool = COMPARISON
    ? Object.values(viewOverlay.layout || {}).flatMap((s) => s?.manual || [])
    : slot.manual || [];
  const seenManual = new Set();
  for (const m of manualPool) {
    const mk = `${m.from}\u0000${m.to}`;
    if (seenManual.has(mk)) continue;
    seenManual.add(mk);
    if (!byId.has(m.from) || !byId.has(m.to) || viewOverlay.deleted.edges[edgeKeyOf({ ...m, line: 0 })]) continue;
    viewEdges.push({ from: m.from, to: m.to, callee: byId.get(m.to).name,
      kind: 'manual', line: 0, via: '手动', manual: true });
  }
  if (COMPARISON) {
    const ids = new Set(clean.map((n) => n.id));
    viewEdges = [...MODEL.edges, ...(MODEL.headerEdges || []).map((e) => ({ ...e, change: 'existing' })),
      ...viewEdges.filter((e) => e.manual)].filter((e) => ids.has(e.from) && ids.has(e.to));
  }
  viewEdges = viewEdges.filter((e) => !viewOverlay.deleted.edges[edgeKeyOf(e)])
    .map((e) => COMPARISON ? comparisonStatus(e, COMPARISON.statusOverrides.edges, e.comparisonKey || edgeKeyOf(e))
      : { ...e, change: viewOverlay.edges?.[edgeKeyOf(e)]?.change || 'existing' });
  if (COMPARISON) clean = clean.map((n) => comparisonStatus(n, COMPARISON.statusOverrides.nodes, n.id));
  const macroNameMode = macroNameDefault();
  clean = clean.map((n) => withMacroName(n, viewOverlay, macroNameMode));
  const laid = await layoutElk(clean, viewEdges, { group, rootLabel: ROOT_LABEL, previous });

  // 合并标注 + 变更状态
  for (const n of laid.nodes) {
    const ov = viewOverlay.nodes?.[n.id];
    if (ov) Object.assign(n, { note: ov.note, color: COMPARISON ? undefined : ov.color, tag: ov.tag });
    // 既存 / 変更 / 追加 / 削除，前端据此决定背景色与线框样式
    n.change = COMPARISON ? n.change || 'existing' : (ov && ov.change) || 'existing';
    n.kind = n.kind === 'var' ? 'var' : 'fn';
  }
  for (const e of laid.edges) {
    const ov = viewOverlay.edges?.[edgeKeyOf(e)];
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
  return { ...laid, root: g.root, roots, expansions: varSel.expansions || [], truncated, layoutEngine: 'elk', projectId, macroNameMode,
    comparison: COMPARISON ? { ...comparisonInfo(), shownNodes: laid.nodes.length, truncated } : null };
}

// ---- MCP（AI 访问）----
// 工具桥接到进程内 HTTP（打自己的 127.0.0.1），与 UI 走同一路径：
// 校验、事件记录、持久化全部复用，时间轴里 actor=ai 可区分 AI 改动。
const mcp = createMcpServer({
  // 端口传 0 时由系统分配，listen 之后才知道真实端口，这里必须惰性取
  baseUrl: () => `http://127.0.0.1:${server.address().port}`,
  getAccess: mcpAccess,
  writeOut: async (name, buf) => {
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

// 回调是 async：/mcp 端点里要 await body 读取；其他端点不受影响（同步 return 路径不变）
const server = http.createServer(async (req, res) => {
  // 请求体可能稍后才读完，工程身份必须在进入请求时固定。
  req.projectId = PROJECT.id;
  req.comparisonId = COMPARISON?.id;
  // 畸形请求目标（如 "//["）会让 new URL 抛异常，必须挡在 try 内，
  // 否则异常冒泡成未捕获异常，整个进程退出
  let u;
  try {
    u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    req.switchRequest = ['/api/switch', '/api/compare', '/api/compare/apply', '/api/compare/exit'].includes(u.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }

  try {
    if (COMPARISON && ((req.method === 'POST' && /^\/api\/(overlay|delete|layout|orphans\/purge|bookmarks|session|restore|labels)/.test(u.pathname)) ||
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
      if (req.projectId !== PROJECT.id || switching) {
        return json(res, { ok: false, error: '工程已切换，请重新调用' }, 409);
      }
      const r = await mcp.handlePost(raw, req.projectId);
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
      req.on('close', () => sseClients.delete(res));
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
            const str = (v) => (typeof v === 'string' ? v : null);
            const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
            pageState = {
              roots: strArr(p.roots),
              up: Math.max(0, Number(p.up) || 0),
              down: Math.max(0, Number(p.down) || 0),
              group: !!p.group,
              vars: strArr(p.vars),
              expansions: normalizeExpansions(p.expansions),
              selected: str(p.selected),
              selectedEdge: str(p.selectedEdge),
              // 回看历史时 AI 不该往当前状态写（前端也会拦），带上让模型知情
              reviewing: Number(p.at) > 0,
              at: Math.max(0, Number(p.at) || 0),
              ts: Date.now(),
            };
            if (pageState.roots.length && !pageState.reviewing && !COMPARISON) {
              const cam = p.cam && [p.cam.x, p.cam.y, p.cam.k].every(Number.isFinite) && p.cam.k > 0 ? p.cam : null;
              const ctxBox = p.ctxBox && ['file', 'dir'].includes(p.ctxBox.kind) && typeof p.ctxBox.id === 'string' ? p.ctxBox : null;
              store.setSetting('ui.last-view.' + PROJECT.id, { ...pageState, hiddenVars: strArr(p.hiddenVars), cam, ctxBox });
            }
            json(res, { ok: true });
          })
          .catch((err) => { if (!res.headersSent) bad(res, err.message); });
      }
      return json(res, {
        page: u.searchParams.has('saved') ? COMPARISON ? null : store.getSetting('ui.last-view.' + PROJECT.id) : pageState,
        project: PROJECT ? { id: PROJECT.id, name: PROJECT.name, path: root } : null,
        hint: pageState
          ? undefined
          : '还没有页面连上来过：打开应用页面后，这里会返回用户当前正在看的视图',
      });
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
          const group = p.group !== false;
          // 导出与屏幕统一使用 ELK 排版。
          const view = await buildView([rootId], up, down, group, null, {}, overlay);
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

    if (u.pathname === '/api/stats') {
      return json(res, {
        stats: S,
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
        fingerprint: fp,
        scannedFingerprint: PROJECT.prevFingerprint || PROJECT.fingerprint,
        changed: !!PROJECT.prevFingerprint && PROJECT.prevFingerprint !== fp,
        db: store.file,
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

    if (u.pathname === '/api/compare' && req.method !== 'POST') return json(res, { comparison: comparisonInfo() });
    if (u.pathname === '/api/compare/status' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      const p = await readJson(req, res);
      if (!COMPARISON || p.comparisonId !== COMPARISON.id) return json(res, { ok: false, error: '比较已切换，请刷新后重试' }, 409);
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
      switching = true;
      try {
        const p = await readJson(req, res);
        if (u.pathname.endsWith('/exit')) {
          if (COMPARISON && comparisonBase) {
            ({ MODEL, S, overlay, pageState } = comparisonBase);
            COMPARISON = null;
            comparisonBase = null;
          }
          comparisonPreview = null;
        } else if (u.pathname.endsWith('/apply')) {
          const preview = comparisonPreview;
          if (!preview || p.previewId !== preview.id || preview.model !== MODEL || preview.projectId !== PROJECT.id) {
            return json(res, { ok: false, error: '比较预览已失效，请重新解析' }, 409);
          }
          const ids = (value, name) => {
            if (!Array.isArray(value) || value.length > 600 || value.some((id) => typeof id !== 'string')) throw new Error(`${name} 必须是最多 600 项的标识数组`);
            return [...new Set(value)];
          };
          const selected = ids(p.selectedIds, '选择项');
          if (!selected.length) throw new Error('请至少选择一个函数或变量');
          if (selected.some((id) => !preview.candidateIds.has(id))) throw new Error('选择项不在本次比较结果中');
          const comparison = preview.comparison;
          const statuses = { nodes: statusOverrides(p.statusOverrides, preview.candidateIds), edges: new Map() };
          const retained = ids(p.retainIds || [], '保留项').filter((id) => MODEL._index.byId.has(id) && comparison.model._index.byId.has(id));
          const roots = [...new Set([...retained, ...selected])];
          if (roots.length > 600) throw new Error('保留与选择的节点合计超过 600 个，请减少选择');
          const nextStats = stats(comparison.model);
          const nextOverlay = structuredClone(overlay);
          const chosen = new Set(selected);
          for (const id of selected) delete nextOverlay.deleted.nodes[id];
          for (const edge of comparison.model.edges) if (chosen.has(edge.from) || chosen.has(edge.to)) delete nextOverlay.deleted.edges[edgeKeyOf(edge)];
          if (!comparisonBase) comparisonBase = { MODEL, S, overlay, pageState };
          COMPARISON = { ...comparison, roots, statusOverrides: statuses, id: randomUUID(), previousComparisonId: COMPARISON?.id,
            totalNodes: comparison.model._index.byId.size };
          COMPARISON.summary = statusSummary(COMPARISON);
          MODEL = comparison.model;
          ROOT_LABEL = PROJECT.name;
          S = nextStats; pageState = null;
          // 原图的标注、手工关系仍可见；主动选择的对象允许重新入图。
          overlay = nextOverlay;
          comparisonPreview = null;
        } else {
          const comparison = await compareProjects(COMPARISON?.projectPath || root, p.beforePath, p.afterPath);
          const candidates = [...comparison.model.functions, ...comparison.model.variables].filter((n) => !n.external)
            .map(({ id, name, file, line, kind, change, reasons, locations, impact, context }) =>
              ({ id, name, file, line, kind: kind === 'var' ? 'var' : 'fn', change, reasons, locations, impact, context }));
          comparisonPreview = { id: randomUUID(), projectId: PROJECT.id, model: MODEL, comparison, candidateIds: new Set(candidates.map((n) => n.id)) };
          return json(res, { ok: true, preview: { id: comparisonPreview.id, projectId: PROJECT.id,
            summary: comparison.summary, warnings: comparison.warnings, mappings: comparison.mappings, candidates,
            validRetainIds: [...comparison.model._index.byId.keys()] } });
        }
        broadcastChange('project.switch', p.actor === 'ai' ? 'ai' : 'user', { project: ROOT_LABEL });
        return json(res, { ok: true, comparison: comparisonInfo(), roots: COMPARISON?.roots || [] });
      } catch (err) {
        if (!res.headersSent) return json(res, { ok: false, error: String(err.message || err) }, 400);
      } finally { switching = false; }
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
        broadcastChange('project.switch', p.actor === 'ai' ? 'ai' : 'user', { project: project.name });
        json(res, {
          ok: true,
          project: { id: project.id, name: project.name, path: root },
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
          if (!o) return json(res, { ok: false, error: '工程已切换，请刷新后重试' }, 409);
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
              const r = store.transaction(() => {
                const name = String(p.name || '').trim();
                const prev = store.findBookmark(PROJECT.id, name);
                const r = store.saveBookmark(PROJECT.id, p);
                store.appendEvent(PROJECT.id, {
                  op: 'bookmark.save',
                  target: r.bookmark.name,
                  // 整份视图参数都记下来：少存深度 / vars 的话，
                  // 以后想按事件重建书签就是有损的
                  before: prev ? bookmarkEventPayload(prev) : null,
                  after: bookmarkEventPayload(r.bookmark),
                });
                return r;
              });
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
        bookmarks: store.listBookmarks(PROJECT.id),
        events: withEvents ? store.dumpEvents(PROJECT.id, 5000) : [],
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
        .then((p) => {
          if (!p || p.format !== 'tcu-callgraph-session') return bad(res, '不是 .cgx 会话文件');
          if (Number(p.version) > 1) return bad(res, `会话文件版本 ${p.version} 高于当前支持的 1`);
          if (p.overlay !== undefined && !isPlainObject(p.overlay)) return bad(res, 'overlay 必须是对象');
          if (p.bookmarks !== undefined && !Array.isArray(p.bookmarks)) return bad(res, 'bookmarks 必须是数组');

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
                summary: { annotations, layout, bookmarks, sameCode },
              },
            });

            return { annotations, layout, bookmarks, delNodes, delEdges, sameCode };
          });

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
      const rows = store.listEventsPage(PROJECT.id, { limit: limit + 1, beforeId, ops, q: query, withPayload });
      const hasMore = rows.length > limit;
      return json(res, {
        latest: store.latestEventId(PROJECT.id),
        total: store.countEvents(PROJECT.id, { ops, q: query }),
        hasMore,
        events: hasMore ? rows.slice(0, limit) : rows,
      });
    }

    // 恢复到此：把历史某一刻的状态整体写回，并追加一条 restore_point 事件
    if (u.pathname === '/api/restore' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then((p) => {
          const at = Number(p.eventId);
          if (!Number.isFinite(at) || at <= 0) return bad(res, 'eventId 必须是正整数');
          const latest = store.latestEventId(PROJECT.id);
          if (at > latest) return bad(res, 'eventId 超出范围');
          const restored = store.overlayAt(PROJECT.id, at);
          // 覆盖状态与记 restore_point 必须同事务：否则中途崩溃会留下
          // 「状态已回退、时间轴上却看不出发生过恢复」的库，后续回放全乱
          store.transaction(() => {
            store.replaceOverlay(PROJECT.id, restored);
            store.appendEvent(PROJECT.id, {
              op: 'restore_point',
              target: `event#${at}`,
              after: restored,
              actor: p.actor === 'ai' ? 'ai' : 'user',
            });
          });
          // 同步内存镜像，后续请求直接读到恢复后的状态
          overlay.nodes = restored.nodes;
          overlay.edges = restored.edges;
          overlay.deleted = restored.deleted;
          overlay.layout = restored.layout;
          broadcastChange('restore_point', p.actor === 'ai' ? 'ai' : 'user');
          json(res, { ok: true, eventId: store.latestEventId(PROJECT.id) });
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
      let previous = null;
      let expansions = [];
      let bodyRoots = null;
      let bodyVars = null, bodyHiddenVars = null;
      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        let body;
        try { body = await readJson(req, res); } catch { return; }
        try { expansions = normalizeExpansions(body.expansions); } catch (err) { return bad(res, err.message); }
        expansions = expansions.filter((e) => MODEL._index.byId.has(e.root) && MODEL._index.byId.get(e.root).kind !== 'var');
        if (body.projectId != null && body.projectId !== PROJECT.id) return json(res, { error: '工程已切换，请重试' }, 409);
        if (body.roots !== undefined) {
          if (!Array.isArray(body.roots) || body.roots.length > 600 || body.roots.some((id) => typeof id !== 'string')) return bad(res, 'roots 必须是最多 600 项的标识数组');
          bodyRoots = body.roots;
        }
        for (const key of ['vars', 'hiddenVars']) if (body[key] !== undefined &&
          (!Array.isArray(body[key]) || body[key].length > 600 || body[key].some((id) => typeof id !== 'string'))) return bad(res, `${key} 必须是最多 600 项的标识数组`);
        bodyVars = body.vars;
        bodyHiddenVars = body.hiddenVars;
        if (body.previous == null && !body.expansions?.length && !bodyRoots?.length) return bad(res, '缺少增量布局、局部展开或入口参数');
        previous = body.previous;
        if (previous != null) {
          const rect = (n) => n && typeof n.id === 'string' &&
            [n.x, n.y, n.w, n.h].every(Number.isFinite) && n.w > 0 && n.h > 0;
          if (!Array.isArray(previous.nodes) || !Array.isArray(previous.edges) ||
              !Array.isArray(previous.groups) || !Array.isArray(previous.containers) ||
              ![previous.width, previous.height].every(Number.isFinite) ||
              ![...previous.nodes, ...previous.groups, ...previous.containers].every(rect)) {
            return bad(res, '增量布局数据无效');
          }
          const ids = new Set(previous.nodes.map((n) => n.id));
          if (!previous.edges.every((e) => e && ids.has(e.from) && ids.has(e.to) &&
              Array.isArray(e.points) && e.points.length >= 2 &&
              e.points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)))) {
            return bad(res, '增量布局连线无效');
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
      const group = u.searchParams.get('group') !== '0';
      if (previous && !!previous.groups.length !== group) previous = null;
      const df = u.searchParams.get('df') || null;
      const split = (k) => (u.searchParams.get(k) ? u.searchParams.get(k).split(',').filter(Boolean) : []);
      const varSel = { want: bodyVars || split('vars'), skip: bodyHiddenVars || split('novars'), expansions };
      // 时间轴回看：at=<eventId> 时用重放出来的历史状态，而不是当前状态
      const at = Number(u.searchParams.get('at') || 0);
      if (COMPARISON && at > 0) return bad(res, '比较视图不支持回看普通工程历史');
      const viewOverlay = at > 0 ? store.overlayAt(PROJECT.id, at) : overlay;
      if (!roots.length) {
        if (COMPARISON) return json(res, await buildView(COMPARISON.roots, 0, 0, group, null, varSel, viewOverlay, previous));
        if (!MODEL.functions.length && !MODEL.headerSymbols?.length) {
          return json(res, {
            nodes: [],
            edges: [],
            width: 480,
            height: 260,
            root: null,
            empty: true,
          });
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
          await buildView([pick.id], up, down, group, df, varSel, viewOverlay, previous)
        );
      }
      return json(res, await buildView(roots, up, down, group, df, varSel, viewOverlay, previous));
    }

    if (u.pathname === '/api/node') {
      const id = u.searchParams.get('id');
      const fn = MODEL._index.byId.get(id);
      if (!fn) return json(res, { error: 'not found' }, 404);
      return json(res, {
        node: { ...(COMPARISON ? comparisonStatus(fn, COMPARISON.statusOverrides.nodes, id) : fn), bodyTokens: undefined },
        inEdges: (fn.headerSymbol ? (MODEL.headerEdges || []).filter((e) => e.to === id) : MODEL._index.inAdj.get(id) || [])
          .map((e) => COMPARISON ? comparisonStatus(e, COMPARISON.statusOverrides.edges, e.comparisonKey || edgeKeyOf(e)) : { ...e, change: overlay.edges?.[edgeKeyOf(e)]?.change || 'existing' }),
        outEdges: (fn.headerSymbol ? (MODEL.headerEdges || []).filter((e) => e.from === id) : MODEL._index.outAdj.get(id) || [])
          .map((e) => COMPARISON ? comparisonStatus(e, COMPARISON.statusOverrides.edges, e.comparisonKey || edgeKeyOf(e)) : { ...e, change: overlay.edges?.[edgeKeyOf(e)]?.change || 'existing' }),
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
      if (MODEL !== model || COMPARISON !== comparison) return json(res, { error: '工程已切换，请重新选择' }, 409);
      if (![body.a, body.b].every(id => model._index.byId.has(id))) return bad(res, '所选函数或变量不存在');
      const result = await (comparison ? comparisonPairDataflow(comparison, body.a, body.b) : pairDataflow(model, body.a, body.b));
      if (MODEL !== model || COMPARISON !== comparison) return json(res, { error: '工程已切换，请重新选择' }, 409);
      return json(res, { ...result, projectId, comparisonId: comparison?.id });
    }

    // 数据流：按需分析，不在扫描阶段做
    if (u.pathname === '/api/dataflow') {
      const fnId = u.searchParams.get('fn');
      const dir = u.searchParams.get('dir') || 'out';
      if (!fnId) return json(res, { error: 'missing fn' }, 400);
      if (!MODEL._index) return json(res, { error: '该视图不支持数据流分析' }, 400);
      if (!COMPARISON) {
        const model = MODEL;
        await ensureAnalysis(model);
        if (model !== MODEL) return json(res, { error: '工程已切换，请重试' }, 409);
      }
      return (COMPARISON ? comparisonDataflow(COMPARISON, fnId, dir) : dataflowFor(MODEL, fnId, dir))
        .then((r) => json(res, r))
        .catch((err) => {
          console.error('[数据流]', err);
          json(res, { ok: false, error: String(err.message || err) }, 500);
        });
    }

    if (u.pathname === '/api/vars') {
      if (COMPARISON) return json(res, { list: comparisonGlobals(COMPARISON) });
      const model = MODEL;
      await ensureAnalysis(model);
      if (model !== MODEL) return json(res, { error: '工程已切换，请重试' }, 409);
      return listGlobals(MODEL)
        .then((list) => json(res, { list }))
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
      if (model !== MODEL) return json(res, { error: '工程已切换，请重试' }, 409);
      return sharedVariables(MODEL)
        .then((list) => json(res, { list }))
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
      const g = subgraph(MODEL, rootId, { up, down, maxNodes: 600 });
      if (COMPARISON) {
        g.nodes = g.nodes.map((n) => comparisonStatus(n, COMPARISON.statusOverrides.nodes, n.id));
        g.edges = g.edges.map((e) => comparisonStatus(e, COMPARISON.statusOverrides.edges, e.comparisonKey || edgeKeyOf(e)));
      }
      g.nodes = g.nodes.map((n) => withMacroName(n, overlay, macroNameDefault()));
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
      await exportHtml(tmp, out);
      return sendFile(res, out, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="callgraph.html"',
        'Cache-Control': 'no-store',
      });
    }

    if (u.pathname === '/api/layout' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then((patch) => {
          if (patch.nodes !== undefined && !isPlainObject(patch.nodes)) return bad(res, 'nodes 必须是对象');
          if (patch.edges !== undefined && !isPlainObject(patch.edges)) return bad(res, 'edges 必须是对象');
          if (patch.manual !== undefined && !Array.isArray(patch.manual)) return bad(res, 'manual 必须是数组');
          const mode = patch.mode === 'group' ? 'group' : 'flat';
          const rootId = String(patch.root || '');
          const key = layoutKey(rootId, mode);
          const slot = store.transaction(() => {
            const before = store.getLayout(PROJECT.id, rootId, mode);
            const slot = store.saveLayout(PROJECT.id, rootId, mode, {
              nodes: patch.nodes,
              edges: patch.edges,
              manual: patch.manual,
              clear: !!patch.clear,
            });
            // 事件只存增量：nodeIds 是被写过的键，before 是它们原来的值
            store.appendEvent(PROJECT.id, {
              op: patch.clear ? 'layout.clear' : 'layout.save',
              target: key,
              before: {
                nodes: pickKeys(before.nodes, Object.keys(patch.nodes || {})),
                edges: pickKeys(before.edges, Object.keys(patch.edges || {})),
                manual: patch.manual ? before.manual : undefined,
              },
              after: { nodes: patch.nodes || {}, edges: patch.edges || {}, manual: patch.manual },
              actor: patch.actor === 'ai' ? 'ai' : 'user',
            });
            return slot;
          });
          overlay.layout = overlay.layout || {};
          overlay.layout[key] = slot;
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
        .then((patch) => {
          if (!isPlainObject(patch.data)) return bad(res, 'data 必须是对象');
          if (patch.data.nameMode !== undefined && patch.data.nameMode !== null && !NAME_MODES.includes(patch.data.nameMode)) return bad(res, 'nameMode 必须是 alias / target，或 null（跟随设置）');
          if (patch.nodeId !== undefined && typeof patch.nodeId !== 'string') return bad(res, 'nodeId 必须是字符串');
          if (patch.edgeKey !== undefined && typeof patch.edgeKey !== 'string') return bad(res, 'edgeKey 必须是字符串');
          // 连线标签（一线可多条）：
          //   data.labels = 数组 → 整组替换（先读现有再合并提交，空数组=清空）
          //   data.label  = 旧版单条 → null 清空全部 / 对象则整组替换成这一条
          // 写入时同步把旧字段 label 清掉，回放（键级合并）才不会残留两份。
          if (patch.data.labels !== undefined || patch.data.label !== undefined) {
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
          const merged = store.transaction(() => {
            // before 从库里取，不用内存镜像——镜像可能是旧的（切工程 / 外部改动），
            // 记错了会让「恢复到这一刻」还原出错误的值
            const before = pickKeys(store.getAnnotation(PROJECT.id, kind, targetId), Object.keys(patch.data));
            const merged = store.setAnnotation(PROJECT.id, kind, targetId, patch.data);
            store.appendEvent(PROJECT.id, {
              op: kind === 'node' ? 'node.annotate' : 'edge.annotate',
              target: targetId,
              before,
              after: patch.data,
              actor: patch.actor === 'ai' ? 'ai' : 'user',
            });
            return merged;
          });
          bucket[targetId] = merged;
          broadcastChange(kind === 'node' ? 'node.annotate' : 'edge.annotate', patch.actor === 'ai' ? 'ai' : 'user', {
            target: targetId,
          });
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
      return json(res, detectTasks(MODEL, u.searchParams.get('from')));
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
          const nodeIds = p.nodes === undefined ? [] : p.nodes;
          const edgeKeys = p.edges === undefined ? [] : p.edges;
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
              store.appendEvent(PROJECT.id, { op: 'delete.clear', actor: p.actor === 'ai' ? 'ai' : 'user' });
            });
            overlay.deleted = { nodes: {}, edges: {} };
            broadcastChange('delete.clear', p.actor === 'ai' ? 'ai' : 'user');
            return json(res, { ok: true, nodes: 0, edges: 0 });
          }
          const restore = !!p.restore;
          const counts = store.transaction(() => {
            const counts = store.setDeleted(PROJECT.id, { nodes: nodeIds, edges: edgeKeys }, restore);
            store.appendEvent(PROJECT.id, {
              op: restore ? 'delete.restore' : 'delete',
              target: nodeIds.length === 1 && !edgeKeys.length ? nodeIds[0] : null,
              // 回放要区分节点和边，不能只留一个拼接字符串
              after: { nodes: nodeIds, edges: edgeKeys },
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
    console.error(err);
    json(res, { error: String(err) }, 500);
  }
});

// 只接受本机连接：原本不传 host 会绑到 0.0.0.0，同网段可直接读写用户的布局存档
server.on('clientError', (err, socket) => {
  if (!socket.destroyed) socket.destroy();
});

// 兜底：任何漏网的未捕获异常只记日志，避免 Electron 侧只看到「exited with 1」
process.on('uncaughtException', (err) => {
  console.error('[未捕获异常]', err && err.stack ? err.stack : err);
});

server.listen(PORT, '127.0.0.1', () => {
  const actual = server.address().port;
  console.log(`[服务] http://localhost:${actual}`);
  if (process.send) process.send({ ready: true, port: actual });
});
