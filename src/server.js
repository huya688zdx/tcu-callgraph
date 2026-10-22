import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadModel, stats, subgraph, search, dataflowOf, scanSources, rebuildIndex } from './core/index.js';
import { layout, layoutGrouped } from './core/layout.js';
import { routeEdges } from './core/routing.js';
import { dataflowFor, sharedVariables, listGlobals, buildDataflowIndex } from './core/dataflow.js';
import { exportXlsx } from './core/export-xlsx.js';
import { exportHtml } from './core/export.js';
import { openStore, fingerprintFiles, importLegacyOverlay, cacheKey } from './core/store.js';
import { collectOrphans as collectOrphansOf, countOrphans } from './core/orphans.js';

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

// 单库多工程：所有状态按 project_id 隔离，见 docs/superpowers/specs/2026-10-22-persistence-design.md
const store = openStore();

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

/** 固定布局用：按节点实际位置精确重算文件框与目录容器（可扩可缩） */
function refitBoxes(groups, containers, nodes) {
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
    const extra = (maxDepth - c.depth) * 10;
    c.x = x0 - 14 - extra;
    c.y = y0 - 30 - extra;
    c.w = x1 - x0 + 28 + extra * 2;
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

/** 固定布局下把互相压住的兄弟文件框整体推开（连带其中的节点与折线） */
function pushApartGroups(groups, nodes, edges) {
  if (!groups || groups.length < 2) return;
  const shift = (g, dy) => {
    g.y += dy;
    const ids = new Set();
    for (const n of nodes) {
      if (n.group !== g.id) continue;
      n.y += dy;
      ids.add(n.id);
    }
    for (const e of edges) {
      if (!ids.has(e.from) && !ids.has(e.to)) continue;
      if (e.points) for (const p of e.points) p[1] += dy;
    }
  };
  for (let iter = 0; iter < 12; iter++) {
    let moved = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i];
        const b = groups[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox <= 1 || oy <= 1) continue;
        shift(a.y >= b.y ? a : b, oy + 20);
        moved = true;
      }
    }
    if (!moved) break;
  }
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

  const laid = group ? layoutGrouped(clean, viewEdges, { rootLabel: ROOT_LABEL }) : layout(clean, viewEdges);

  // 手动布局按「入口 + 模式」分开存：坐标只在生成它的那个视图里有效
  const mode = group ? 'group' : 'flat';
  // 入口集合作为布局存档的 key：单入口时就是函数 id，与旧存档兼容
  const slot = optimal && !fixed ? {} : viewOverlay.layout?.[layoutKey(roots.join('+'), mode)] || {};

  // 手动拖拽的节点位置优先。
  // 但坐标必须仍落在它所属的文件框内才采用——拖拽本身被前端限制在框内，
  // 出框的坐标只可能是跨视图/跨深度的陈旧存档，直接丢弃并回落自动布局
  const savedNodes = slot.nodes || {};
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

  // 固定布局：已有节点钉在原位，新加入的节点（变量/函数）自己找空位，
  // 只有在框里放不下时才撑大框，并把压到的兄弟框整体推开
  if (fixed) {
    const savedSet = new Set(savedApplied.map((n) => n.id));
    for (const n of laid.nodes) {
      if (savedSet.has(n.id)) continue;
      const clash = laid.nodes.some(
        (m) => m !== n && n.x < m.x + m.w + 6 && m.x < n.x + n.w + 6 && n.y < m.y + m.h + 6 && m.y < n.y + n.h + 6
      );
      if (clash) relocateNewNode(n, laid);
    }
    pushApartGroups(laid.groups, laid.nodes, laid.edges);
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

  // 基于最终节点位置统一重路由（严格正交）
  routeEdges(laid.nodes, laid.edges);

  // 兜底：坐标若与当前布局不匹配（旧存档 / 手动拖拽），把文件框扩到包住节点，
  // 避免函数节点看起来脱离了所属文件的层级
  if (laid.groups) {
    if (fixed) {
      // 固定布局：框跟着节点「精确贴合」——加变量时撑大，撤销时也能缩回去，
      // 不会留下大片空白
      refitBoxes(laid.groups, laid.containers, laid.nodes);
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
  }
  return { ...laid, root: g.root, roots };
}

const server = http.createServer((req, res) => {
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
      readJson(req, res)
        .then(async (p) => {
          let targetPath = typeof p.path === 'string' ? p.path : '';
          if (!targetPath && p.id !== undefined) {
            const pr = store.getProject(Number(p.id));
            if (!pr) return bad(res, '工程不存在');
            targetPath = pr.path;
          }
          if (!targetPath) return bad(res, 'id 或 path 必须给一个');
          try {
            const { project, stats: st } = await openTarget(targetPath);
            json(res, {
              ok: true,
              project: { id: project.id, name: project.name, path: root },
              stats: st,
            });
          } catch (err) {
            json(res, { ok: false, error: String(err.message || err) }, 400);
          }
        })
        .catch((err) => {
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
          const removed = store.purgeTargets(PROJECT.id, o);
          store.appendEvent(PROJECT.id, { op: 'orphan.purge', target: 'orphans', after: o });
          reloadOverlay();
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
              const r = store.saveBookmark(PROJECT.id, p);
              store.appendEvent(PROJECT.id, {
                op: 'bookmark.save',
                target: r.bookmark.name,
                after: {
                  roots: r.bookmark.roots,
                  up: r.bookmark.up,
                  down: r.bookmark.down,
                  group: r.bookmark.group,
                },
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
          const gone = store.listBookmarks(PROJECT.id).find((b) => b.id === id);
          const ok = store.deleteBookmark(PROJECT.id, id);
          if (ok) store.appendEvent(PROJECT.id, { op: 'bookmark.delete', target: gone?.name || `#${id}` });
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
      const safe = String(PROJECT.name || 'session').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safe}.cgx"`,
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

          const ov = p.overlay || {};
          let annotations = 0;
          for (const [id, data] of Object.entries(ov.nodes || {})) {
            store.setAnnotation(PROJECT.id, 'node', id, data);
            annotations++;
          }
          for (const [k, data] of Object.entries(ov.edges || {})) {
            store.setAnnotation(PROJECT.id, 'edge', k, data);
            annotations++;
          }

          const delNodes = Object.keys((ov.deleted || {}).nodes || {});
          const delEdges = Object.keys((ov.deleted || {}).edges || {});
          if (delNodes.length || delEdges.length) {
            store.setDeleted(PROJECT.id, { nodes: delNodes, edges: delEdges });
          }

          let layout = 0;
          for (const [key, slot] of Object.entries(ov.layout || {})) {
            const idx = key.lastIndexOf('::');
            if (idx < 0) continue;
            store.saveLayout(PROJECT.id, key.slice(0, idx), key.slice(idx + 2), {
              nodes: slot.nodes || {},
              edges: slot.edges || {},
              manual: slot.manual || [],
            });
            layout++;
          }

          let bookmarks = 0;
          for (const b of p.bookmarks || []) {
            try {
              store.saveBookmark(PROJECT.id, b);
              bookmarks++;
            } catch {
              /* 单条书签不合法不影响整体导入 */
            }
          }

          // 代码版本对不上时标注可能挂不到节点上，返回给前端提示
          const fp = fingerprintFiles(MODEL.files);
          const sameCode = !p.project?.fingerprint || p.project.fingerprint === fp;

          store.appendEvent(PROJECT.id, {
            op: 'session.import',
            target: p.project?.name || 'session',
            after: { annotations, layout, bookmarks, sameCode },
          });
          reloadOverlay();

          json(res, {
            ok: true,
            sameCode,
            from: p.project?.name || '',
            imported: { annotations, layout, bookmarks, deleted: delNodes.length + delEdges.length },
          });
        })
        .catch((err) => {
          if (!res.headersSent) json(res, { ok: false, error: String(err.message || err) }, 500);
        });
      return;
    }

    // 时间轴：分页 + 过滤。默认只回 brief，不回完整载荷
    if (u.pathname === '/api/events') {
      const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit') || 50)));
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
          store.replaceOverlay(PROJECT.id, restored);
          store.appendEvent(PROJECT.id, {
            op: 'restore_point',
            target: `event#${at}`,
            after: restored,
          });
          // 同步内存镜像，后续请求直接读到恢复后的状态
          overlay.nodes = restored.nodes;
          overlay.edges = restored.edges;
          overlay.deleted = restored.deleted;
          overlay.layout = restored.layout;
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
          const before = store.getLayout(PROJECT.id, rootId, mode);
          const slot = store.saveLayout(PROJECT.id, rootId, mode, {
            nodes: patch.nodes,
            edges: patch.edges,
            manual: patch.manual,
            clear: !!patch.clear,
          });
          overlay.layout = overlay.layout || {};
          overlay.layout[key] = slot;

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
          });
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
          overlay.nodes = overlay.nodes || {};
          overlay.edges = overlay.edges || {};
          const kind = patch.nodeId ? 'node' : patch.edgeKey ? 'edge' : null;
          const targetId = patch.nodeId || patch.edgeKey || null;
          if (!kind) return bad(res, 'nodeId 或 edgeKey 必须给一个');
          const bucket = kind === 'node' ? overlay.nodes : overlay.edges;
          const before = pickKeys(bucket[targetId], Object.keys(patch.data));
          const merged = store.setAnnotation(PROJECT.id, kind, targetId, patch.data);
          bucket[targetId] = merged;
          store.appendEvent(PROJECT.id, {
            op: kind === 'node' ? 'node.annotate' : 'edge.annotate',
            target: targetId,
            before,
            after: patch.data,
          });
          json(res, { ok: true });
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
            store.clearDeleted(PROJECT.id);
            overlay.deleted = { nodes: {}, edges: {} };
            store.appendEvent(PROJECT.id, { op: 'delete.clear' });
            return json(res, { ok: true, nodes: 0, edges: 0 });
          }
          const restore = !!p.restore;
          const counts = store.setDeleted(PROJECT.id, { nodes: nodeIds, edges: edgeKeys }, restore);
          for (const id of nodeIds) {
            if (restore) delete overlay.deleted.nodes[id];
            else overlay.deleted.nodes[id] = 1;
          }
          for (const k of edgeKeys) {
            if (restore) delete overlay.deleted.edges[k];
            else overlay.deleted.edges[k] = 1;
          }
          store.appendEvent(PROJECT.id, {
            op: restore ? 'delete.restore' : 'delete',
            target: nodeIds.length === 1 && !edgeKeys.length ? nodeIds[0] : null,
            // 回放要区分节点和边，不能只留一个拼接字符串
            after: { nodes: nodeIds, edges: edgeKeys },
          });
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
