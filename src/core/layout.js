/**
 * 分层布局（Sugiyama 简化版）
 * 找回边 → Kahn 分层（压缩空层）→ 重心法减少交叉 →
 * 优先级对齐分配 x（子随父 / 父就子两遍取平均，空间随结构展开）→
 * 通道需求估算层间高度 → 坐标分配
 * 边路由统一交给 ./routing.js（前后端共享的正交路由器）
 */

import { routeEdges, collectSegments, STUB, SPACING, PORT_INSET } from './routing.js';

export function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += ch.charCodeAt(0) > 255 ? 14 : 7.6;
  }
  return w;
}

const pushTo = (m, k, v) => {
  if (!m.has(k)) m.set(k, []);
  m.get(k).push(v);
};

/** 区间最大重叠（贪心扫描），用于估算层间通道数 */
function maxOverlap(intervals) {
  const ev = [];
  for (const [a, b] of intervals) {
    ev.push([a, 1]);
    ev.push([b, -1]);
  }
  ev.sort((u, v) => u[0] - v[0] || v[1] - u[1]);
  let cur = 0;
  let best = 0;
  for (const [, d] of ev) {
    cur += d;
    if (cur > best) best = cur;
  }
  return best;
}

/** 与路由器 portAt 一致的近似端口 x（沿节点边展开） */
function spreadX(n, i, total) {
  const inset = Math.min(PORT_INSET, n.w / 4);
  return n.x + inset + ((i + 1) / (total + 1)) * Math.max(1, n.w - 2 * inset);
}

export function layout(nodes, edges, opts = {}) {
  const {
    nodeH = 44,
    subH = 58,
    gapX = 34,
    gapY = 76,
    padding = 40,
    maxLabelWidth = 260,
    minWidth = 120,
  } = opts;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const es = edges.filter((e) => idSet.has(e.from) && idSet.has(e.to));

  // ---- 1. 找回边 ----
  const out = new Map();
  for (const e of es) pushTo(out, e.from, e);
  const state = new Map();
  const backSet = new Set();
  const dfs = (v) => {
    state.set(v, 1);
    for (const e of out.get(v) || []) {
      const st = state.get(e.to);
      if (st === 1) backSet.add(e);
      else if (st === undefined) dfs(e.to);
    }
    state.set(v, 2);
  };
  for (const id of ids) if (!state.has(id)) dfs(id);

  // ---- 2. Kahn 分层 ----
  const layer = new Map(ids.map((id) => [id, 0]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of es) {
    if (backSet.has(e)) continue;
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const q = ids.filter((id) => indeg.get(id) === 0);
  const placed = new Set();
  while (q.length) {
    const v = q.shift();
    placed.add(v);
    for (const e of out.get(v) || []) {
      if (backSet.has(e)) continue;
      if (layer.get(e.to) < layer.get(v) + 1) layer.set(e.to, layer.get(v) + 1);
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) q.push(e.to);
    }
  }
  for (const id of ids) {
    if (placed.has(id)) continue;
    let mp = 0;
    for (const e of es) {
      if (e.to === id && placed.has(e.from)) mp = Math.max(mp, layer.get(e.from) + 1);
    }
    layer.set(id, mp);
  }

  // ---- 3. 分组 + 重心排序 ----
  const maxLayer = Math.max(0, ...ids.map((id) => layer.get(id)));
  const layers = [];
  for (let i = 0; i <= maxLayer; i++) layers.push([]);
  for (const id of ids) layers[layer.get(id)].push(id);
  const nonEmpty = layers.filter((l) => l.length);
  layers.length = 0;
  layers.push(...nonEmpty);

  // 压缩后的层号映射：层序（排序/高度估算）必须用压缩索引，
  // 用原始层号索引 layers 会在有空层时指向错误的层
  const layerIdx = new Map();
  layers.forEach((arr, li) => arr.forEach((id) => layerIdx.set(id, li)));

  const pos = new Map();
  const reindex = () => layers.forEach((arr) => arr.forEach((id, i) => pos.set(id, i)));
  reindex();

  const normPos = (id) => {
    const arr = layers[layerIdx.get(id)];
    if (!arr || arr.length <= 1) return 0.5;
    return pos.get(id) / (arr.length - 1);
  };

  const preds = new Map();
  const succs = new Map();
  for (const e of es) {
    if (backSet.has(e)) continue;
    pushTo(succs, e.from, e.to);
    pushTo(preds, e.to, e.from);
  }

  for (let it = 0; it < 8; it++) {
    const down = it % 2 === 0;
    const seq = [];
    if (down) for (let i = 1; i < layers.length; i++) seq.push(i);
    else for (let i = layers.length - 2; i >= 0; i--) seq.push(i);

    for (const li of seq) {
      const arr = layers[li];
      const bc = new Map();
      for (const id of arr) {
        const nb = down ? preds.get(id) || [] : succs.get(id) || [];
        let s = 0;
        let c = 0;
        for (const x of nb) {
          if (pos.has(x)) {
            s += normPos(x);
            c++;
          }
        }
        bc.set(id, c ? s / c : normPos(id));
      }
      arr.sort((a, b) => bc.get(a) - bc.get(b));
      arr.forEach((id, i) => pos.set(id, i));
    }
  }

  // ---- 4. 尺寸 ----
  const widthOf = (n) => {
    if (n.w) return n.w;
    const label = n.label || n.name || n.id;
    return Math.min(maxLabelWidth, Math.max(minWidth, textWidth(label) + 28));
  };
  const heightOf = (n) => n.h || (n.sub ? subH : nodeH);

  const nodeW = new Map(nodes.map((n) => [n.id, widthOf(n)]));
  const layerH = layers.map((arr) => Math.max(...arr.map((id) => heightOf(nodeMap.get(id)))));

  // ---- 4b. 每层动态水平间距：层越宽自动越紧凑，空间按需分配 ----
  const minGapX = opts.minGapX ?? 16;
  const layerGap = layers.map((arr) => {
    const k = Math.sqrt(12 / Math.max(1, arr.length)); // 约 12 个节点起开始收紧
    return Math.max(minGapX, Math.min(gapX, gapX * k));
  });

  // ---- 5. x 坐标：优先级对齐（子随父 / 父就子，两遍取平均）----
  // 逐层居中会让窄层全部挤向中线、两侧大片留白；改为按邻接关系对齐，
  // 节点跟随其在图中的结构位置展开，空间随结构自然分配。
  const packCentered = (li) => {
    const arr = layers[li];
    const g = layerGap[li];
    const totalW = arr.reduce((s, id) => s + nodeW.get(id), 0) + g * (arr.length - 1);
    const xs = new Map();
    let x = -totalW / 2;
    for (const id of arr) {
      xs.set(id, x);
      x += nodeW.get(id) + g;
    }
    return xs;
  };
  const xInit = new Map();
  for (let li = 0; li < layers.length; li++) {
    for (const [id, x] of packCentered(li)) xInit.set(id, x);
  }

  /**
   * 一层内落位：按期望 x 排序 → 向右推送消重叠 → 向左回拉去右偏 → 按期望均值整体校正。
   * 单向推送会让「期望相同的一串节点」整体偏向一侧，回拉 + 均值校正使其对称居中。
   */
  const placeLayer = (li, desired, out) => {
    const arr = layers[li].slice().sort((a, b) => desired.get(a) - desired.get(b));
    const g = layerGap[li];
    const x = new Map(arr.map((id) => [id, desired.get(id)]));
    let right = -Infinity;
    for (const id of arr) {
      if (x.get(id) < right + g) x.set(id, right + g);
      right = x.get(id) + nodeW.get(id);
    }
    let left = Infinity;
    for (let i = arr.length - 1; i >= 0; i--) {
      const id = arr[i];
      if (x.get(id) + nodeW.get(id) > left - g) x.set(id, left - g - nodeW.get(id));
      left = x.get(id);
    }
    let sumD = 0;
    let sumX = 0;
    for (const id of arr) {
      sumD += desired.get(id);
      sumX += x.get(id);
    }
    const shift = arr.length ? sumD / arr.length - sumX / arr.length : 0;
    for (const id of arr) out.set(id, x.get(id) + shift);
  };

  const alignPass = (down, from) => {
    const out = new Map(from);
    const seq = [];
    if (down) for (let i = 0; i < layers.length; i++) seq.push(i);
    else for (let i = layers.length - 1; i >= 0; i--) seq.push(i);
    for (const li of seq) {
      const desired = new Map();
      for (const id of layers[li]) {
        const nb = down ? preds.get(id) || [] : succs.get(id) || [];
        let s = 0;
        let c = 0;
        for (const t of nb) {
          s += out.get(t) + nodeW.get(t) / 2;
          c++;
        }
        desired.set(id, c ? s / c - nodeW.get(id) / 2 : xInit.get(id));
      }
      placeLayer(li, desired, out);
    }
    return out;
  };

  const xDown = alignPass(true, xInit); // 子对齐父
  const xUp = alignPass(false, xInit); // 父对齐子
  const xAvg = new Map(ids.map((id) => [id, (xDown.get(id) + xUp.get(id)) / 2]));
  const xFinal = new Map();
  for (let li = 0; li < layers.length; li++) placeLayer(li, xAvg, xFinal);

  // 平移到正区：左边贴 padding
  let minX = Infinity;
  for (const id of ids) minX = Math.min(minX, xFinal.get(id));
  const shiftX = padding - minX;
  for (const id of ids) xFinal.set(id, xFinal.get(id) + shiftX);

  const geo = new Map();
  for (let li = 0; li < layers.length; li++) {
    for (const id of layers[li]) {
      const n = nodeMap.get(id);
      geo.set(id, { x: xFinal.get(id), y: 0, w: nodeW.get(id), h: heightOf(n) });
    }
  }

  // ---- 6. 层间空隙高度：按压缩层号估算相邻层边的水平通道需求（区间最大重叠） ----
  const gapCount = Math.max(0, layers.length - 1);
  const gapEdges = Array.from({ length: gapCount }, () => []);
  const addGap = (li, e) => {
    if (li >= 0 && li < gapCount && !gapEdges[li].includes(e)) gapEdges[li].push(e);
  };
  for (const e of es) {
    if (e.from === e.to) continue;
    const la = layerIdx.get(e.from);
    const lb = layerIdx.get(e.to);
    if (la === lb) continue;
    // 长边/回边同样占据源层与目标层相邻间隙的水平通道，一并计入
    addGap(la < lb ? la : la - 1, e);
    addGap(lb > la ? lb - 1 : lb, e);
  }

  const gapHeights = gapEdges.map((list, li) => {
    if (!list.length) return gapY;
    // 近似端口 x：与路由器同款「按对端位置排序后沿边展开」
    const outMap = new Map();
    const inMap = new Map();
    for (const e of list) {
      pushTo(outMap, e.from, e);
      pushTo(inMap, e.to, e);
    }
    const sx = new Map();
    const tx = new Map();
    for (const [id, l] of outMap) {
      const n = geo.get(id);
      l.sort(
        (p, q) =>
          geo.get(q.to).x + geo.get(q.to).w / 2 - (geo.get(p.to).x + geo.get(p.to).w / 2)
      );
      l.forEach((e, i) => sx.set(e, spreadX(n, i, l.length)));
    }
    for (const [id, l] of inMap) {
      const n = geo.get(id);
      l.sort(
        (p, q) =>
          geo.get(q.from).x + geo.get(q.from).w / 2 - (geo.get(p.from).x + geo.get(p.from).w / 2)
      );
      l.forEach((e, i) => tx.set(e, spreadX(n, i, l.length)));
    }
    const intervals = list.map((e) => {
      const a = sx.get(e);
      const b = tx.get(e);
      return [Math.min(a, b), Math.max(a, b)];
    });
    const bands = Math.max(1, maxOverlap(intervals));
    // +SPACING 余量：容纳长边落在该间隙里的通道
    return Math.max(gapY, STUB * 2 + (bands - 1) * SPACING + 14 + SPACING);
  });

  // ---- 7. y 坐标 ----
  let y = padding;
  const layerBottom = [];
  for (let li = 0; li < layers.length; li++) {
    const arr = layers[li];
    for (const id of arr) {
      const g = geo.get(id);
      g.y = y + (layerH[li] - g.h) / 2;
    }
    y += layerH[li];
    layerBottom[li] = y;
    if (li < layers.length - 1) y += gapHeights[li] ?? gapY;
  }
  const totalH = y + padding;

  // ---- 8. 正交路由（共享路由器） ----
  const geoNodes = nodes.map((n) => {
    const g = geo.get(n.id);
    return { ...n, ...g };
  });
  routeEdges(geoNodes, es);

  // 侧边车道可能越界：整体平移 + 扩画布
  let maxRight = 0;
  let minLeft = Infinity;
  for (const g of geoNodes) {
    if (g.x + g.w > maxRight) maxRight = g.x + g.w;
    if (g.x < minLeft) minLeft = g.x;
  }
  let laneRight = -Infinity;
  let laneLeft = Infinity;
  for (const e of es) {
    if (!e.points) continue;
    for (const p of e.points) {
      if (p[0] > laneRight) laneRight = p[0];
      if (p[0] < laneLeft) laneLeft = p[0];
    }
  }
  let shift = 0;
  if (laneLeft < minLeft && laneLeft < padding) shift = Math.min(minLeft, padding) - laneLeft;
  if (shift > 0) {
    for (const n of geoNodes) n.x += shift;
    for (const e of es) {
      if (e.points) for (const p of e.points) p[0] += shift;
    }
    laneRight += shift;
  }
  const width = Math.max(maxRight + shift, laneRight) + padding;

  return {
    nodes: geoNodes,
    edges: es,
    width,
    height: totalH,
    layers: layers.length,
    backEdges: backSet.size,
  };
}

function shortName(f) {
  const parts = String(f).split(/[\\/]/);
  return parts[parts.length - 1];
}

/**
 * 分组布局：每个文件一个大框，框内是该文件的函数
 * 先对文件级图分层，再对每个文件内部独立布局，最后合并坐标
 * 组内边随内部布局平移，跨组边用共享路由器统一布线
 */
export function layoutGrouped(nodes, edges, opts = {}) {
  const { fileOf = (n) => n.file || 'unknown', headerH = 26, ...rest } = opts;

  const groups = new Map();
  for (const n of nodes) {
    const f = fileOf(n);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(n);
  }

  // 1. 组内布局
  const inner = new Map();
  for (const [file, list] of groups) {
    const ids = new Set(list.map((n) => n.id));
    const innerEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const laid = layout(list, innerEdges, {
      ...rest,
      padding: 16,
      gapX: 24,
      gapY: 50,
      maxLabelWidth: 190,
    });
    for (const n of laid.nodes) n.y += headerH;
    for (const e of laid.edges) {
      if (e.points) for (const p of e.points) p[1] += headerH;
    }
    laid.height += headerH;
    inner.set(file, laid);
  }

  // 2. 文件级图（跨文件调用去重）
  const fileOfId = new Map(nodes.map((n) => [n.id, fileOf(n)]));
  const fileEdges = [];
  const seen = new Set();
  for (const e of edges) {
    const a = fileOfId.get(e.from);
    const b = fileOfId.get(e.to);
    if (!a || !b || a === b) continue;
    const k = a + '\u0000' + b;
    if (seen.has(k)) continue;
    seen.add(k);
    fileEdges.push({ from: a, to: b, kind: 'direct' });
  }

  const fileNodes = [...groups.keys()].map((f) => ({
    id: f,
    name: shortName(f),
    label: shortName(f),
    w: inner.get(f).width,
    h: inner.get(f).height,
    isGroup: true,
  }));

  const fileLay = layout(fileNodes, fileEdges, {
    padding: 30,
    gapX: 46,
    gapY: 62,
    minWidth: 140,
  });

  // 3. 合并坐标 + 组内边平移
  const geo = new Map();
  const offsetOf = new Map();
  const innerEdgeMap = new Map(); // from|to|line → 平移后的 points
  for (const fn of fileLay.nodes) {
    offsetOf.set(fn.id, { x: fn.x, y: fn.y });
    const laid = inner.get(fn.id);
    const idx = new Map();
    for (const e of laid.edges) {
      idx.set(`${e.from}|${e.to}|${e.line}`, e);
    }
    for (const n of laid.nodes) {
      geo.set(n.id, { ...n, x: n.x + fn.x, y: n.y + fn.y, group: fn.id });
    }
    for (const e of laid.edges) {
      innerEdgeMap.set(`${e.from}|${e.to}|${e.line}`, {
        ...e,
        points: e.points.map((p) => [p[0] + fn.x, p[1] + fn.y]),
      });
    }
  }

  // 4. 边：组内直接平移，跨组用共享路由器
  const mergedNodes = [...geo.values()];
  const routed = [];
  const crossEdges = [];
  for (const e of edges) {
    const a = geo.get(e.from);
    const b = geo.get(e.to);
    if (!a || !b) continue;
    if (a.group === b.group) {
      const m = innerEdgeMap.get(`${e.from}|${e.to}|${e.line}`);
      if (m) {
        routed.push(m);
        continue;
      }
    }
    crossEdges.push(e);
  }

  // 跨组边路由：组内边线段作为避让约束
  const innerRouted = routed.slice();
  const res = routeEdges(mergedNodes, crossEdges, {
    existing: collectSegments(innerRouted),
  });
  routed.push(...crossEdges);

  let maxX = 0;
  let maxY = 0;
  for (const n of fileLay.nodes) {
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  let laneRight = -Infinity;
  for (const e of crossEdges) {
    if (!e.points) continue;
    for (const p of e.points) if (p[0] > laneRight) laneRight = p[0];
  }
  const width = Math.max(maxX, laneRight) + 30;

  // 目录容器：按路径前缀聚合文件框，形成 src / db / se 多层嵌套
  const dirBoxes = new Map();
  for (const fn of fileLay.nodes) {
    const parts = String(fn.id).split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirBoxes.has(dir)) dirBoxes.set(dir, []);
      dirBoxes.get(dir).push(fn);
    }
  }
  const dirEntries = [...dirBoxes.entries()];
  const maxDepth = dirEntries.reduce((m, [p]) => Math.max(m, p.split('/').length), 1);
  const containers = dirEntries
    .map(([p, list]) => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const g of list) {
        x0 = Math.min(x0, g.x);
        y0 = Math.min(y0, g.y);
        x1 = Math.max(x1, g.x + g.w);
        y1 = Math.max(y1, g.y + g.h);
      }
      const depth = p.split('/').length;
      // 外层比内层多留出 (maxDepth - depth) * 22，保证每层标题不重叠
      const extra = (maxDepth - depth) * 22;
      return {
        id: p,
        label: p.split('/').pop(),
        x: x0 - 18 - extra,
        y: y0 - 34 - extra,
        w: x1 - x0 + 36 + extra * 2,
        h: y1 - y0 + 52 + extra * 2,
        depth,
      };
    })
    .sort((a, b) => a.depth - b.depth);

  const fileGroups = fileLay.nodes.map((n) => ({
    id: n.id,
    label: n.name,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
    layer: n.layer,
  }));

  // 外层容器的负 padding 会把框推到负坐标，整体平移回正区
  let minX = Infinity;
  let minY = Infinity;
  for (const c of containers) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
  }
  for (const g of fileGroups) {
    minX = Math.min(minX, g.x);
    minY = Math.min(minY, g.y);
  }
  const ox = Number.isFinite(minX) && minX < 40 ? 40 - minX : 0;
  const oy = Number.isFinite(minY) && minY < 40 ? 40 - minY : 0;
  if (ox || oy) {
    for (const n of mergedNodes) {
      n.x += ox;
      n.y += oy;
    }
    for (const g of fileGroups) {
      g.x += ox;
      g.y += oy;
    }
    for (const c of containers) {
      c.x += ox;
      c.y += oy;
    }
    for (const e of routed) {
      if (!e.points) continue;
      for (const p of e.points) {
        p[0] += ox;
        p[1] += oy;
      }
    }
  }

  return {
    nodes: mergedNodes,
    edges: routed,
    containers,
    groups: fileGroups,
    width: width + ox,
    height: maxY + 30 + oy,
    layers: fileLay.layers,
  };
}
