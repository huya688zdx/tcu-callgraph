import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModel, stats, subgraph, search } from './core/index.js';
import { layout, layoutGrouped } from './core/layout.js';
import { routeEdges } from './core/routing.js';
import { exportXlsx } from './core/export-xlsx.js';
import { exportHtml } from './core/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, '../web');
const OUT = path.resolve(__dirname, '../out');

const target = process.argv[2] || 'samples/tcu';
const PORT = Number(process.argv[3] || 5173);
const root = path.resolve(target);

console.log(`[加载] ${root}`);
const MODEL = loadModel(root);
const S = stats(MODEL);
console.log(
  `[就绪] 文件 ${S.files} / 函数 ${S.functions} / 边 ${S.edges} / 宏 ${S.macros} / 耗时 ${S.elapsedMs}ms`
);

const OVERLAY_PATH = path.join(OUT, 'overlay.json');
let overlay = {};
try {
  overlay = JSON.parse(fs.readFileSync(OVERLAY_PATH, 'utf8'));
} catch {
  overlay = { nodes: {}, edges: {}, notes: [] };
}

// 用户在界面上删掉的函数 / 连线：按 id 记下来，所有视图里都不再显示
overlay.deleted = overlay.deleted || { nodes: {}, edges: {} };
overlay.deleted.nodes = overlay.deleted.nodes || {};
overlay.deleted.edges = overlay.deleted.edges || {};

const saveOverlay = () => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(OVERLAY_PATH, JSON.stringify(overlay, null, 1), 'utf8');
};

/** 与前端 edgeKey 保持一致 */
const edgeKeyOf = (e) => `${e.from}->${e.to}:${e.line}`;

function buildFileTree(model) {
  const root = { name: '', type: 'dir', path: '', children: new Map() };
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

/** 目录容器跟随文件框：文件框被扩展后，上层目录框也要同步包住 */
function fitContainers(containers, fileGroups) {
  if (!containers || !containers.length || !fileGroups || !fileGroups.length) return;
  const maxDepth = containers.reduce((m, c) => Math.max(m, c.depth), 1);
  for (const c of containers) {
    const inner = fileGroups.filter((g) => String(g.id).startsWith(c.id + '/'));
    if (!inner.length) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const g of inner) {
      if (g.x < x0) x0 = g.x;
      if (g.y < y0) y0 = g.y;
      if (g.x + g.w > x1) x1 = g.x + g.w;
      if (g.y + g.h > y1) y1 = g.y + g.h;
    }
    const extra = (maxDepth - c.depth) * 22;
    c.x = x0 - 18 - extra;
    c.y = y0 - 34 - extra;
    c.w = x1 - x0 + 36 + extra * 2;
    c.h = y1 - y0 + 52 + extra * 2;
  }
}

function buildView(rootId, up, down, group = false) {
  const g = subgraph(MODEL, rootId, { up, down, maxNodes: 600 });
  // 过滤用户删掉的函数与连线。文件框 / 目录容器是从节点推导出来的，
  // 所以某个文件或目录里的函数被删空时，对应层级会自动消失
  const alive = g.nodes.filter((n) => !overlay.deleted.nodes[n.id]);
  const aliveIds = new Set(alive.map((n) => n.id));
  const viewEdges = g.edges.filter(
    (e) => aliveIds.has(e.from) && aliveIds.has(e.to) && !overlay.deleted.edges[edgeKeyOf(e)]
  );
  const clean = alive.map(({ bodyTokens, ...rest }) => rest);
  if (!clean.length) {
    return { nodes: [], edges: [], width: 480, height: 260, root: g.root, empty: true };
  }
  const laid = group ? layoutGrouped(clean, viewEdges) : layout(clean, viewEdges);

  // 手动布局按「入口 + 模式」分开存：坐标只在生成它的那个视图里有效
  const mode = group ? 'group' : 'flat';
  const slot = overlay.layout?.[layoutKey(g.root, mode)] || {};

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
    if (gb) {
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
    fitGroups(laid.groups, laid.nodes);
    fitContainers(laid.containers, laid.groups);
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

  // 合并标注
  for (const n of laid.nodes) {
    const ov = overlay.nodes?.[n.id];
    if (ov) Object.assign(n, { note: ov.note, color: ov.color, tag: ov.tag });
  }
  return { ...laid, root: g.root };
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

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
      const rootId = u.searchParams.get('root');
      const up = Number(u.searchParams.get('up') || 0);
      const down = Number(u.searchParams.get('down') || 2);
      const group = u.searchParams.get('group') === '1';
      if (!rootId) {
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
        return json(res, buildView(pick.id, up, Math.max(down, 3), group));
      }
      return json(res, buildView(rootId, up, down, group));
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

    if (u.pathname === '/api/export/xlsx') {
      const out = path.join(OUT, 'callgraph.xlsx');
      exportXlsx(MODEL, out);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="callgraph.xlsx"',
      });
      return fs.createReadStream(out).pipe(res);
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
      const out = path.join(OUT, 'view.html');
      exportHtml(tmp, out);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="callgraph.html"',
      });
      return fs.createReadStream(out).pipe(res);
    }

    if (u.pathname === '/api/layout' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const patch = JSON.parse(body);
          const mode = patch.mode === 'group' ? 'group' : 'flat';
          const rootId = String(patch.root || '');
          overlay.layout = overlay.layout || {};
          const key = layoutKey(rootId, mode);
          if (!overlay.layout[key]) overlay.layout[key] = { nodes: {}, edges: {}, manual: [] };
          const slot = overlay.layout[key];

          if (patch.clear) {
            slot.nodes = {};
            slot.edges = {};
            slot.manual = [];
          } else {
            if (patch.nodes) Object.assign(slot.nodes, patch.nodes);
            if (patch.manual) slot.manual = patch.manual;
            if (patch.edges) Object.assign(slot.edges, patch.edges);
          }
          fs.mkdirSync(OUT, { recursive: true });
          fs.writeFileSync(OVERLAY_PATH, JSON.stringify(overlay, null, 1), 'utf8');
          json(res, { ok: true });
        } catch (err) {
          json(res, { error: String(err) }, 400);
        }
      });
      return;
    }

    if (u.pathname === '/api/overlay' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const patch = JSON.parse(body);
          overlay.nodes = overlay.nodes || {};
          overlay.edges = overlay.edges || {};
          if (patch.nodeId) {
            overlay.nodes[patch.nodeId] = {
              ...(overlay.nodes[patch.nodeId] || {}),
              ...patch.data,
              updatedAt: new Date().toISOString(),
            };
          }
          if (patch.edgeKey) {
            overlay.edges[patch.edgeKey] = {
              ...(overlay.edges[patch.edgeKey] || {}),
              ...patch.data,
            };
          }
          fs.mkdirSync(OUT, { recursive: true });
          fs.writeFileSync(OVERLAY_PATH, JSON.stringify(overlay, null, 1), 'utf8');
          json(res, { ok: true });
        } catch (err) {
          json(res, { error: String(err) }, 400);
        }
      });
      return;
    }

    // 删除 / 恢复函数与连线：只记录 id，不改动源码
    if (u.pathname === '/api/delete' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const p = JSON.parse(body);
          if (p.clear) {
            // 一次性恢复所有被删除的函数与连线
            overlay.deleted = { nodes: {}, edges: {} };
            saveOverlay();
            return json(res, { ok: true, nodes: 0, edges: 0 });
          }
          const restore = !!p.restore;
          for (const id of p.nodes || []) {
            if (restore) delete overlay.deleted.nodes[id];
            else overlay.deleted.nodes[id] = 1;
          }
          for (const k of p.edges || []) {
            if (restore) delete overlay.deleted.edges[k];
            else overlay.deleted.edges[k] = 1;
          }
          saveOverlay();
          json(res, {
            ok: true,
            nodes: Object.keys(overlay.deleted.nodes).length,
            edges: Object.keys(overlay.deleted.edges).length,
          });
        } catch (err) {
          json(res, { error: String(err) }, 400);
        }
      });
      return;
    }

    // 共享路由模块（浏览器端动态重路由用）
    if (u.pathname === '/core/routing.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      return fs.createReadStream(path.join(__dirname, 'core', 'routing.js')).pipe(res);
    }

    // 静态文件
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.join(WEB, p);
    if (!file.startsWith(WEB)) {
      res.writeHead(403);
      return res.end('forbidden');
    }
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error(err);
    json(res, { error: String(err) }, 500);
  }
});

server.listen(PORT, () => {
  const actual = server.address().port;
  console.log(`[服务] http://localhost:${actual}`);
  if (process.send) process.send({ ready: true, port: actual });
});
