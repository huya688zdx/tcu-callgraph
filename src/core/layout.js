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

/**
 * 找回边（DFS 染色法）：把指向「仍在栈上」的节点的边判为回边。
 * 用显式栈实现，避免长链图（12000 节点）触发递归栈溢出。
 */
function findBackEdges(ids, out) {
  const state = new Map(); // 1 = 在栈上, 2 = 已访问完
  const backSet = new Set();
  for (const root of ids) {
    if (state.has(root)) continue;
    state.set(root, 1);
    const stack = [{ v: root, i: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const list = out.get(frame.v) || [];
      if (frame.i < list.length) {
        const e = list[frame.i++];
        const st = state.get(e.to);
        if (st === 1) backSet.add(e);
        else if (st === undefined) {
          state.set(e.to, 1);
          stack.push({ v: e.to, i: 0 });
        }
      } else {
        state.set(frame.v, 2);
        stack.pop();
      }
    }
  }
  return backSet;
}

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

function layoutBase(nodes, edges, opts = {}) {
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
  const backSet = findBackEdges(ids, out);

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

  // 存档坐标作重心初值（seeded barycenter，ELK INTERACTIVE 策略的思想）：
  // 同一视图上次布局的 x 次序作为各层初始排列——旧节点保持相对次序，
  // 新节点（没有 seed 坐标）保持原相对次序排在该层有坐标的节点之后，
  // 加节点时旧节点不跳变、只引起局部挪动。
  // 只影响初始次序，后面的 8 轮重心迭代逻辑完全不变；分层与回边检测也不受影响
  const seed = opts.seed || null;
  if (seed) {
    for (const arr of layers) {
      const withSeed = [];
      const withoutSeed = [];
      for (const id of arr) {
        (seed[id] && Number.isFinite(seed[id].x) ? withSeed : withoutSeed).push(id);
      }
      if (!withSeed.length) continue;
      withSeed.sort((a, b) => seed[a].x - seed[b].x);
      arr.length = 0;
      arr.push(...withSeed, ...withoutSeed);
    }
  }

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
    // 函数名显示时带 ()，比裸名字多留两个字符
    const extra = n.kind === 'var' ? 0 : 16;
    return Math.min(maxLabelWidth, Math.max(minWidth, textWidth(label) + 28 + extra));
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

  // ---- 7. y 坐标（超宽层拆行 + 层带折行，整体长宽比贴近 1:1）----
  // 单文件大图（扁平布局 / 文件框内部）没有分区式布局的列数优化可用，
  // 这里做两级装填：超宽的层先拆成多行（同层无前向边，安全），
  // 再把层栈按累计高度均衡切成几段并排摆放；跨列连线由后面的统一路由绕行。
  // 列内保持全局 x（父子对齐不被破坏），整列只做平移
  const bandGap = Math.max(gapX * 2, 90); // 列间走廊：跨列连线绕行走这里
  const splitRowGap = gapY; // 同层拆行后的行距：上一层连到第二行的线要穿行间通道
  const maxRowWidth = opts.maxRowWidth ?? 900;
  const gapAfter = layers.map((_, li) => (li < layers.length - 1 ? gapHeights[li] ?? gapY : 0));

  // 7a. 超宽层拆行：按 x 序贪心装行，行内从左重排（对齐信息在几十个节点的宽层里本就不可读）
  const rowsOf = layers.map((arr, li) => {
    const g = layerGap[li];
    const sorted = arr.slice().sort((a, b) => xFinal.get(a) - xFinal.get(b));
    const totalW = sorted.reduce((s, id) => s + nodeW.get(id), 0) + g * (arr.length - 1);
    if (arr.length < 4 || totalW <= maxRowWidth) {
      return [{ ids: sorted, x0: Math.min(...sorted.map((id) => xFinal.get(id))) }];
    }
    const rows = [];
    let row = [];
    let rowW = 0;
    let x = 0;
    for (const id of sorted) {
      const w = nodeW.get(id);
      if (row.length && rowW + g + w > maxRowWidth) {
        rows.push({ ids: row, x0: 0 });
        row = [];
        rowW = 0;
        x = 0;
      }
      xFinal.set(id, x); // 行内从左重排
      row.push(id);
      rowW += (row.length > 1 ? g : 0) + w;
      x += w + g;
    }
    if (row.length) rows.push({ ids: row, x0: 0 });
    return rows;
  });
  const layerExt = rowsOf.map((rows) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (const row of rows) {
      for (const id of row.ids) {
        const x = xFinal.get(id);
        if (x < x0) x0 = x;
        if (x + nodeW.get(id) > x1) x1 = x + nodeW.get(id);
      }
    }
    return { x0, x1 };
  });
  // 拆行后的层高
  const effH = rowsOf.map((rows, li) =>
    rows.reduce(
      (s, row, k) =>
        s + (k ? splitRowGap : 0) + Math.max(...row.ids.map((id) => heightOf(nodeMap.get(id)))),
      0
    )
  );

  // 7b. 层带折行：各层按累计高度均衡分配到 C 列
  const prefix = [0];
  for (let li = 0; li < layers.length; li++) prefix.push(prefix[li] + effH[li] + gapAfter[li]);
  const totalStack = prefix[layers.length];
  const planFor = (C) => {
    // 第 li 层按累计高度落进 floor(P/(总高/C)) 列；某层跨过多个切点时空列直接并掉
    const remap = new Map();
    const cols = [];
    layers.forEach((_, li) => {
      const raw = Math.min(C - 1, Math.floor((prefix[li] / (totalStack / C)) * (1 - 1e-9)));
      if (!remap.has(raw)) {
        remap.set(raw, cols.length);
        cols.push([]);
      }
      cols[remap.get(raw)].push(li);
    });
    const colBox = cols.map((lis) => ({
      x0: Math.min(...lis.map((li) => layerExt[li].x0)),
      x1: Math.max(...lis.map((li) => layerExt[li].x1)),
      h: lis.reduce((s, li, k) => s + effH[li] + (k < lis.length - 1 ? gapAfter[li] : 0), 0),
    }));
    const W = padding * 2 + colBox.reduce((s, b) => s + (b.x1 - b.x0), 0) + bandGap * (cols.length - 1);
    const H = padding * 2 + Math.max(...colBox.map((b) => b.h));
    return { cols, colBox, W, H, score: Math.abs(Math.log(W / Math.max(1, H))) + (cols.length - 1) * 0.02 };
  };
  let plan = planFor(1);
  for (let C = 2; C <= Math.min(8, layers.length); C++) {
    const p = planFor(C);
    // 折行要有明显收益（0.08 log）才动：小图保持单列
    if (p.score < plan.score - 0.08) plan = p;
  }
  let colX = padding;
  let maxY = 0;
  for (let c = 0; c < plan.cols.length; c++) {
    let y = padding;
    const shift = colX - plan.colBox[c].x0;
    for (let k = 0; k < plan.cols[c].length; k++) {
      const li = plan.cols[c][k];
      for (const row of rowsOf[li]) {
        const rowH = Math.max(...row.ids.map((id) => heightOf(nodeMap.get(id))));
        for (const id of row.ids) {
          const g = geo.get(id);
          g.x = xFinal.get(id) + shift;
          g.y = y + (rowH - g.h) / 2;
        }
        y += rowH + splitRowGap;
      }
      y -= splitRowGap; // 最后一行不加行距
      y += k < plan.cols[c].length - 1 ? gapAfter[li] : 0;
    }
    maxY = Math.max(maxY, y);
    colX += plan.colBox[c].x1 - plan.colBox[c].x0 + bandGap;
  }
  const totalH = maxY + padding;

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

function cloneEdges(edges) {
  return edges.map((e) => {
    const copy = { ...e };
    if (e.points) copy.points = e.points.map((p) => [p[0], p[1]]);
    delete copy._p0;
    delete copy._p1;
    return copy;
  });
}

function overlapNodes(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (
        Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 &&
        Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5
      ) return true;
    }
  }
  return false;
}

/** 只检查第 idx 个节点是否与其它节点重叠（其余节点对在基线布局里已无重叠） */
function overlapsAny(nodes, idx) {
  const a = nodes[idx];
  if (!a) return false;
  for (let j = 0; j < nodes.length; j++) {
    if (j === idx) continue;
    const b = nodes[j];
    if (
      Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 &&
      Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5
    ) return true;
  }
  return false;
}

function routeLengthAndCrossings(edges) {
  const horizontal = [];
  const vertical = [];
  const pathKeys = new Set();
  let bends = 0;
  let rawLength = 0;
  for (const e of edges) {
    const pts = e.points || [];
    const signature = pts.map((p) => `${Math.round(p[0])},${Math.round(p[1])}`).join(';');
    if (signature && !pathKeys.has(signature)) {
      pathKeys.add(signature);
      bends += Math.max(0, pts.length - 2);
      let pathLength = 0;
      for (let i = 0; i < pts.length - 1; i++) pathLength += Math.abs(pts[i + 1][0] - pts[i][0]) + Math.abs(pts[i + 1][1] - pts[i][1]);
      rawLength += pathLength;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      if (Math.abs(y1 - y2) < 0.5) {
        horizontal.push({ y: Math.round((y1 + y2) / 2), x1: Math.min(x1, x2), x2: Math.max(x1, x2), edge: e });
      } else if (Math.abs(x1 - x2) < 0.5) {
        vertical.push({ x: Math.round((x1 + x2) / 2), y1: Math.min(y1, y2), y2: Math.max(y1, y2), edge: e });
      }
    }
  }

  // 共线共享干线只按画面上实际占用的长度计一次。
  const unionLength = (segments, axis, coord) => {
    const byLine = new Map();
    for (const s of segments) {
      const key = Math.round(s[axis] / 2) * 2;
      if (!byLine.has(key)) byLine.set(key, []);
      byLine.get(key).push([s[coord[0]], s[coord[1]]]);
    }
    let total = 0;
    for (const list of byLine.values()) {
      list.sort((a, b) => a[0] - b[0]);
      let lo = null;
      let hi = null;
      for (const [a, b] of list) {
        if (lo === null) [lo, hi] = [a, b];
        else if (a <= hi + 1) hi = Math.max(hi, b);
        else {
          total += hi - lo;
          [lo, hi] = [a, b];
        }
      }
      if (lo !== null) total += hi - lo;
    }
    return total;
  };
  const length = unionLength(horizontal, 'y', ['x1', 'x2']) + unionLength(vertical, 'x', ['y1', 'y2']);

  const intersections = new Set();
  for (const h of horizontal) {
    for (const v of vertical) {
      if (v.x <= h.x1 + 0.5 || v.x >= h.x2 - 0.5 || h.y <= v.y1 + 0.5 || h.y >= v.y2 - 0.5) continue;
      const related = h.edge.from === v.edge.from || h.edge.from === v.edge.to || h.edge.to === v.edge.from || h.edge.to === v.edge.to;
      if (!related) intersections.add(`${Math.round(v.x)},${Math.round(h.y)}`);
    }
  }
  return { length, rawLength, sharedLength: Math.max(0, rawLength - length), crossings: intersections.size, bends };
}

function normalizeCandidate(nodes, edges, padding) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = 0;
  let maxY = 0;
  const take = (x, y) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const n of nodes) {
    take(n.x, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const e of edges) for (const p of e.points || []) take(p[0], p[1]);
  if (!Number.isFinite(minX)) return { width: padding * 2, height: padding * 2 };
  const dx = Math.max(0, padding - minX);
  const dy = Math.max(0, padding - minY);
  if (dx || dy) {
    for (const n of nodes) { n.x += dx; n.y += dy; }
    for (const e of edges) for (const p of e.points || []) { p[0] += dx; p[1] += dy; }
    maxX += dx;
    maxY += dy;
  }
  return { width: maxX + padding, height: maxY + padding };
}

function candidateScore(candidate) {
  if (overlapNodes(candidate.nodes)) return Infinity;
  const { length, sharedLength, crossings, bends } = routeLengthAndCrossings(candidate.edges);
  let width = candidate.width;
  let height = candidate.height;
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    let maxX = 0;
    let maxY = 0;
    for (const n of candidate.nodes) {
      maxX = Math.max(maxX, n.x + n.w);
      maxY = Math.max(maxY, n.y + n.h);
    }
    for (const e of candidate.edges) for (const p of e.points || []) {
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
    width = maxX + 40;
    height = maxY + 40;
  }
  const area = width * height;
  const bundleCredit = Math.min(length * 0.65, sharedLength * 1.1);
  // 长宽比软约束：横向/纵向两个候选连线质量相近时，选更接近 1:1 的那个，
  // 避免长链图排出 1:N 的细长条（权重远小于线长，只在接近时起作用）
  const aspectPenalty = Math.abs(Math.log(Math.max(1e-3, width) / Math.max(1, height))) * 60;
  return length - bundleCredit + crossings * 360 + bends * 16 + area * 0.00008 + aspectPenalty;
}

function refineGroupedNodes(nodes, edges, groups, headerH = 26) {
  if (nodes.length > 120 || edges.length > 260 || edges.some((e) => e.custom)) return;
  // 试算预算：每个候选位置都要做一次完整重路由 + 交叉数统计，
  // 不设预算时 80 节点 / 180 边会跑到 5 秒级（服务端同步阻塞整个请求）。
  const TRIAL_BUDGET = 120;
  const TRIAL_TIME_BUDGET = 150;
  const trialStart = Date.now();
  let trials = 0;
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const currentNodes = nodes.map((n) => ({ ...n }));
  const currentEdges = cloneEdges(edges);
  routeEdges(currentNodes, currentEdges);
  const byId = new Map(currentNodes.map((n) => [n.id, n]));
  const neighbors = new Map(currentNodes.map((n) => [n.id, new Set()]));
  const extDegree = new Map(currentNodes.map((n) => [n.id, 0]));
  const degree = new Map(currentNodes.map((n) => [n.id, 0]));
  const fanoutTargets = new Map();
  for (const e of currentEdges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    neighbors.get(a.id).add(b.id);
    neighbors.get(b.id).add(a.id);
    degree.set(a.id, degree.get(a.id) + 1);
    degree.set(b.id, degree.get(b.id) + 1);
    if (a.group !== b.group) {
      extDegree.set(a.id, extDegree.get(a.id) + 1);
      extDegree.set(b.id, extDegree.get(b.id) + 1);
      if (!fanoutTargets.has(a.id)) fanoutTargets.set(a.id, new Set());
      fanoutTargets.get(a.id).add(b.id);
    }
  }
  // 保持调用者锚点稳定，让多个目标仍可在各自文件框内靠拢以形成共享干线。
  const bundledSources = new Set();
  for (const [sourceId, targetIds] of fanoutTargets) {
    if (targetIds.size < 2) continue;
    bundledSources.add(sourceId);
  }
  const order = currentNodes.slice().sort(
    (a, b) => extDegree.get(b.id) - extDegree.get(a.id) || degree.get(b.id) - degree.get(a.id) || a.id.localeCompare(b.id)
  ).filter((n) => extDegree.get(n.id) > 0 && !bundledSources.has(n.id)).slice(0, 24);
  let score = candidateScore({ nodes: currentNodes, edges: currentEdges });

  for (const original of order) {
    if (trials >= TRIAL_BUDGET || Date.now() - trialStart > TRIAL_TIME_BUDGET) break;
    let node = byId.get(original.id);
    const box = groupById.get(node.group);
    if (!box) continue;
    const alignedOptions = [];
    const options = [];
    for (const neighborId of neighbors.get(node.id) || []) {
      const other = byId.get(neighborId);
      if (!other) continue;
      if (other.group !== node.group) {
        // 外部调用点可能与节点不在同一行/列。扫描所属文件框内与调用点对齐的空位，
        // 让被调用节点有机会靠到文件框右侧并直接接入共享线路。
        const minX = box.x + 8;
        const maxX = box.x + box.w - node.w - 8;
        const y = other.y + (other.h - node.h) / 2;
        for (let x = minX; x <= maxX; x += 24) {
          alignedOptions.push({ x, y });
        }
        const minY = box.y + headerH + 4;
        const maxY = box.y + box.h - node.h - 6;
        const x = Math.max(minX, Math.min(maxX, other.x + (other.w - node.w) / 2));
        for (let yy = minY; yy <= maxY; yy += 24) {
          alignedOptions.push({ x, y: yy });
        }
      }
      options.push(
        { x: other.x + other.w + 24, y: other.y + (other.h - node.h) / 2 },
        { x: other.x - node.w - 24, y: other.y + (other.h - node.h) / 2 },
        { x: other.x + (other.w - node.w) / 2, y: other.y + other.h + 24 },
        { x: other.x + (other.w - node.w) / 2, y: other.y - node.h - 24 }
      );
    }
    const seen = new Set();
    for (const p of [...alignedOptions, ...options].slice(0, 40)) {
      if (trials >= TRIAL_BUDGET || Date.now() - trialStart > TRIAL_TIME_BUDGET) break;
      trials++;
      const key = `${Math.round(p.x)},${Math.round(p.y)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (
        p.x < box.x + 8 || p.y < box.y + headerH + 4 ||
        p.x + node.w > box.x + box.w - 8 || p.y + node.h > box.y + box.h - 6
      ) continue;
      // 只替换被移动的那一个节点对象，其余节点原样复用（浅拷贝）
      const nodeIdx = currentNodes.indexOf(node);
      if (nodeIdx < 0) continue;
      const trialNodes = currentNodes.slice();
      trialNodes[nodeIdx] = { ...node, ...p };
      // 基线布局里节点两两不重叠，所以只有被移动的节点可能新产生重叠
      if (overlapsAny(trialNodes, nodeIdx)) continue;
      const trialEdges = cloneEdges(edges);
      routeEdges(trialNodes, trialEdges);
      const trialScore = candidateScore({ nodes: trialNodes, edges: trialEdges });
      const movementCost = (Math.abs(p.x - node.x) + Math.abs(p.y - node.y)) * 0.06;
      if (trialScore + movementCost < score - 1) {
        currentNodes.splice(0, currentNodes.length, ...trialNodes);
        currentEdges.splice(0, currentEdges.length, ...trialEdges);
        score = trialScore;
        for (const n of currentNodes) byId.set(n.id, n);
        node = byId.get(node.id);
      }
    }
  }

  for (const n of nodes) {
    const p = byId.get(n.id);
    n.x = p.x;
    n.y = p.y;
  }
  for (let i = 0; i < edges.length; i++) Object.assign(edges[i], currentEdges[i]);
}

/** 同时比较上下流向和左右流向，并在小图上试探邻接节点四周的局部摆位。 */
export function layout(nodes, edges, opts = {}) {
  const padding = opts.padding ?? 40;
  const vertical = layoutBase(nodes.map((n) => ({ ...n })), cloneEdges(edges), opts);
  Object.assign(vertical, normalizeCandidate(vertical.nodes, vertical.edges, padding));
  const candidates = [vertical];

  // 手工折线的位置有明确含义，自动旋转不会改写这类用户布局。
  if (!edges.some((e) => e.custom && Array.isArray(e.points) && e.points.length >= 2) && nodes.length > 1) {
    const widthOf = (n) => {
      if (n.w) return n.w;
      const label = n.label || n.name || n.id;
      return Math.min(opts.maxLabelWidth ?? 260, Math.max(opts.minWidth ?? 120, textWidth(label) + 28 + (n.kind === 'var' ? 0 : 16)));
    };
    const heightOf = (n) => n.h || (n.sub ? (opts.subH ?? 58) : (opts.nodeH ?? 44));
    const swapped = nodes.map((n) => ({ ...n, w: heightOf(n), h: widthOf(n) }));
    const rotated = layoutBase(swapped, cloneEdges(edges), {
      ...opts,
      gapX: opts.gapY ?? 76,
      gapY: opts.gapX ?? 34,
    });
    const rotatedById = new Map(rotated.nodes.map((n) => [n.id, n]));
    const horizontalNodes = nodes.map((n) => {
      const p = rotatedById.get(n.id);
      return { ...n, x: p.y, y: p.x, w: p.h, h: p.w };
    });
    const horizontalEdges = cloneEdges(edges);
    routeEdges(horizontalNodes, horizontalEdges);
    const size = normalizeCandidate(horizontalNodes, horizontalEdges, padding);
    candidates.push({ ...rotated, nodes: horizontalNodes, edges: horizontalEdges, ...size });
  }

  let best = candidates[0];
  let bestScore = candidateScore(best);
  for (let i = 1; i < candidates.length; i++) {
    const score = candidateScore(candidates[i]);
    if (score < bestScore - 0.5) {
      best = candidates[i];
      bestScore = score;
    }
  }

  // 小图上允许单个节点换到邻居左右/上下；大图只比较两种整体方向，控制计算量。
  if (best.nodes.length <= 36 && best.edges.length <= 120 && !edges.some((e) => e.custom)) {
    let current = { ...best, nodes: best.nodes.map((n) => ({ ...n })), edges: cloneEdges(best.edges) };
    let currentScore = candidateScore(current);
    const degree = new Map(current.nodes.map((n) => [n.id, 0]));
    const neighbors = new Map(current.nodes.map((n) => [n.id, new Set()]));
    for (const e of current.edges) {
      degree.set(e.from, (degree.get(e.from) || 0) + 1);
      degree.set(e.to, (degree.get(e.to) || 0) + 1);
      neighbors.get(e.from)?.add(e.to);
      neighbors.get(e.to)?.add(e.from);
    }
    const nodeById = new Map(current.nodes.map((n) => [n.id, n]));
    const order = current.nodes.slice().sort((a, b) => (degree.get(b.id) || 0) - (degree.get(a.id) || 0) || a.id.localeCompare(b.id));
    for (const n0 of order) {
      let n = nodeById.get(n0.id);
      const points = [];
      for (const id of neighbors.get(n.id) || []) {
        const other = nodeById.get(id);
        if (!other) continue;
        points.push(
          { x: other.x + other.w + 32, y: other.y + (other.h - n.h) / 2 },
          { x: other.x - n.w - 32, y: other.y + (other.h - n.h) / 2 },
          { x: other.x + (other.w - n.w) / 2, y: other.y + other.h + 32 },
          { x: other.x + (other.w - n.w) / 2, y: other.y - n.h - 32 }
        );
      }
      const seen = new Set();
      for (const p of points) {
        const key = `${Math.round(p.x)},${Math.round(p.y)}`;
        if (seen.has(key) || p.x < padding || p.y < padding) continue;
        seen.add(key);
        const trialNodes = current.nodes.map((x) => x.id === n.id ? { ...x, ...p } : { ...x });
        if (overlapNodes(trialNodes)) continue;
        const trialEdges = cloneEdges(edges);
        routeEdges(trialNodes, trialEdges);
        const size = normalizeCandidate(trialNodes, trialEdges, padding);
        const trial = { ...current, nodes: trialNodes, edges: trialEdges, ...size };
        const score = candidateScore(trial);
        const move = Math.abs(p.x - n.x) + Math.abs(p.y - n.y);
        const adjusted = score + move * 0.06;
        if (adjusted < currentScore - 1) {
          current = trial;
          currentScore = score;
          for (const updated of current.nodes) nodeById.set(updated.id, updated);
          n = nodeById.get(n.id);
        }
      }
    }
    best = current;
  }
  return best;
}

/**
 * 分区式紧凑布局：把一组矩形（文件框 / 目录框）按调用方向分级，
 * 级内按重心排序，再按「每列 R 级」列优先蛇形折行成多列二维分区
 * （第 0 级→左上、第 1 级→左下、第 2 级→右上……），
 * R 由整体宽高比最优化自动选择（目标接近 1:1），避免所有模块排成一列。
 * 超宽的级自动拆成多行（同级之间没有前向边，拆行安全）。
 * 相邻级之间的行距按边的水平通道需求自适应撑高。
 */
export function layoutPartitioned(items, edges, opts = {}) {
  const {
    padding = 14,
    gapX = 40, // 同级相邻框的水平间距
    rowGap = 56, // 相邻两级（上下）的基础行距
    colGap = 72, // 列间距（跨列连线走这里）
    maxRowWidth = 780, // 单行最大宽度，超过拆行
    targetAspect = 1, // 期望的整体宽高比：接近 1:1 最利于阅读
    scorePlacement = null,
  } = opts;

  const byId = new Map(items.map((it) => [it.id, it]));
  const ids = items.map((it) => it.id);
  const es = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to);
  const wOf = (id) => byId.get(id).w;
  const hOf = (id) => byId.get(id).h;

  if (!items.length) return { pos: new Map(), width: 0, height: 0, columns: 0, ranks: 0 };

  // ---- 1. 分级（找环回边 → Kahn 最长路径）----
  const out = new Map();
  for (const e of es) pushTo(out, e.from, e);
  const back = findBackEdges(ids, out);

  const rank = new Map(ids.map((id) => [id, 0]));
  const indeg = new Map(ids.map((id) => [id, 0]));
  for (const e of es) {
    if (back.has(e)) continue;
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const q = ids.filter((id) => indeg.get(id) === 0);
  const done = new Set();
  while (q.length) {
    const v = q.shift();
    done.add(v);
    for (const e of out.get(v) || []) {
      if (back.has(e)) continue;
      if (rank.get(e.to) < rank.get(v) + 1) rank.set(e.to, rank.get(v) + 1);
      indeg.set(e.to, indeg.get(e.to) - 1);
      if (indeg.get(e.to) === 0) q.push(e.to);
    }
  }
  for (const id of ids) {
    if (done.has(id)) continue;
    let mp = 0;
    for (const e of es) {
      if (e.to === id && done.has(e.from)) mp = Math.max(mp, rank.get(e.from) + 1);
    }
    rank.set(id, mp);
  }

  const K = Math.max(0, ...ids.map((id) => rank.get(id)));
  const ranks = [];
  for (let i = 0; i <= K; i++) ranks.push([]);
  for (const id of ids) ranks[rank.get(id)].push(id);
  const nonEmpty = ranks.filter((r) => r.length);
  const n = nonEmpty.length;
  const rankIdx = new Map();
  nonEmpty.forEach((arr, r) => arr.forEach((id) => rankIdx.set(id, r)));

  // ---- 2. 级内重心排序（归一化位置跨级可比）----
  const pos = new Map();
  const reindex = () => nonEmpty.forEach((arr) => arr.forEach((id, i) => pos.set(id, i)));
  reindex();
  const norm = (id) => {
    const arr = nonEmpty[rankIdx.get(id)];
    if (!arr || arr.length <= 1) return 0.5;
    return pos.get(id) / (arr.length - 1);
  };
  const preds = new Map();
  const succs = new Map();
  for (const e of es) {
    if (back.has(e)) continue;
    pushTo(succs, e.from, { id: e.to, weight: Math.max(1, e.weight || 1) });
    pushTo(preds, e.to, { id: e.from, weight: Math.max(1, e.weight || 1) });
  }
  for (let it = 0; it < 4; it++) {
    const down = it % 2 === 0;
    const seq = [];
    if (down) for (let i = 1; i < n; i++) seq.push(i);
    else for (let i = n - 2; i >= 0; i--) seq.push(i);
    for (const li of seq) {
      const arr = nonEmpty[li];
      const bc = new Map();
      for (const id of arr) {
        const nb = down ? preds.get(id) || [] : succs.get(id) || [];
        let s = 0;
        let c = 0;
        for (const { id: x, weight } of nb) {
          s += norm(x) * weight;
          c += weight;
        }
        bc.set(id, c ? s / c : norm(id));
      }
      arr.sort((a, b) => bc.get(a) - bc.get(b));
      arr.forEach((id, i) => pos.set(id, i));
    }
  }

  // ---- 3. 超宽的级拆成多行（同级无前向边，安全）----
  const units = []; // { ids, w, h, rank }
  for (let r = 0; r < n; r++) {
    const arr = nonEmpty[r];
    let row = [];
    let rowW = 0;
    const flush = () => {
      if (!row.length) return;
      units.push({
        ids: row,
        w: rowW,
        h: Math.max(...row.map(hOf)),
        rank: r,
      });
      row = [];
      rowW = 0;
    };
    for (const id of arr) {
      const w = wOf(id);
      if (row.length && rowW + gapX + w > maxRowWidth) flush();
      rowW += (row.length ? gapX : 0) + w;
      row.push(id);
    }
    flush();
  }

  // ---- 4. 相邻单元间行距：按跨级边的水平通道需求自适应 ----
  // 近似端口 x：按级内顺序左对齐累计
  const approxX = new Map();
  for (let r = 0; r < n; r++) {
    let x = 0;
    for (const id of nonEmpty[r]) {
      approxX.set(id, x + wOf(id) / 2);
      x += wOf(id) + gapX;
    }
  }
  const gapNeed = Array.from({ length: Math.max(0, n - 1) }, () => 0);
  for (const e of es) {
    if (back.has(e)) continue;
    const ra = rankIdx.get(e.from);
    const rb = rankIdx.get(e.to);
    if (ra === rb || rb < ra) continue;
    for (let r = ra; r < rb && r < n - 1; r++) gapNeed[r] += Math.max(1, e.weight || 1);
  }
  const gapBetween = Array.from({ length: Math.max(0, n - 1) }, (_, r) => {
    if (!gapNeed[r]) return rowGap;
    // 区间重叠 → 通道数（用近似中心 x）
    const ev = [];
    for (const e of es) {
      if (back.has(e)) continue;
      const ra = rankIdx.get(e.from);
      const rb = rankIdx.get(e.to);
      if (ra === rb || rb < ra) continue;
      if (r < ra || r >= rb) continue;
      const a = approxX.get(e.from);
      const b = approxX.get(e.to);
      const weight = Math.max(1, e.weight || 1);
      ev.push([Math.min(a, b), weight], [Math.max(a, b), -weight]);
    }
    ev.sort((u, v) => u[0] - v[0] || v[1] - u[1]);
    let cur = 0;
    let bands = 0;
    for (const [, d] of ev) {
      cur += d;
      if (cur > bands) bands = cur;
    }
    return Math.max(rowGap, STUB * 2 + Math.max(0, bands - 1) * SPACING + 14);
  });

  // ---- 5. 每列单元数 R：宽高比最优 ----
  const unitGap = (u) => {
    if (u + 1 >= units.length) return 0;
    return units[u].rank === units[u + 1].rank ? Math.round(rowGap * 0.7) : gapBetween[units[u].rank];
  };
  const m = units.length;
  let best = null;
  const placeUnits = (R) => {
    const C = Math.ceil(m / R);
    const colW = [];
    const colH = [];
    for (let c = 0; c < C; c++) {
      let w = 0;
      let h = 0;
      for (let u = c * R; u < Math.min(m, (c + 1) * R); u++) {
        w = Math.max(w, units[u].w);
        h += units[u].h + (h ? unitGap(u - 1) : 0);
      }
      colW.push(w);
      colH.push(h);
    }
    let x = padding;
    const colX = [];
    for (let c = 0; c < C; c++) {
      colX.push(x);
      x += colW[c] + colGap;
    }
    const placed = new Map();
    for (let u = 0; u < m; u++) {
      const c = Math.floor(u / R);
      let y = padding;
      for (let v = c * R; v < u; v++) y += units[v].h + unitGap(v);
      const unit = units[u];
      let ix = colX[c];
      for (const id of unit.ids) {
        placed.set(id, { x: ix, y: y + (unit.h - hOf(id)) / 2 });
        ix += wOf(id) + gapX;
      }
    }
    return {
      pos: placed,
      width: x - colGap + padding,
      height: Math.max(...colH) + padding * 2,
      columns: C,
      ranks: n,
      R,
      colH,
    };
  };
  for (let R = 1; R <= m; R++) {
    const candidate = placeUnits(R);
    const W = candidate.width;
    const H = candidate.height;
    const aspect = W / Math.max(1, H);
    const spread = (Math.max(...candidate.colH) - Math.min(...candidate.colH)) / Math.max(1, Math.max(...candidate.colH));
    const aspectScore = Math.abs(Math.log(aspect / targetAspect)) + spread * 0.25 + (candidate.columns - 1) * 0.02;
    const trialNodes = items.map((it) => ({ ...it, ...(candidate.pos.get(it.id) || {}) }));
    const trialEdges = edges.map((e) => ({ ...e }));
    routeEdges(trialNodes, trialEdges);
    const metrics = routeLengthAndCrossings(trialEdges);
    const bundleCredit = Math.min(metrics.length * 0.65, metrics.sharedLength * 1.1);
    const wireScore = scorePlacement
      ? scorePlacement(candidate.pos, candidate.width, candidate.height)
      : (metrics.length - bundleCredit) / Math.max(1, W + H) + metrics.crossings * 2 + metrics.bends * 0.12;
    // 长宽比是首要目标（用户明确要求接近 1:1），连线质量只在长宽比相近的候选里起决定作用
    const score = aspectScore * 4 + wireScore * 0.3;
    if (!best || score < best.score - 0.001) best = { ...candidate, score };
  }

  return {
    pos: best.pos,
    width: best.width,
    height: best.height,
    columns: best.columns,
    ranks: best.ranks,
  };
}

/**
 * 分组布局：文件框 + 目录容器，按目录树自底向上递归排布
 * 每个文件内部独立布局；同一父目录下的文件框 / 子目录用 layoutPartitioned
 * 排成分区式紧凑二维布局（列优先蛇形 + 宽高比最优），
 * 兄弟之间互不重叠；目录容器直接取节点自身的矩形，因此层级之间不会交叉
 * 组内边随内部布局平移，跨组边用共享路由器统一布线
 * seed（存档坐标作重心初值）在这里被剔除，不传给内部文件级 layout()：
 * group 模式的稳定性由存档回填机制承担（buildView 把存档坐标回填到 laid.nodes），
 * seed 只用于扁平模式——文件框内部是组内相对布局，视图级绝对坐标会污染组内排序
 */
export function layoutGrouped(nodes, edges, opts = {}) {
  const {
    fileOf = (n) => n.file || 'unknown',
    headerH = 26,
    // 打开的根目录名。给了就把根目录本身也画成最外层容器：
    // 以 src 为根打开时，文件路径是相对 src 的（tcu/xxx/xx.c），
    // 不补这一层就看不出这些代码属于 src
    rootLabel = '',
    // 显式丢弃 seed，避免它混进 rest 传给内部 layout()（理由见上方函数注释）
    seed: _seedOmitted,
    ...rest
  } = opts;

  const groups = new Map();
  for (const n of nodes) {
    const f = fileOf(n);
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(n);
  }

  // 1. 组内布局（紧凑：小间距、小内边距）
  const inner = new Map();
  for (const [file, list] of groups) {
    const ids = new Set(list.map((n) => n.id));
    const innerEdges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    const laid = layout(list, innerEdges, {
      ...rest,
      padding: 14,
      gapX: 26,
      gapY: 52,
      maxLabelWidth: 190,
      minGapX: 12,
    });
    for (const n of laid.nodes) n.y += headerH;
    for (const e of laid.edges) {
      if (e.points) for (const p of e.points) p[1] += headerH;
    }
    laid.height += headerH;
    inner.set(file, laid);
  }

  // 2. 目录树：文件框是叶子，目录是中间节点。
  //    自底向上逐层用 layout() 排开兄弟节点 —— 兄弟之间由布局保证互不重叠，
  //    目录容器直接取节点自身的矩形，而不是事后套一个包围盒。
  //    这样文件框、目录容器都不会交叉，父子嵌套也天然成立。
  const fileOfId = new Map(nodes.map((n) => [n.id, fileOf(n)]));
  const root = {
    path: '',
    name: '',
    type: 'dir',
    children: new Map(),
    x: 0,
    y: 0,
    w: 0,
    h: 0,
  };
  for (const file of groups.keys()) {
    const parts = String(file).split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isFile = i === parts.length - 1;
      const p = parts.slice(0, i + 1).join('/');
      if (!cur.children.has(p)) {
        cur.children.set(p, {
          path: p,
          name: parts[i],
          type: isFile ? 'file' : 'dir',
          children: isFile ? null : new Map(),
          x: 0,
          y: 0,
          w: 0,
          h: 0,
        });
      }
      cur = cur.children.get(p);
    }
  }

  // 叶子尺寸 = 文件框尺寸。标题按画布字号估宽，标题比内容宽时以标题为准，
  // 否则长文件名会越出文件框（设计规格「文字占位」要求）
  const leafOf = new Map();
  const walkLeaf = (node) => {
    if (node.type === 'file') {
      const l = inner.get(node.path);
      node.w = Math.max(l.width, textWidth(node.name) + 24);
      node.h = l.height;
      leafOf.set(node.path, node);
      return;
    }
    for (const c of node.children.values()) walkLeaf(c);
  };
  walkLeaf(root);

  const ownerChild = (node, filePath) => {
    for (const c of node.children.values()) {
      if (filePath === c.path || filePath.startsWith(c.path + '/')) return c;
    }
    return null;
  };

  // 子节点之间的边：把文件级调用聚合到当前目录层级，供该层排序使用
  const childEdgesOf = (node) => {
    const links = new Map();
    for (const e of edges) {
      const fa = fileOfId.get(e.from);
      const fb = fileOfId.get(e.to);
      if (!fa || !fb || fa === fb) continue;
      const a = ownerChild(node, fa);
      const b = ownerChild(node, fb);
      if (!a || !b || a === b) continue;
      const k = a.path + '\u0000' + b.path;
      const link = links.get(k) || { from: a.path, to: b.path, kind: 'direct', weight: 0 };
      link.weight++;
      links.set(k, link);
    }
    return [...links.values()];
  };

  // 文件框 / 目录框之间的物理间隔：连线走这些空隙。
  // 分区式布局：同级水平并排（gapX）、相邻级上下（rowGap，随通道需求自适应）、
  // 列间留出跨列连线的走廊（colGap）
  const BOX = { padding: 14, gapX: 40, rowGap: 56, colGap: 72 };

  // 目录容器最终矩形 = 子框包围盒 + 一圈外扩（见下面 6a）。
  // 排布兄弟时必须按「含这圈的外框」占位，否则外扩会吃掉兄弟之间的间距，
  // 目录框就会互相压住（18px 那类重叠就是这么来的）。
  const depthBase = rootLabel ? 1 : 0;
  const depthOfPath = (p) => p.split('/').length + depthBase;
  let treeMaxDepth = 1;
  const walkDepth = (n) => {
    for (const c of n.children ? n.children.values() : []) {
      if (c.type === 'dir') {
        if (depthOfPath(c.path) > treeMaxDepth) treeMaxDepth = depthOfPath(c.path);
        walkDepth(c);
      }
    }
  };
  walkDepth(root);
  const ringOf = (path) => {
    const extra = (treeMaxDepth - depthOfPath(path)) * 10;
    return { side: 14 + extra, top: 30 + extra, bottom: 14 + extra };
  };

  const layoutDir = (node) => {
    if (node.type === 'file') return;
    const list = [...node.children.values()];
    for (const c of list) layoutDir(c);
    if (!list.length) {
      node.w = 0;
      node.h = 0;
      return;
    }
    const cn = list.map((c) => {
      if (c.type === 'file') return { id: c.path, name: c.name, w: c.w, h: c.h };
      const r = ringOf(c.path);
      return { id: c.path, name: c.name, w: c.w + r.side * 2, h: c.h + r.top + r.bottom };
    });
    // 分区式紧凑布局：列优先蛇形折行，宽高比最优，不再排成一列
    const childOfFile = new Map();
    const filesByChild = new Map();
    const addFiles = (top, cur, ox, oy) => {
      if (cur.type === 'file') {
        childOfFile.set(cur.path, top.path);
        if (!filesByChild.has(top.path)) filesByChild.set(top.path, []);
        filesByChild.get(top.path).push({ file: cur.path, x: ox, y: oy });
        return;
      }
      for (const c of cur.children.values()) addFiles(top, c, ox + c.x, oy + c.y);
    };
    for (const c of list) addFiles(c, c, 0, 0);

    const crossingFunctionEdges = edges.filter((e) => {
      const a = childOfFile.get(fileOfId.get(e.from));
      const b = childOfFile.get(fileOfId.get(e.to));
      return a && b && a !== b;
    });
    const fanoutByGroupPair = new Map();
    for (const e of crossingFunctionEdges) {
      const sourceGroup = childOfFile.get(fileOfId.get(e.from));
      const targetGroup = childOfFile.get(fileOfId.get(e.to));
      const key = `${sourceGroup}\u0000${targetGroup}`;
      if (!fanoutByGroupPair.has(key)) fanoutByGroupPair.set(key, { sourceGroup, targetGroup, targets: new Set() });
      fanoutByGroupPair.get(key).targets.add(e.to);
    }
    const fanoutBundles = [...fanoutByGroupPair.values()].filter((b) => b.targets.size > 1);
    const childDims = new Map(cn.map((child) => [child.id, child]));
    const actualNodes = [...filesByChild.values()].reduce((sum, files) =>
      sum + files.reduce((n, f) => n + (inner.get(f.file)?.nodes.length || 0), 0), 0);
    const scorePlacement = actualNodes <= 160 && crossingFunctionEdges.length <= 160
      ? (positions, width, height) => {
          const tempNodes = [];
          for (const [childPath, files] of filesByChild) {
            const base = positions.get(childPath);
            if (!base) continue;
            for (const f of files) {
              const laidFile = inner.get(f.file);
              if (!laidFile) continue;
              for (const fn of laidFile.nodes) {
                tempNodes.push({ ...fn, x: base.x + f.x + fn.x, y: base.y + f.y + fn.y, group: f.file });
              }
            }
          }
          const tempEdges = cloneEdges(crossingFunctionEdges);
          routeEdges(tempNodes, tempEdges);
          const metrics = routeLengthAndCrossings(tempEdges);
          const bundleCredit = Math.min(metrics.length * 0.75, metrics.sharedLength * 1.5);
          // 高扇出跨文件调用优先让文件并排；这样路由器能用一根纵向主干分发到多个目标。
          let fanoutAxisPenalty = 0;
          for (const bundle of fanoutBundles) {
            const a = positions.get(bundle.sourceGroup);
            const b = positions.get(bundle.targetGroup);
            const da = childDims.get(bundle.sourceGroup);
            const db = childDims.get(bundle.targetGroup);
            if (!a || !b || !da || !db) continue;
            const dx = Math.abs((b.x + db.w / 2) - (a.x + da.w / 2));
            const dy = Math.abs((b.y + db.h / 2) - (a.y + da.h / 2));
            if (dx < dy * 1.15) fanoutAxisPenalty += Math.min(2, bundle.targets.size - 1) * 1.5;
          }
          return (metrics.length - bundleCredit) / Math.max(1, width + height) + metrics.crossings * 0.35 + metrics.bends * 0.12 + fanoutAxisPenalty;
        }
      : null;
    const laid = layoutPartitioned(cn, childEdgesOf(node), { ...BOX, scorePlacement });
    const byId = new Map(list.map((c) => [c.path, c]));
    for (const it of cn) {
      const c = byId.get(it.id);
      const p = laid.pos.get(it.id);
      if (c.type === 'file') {
        c.x = p.x;
        c.y = p.y;
        c.w = it.w;
        c.h = it.h;
      } else {
        // 槽位是「含外扩圈的外框」，目录自身坐标往里缩一圈；
        // w/h 保持紧凑包围盒，父层再按同一套公式外扩，避免重复计算
        const r = ringOf(c.path);
        c.x = p.x + r.side;
        c.y = p.y + r.top;
      }
    }
    node.w = Math.max(laid.width, textWidth(node.name) + 24);
    node.h = laid.height;
    node.columns = laid.columns;
  };
  layoutDir(root);

  // 3. 相对坐标累加成绝对坐标
  const abs = (node, ox, oy) => {
    node.x += ox;
    node.y += oy;
    if (node.type === 'dir') for (const c of node.children.values()) abs(c, node.x, node.y);
  };
  for (const c of root.children.values()) abs(c, 0, 0);

  // 4. 合并坐标 + 组内边平移
  const geo = new Map();
  // from|to|line|kind|序号 → 平移后的 points。序号用于区分同一行重复调用产生的平行边，
  // 否则两条边会指向同一个数组，后面整体平移时被平移两次
  const innerEdgeMap = new Map();
  const innerSeq = new Map();
  const innerKey = (e, seq) => `${e.from}|${e.to}|${e.line}|${e.kind || 'direct'}|${seq}`;
  const bump = (seqMap, base) => {
    const n = (seqMap.get(base) || 0) + 1;
    seqMap.set(base, n);
    return n;
  };
  for (const [file, laid] of inner) {
    const leaf = leafOf.get(file);
    if (!leaf) continue;
    for (const n of laid.nodes) {
      geo.set(n.id, { ...n, x: n.x + leaf.x, y: n.y + leaf.y, group: file });
    }
    for (const e of laid.edges) {
      const base = `${e.from}|${e.to}|${e.line}|${e.kind || 'direct'}`;
      innerEdgeMap.set(innerKey(e, bump(innerSeq, base)), {
        ...e,
        points: (e.points || []).map((p) => [p[0] + leaf.x, p[1] + leaf.y]),
      });
    }
  }

  // 4. 边：组内直接平移，跨组用共享路由器
  const mergedNodes = [...geo.values()];
  const routed = [];
  const crossEdges = [];
  const seenSeq = new Map();
  for (const e of edges) {
    const a = geo.get(e.from);
    const b = geo.get(e.to);
    if (!a || !b) continue;
    if (a.group === b.group) {
      const base = `${e.from}|${e.to}|${e.line}|${e.kind || 'direct'}`;
      const m = innerEdgeMap.get(innerKey(e, bump(seenSeq, base)));
      if (m) {
        // 每条边独立一份 points，避免平行边共享可变数组
        routed.push({ ...m, points: m.points.map((p) => [p[0], p[1]]) });
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

  // 6. 容器 = 目录节点自身的矩形：父子天然嵌套，兄弟由布局保证不重叠
  const fileGroups = [...leafOf.values()].map((n) => ({
    id: n.path,
    label: n.name,
    x: n.x,
    y: n.y,
    w: n.w,
    h: n.h,
  }));

  // 根容器占掉 depth 1，目录容器整体下移一层（depthBase 在上面已算好）
  const containers = [];
  const collectDir = (node) => {
    for (const c of node.children.values()) {
      if (c.type !== 'dir') continue;
      containers.push({
        id: c.path,
        label: c.name,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        depth: c.path.split('/').length + depthBase,
      });
      collectDir(c);
    }
  };
  collectDir(root);
  containers.sort((a, b) => a.depth - b.depth);

  // 6a. 目录容器几何：按「文件框 + 子容器」的包围盒逐层外扩（深的先算），
  //     每级只多留一小圈（标题 + 呼吸空隙），嵌套紧凑不浪费面积。
  //     这里算完就是最终坐标，服务端只在此基础上做「只扩不缩」的兜底，
  //     否则两边各算一套坐标系，手动布局存档会对不上
  const maxDepth = containers.reduce((m, c) => Math.max(m, c.depth), 1);
  for (const c of containers.slice().sort((a, b) => b.depth - a.depth)) {
    const innerFiles = fileGroups.filter((g) => String(g.id).startsWith(c.id + '/'));
    const kids = containers.filter((k) => k !== c && String(k.id).startsWith(c.id + '/'));
    const boxes = innerFiles.concat(kids);
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
    const extra = (maxDepth - c.depth) * 10;
    c.x = x0 - 14 - extra;
    c.y = y0 - 30 - extra;
    // 目录标题（font-size 13，画在 x+12）也要放得下：父级槽位已按 node.w 预留过标题宽度，
    // 这里取包围盒与标题的较大值即可，不会把兄弟框挤到一起
    c.w = Math.max(x1 - x0 + 28 + extra * 2, textWidth(c.label) + 24);
    c.h = y1 - y0 + 44 + extra * 2;
  }

  // 6b. 根容器：包住所有文件框与子目录容器，标题用根目录名
  const RING = { side: 22, top: 38, bottom: 26 };
  let rootC = null;
  if (rootLabel) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const take = (b) => {
      if (b.x < x0) x0 = b.x;
      if (b.y < y0) y0 = b.y;
      if (b.x + b.w > x1) x1 = b.x + b.w;
      if (b.y + b.h > y1) y1 = b.y + b.h;
    };
    for (const g of fileGroups) take(g);
    for (const c of containers) take(c);
    if (Number.isFinite(x0)) {
      rootC = {
        id: '',
        label: rootLabel,
        root: true,
        depth: 1,
        x: x0 - RING.side,
        y: y0 - RING.top,
        w: Math.max(x1 - x0 + RING.side * 2, textWidth(rootLabel) + 24),
        h: y1 - y0 + RING.top + RING.bottom,
      };
    }
  }

  // 根容器外扩后可能落到负坐标（画布左上被裁，标题也看不见），整体平移回正区。
  // 留 30px 余量：服务端 fitGroups 兜底时文件框最多再向左/上各长 14px
  const MIN_ORIGIN = 30;
  let dx = 0;
  let dy = 0;
  if (rootC) {
    if (rootC.x < MIN_ORIGIN) dx = MIN_ORIGIN - rootC.x;
    if (rootC.y < MIN_ORIGIN) dy = MIN_ORIGIN - rootC.y;
  }
  if (dx || dy) {
    for (const n of mergedNodes) {
      n.x += dx;
      n.y += dy;
    }
    // routed 里可能有同一条边被引用多次（平行边），按对象去重后再平移
    for (const e of new Set(routed)) {
      if (e.points) for (const p of e.points) { p[0] += dx; p[1] += dy; }
    }
    for (const b of fileGroups) {
      b.x += dx;
      b.y += dy;
    }
    for (const b of containers) {
      b.x += dx;
      b.y += dy;
    }
    rootC.x += dx;
    rootC.y += dy;
  }

  const allContainers = rootC ? [rootC, ...containers] : containers;

  // 跨文件连线也参与局部摆位：只在所属文件框内移动节点，避免破坏目录/文件层级。
  refineGroupedNodes(mergedNodes, routed, fileGroups, headerH);

  // 7. 画布尺寸：内容与侧边车道取并集
  let maxX = 0;
  let maxY = 0;
  for (const g of fileGroups) {
    maxX = Math.max(maxX, g.x + g.w);
    maxY = Math.max(maxY, g.y + g.h);
  }
  for (const c of allContainers) {
    maxX = Math.max(maxX, c.x + c.w);
    maxY = Math.max(maxY, c.y + c.h);
  }
  let laneRight = -Infinity;
  for (const e of crossEdges) {
    if (!e.points) continue;
    for (const p of e.points) if (p[0] > laneRight) laneRight = p[0];
  }
  const width = Math.max(maxX, laneRight) + 30;

  return {
    nodes: mergedNodes,
    edges: routed,
    containers: allContainers,
    groups: fileGroups,
    width,
    height: maxY + 30,
    layers: root.columns || 1,
    // 根容器引起的整体平移量：存档坐标与新坐标同帧，这里只作诊断用
    offset: { dx, dy },
  };
}
