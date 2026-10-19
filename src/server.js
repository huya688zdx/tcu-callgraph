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

function buildView(rootId, up, down, group = false) {
  const g = subgraph(MODEL, rootId, { up, down, maxNodes: 600 });
  const clean = g.nodes.map(({ bodyTokens, ...rest }) => rest);
  const laid = group ? layoutGrouped(clean, g.edges) : layout(clean, g.edges);

  // 手动布局按模式分开存：flat / group 坐标不通用
  const mode = group ? 'group' : 'flat';
  const slot = overlay.layout?.[mode] || {};

  // 手动拖拽的节点位置优先
  const savedNodes = slot.nodes || {};
  for (const n of laid.nodes) {
    const p = savedNodes[n.id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      n.x = p.x;
      n.y = p.y;
    }
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
          overlay.layout = overlay.layout || {};
          if (!overlay.layout[mode]) overlay.layout[mode] = { nodes: {}, edges: {}, manual: [] };
          const slot = overlay.layout[mode];

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
