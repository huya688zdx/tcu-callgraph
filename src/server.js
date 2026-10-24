import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadModel, stats, subgraph, search, dataflowOf, scanSources, rebuildIndex } from './core/index.js';
import { layout, layoutGrouped, textWidth } from './core/layout.js';
import { routeEdges } from './core/routing.js';
import { optimizeCrossings } from './core/optimize.js';
import { dataflowFor, sharedVariables, listGlobals, buildDataflowIndex } from './core/dataflow.js';
import { exportXlsx } from './core/export-xlsx.js';
import { exportHtml } from './core/export.js';
import { exportSvg } from './core/export-svg.js';
import { detectTasks } from './core/detect-tasks.js';
import { createMcpServer } from './mcp.js';
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

// 页面当前视图状态（入口 / 深度 / 选中）：前端上报，AI 通过 cg_page 工具读取，
// 用来对齐「用户正在看什么」。内存态、不落库、不进时间轴。
let pageState = null;

// 单库多工程：所有状态按 project_id 隔离，见 docs/superpowers/specs/2026-10-22-persistence-design.md
const store = openStore();

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
    if (key) {
      const r = store.putCachedModel(key, model);
      if (!r.cached) console.log(`[缓存] 未缓存：${r.reason}`);
    }
  }
  const loadMs = Date.now() - t0;
  model.elapsedMs = loadMs;

  // 预先建好 AST 变量索引：右侧「全局变量」面板要按它列变量，
  // 正则版的 index.js 只认白名单类型，GearCtx 这类 typedef 变量会漏掉
  try {
    await buildDataflowIndex(model);
  } catch (err) {
    console.warn('[数据流] 索引构建失败，变量面板将不可用：', err.message);
  }
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
  ROOT_LABEL = label;
  MODEL = model;
  S = st;
  PROJECT = project;
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
function collectOrphans() {
  return collectOrphansOf(MODEL, store.listAllTargets(PROJECT.id));
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
  for (const fn of model.functions) {
    const parts = String(fn.file).split('/');
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
      if (isFile) cur.functions.push({ id: fn.id, name: fn.name, line: fn.line });
    }
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
 * 以后想「恢复到删掉书签之前」会还原出一个缺 fixed / vars 的残本。
 */
const bookmarkEventPayload = (b) => ({
  name: b.name,
  roots: b.roots || [],
  up: b.up,
  down: b.down,
  group: !!b.group,
  fixed: !!b.fixed,
  vars: b.vars || [],
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
    req.on('end', () => {
      if (done) return;
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail(400, 'body 不是合法 JSON');
      }
      if (!isPlainObject(parsed)) return fail(400, 'body 必须是 JSON 对象');
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

/** 文件框兜底：节点被手动坐标移出框时扩展框，保证节点始终被框包住（只扩不缩） */
function fitGroups(groups, nodes) {
  if (!groups || !groups.length) return;
  const byGroup = new Map();
  for (const n of nodes) {
    if (!n.group) continue;
    if (!byGroup.has(n.group)) byGroup.set(n.group, []);
    byGroup.get(n.group).push(n);
  }
  for (const g of groups) {
    const list = byGroup.get(g.id);
    if (!list || !list.length) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of list) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x + n.w > maxX) maxX = n.x + n.w;
      if (n.y + n.h > maxY) maxY = n.y + n.h;
    }
    const nx = Math.min(g.x, minX - 14);
    const ny = Math.min(g.y, minY - 34);
    const nr = Math.max(g.x + g.w, maxX + 14);
    const nb = Math.max(g.y + g.h, maxY + 14);
    g.x = nx;
    g.y = ny;
    g.w = nr - nx;
    g.h = nb - ny;
  }
}

/** 固定布局用：按节点实际位置精确重算文件框（可扩可缩） */
function refitGroupBoxes(groups, nodes) {
  const byGroup = new Map();
  for (const n of nodes) {
    if (!n.group) continue;
    if (!byGroup.has(n.group)) byGroup.set(n.group, []);
    byGroup.get(n.group).push(n);
  }
  const bounds = (list) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of list) {
      if (n.x < x0) x0 = n.x;
      if (n.y < y0) y0 = n.y;
      if (n.x + n.w > x1) x1 = n.x + n.w;
      if (n.y + n.h > y1) y1 = n.y + n.h;
    }
    return { x0, y0, x1, y1 };
  };

  for (const g of groups || []) {
    const list = byGroup.get(g.id);
    if (!list || !list.length) continue;
    const { x0, y0, x1, y1 } = bounds(list);
    g.x = x0 - 14;
    g.y = y0 - 30;
    g.w = x1 - x0 + 28;
    g.h = y1 - y0 + 44;
  }
  return bounds;
}

/**
 * 固定布局用：文件框分开之后，目录容器跟着包住最终矩形（可扩可缩）。
 * 根容器保持 layoutGrouped 的外扩规格（RING），子目录沿用 14/30 + 深度外扩
 */
function refitDirContainers(containers, groups, bounds) {
  if (!containers || !containers.length) return;
  const maxDepth = containers.reduce((m, c) => Math.max(m, c.depth), 1);
  // 深的先算：父容器用子容器的最终矩形求并集
  for (const c of containers.slice().sort((a, b) => b.depth - a.depth)) {
    const prefix = c.id ? c.id + '/' : '';
    const kids = [...(groups || []), ...containers].filter(
      (b) => b !== c && String(b.id).startsWith(prefix) && b.w > 0 && b.h > 0
    );
    if (!kids.length) continue;
    const { x0, y0, x1, y1 } = bounds(kids);
    if (c.root) {
      // 根容器：与 layoutGrouped 的 RING 保持一致，标题行更高
      c.x = x0 - 22;
      c.y = y0 - 38;
      c.w = Math.max(x1 - x0 + 44, textWidth(c.label) + 24);
      c.h = y1 - y0 + 64;
      continue;
    }
    const extra = (maxDepth - c.depth) * 10;
    c.x = x0 - 14 - extra;
    c.y = y0 - 30 - extra;
    c.w = Math.max(x1 - x0 + 28 + extra * 2, textWidth(c.label) + 24);
    c.h = y1 - y0 + 44 + extra * 2;
  }
}

/** 在所属文件框里找一个空位放新节点；框里放不下就贴着框底往下排（框随后被撑大） */
function relocateNewNode(n, laid) {
  const g = (laid.groups || []).find((x) => x.id === n.group);
  const clash = (x, y) =>
    laid.nodes.some(
      (m) => m !== n && x < m.x + m.w + 6 && m.x < x + n.w + 6 && y < m.y + m.h + 6 && m.y < y + n.h + 6
    );
  const baseX = g ? g.x + 14 : n.x;
  const baseY = g ? g.y + 34 : n.y;
  const stepX = n.w + 16;
  const stepY = n.h + 16;
  const cols = g ? Math.max(1, Math.floor((g.w - 28) / stepX)) : 1;
  for (let r = 0; r < 40; r++) {
    for (let c = 0; c < cols; c++) {
      const x = baseX + c * stepX;
      const y = baseY + r * stepY;
      if (!clash(x, y)) {
        n.x = x;
        n.y = y;
        return true;
      }
    }
  }
  n.x = baseX;
  n.y = g ? g.y + g.h + 10 : n.y + n.h + 20;
  return false;
}

/**
 * 固定布局下把互相压住的兄弟文件框整体推开（连带其中的节点与折线）。
 * 推开的间距必须容下两框之间所有目录容器的环（标题栏 + 逐级外扩），
 * 否则文件框分开了，外层目录容器贴合后还是会压在一起。
 * 沿重叠较小的轴推：竖向按「上方链的底环 + 下方链的顶环」，
 * 横向按「两侧链的侧环」；环只累计到最近公共祖先为止（再往上就包住双方了）。
 */
function pushApartGroups(groups, containers, nodes, edges) {
  if (!groups || groups.length < 2) return;
  const maxDepth = (containers || []).reduce((m, c) => Math.max(m, c.depth), 1);
  const ring = new Map(); // id -> { top, bottom, side }
  for (const c of containers || []) {
    if (c.root) {
      ring.set(c.id, { top: 38, bottom: 26, side: 22 });
      continue;
    }
    const extra = (maxDepth - c.depth) * 10;
    ring.set(c.id, { top: 30 + extra, bottom: 14 + extra, side: 14 + extra });
  }
  const chainOf = new Map(); // 文件框 id -> 祖先容器链（浅→深，不含根）
  for (const g of groups) {
    chainOf.set(
      g.id,
      (containers || [])
        .filter((c) => !c.root && g.id.startsWith(c.id + '/'))
        .sort((a, b) => a.depth - b.depth)
    );
  }
  const marginBetween = (upper, lower, axis) => {
    const cu = chainOf.get(upper.id) || [];
    const cl = chainOf.get(lower.id) || [];
    let i = 0;
    while (i < cu.length && i < cl.length && cu[i] === cl[i]) i++;
    let m = 0;
    for (let k = i; k < cu.length; k++) m += ring.get(cu[k].id)?.[axis === 'y' ? 'bottom' : 'side'] || 0;
    for (let k = i; k < cl.length; k++) m += ring.get(cl[k].id)?.[axis === 'y' ? 'top' : 'side'] || 0;
    return m;
  };
  const shift = (g, dx, dy) => {
    g.x += dx;
    g.y += dy;
    const ids = new Set();
    for (const n of nodes) {
      if (n.group !== g.id) continue;
      n.x += dx;
      n.y += dy;
      ids.add(n.id);
    }
    for (const e of edges) {
      if (!ids.has(e.from) && !ids.has(e.to)) continue;
      if (e.points) for (const p of e.points) { p[0] += dx; p[1] += dy; }
    }
  };
  for (let iter = 0; iter < 24; iter++) {
    let moved = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 1 || oy <= 1) continue;
        // 彻底分离所需的位移（不是相交量）：包含型重叠时按相交量推永远推不出去。
        // 竖向 = 下框顶推到上框底之下再留出容器环；横向同理
        const lower = a.y >= b.y ? a : b;
        const upper = lower === a ? b : a;
        const dy = upper.y + upper.h - lower.y + marginBetween(upper, lower, 'y') + 8;
        const right = a.x >= b.x ? a : b;
        const left = right === a ? b : a;
        const dx = left.x + left.w - right.x + marginBetween(left, right, 'x') + 8;
        if (dy <= dx) shift(lower, 0, dy);
        else shift(right, dx, 0);
        moved = true;
      }
    }
    if (!moved) break;
  }
}

/**
 * 固定布局兜底第二层：容器级分离。
 * 文件框两两分开仍不够 —— 目录容器的包围盒会伸进兄弟文件框之间的
 * 「L 形空隙」（框与框不交，但容器的包围盒横跨多个框把别人罩进去）。
 * 这里把参与占位的「范围框」（目录容器 + 顶层文件框）两两分离，
 * 位移时整棵子树（容器、文件框、节点、折线）一起平移，嵌套关系不被破坏。
 * 容器矩形本身已含各级环，因此不需要再算环间距。
 */
function pushApartContainers(containers, groups, nodes, edges) {
  if (!containers || !containers.length || !groups) return false;
  const dirs = containers.filter((c) => !c.root && c.w > 0 && c.h > 0);
  const inDir = (id) => dirs.some((c) => id.startsWith(c.id + '/'));
  // 顶层文件框 = 不在任何目录容器里的文件框（它自己就是占位单位）
  const extents = [
    ...dirs.map((c) => ({ box: c, isGroup: false })),
    ...groups.filter((g) => g.w > 0 && g.h > 0 && !inDir(g.id)).map((g) => ({ box: g, isGroup: true })),
  ];
  if (extents.length < 2) return false;

  const shiftSubtree = (item, dx, dy) => {
    const { box, isGroup } = item;
    box.x += dx;
    box.y += dy;
    const gIds = new Set();
    if (isGroup) {
      gIds.add(box.id);
    } else {
      for (const g of groups) {
        if (!g.id.startsWith(box.id + '/')) continue;
        g.x += dx;
        g.y += dy;
        gIds.add(g.id);
      }
      for (const c of containers) {
        if (c !== box && !c.root && c.id.startsWith(box.id + '/')) {
          c.x += dx;
          c.y += dy;
        }
      }
    }
    const ids = new Set();
    for (const n of nodes) {
      if (!gIds.has(n.group)) continue;
      n.x += dx;
      n.y += dy;
      ids.add(n.id);
    }
    for (const e of edges) {
      if (!ids.has(e.from) && !ids.has(e.to)) continue;
      if (e.points) for (const p of e.points) { p[0] += dx; p[1] += dy; }
    }
  };

  let moved = false;
  for (let round = 0; round < 8; round++) {
    let roundMoved = false;
    for (let i = 0; i < extents.length; i++) {
      for (let j = i + 1; j < extents.length; j++) {
        const A = extents[i];
        const B = extents[j];
        // 祖先-后代关系的容器（嵌套）不分离
        if (!A.isGroup && !B.isGroup) {
          if (A.box.id.startsWith(B.box.id + '/') || B.box.id.startsWith(A.box.id + '/')) continue;
        }
        const a = A.box;
        const b = B.box;
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 1 || oy <= 1) continue;
        // 与文件框级同理：按彻底分离所需位移算，取较小的轴
        const lower = a.y >= b.y ? A : B;
        const upper = lower === A ? B : A;
        const dy = upper.box.y + upper.box.h - lower.box.y + 8;
        const right = a.x >= b.x ? A : B;
        const left = right === A ? B : A;
        const dx = left.box.x + left.box.w - right.box.x + 8;
        if (dy <= dx) shiftSubtree(lower, 0, dy);
        else shiftSubtree(right, dx, 0);
        roundMoved = true;
      }
    }
    moved = moved || roundMoved;
    if (!roundMoved) break;
  }
  return moved;
}

/**
 * 目录容器 / 根容器兜底：文件框被 fitGroups 撑大后，上层框要跟着包住。
 * 只扩不缩 —— 嵌套几何已经在 layoutGrouped 里算好了（含每级外扩的一圈），
 * 这里若重新算一套坐标，手动布局存档的坐标系就会整体偏移。
 */
function fitContainers(containers, fileGroups) {
  if (!containers || !containers.length || !fileGroups || !fileGroups.length) return;

  const grow = (c, x0, y0, x1, y1, left, top, right, bottom) => {
    const nx = Math.min(c.x, x0 - left);
    const ny = Math.min(c.y, y0 - top);
    const nr = Math.max(c.x + c.w, x1 + right);
    const nb = Math.max(c.y + c.h, y1 + bottom);
    c.x = nx;
    c.y = ny;
    c.w = nr - nx;
    c.h = nb - ny;
  };

  // 深的先算：子容器长大后再撑父容器
  const dirs = containers.filter((c) => !c.root).sort((a, b) => b.depth - a.depth);
  for (const c of dirs) {
    const boxes = [
      ...fileGroups.filter((g) => String(g.id).startsWith(c.id + '/')),
      ...dirs.filter((k) => k !== c && String(k.id).startsWith(c.id + '/')),
    ];
    if (!boxes.length) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const b of boxes) {
      if (b.x < x0) x0 = b.x;
      if (b.y < y0) y0 = b.y;
      if (b.x + b.w > x1) x1 = b.x + b.w;
      if (b.y + b.h > y1) y1 = b.y + b.h;
    }
    grow(c, x0, y0, x1, y1, 18, 34, 18, 18);
  }

  const rootC = containers.find((c) => c.root);
  if (!rootC) return;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of [...fileGroups, ...dirs]) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.w > x1) x1 = b.x + b.w;
    if (b.y + b.h > y1) y1 = b.y + b.h;
  }
  if (!Number.isFinite(x0)) return;
  grow(rootC, x0, y0, x1, y1, 22, 38, 22, 26);
}

function buildView(
  rootIds,
  up,
  down,
  group = false,
  dfNode = null,
  optimal = false,
  varSel = {},
  fixed = false,
  // 时间轴回看时传历史 overlay：视图构建逻辑完全复用，只是输入换了一份
  viewOverlay = overlay
) {
  // 支持多个入口（文件树多选）：各自取子图后合并节点与边
  const roots = (Array.isArray(rootIds) ? rootIds : rootIds ? [rootIds] : []).filter(Boolean);
  const perRoot = Math.max(120, Math.floor(600 / Math.max(1, roots.length)));
  const nodeMap = new Map();
  const edgeList = [];
  const seenEdge = new Set();
  for (const r of roots) {
    const part = subgraph(MODEL, r, { up, down, maxNodes: perRoot });
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
    return { nodes: [], edges: [], width: 480, height: 260, root: g.root, empty: true };
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
    const seen = new Set(viewEdges.map((e) => `${e.from}|${e.to}|${e.line}`));
    const varEdgeOf = new Map(); // fnId|varId → edge，读写合并成一条
    const pushVarEdge = (fnId, varId, via) => {
      if (!ids.has(fnId) || !ids.has(varId)) return;
      const k = `${fnId}|${varId}|0`;
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

  // 手动布局按「入口 + 模式」分开存：坐标只在生成它的那个视图里有效
  const mode = group ? 'group' : 'flat';
  // 入口集合作为布局存档的 key：单入口时就是函数 id，与旧存档兼容
  const slot = optimal && !fixed ? {} : viewOverlay.layout?.[layoutKey(roots.join('+'), mode)] || {};

  // 手动拖拽的节点位置优先。
  // 但坐标必须仍落在它所属的文件框内才采用——拖拽本身被前端限制在框内，
  // 出框的坐标只可能是跨视图/跨深度的陈旧存档，直接丢弃并回落自动布局
  const savedNodes = slot.nodes || {};

  // 存档坐标作重心初值（seeded barycenter，加节点不跳变）：
  // 扁平模式且非 fixed 时，把该视图上次布局的存档坐标作为重心排序的初始次序传入
  // layout()——旧节点保持相对次序，新加入的节点只引起局部挪动；
  // group 模式的稳定性由下面的存档回填机制承担，fixed 模式直接钉存档坐标，均不传
  const laid = group
    ? layoutGrouped(clean, viewEdges, { rootLabel: ROOT_LABEL })
    : layout(clean, viewEdges, fixed ? {} : { seed: savedNodes });
  const groupBox = new Map((laid.groups || []).map((bg) => [bg.id, bg]));
  const savedApplied = [];
  for (const n of laid.nodes) {
    const p = savedNodes[n.id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const gb = groupBox.get(n.group);
    if (gb && !fixed) {
      const tol = 2;
      const inside =
        p.x >= gb.x - tol &&
        p.y >= gb.y - tol &&
        p.x + n.w <= gb.x + gb.w + tol &&
        p.y + n.h <= gb.y + gb.h + tol;
      if (!inside) continue;
    }
    n._autoX = n.x;
    n._autoY = n.y;
    n.x = p.x;
    n.y = p.y;
    savedApplied.push(n);
  }

  // 固定布局：已有节点钉在原位，新加入的节点（变量/函数）自己找空位。
  // 框的分离放到下面贴合之后统一做——这里文件框还是自动布局的旧矩形，
  // 钉到别处的节点不在旧框里，先推开推了个寂寞，贴合后又会压回去
  if (fixed) {
    const savedSet = new Set(savedApplied.map((n) => n.id));
    for (const n of laid.nodes) {
      if (savedSet.has(n.id)) continue;
      const clash = laid.nodes.some(
        (m) => m !== n && n.x < m.x + m.w + 6 && m.x < n.x + n.w + 6 && n.y < m.y + m.h + 6 && m.y < n.y + n.h + 6
      );
      if (clash) relocateNewNode(n, laid);
    }
  }

  // 存档坐标防叠压：旧存档 / 跨深度的坐标可能压在其他节点上，
  // 出现矩形相交时该节点回退自动布局位置（自动布局本身保证互不重叠）
  for (const n of savedApplied) {
    let clash = false;
    for (const m of laid.nodes) {
      if (m === n) continue;
      if (
        n.x < m.x + m.w - 4 &&
        m.x < n.x + n.w - 4 &&
        n.y < m.y + m.h - 4 &&
        m.y < n.y + n.h - 4
      ) {
        clash = true;
        break;
      }
    }
    if (clash) {
      n.x = n._autoX;
      n.y = n._autoY;
    }
  }
  for (const n of laid.nodes) {
    delete n._autoX;
    delete n._autoY;
  }

  // 手动画的连线（不预置折线，统一交给路由器）
  const byId = new Map(laid.nodes.map((n) => [n.id, n]));
  const manual = (slot.manual || []).filter((m) => byId.has(m.from) && byId.has(m.to));
  for (const m of manual) {
    const b = byId.get(m.to);
    laid.edges.push({
      from: m.from,
      to: m.to,
      callee: b.name,
      kind: 'manual',
      line: 0,
      via: '手动',
      manual: true,
    });
  }

  // 用户调整过的连线：恢复手动折线 / 端口方向覆盖
  const savedEdges = slot.edges || {};
  for (const e of laid.edges) {
    const k = `${e.from}->${e.to}:${e.line}`;
    const saved = savedEdges[k];
    if (!saved) continue;
    if (saved.fromSide) e.fromSide = saved.fromSide;
    if (saved.toSide) e.toSide = saved.toSide;
    if (saved.custom && Array.isArray(saved.points) && saved.points.length >= 2) {
      e.custom = true;
      e.points = saved.points;
    }
  }

  // 基于最终节点位置统一重路由（严格正交）。
  // 最优布局（非固定）模式在路由基础上跑实测交叉局部搜索：挪同组节点位置、
  // 整组换出/入线面——每个候选完整重路由后按真实交叉数裁决，人工调图的
  // 两招由算法自动完成；固定模式不跑（钉住的位置是用户所有物）
  if (optimal && !fixed) {
    const groupBoxes = laid.groups ? new Map(laid.groups.map((g) => [g.id, g])) : null;
    optimizeCrossings(laid.nodes, laid.edges, { groupBoxes });
  } else {
    routeEdges(laid.nodes, laid.edges);
  }

  // 兜底：坐标若与当前布局不匹配（旧存档 / 手动拖拽），把文件框扩到包住节点，
  // 避免函数节点看起来脱离了所属文件的层级
  if (laid.groups) {
    if (fixed) {
      // 固定布局的层级分离，顺序不能换：
      //   1. 文件框按节点实际位置「精确贴合」（可扩可缩）
      //   2. 文件框级分离（间距含祖先容器的环）
      //   3. 容器贴合 → 容器级分离，迭代到稳定（子树整体平移）
      // 陈旧坐标把节点钉进别的层级时，靠 2/3 两层把它彻底分开
      const bounds = refitGroupBoxes(laid.groups, laid.nodes);
      pushApartGroups(laid.groups, laid.containers, laid.nodes, laid.edges);
      let settled = false;
      for (let i = 0; i < 10; i++) {
        refitDirContainers(laid.containers, laid.groups, bounds);
        if (!pushApartContainers(laid.containers, laid.groups, laid.nodes, laid.edges)) {
          settled = true;
          break;
        }
      }
      if (!settled) refitDirContainers(laid.containers, laid.groups, bounds);
    } else {
      fitGroups(laid.groups, laid.nodes);
      fitContainers(laid.containers, laid.groups);
    }
  }

  // 侧边车道可能超出画布：扩一下尺寸
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of laid.nodes) {
    if (n.x + n.w > maxX) maxX = n.x + n.w;
    if (n.y + n.h > maxY) maxY = n.y + n.h;
  }
  for (const e of laid.edges) {
    for (const p of e.points || []) {
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    }
  }
  for (const box of [...(laid.groups || []), ...(laid.containers || [])]) {
    if (box.x + box.w > maxX) maxX = box.x + box.w;
    if (box.y + box.h > maxY) maxY = box.y + box.h;
  }
  laid.width = Math.max(laid.width, maxX + 40);
  laid.height = Math.max(laid.height, maxY + 40);

  // 合并标注 + 变更状态
  for (const n of laid.nodes) {
    const ov = viewOverlay.nodes?.[n.id];
    if (ov) Object.assign(n, { note: ov.note, color: ov.color, tag: ov.tag });
    // 既存 / 変更 / 追加 / 削除，前端据此决定背景色与线框样式
    n.change = (ov && ov.change) || 'existing';
    n.kind = n.kind === 'var' ? 'var' : 'fn';
  }
  for (const e of laid.edges) {
    const ov = viewOverlay.edges?.[edgeKeyOf(e)];
    // 原有 / 新增 / 删除
    e.change = (ov && ov.change) || 'existing';
    // 连线标签（一线可多条）：统一在这里规整，前端与导出拿到的都是干净数据。
    // 旧库存的是单条 label，读出来同样归成数组；e.label 保留为首条做兼容
    const labels = normalizeLabels(ov ? ov.labels ?? ov.label : null);
    if (labels.length) {
      e.labels = labels;
      e.label = labels[0];
    }
  }
  return { ...laid, root: g.root, roots };
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
  // 畸形请求目标（如 "//["）会让 new URL 抛异常，必须挡在 try 内，
  // 否则异常冒泡成未捕获异常，整个进程退出
  let u;
  try {
    u = new URL(req.url, `http://127.0.0.1:${PORT}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }

  try {
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
      const r = await mcp.handlePost(raw);
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
    // 内存态，不广播、不进时间轴——它不是数据变更，只是「用户在看什么」。
    if (u.pathname === '/api/page') {
      if (req.method === 'POST') {
        if (!guardWrite(req, res)) return;
        return readJson(req, res)
          .then((p) => {
            const str = (v) => (typeof v === 'string' ? v : null);
            const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
            pageState = {
              roots: strArr(p.roots),
              up: Math.max(0, Number(p.up) || 0),
              down: Math.max(0, Number(p.down) || 0),
              group: !!p.group,
              fixed: !!p.fixed,
              vars: strArr(p.vars),
              selected: str(p.selected),
              selectedEdge: str(p.selectedEdge),
              // 回看历史时 AI 不该往当前状态写（前端也会拦），带上让模型知情
              reviewing: Number(p.at) > 0,
              at: Math.max(0, Number(p.at) || 0),
              ts: Date.now(),
            };
            json(res, { ok: true });
          })
          .catch(() => {});
      }
      return json(res, {
        page: pageState,
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
        .then((p) => {
          const rootId = typeof p.root === 'string' && p.root ? p.root : pickEntryId();
          if (!rootId) return bad(res, '工程里没有函数，无从导出');
          const up = Math.max(0, Number(p.up ?? 0) || 0);
          const down = Math.max(0, Number(p.down ?? 3) || 3);
          const group = p.group !== false;
          // 界面默认 optimal=1：导出与屏幕同款最优路径，导出的图不比看到的差
          const view = buildView([rootId], up, down, group, null, true, {}, false, overlay);
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

    // 切换工程：重新解析目标并整体替换会话状态，前端拿到新统计后重载数据即可
    if (u.pathname === '/api/switch' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      // openTarget 里有 await（重建数据流索引），期间第二个切换请求会插进来
      // 交错改写 MODEL / PROJECT / overlay——A 工程的标注就可能写进 B 的 project_id。
      // 这里用一把简单的锁：切换期间再来的请求直接 409，让前端等上一次完成。
      if (switching) return json(res, { ok: false, error: '正在切换工程，请稍候' }, 409);
      readJson(req, res)
        .then(async (p) => {
          let targetPath = typeof p.path === 'string' ? p.path : '';
          if (!targetPath && p.id !== undefined) {
            const pr = store.getProject(Number(p.id));
            if (!pr) return bad(res, '工程不存在');
            targetPath = pr.path;
          }
          if (!targetPath) return bad(res, 'id 或 path 必须给一个');
          switching = true;
          try {
            const { project, stats: st } = await openTarget(targetPath);
            // 打开着的页面整体重载：跨工程没有任何状态可保留
            broadcastChange('project.switch', p.actor === 'ai' ? 'ai' : 'user', { project: project.name });
            json(res, {
              ok: true,
              project: { id: project.id, name: project.name, path: root },
              stats: st,
            });
          } catch (err) {
            json(res, { ok: false, error: String(err.message || err) }, 400);
          } finally {
            switching = false;
          }
        })
        .catch((err) => {
          switching = false;
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    // 孤儿标注：库里指向已不存在的函数 / 连线的条目
    if (u.pathname === '/api/orphans') {
      const o = collectOrphans();
      return json(res, { ...o, total: countOrphans(o) });
    }

    if (u.pathname === '/api/orphans/purge' && req.method === 'POST') {
      if (!guardWrite(req, res)) return;
      readJson(req, res)
        .then((p) => {
          const o = collectOrphans();
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
                  // 整份视图参数都记下来：少存 fixed / vars 的话，
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
      const rootsParam = u.searchParams.get('roots');
      const rootId = u.searchParams.get('root');
      const roots = rootsParam
        ? rootsParam.split(',').filter(Boolean)
        : rootId
        ? [rootId]
        : [];
      const up = Number(u.searchParams.get('up') || 0);
      const down = Number(u.searchParams.get('down') || 2);
      const group = u.searchParams.get('group') === '1';
      const df = u.searchParams.get('df') || null;
      const optimal = u.searchParams.get('optimal') === '1';
      const split = (k) => (u.searchParams.get(k) ? u.searchParams.get(k).split(',').filter(Boolean) : []);
      const varSel = { want: split('vars'), skip: split('novars') };
      const fixed = u.searchParams.get('fixed') === '1';
      // 时间轴回看：at=<eventId> 时用重放出来的历史状态，而不是当前状态
      const at = Number(u.searchParams.get('at') || 0);
      const viewOverlay = at > 0 ? store.overlayAt(PROJECT.id, at) : overlay;
      if (!roots.length) {
        if (!MODEL.functions.length) {
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
          ? MODEL.functions.filter((f) => f.file === MODEL.focusFile)
          : MODEL.functions;
        const deg = (id) => (MODEL._index.outAdj.get(id) || []).length;
        const entries = pool
          .filter((f) => !(MODEL._index.inAdj.get(f.id) || []).length)
          .sort((a, b) => deg(b.id) - deg(a.id));
        const pick = entries[0] || [...pool].sort((a, b) => deg(b.id) - deg(a.id))[0] || MODEL.functions[0];
        return json(
          res,
          buildView([pick.id], up, Math.max(down, 3), group, df, optimal, varSel, fixed, viewOverlay)
        );
      }
      return json(res, buildView(roots, up, down, group, df, optimal, varSel, fixed, viewOverlay));
    }

    if (u.pathname === '/api/node') {
      const id = u.searchParams.get('id');
      const fn = MODEL._index.byId.get(id);
      if (!fn) return json(res, { error: 'not found' }, 404);
      return json(res, {
        node: { ...fn, bodyTokens: undefined },
        inEdges: MODEL._index.inAdj.get(id) || [],
        outEdges: MODEL._index.outAdj.get(id) || [],
        overlay: overlay.nodes?.[id] || {},
      });
    }

    // 数据流：按需分析，不在扫描阶段做
    if (u.pathname === '/api/dataflow') {
      const fnId = u.searchParams.get('fn');
      const dir = u.searchParams.get('dir') || 'out';
      if (!fnId) return json(res, { error: 'missing fn' }, 400);
      if (!MODEL._index) return json(res, { error: '该视图不支持数据流分析' }, 400);
      return dataflowFor(MODEL, fnId, dir)
        .then((r) => json(res, r))
        .catch((err) => {
          console.error('[数据流]', err);
          json(res, { ok: false, error: String(err.message || err) }, 500);
        });
    }

    if (u.pathname === '/api/vars') {
      return listGlobals(MODEL)
        .then((list) => json(res, { list }))
        .catch((err) => json(res, { ok: false, error: String(err.message || err) }, 500));
    }

    if (u.pathname === '/api/shared-vars') {
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
      const up = Number(u.searchParams.get('up') || 0);
      const down = Number(u.searchParams.get('down') || 3);
      if (!rootId) return json(res, { error: 'missing root' }, 400);
      const g = subgraph(MODEL, rootId, { up, down, maxNodes: 600 });
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
      exportHtml(tmp, out);
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
      return json(res, detectTasks(MODEL));
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
    if (u.pathname === '/core/routing.js') {
      return sendFile(res, path.join(__dirname, 'core', 'routing.js'), {
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
