// 应用和评估共用 ELK 的层级分组与四中点端口转换。
import { createRequire } from 'node:module';
import { textWidth, routeScore, improveEdgeRoutes, mergeSharedRoutes } from './layout-metrics.js';
import { edgeStyleKey, routeEdges, collectSegments, pathBlockedByNodes, pathCrossesBody } from './routing.js';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const elk = new ELK();
const TOP_PADDING = 32;
const ROOT_PAD = 24;
const BOX_PAD = 10;
const NODE_GAP = 18;
const LAYER_GAP = 36;
const MODEL_ORDER = 'elk.layered.considerModelOrder.strategy';
const edgeKey = (e) => `${e.from}->${e.to}:${e.line}|${e.kind}|${e.change || 'existing'}`;
const isReverseFlow = (e) => (e.kind === 'var' && e.via === '读') || e.kind === 'df-read';
const flowSource = (e) => isReverseFlow(e) ? e.to : e.from;
const flowTarget = (e) => isReverseFlow(e) ? e.from : e.to;
const callRank = (e) => (e.callNumbers?.length ? parseInt(e.callNumbers[0], 10) : e.orderGroup || e.line) || 0;

function modelOrder(nodes, edges) {
  const readers = new Set(), callers = new Set(), incoming = new Map();
  for (const e of edges) {
    if (isReverseFlow(e)) readers.add(e.from);
    if (e.kind === 'var' || e.kind === 'dataflow' || e.kind?.startsWith('df-')) continue;
    if (e.from !== e.to) callers.add(e.from);
    incoming.set(e.to, Math.min(incoming.get(e.to) ?? Infinity, callRank(e)));
  }
  const ranked = nodes.map((n) => ({
    id: n.id,
    role: n.taskEntry ? 0 : n.kind === 'var' ? 2 : readers.has(n.id) && !callers.has(n.id) ? 3 : 1,
    call: incoming.get(n.id) ?? 0,
    period: (n.taskPeriods || []).reduce((min, { us }) => Number.isInteger(us) && us > 0 ? Math.min(min, us) : min, Infinity),
  }));
  ranked.sort((a, b) => a.role - b.role || a.call - b.call || a.period - b.period);
  return new Map(ranked.map(({ id }, i) => [id, i]));
}

// ELK 会把共用逻辑端口的边排成干线。每一面按收发方向和线型设口，
// 同组调用可以先汇集再分支，调用记录仍各自保留完整的端点与路径。
function fixedPorts(nodes, edges, faces, separateStyles) {
  const ports = new Map();
  const nodeIds = new Set(nodes.map((n) => n.id));
  let nextPort = 0;
  const port = (node, side, role, style) => {
    if (!ports.has(node)) ports.set(node, new Map());
    const list = ports.get(node);
    const key = JSON.stringify([side, role, style]);
    if (!list.has(key)) {
      let id;
      do { id = 'port:' + nextPort++; } while (nodeIds.has(id));
      list.set(key, { id, side });
    }
    return list.get(key).id;
  };
  const pairs = edges.map((e, i) => {
    const style = separateStyles ? edgeStyleKey(e) : '';
    const reverse = isReverseFlow(e);
    return [port(flowSource(e), faces[i][reverse ? 1 : 0], 'out', style),
      port(flowTarget(e), faces[i][reverse ? 0 : 1], 'in', style)];
  });
  return { ports, pairs };
}

export function graphOf(nodes, edges, direction, faces, separateStyles = false, group = true) {
  const root = { id: 'root', children: [], layoutOptions: {
    'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.json.edgeCoords': 'ROOT',
    'elk.padding': `[top=${TOP_PADDING},left=${ROOT_PAD},bottom=${ROOT_PAD},right=${ROOT_PAD}]`,
    'elk.spacing.nodeNode': String(NODE_GAP),
    'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP),
    'elk.spacing.edgeNode': '12', 'elk.spacing.edgeEdge': '8',
    'elk.layered.mergeEdges': 'false', 'elk.layered.mergeHierarchyEdges': 'false',
    'elk.randomSeed': '1',
    [MODEL_ORDER]: 'NODES_AND_EDGES',
    'elk.layered.wrapping.strategy': 'OFF',
  } };
  const order = modelOrder(nodes, edges);
  const boxes = new Map([['', root]]);
  const fixed = faces && fixedPorts(nodes, edges, faces, separateStyles);
  for (const n of nodes) {
    const parts = group ? (n.file || 'unknown').split('/') : [];
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (!boxes.has(key)) {
        const box = { id: 'box:' + key, label: parts[i], fileGroup: i === parts.length - 1,
          children: [], layoutOptions: { 'elk.padding': `[top=${TOP_PADDING},left=${BOX_PAD},bottom=${BOX_PAD},right=${BOX_PAD}]`,
            [MODEL_ORDER]: 'NODES_AND_EDGES' } };
        parent.children.push(box);
        boxes.set(key, box);
      }
      parent = boxes.get(key);
    }
    const node = { id: n.id, width: n.w, height: n.h };
    if (fixed) {
      node.layoutOptions = { 'elk.portConstraints': 'FIXED_POS' };
      const centers = { NORTH: [n.w / 2, 0], SOUTH: [n.w / 2, n.h], WEST: [0, n.h / 2], EAST: [n.w, n.h / 2] };
      node.ports = Array.from(fixed.ports.get(n.id)?.values() || [], ({ id, side }) => ({
        id, x: centers[side][0], y: centers[side][1], width: 0, height: 0, layoutOptions: { 'elk.port.side': side },
      }));
    }
    parent.children.push(node);
  }
  const sortChildren = (parent) => {
    for (const child of parent.children) if (child.children) {
      sortChildren(child);
      order.set(child.id, order.get(child.children[0].id));
    }
    parent.children.sort((a, b) => order.get(a.id) - order.get(b.id));
  };
  sortChildren(root);
  root.edges = edges.map((e, index) => ({ index, source: flowSource(e), target: flowTarget(e), rank: callRank(e) }))
    .sort((a, b) => order.get(a.source) - order.get(b.source) || a.rank - b.rank || order.get(a.target) - order.get(b.target))
    .map(({ index, source, target }) => ({ id: 'e' + index,
      sources: [fixed ? fixed.pairs[index][0] : source], targets: [fixed ? fixed.pairs[index][1] : target] }));
  return root;
}

function layoutGraph(graph) {
  const vertical = graph.layoutOptions['elk.direction'] === 'DOWN';
  const walkBoxes = (parent) => {
    for (const child of parent.children || []) {
      if (!child.children) continue;
      // elkjs 0.12 的 INCLUDE_CHILDREN 子图开启 considerModelOrder 会在内部比较同层节点时越界；
      // 子框内统一关闭 MODEL_ORDER，改用横切轴上的初始相对坐标 + semiInteractive 传递已排好的同层先后顺序。
      child.layoutOptions[MODEL_ORDER] = 'NONE';
      child.layoutOptions['elk.layered.crossingMinimization.semiInteractive'] = 'true';
      let across = 0;
      for (const item of child.children) {
        const options = item.layoutOptions ||= {};
        if (!options['elk.position']) {
          item.x = vertical ? across : 0;
          item.y = vertical ? 0 : across;
          options['elk.position'] = `(${item.x},${item.y})`;
        }
        across += ((vertical ? item.width : item.height) || 160) + NODE_GAP;
      }
      walkBoxes(child);
    }
  };
  walkBoxes(graph);
  return elk.layout(graph);
}

export function converted(result, originals, edges) {
  const byId = new Map(originals.map((n) => [n.id, n]));
  const view = { nodes: [], groups: [], containers: [], width: result.width, height: result.height };
  const walk = (parent, ox, oy, depth) => {
    for (const n of parent.children || []) {
      const x = ox + n.x, y = oy + n.y;
      if (byId.has(n.id)) view.nodes.push({ ...byId.get(n.id), x, y, w: n.width, h: n.height, group: byId.get(n.id).file || 'unknown' });
      else {
        const box = { id: n.id.slice(4), label: n.label, x, y, w: n.width, h: n.height, depth };
        (n.fileGroup ? view.groups : view.containers).push(box);
        walk(n, x, y, depth + 1);
      }
    }
  };
  walk(result, 0, 0, 1);
  const routed = new Map(result.edges.map((e) => [e.id, e]));
  view.edges = edges.map((edge, i) => {
    const e = routed.get('e' + i);
    if (!e) throw new Error(`ELK 缺少连线 e${i}`);
    if (e.sections?.length !== 1) throw new Error(`连线 ${e.id} 不是单段路径，需单独检查，不能拼接伪造折线`);
    const s = e.sections[0];
    const points = [s.startPoint, ...(s.bendPoints || []), s.endPoint].map((p) => [p.x, p.y]);
    if (isReverseFlow(edge)) points.reverse();
    return { ...edge, points };
  });
  return view;
}

export function facesOf(view) {
  const nodes = new Map(view.nodes.map((n) => [n.id, n]));
  const sideOf = (n, p) => [['NORTH', Math.abs(p[1] - n.y)], ['SOUTH', Math.abs(p[1] - n.y - n.h)],
    ['WEST', Math.abs(p[0] - n.x)], ['EAST', Math.abs(p[0] - n.x - n.w)]].sort((a, b) => a[1] - b[1])[0][0];
  // 端口面沿用存储顺序；读取边的收发角色由 fixedPorts 按实际流向分配。
  return view.edges.map((e) => e.from === e.to ? ['EAST', 'SOUTH'] :
    [sideOf(nodes.get(e.from), e.points[0]), sideOf(nodes.get(e.to), e.points.at(-1))]);
}

/** 用当前画面的相对位置驱动 ELK 的交互式分层，不读取固定坐标存档。 */
function seedInteractive(graph, previous, initial) {
  const vertical = graph.layoutOptions['elk.direction'] === 'DOWN';
  const positions = (view) => new Map([
    ...view.nodes, ...(view.groups || []).map((n) => ({ ...n, id: 'box:' + n.id })),
    ...(view.containers || []).map((n) => ({ ...n, id: 'box:' + n.id })),
  ].map((n) => [n.id, n]));
  const old = positions(previous), fresh = positions(initial);
  const anchors = new Map(previous.nodes.map((n) => [n.id, n]));
  // 新节点沿用同文件邻居的层次，优先复用空位，不追加到保留的旧框底部。
  for (const n of initial.nodes) {
    if (anchors.has(n.id)) continue;
    const box = old.get('box:' + n.file);
    if (!box) continue;
    const edge = initial.edges.find((e) => {
      const peer = anchors.get(e.from === n.id ? e.to : e.to === n.id ? e.from : null);
      return peer?.file === n.file;
    });
    const peer = edge && anchors.get(edge.from === n.id ? edge.to : edge.from);
    const occupied = [...anchors.values()].filter((a) => a.file === n.file);
    const [flow, flowSize, across, acrossSize] = vertical ? ['y', 'h', 'x', 'w'] : ['x', 'w', 'y', 'h'];
    const at = peer ? edge.from === n.id ? peer[flow] - n[flowSize] - LAYER_GAP : peer[flow] + peer[flowSize] + LAYER_GAP :
      vertical ? Math.min(...occupied.map((a) => a.y)) : box.x + BOX_PAD;
    const slots = [Math.min(...occupied.map((a) => a[across])),
      ...occupied.map((a) => a[across] + a[acrossSize] + NODE_GAP)].sort((a, b) => a - b);
    const free = slots.find((slot) => occupied.every((a) => at + n[flowSize] + NODE_GAP <= a[flow] ||
      a[flow] + a[flowSize] + NODE_GAP <= at || slot + n[acrossSize] + NODE_GAP <= a[across] ||
      a[across] + a[acrossSize] + NODE_GAP <= slot));
    const p = { ...n, [flow]: at, [across]: free };
    fresh.set(n.id, p);
    anchors.set(n.id, p);
  }
  const walk = (parent, ox = 0, oy = 0) => {
    Object.assign(parent.layoutOptions, {
      'elk.layered.cycleBreaking.strategy': 'INTERACTIVE',
      'elk.layered.layering.strategy': 'INTERACTIVE',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
      'elk.layered.nodePlacement.strategy': 'INTERACTIVE',
      'elk.separateConnectedComponents': 'false',
    });
    for (const n of parent.children || []) {
      const p = old.get(n.id) || fresh.get(n.id);
      n.x = p.x - ox - (vertical ? parent === graph ? ROOT_PAD : BOX_PAD : 0);
      // 输出坐标已含标题留白；参考坐标要扣掉，避免每次增量排版再累加一次。
      n.y = p.y - oy - TOP_PADDING;
      (n.layoutOptions ||= {})['elk.position'] = `(${n.x},${n.y})`;
      if (n.children) walk(n, p.x, p.y);
    }
  };
  walk(graph);
}

/** 以走线为主，兼顾相连节点紧凑度、1:1 画布比例与占用面积。 */
function quality(view) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  let distSum = 0, edgeCnt = 0;
  for (const e of view.edges) {
    if (e.from === e.to) continue;
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    distSum += Math.hypot(a.x + a.w / 2 - (b.x + b.w / 2), a.y + a.h / 2 - (b.y + b.h / 2));
    edgeCnt++;
  }
  const avgDist = edgeCnt ? distSum / edgeCnt : 0;
  const aspect = Math.max(1, view.width) / Math.max(1, view.height);
  return routeScore(view.edges) +
    140 * Math.log(aspect) ** 2 + Math.sqrt(view.width * view.height) / 40 + avgDist * 0.22;
}

function validLayout(view) {
  const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
  for (let i = 0; i < view.nodes.length; i++) for (let j = i + 1; j < view.nodes.length; j++) {
    if (overlap(view.nodes[i], view.nodes[j])) return false;
  }
  const boxes = [...view.groups, ...view.containers];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (!boxes[i].id.startsWith(boxes[j].id + '/') && !boxes[j].id.startsWith(boxes[i].id + '/') &&
        overlap(boxes[i], boxes[j])) return false;
  }
  const inside = (child, parent) => child.x >= parent.x - 1 && child.y >= parent.y - 1 &&
    child.x + child.w <= parent.x + parent.w + 1 && child.y + child.h <= parent.y + parent.h + 1;
  const groupById = new Map(view.groups.map((g) => [g.id, g]));
  for (const n of view.nodes) {
    if (!n.group) continue;
    const g = groupById.get(n.group);
    if (!g || !inside(n, g)) return false;
  }
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  for (const b of boxes) {
    const slash = b.id.lastIndexOf('/');
    if (slash > 0) {
      const parent = boxById.get(b.id.slice(0, slash));
      if (parent && !inside(b, parent)) return false;
    }
  }
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const onPort = (n, p) => n && p && [[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h],
    [n.x, n.y + n.h / 2], [n.x + n.w, n.y + n.h / 2]].some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.5);
  return view.edges.every((e) => {
    const pts = e.points;
    if (!pts || pts.length < 2) return false;
    if (!onPort(byId.get(e.from), pts[0]) || !onPort(byId.get(e.to), pts.at(-1))) return false;
    if (e.from === e.to) {
      if (Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) <= 0.5) return false;
      if (new Set(pts.map((p) => p[0])).size <= 1 || new Set(pts.map((p) => p[1])).size <= 1) return false;
    }
    return !pathBlockedByNodes(pts, view.nodes, new Set([e.from, e.to])) &&
      !view.nodes.some((n) => pathCrossesBody(pts, n));
  });
}

function finalizeCandidate(view) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  improveEdgeRoutes(view, view.edges, (e) => byId.get(e.from)?.file !== byId.get(e.to)?.file);
  mergeSharedRoutes(view);
  return view;
}

/** 保护基准布局已成立的同级显式调用顺序与跨顶层容器数据流向。 */
function preservesSemanticOrder(baseline, candidate, edges) {
  const posMap = (view, axis) => new Map(view.nodes.map((n) => [n.id, n[axis]]));
  const topBoxOf = (n) => (n?.file || 'unknown').split('/')[0];
  const nodeById = new Map(baseline.nodes.map((n) => [n.id, n]));
  const baseCross = posMap(baseline, baseline.layoutDirection === 'RIGHT' ? 'y' : 'x');
  const candCross = posMap(candidate, candidate.layoutDirection === 'RIGHT' ? 'y' : 'x');
  const byCaller = new Map();
  for (const e of edges) {
    if (e.from === e.to || e.kind === 'var' || e.kind === 'dataflow' || e.kind?.startsWith('df-')) continue;
    if (!e.callNumbers?.length && !e.orderGroup) continue;
    let rec = byCaller.get(e.from);
    if (!rec) { rec = { targets: new Map(), explicit: false }; byCaller.set(e.from, rec); }
    if (e.callNumbers?.length) rec.explicit = true;
    const prev = rec.targets.get(e.to);
    const rank = callRank(e);
    if (prev === undefined || rank < prev) rec.targets.set(e.to, rank);
  }
  const hasDirs = (candidate.containers || []).length > 0;
  for (const { targets, explicit } of byCaller.values()) {
    if (targets.size < 2) continue;
    const ordered = [...targets.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    const sameFile = new Set(ordered.map((id) => nodeById.get(id)?.file)).size === 1;
    const distinctTop = new Set(ordered.map((id) => topBoxOf(nodeById.get(id)))).size === ordered.length;
    const shouldCheck = (sameFile && explicit) || (!hasDirs && (sameFile || distinctTop) &&
      ordered.every((id) => !(nodeById.get(id)?.file || '').includes('/')));
    if (!shouldCheck) continue;
    const mono = (pos) => ordered.every((id, i) => !i || pos.get(ordered[i - 1]) < pos.get(id));
    if (mono(baseCross) && !mono(candCross)) return false;
  }

  const baseMain = posMap(baseline, baseline.layoutDirection === 'RIGHT' ? 'x' : 'y');
  const candMain = posMap(candidate, candidate.layoutDirection === 'RIGHT' ? 'x' : 'y');
  const writers = new Map(), readers = new Map();
  for (const e of edges) {
    if (e.kind === 'var') {
      if (e.via === '读') {
        if (!readers.has(e.to)) readers.set(e.to, []);
        readers.get(e.to).push(e.from);
      } else if (e.via === '写') {
        if (!writers.has(e.to)) writers.set(e.to, []);
        writers.get(e.to).push(e.from);
      }
    } else if (e.kind === 'df-write') {
      if (!writers.has(e.to)) writers.set(e.to, []);
      writers.get(e.to).push(e.from);
    } else if (e.kind === 'df-read') {
      if (!readers.has(e.from)) readers.set(e.from, []);
      readers.get(e.from).push(e.to);
    }
  }
  if (!hasDirs) {
    for (const [varId, ws] of writers) {
      const rs = readers.get(varId);
      if (!rs) continue;
      const vTop = topBoxOf(nodeById.get(varId));
      for (const w of ws) for (const r of rs) {
        if (w === r) continue;
        const wTop = topBoxOf(nodeById.get(w)), rTop = topBoxOf(nodeById.get(r));
        if (wTop === vTop || vTop === rTop || wTop === rTop) continue;
        if (baseMain.get(w) < baseMain.get(varId) && baseMain.get(varId) < baseMain.get(r)) {
          if (!(candMain.get(w) < candMain.get(varId) && candMain.get(varId) < candMain.get(r))) return false;
        }
      }
    }
  }
  return true;
}

/** 自底向上逐层紧凑排布：文件框自适应方向/散点网格化 + 跨框邻近微调 + 正交路由。 */
async function bottomUpCandidate(sized, edges, { rootDir, dirDir, fileDir }) {
  const order = modelOrder(sized, edges);
  const root = { id: '', label: '', children: new Map(), leafNodes: [] };
  let boxCount = 0;
  for (const n of sized) {
    const parts = (n.file || 'unknown').split('/');
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (!cur.children.has(key)) {
        cur.children.set(key, { id: key, label: parts[i], fileGroup: i === parts.length - 1, children: new Map(), leafNodes: [] });
        boxCount++;
      }
      cur = cur.children.get(key);
    }
    cur.leafNodes.push(n);
  }
  if (boxCount < 2) return null;

  async function layoutBox(box, depth, dirOverride = null, hints = null) {
    const childItems = [];
    for (const child of box.children.values()) {
      childItems.push({ id: 'box:' + child.id, isBox: true, ref: child, width: child.w, height: child.h, ord: child.minOrd });
    }
    for (const n of box.leafNodes) {
      childItems.push({ id: n.id, isBox: false, ref: n, width: n.w, height: n.h, ord: order.get(n.id) ?? 0 });
    }
    box.minOrd = Math.min(...childItems.map((c) => c.ord), 0);

    const memberOf = new Map();
    const mapDesc = (b, ownerId) => {
      for (const n of b.leafNodes) memberOf.set(n.id, ownerId);
      for (const c of b.children.values()) mapDesc(c, ownerId);
    };
    for (const item of childItems) {
      if (item.isBox) mapDesc(item.ref, item.id);
      else memberOf.set(item.id, item.id);
    }

    const agg = new Map();
    for (const e of edges) {
      const s = memberOf.get(flowSource(e)), t = memberOf.get(flowTarget(e));
      if (!s || !t || s === t) continue;
      const key = s + '->' + t;
      const prev = agg.get(key), rank = callRank(e);
      if (!prev) agg.set(key, { s, t, count: 1, rank });
      else { prev.count++; prev.rank = Math.min(prev.rank, rank); }
    }

    if (hints) childItems.sort((a, b) => (hints.get(a.id) ?? 0) - (hints.get(b.id) ?? 0) || a.ord - b.ord);
    else childItems.sort((a, b) => a.ord - b.ord);

    const isRoot = depth === 0;
    const sidePad = isRoot ? ROOT_PAD : 14;
    if (childItems.length === 1) {
      const item = childItems[0];
      box.w = item.width + sidePad * 2;
      box.h = item.height + TOP_PADDING + sidePad;
      box.relPos = new Map([[item.id, { x: sidePad, y: TOP_PADDING }]]);
      box.usedDir = dirOverride || (box.fileGroup ? (fileDir === 'AUTO' ? 'DOWN' : fileDir) : isRoot ? rootDir : dirDir);
      return;
    }
    const pad = isRoot ? `[top=${TOP_PADDING},left=${ROOT_PAD},bottom=${ROOT_PAD},right=${ROOT_PAD}]` : `[top=${TOP_PADDING},left=14,bottom=14,right=14]`;
    const gap = box.fileGroup ? 16 : 30;
    const layerGap = box.fileGroup ? 28 : 44;

    const runDir = async (dir) => {
      if (agg.size === 0 && childItems.length > 1) {
        return elk.layout({
          id: 'g:' + box.id,
          layoutOptions: {
            'elk.algorithm': 'rectpacking',
            'elk.padding': pad,
            'elk.spacing.nodeNode': String(gap),
            'elk.aspectRatio': '1.15',
          },
          children: childItems.map((it) => ({ id: it.id, width: it.width, height: it.height })),
          edges: [],
        });
      }
      const aggList = [...agg.values()].sort((a, b) => a.rank - b.rank || b.count - a.count);
      return elk.layout({
        id: 'g:' + box.id,
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': dir,
          'elk.padding': pad,
          'elk.spacing.nodeNode': String(gap),
          'elk.layered.spacing.nodeNodeBetweenLayers': String(layerGap),
          'elk.spacing.componentComponent': String(box.fileGroup ? 18 : 28),
          'elk.aspectRatio': '1.0',
          'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
          'elk.layered.compaction.connectedComponents': 'true',
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.considerModelOrder.strategy': hints ? 'PREFER_NODES' : 'NODES_AND_EDGES',
          'elk.layered.thoroughness': '7',
          'elk.randomSeed': '1',
        },
        children: childItems.map((it) => ({ id: it.id, width: it.width, height: it.height })),
        edges: aggList.map((a, idx) => ({
          id: 'ae' + idx, sources: [a.s], targets: [a.t],
          layoutOptions: { 'elk.layered.priority.shortness': String(Math.min(10, a.count)) },
        })),
      });
    };

    let best, usedDir;
    if (dirOverride) {
      usedDir = dirOverride;
      best = await runDir(dirOverride);
    } else if (box.fileGroup && fileDir === 'AUTO' && agg.size > 0) {
      const [r1, r2] = await Promise.all([runDir('RIGHT'), runDir('DOWN')]);
      const boxScore = (r) => Math.abs(Math.log(Math.max(1, r.width) / Math.max(1, r.height) / 1.15)) +
        Math.sqrt(r.width * r.height) / 2000;
      if (boxScore(r1) <= boxScore(r2)) { best = r1; usedDir = 'RIGHT'; } else { best = r2; usedDir = 'DOWN'; }
    } else {
      usedDir = box.fileGroup ? (fileDir === 'AUTO' ? 'DOWN' : fileDir) : isRoot ? rootDir : dirDir;
      best = await runDir(usedDir);
    }
    box.w = best.width;
    box.h = best.height;
    box.relPos = new Map(best.children.map((c) => [c.id, { x: c.x, y: c.y }]));
    box.usedDir = usedDir;
  }

  async function pass1(box, depth) {
    await Promise.all([...box.children.values()].map((child) => pass1(child, depth + 1)));
    await layoutBox(box, depth);
  }
  await pass1(root, 0);

  const absPos = new Map();
  const computeAbs = (box, ox, oy) => {
    for (const child of box.children.values()) {
      const p = box.relPos.get('box:' + child.id);
      computeAbs(child, ox + p.x, oy + p.y);
    }
    for (const n of box.leafNodes) {
      const p = box.relPos.get(n.id);
      absPos.set(n.id, { x: ox + p.x + n.w / 2, y: oy + p.y + n.h / 2 });
    }
  };
  computeAbs(root, 0, 0);

  async function pass2(box, depth) {
    const prevW = box.w, prevH = box.h;
    const childChanged = (await Promise.all([...box.children.values()].map((child) => pass2(child, depth + 1)))).some(Boolean);
    if (box.fileGroup && box.leafNodes.length > 1) {
      const ids = new Set(box.leafNodes.map((n) => n.id));
      const intraOrder = new Map();
      for (const e of edges) {
        if (!ids.has(e.to) || e.from === e.to) continue;
        if (e.kind === 'var' || e.kind === 'dataflow' || e.kind?.startsWith('df-')) continue;
        if (!e.callNumbers?.length && !e.orderGroup) continue;
        if (!intraOrder.has(e.from)) intraOrder.set(e.from, new Set());
        intraOrder.get(e.from).add(e.to);
      }
      const hasExplicitOrder = [...intraOrder.values()].some((targets) => targets.size >= 2);
      if (!hasExplicitOrder) {
        const vertical = box.usedDir === 'DOWN';
        const hints = new Map();
        let hasExternal = false;
        for (const n of box.leafNodes) {
          let sum = 0, cnt = 0;
          for (const e of edges) {
            const peer = e.from === n.id ? e.to : e.to === n.id ? e.from : null;
            if (!peer || ids.has(peer)) continue;
            const pt = absPos.get(peer);
            if (pt) { sum += vertical ? pt.x : pt.y; cnt++; hasExternal = true; }
          }
          const self = absPos.get(n.id);
          hints.set(n.id, cnt ? sum / cnt : (vertical ? self.x : self.y));
        }
        if (hasExternal) await layoutBox(box, depth, box.usedDir, hints);
      }
    } else if (!box.fileGroup && childChanged) {
      await layoutBox(box, depth, box.usedDir);
    }
    return Math.abs(box.w - prevW) > 0.5 || Math.abs(box.h - prevH) > 0.5;
  }
  if (edges.length) await pass2(root, 0);

  const view = { nodes: [], groups: [], containers: [], width: root.w, height: root.h, layoutDirection: rootDir };
  const flatten = (box, ox, oy, depth) => {
    for (const child of box.children.values()) {
      const p = box.relPos.get('box:' + child.id);
      const x = ox + p.x, y = oy + p.y;
      const entry = { id: child.id, label: child.label, x, y, w: child.w, h: child.h, depth };
      (child.fileGroup ? view.groups : view.containers).push(entry);
      flatten(child, x, y, depth + 1);
    }
    for (const n of box.leafNodes) {
      const p = box.relPos.get(n.id);
      view.nodes.push({ ...n, x: ox + p.x, y: oy + p.y, group: n.file || 'unknown' });
    }
  };
  flatten(root, 0, 0, 1);

  // 克隆边送入路由器，避免写入临时属性破坏输出契约。
  const routed = edges.map((e) => ({ ...e }));
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  view.edges = routed;
  routeEdges(view.nodes, routed);
  improveEdgeRoutes(view, routed, (e) => byId.get(e.from)?.file !== byId.get(e.to)?.file);
  const bad = routed.filter((e) => e.blocked ||
    pathBlockedByNodes(e.points, view.nodes, new Set([e.from, e.to])) ||
    pathCrossesBody(e.points, byId.get(e.from)) || pathCrossesBody(e.points, byId.get(e.to)));
  if (bad.length) improveEdgeRoutes(view, bad, () => true);
  mergeSharedRoutes(view);
  view.edges = edges.map((e, i) => ({ ...e, points: routed[i].points }));

  let minX = 0, minY = 0, maxX = view.width, maxY = view.height;
  for (const e of view.edges) for (const [x, y] of e.points || []) {
    minX = Math.min(minX, x - ROOT_PAD);
    minY = Math.min(minY, y - ROOT_PAD);
    maxX = Math.max(maxX, x + ROOT_PAD);
    maxY = Math.max(maxY, y + ROOT_PAD);
  }
  if (minX < 0 || minY < 0) {
    const dx = -minX, dy = -minY;
    for (const b of [...view.nodes, ...view.groups, ...view.containers]) { b.x += dx; b.y += dy; }
    for (const e of view.edges) e.points = e.points.map(([x, y]) => [x + dx, y + dy]);
    maxX += dx;
    maxY += dy;
  }
  view.width = maxX;
  view.height = maxY;
  return view;
}

export async function layoutElk(nodes, edges, { group = true, rootLabel = '', previous = null } = {}) {
  const ids = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const sized = nodes.map((n) => ({ ...n,
    w: n.w || Math.min(190, Math.max(120, Math.max(textWidth(n.label || n.name || n.id),
      textWidth((n.targetNames || []).join(' / '))) + 28 + (n.kind === 'var' ? 0 : 16))),
    h: n.h || (n.sub ? 58 : 44),
  }));
  // 删除时保留空位的几何快照。重新加入同一批节点时直接复用，避免再次
  // 运行 INTERACTIVE 排版产生逐轮漂移；拖动过任一剩余节点就不再复用。
  const slots = previous?.layoutSlots;
  if (slots && Array.isArray(slots.nodes) && Array.isArray(slots.edges) &&
      Array.isArray(slots.groups) && Array.isArray(slots.containers) &&
      slots.nodes.every((n) => [n.x, n.y, n.w, n.h].every(Number.isFinite))) {
    const saved = new Map(slots.nodes.map((n) => [n.id, n]));
    const unchanged = (n) => {
      const old = saved.get(n.id);
      return old && ['file', 'x', 'y', 'w', 'h'].every((key) => old[key] === n[key]);
    };
    if (previous.nodes.every(unchanged) && sized.every((n) => {
      const old = saved.get(n.id);
      return old && old.file === n.file && old.w === n.w && old.h === n.h;
    })) {
      const order = new Map(slots.nodes.map((n, i) => [n.id, i]));
      sized.sort((a, b) => order.get(a.id) - order.get(b.id));
      previous = { ...slots, edges: [...new Map([...slots.edges, ...previous.edges].map((e) => [edgeKey(e), e])).values()] };
    }
  }
  // 新增函数或变量时使用与“重新排版”相同的完整布局，避免旧方向与位置约束拉长新图。
  if (previous) {
    const oldIds = new Set(previous.nodes.map((n) => n.id));
    if (sized.some((n) => !oldIds.has(n.id))) previous = null;
  }
  const oldNodes = new Map((previous?.nodes || []).map((n) => [n.id, n]));
  const oldEdges = new Map((previous?.edges || []).map((e) => [edgeKey(e), e]));
  const direction = previous?.layoutDirection === 'DOWN' ? 'DOWN' : 'RIGHT';
  // 没有新增节点时不移动已有内容；新增关系只补连线，删除则留下原来的空位。
  if (previous && sized.every((n) => {
    const old = oldNodes.get(n.id);
    return old && old.file === n.file && old.w === n.w && old.h === n.h;
  })) {
    const files = new Set(sized.map((n) => n.file || 'unknown'));
    const view = { width: previous.width, height: previous.height, layoutDirection: direction,
      nodes: sized.map((n) => ({ ...n, x: oldNodes.get(n.id).x, y: oldNodes.get(n.id).y,
        ...(group ? { group: n.file || 'unknown' } : {}) })),
      edges: edges.map((e) => {
        const old = oldEdges.get(edgeKey(e));
        return { ...e, points: old?.points.map((p) => [...p]),
          custom: old?.custom ?? e.custom, fromSide: old?.fromSide ?? e.fromSide, toSide: old?.toSide ?? e.toSide };
      }),
      groups: group ? (previous.groups || []).filter((g) => files.has(g.id)).map((g) => ({ ...g })) : [],
      containers: group ? (previous.containers || []).filter((c) => c.root ||
        [...files].some((file) => file.startsWith(c.id + '/'))).map((c) => ({ ...c })) : [],
    };
    const addedEdges = view.edges.filter((e) => !e.points);
    if (addedEdges.length) {
      routeEdges(view.nodes, addedEdges, { existing: collectSegments(view.edges.filter((e) => e.points)) });
      improveEdgeRoutes(view, addedEdges, () => false);
      mergeSharedRoutes(view, addedEdges);
    }
    for (const e of addedEdges) for (const [x, y] of e.points) {
      view.width = Math.max(view.width, x + ROOT_PAD);
      view.height = Math.max(view.height, y + ROOT_PAD);
    }
    for (const c of view.containers) if (c.root) {
      c.w = Math.max(c.w, view.width);
      c.h = Math.max(c.h, view.height);
    }
    if (previous.nodes.some((n) => !ids.has(n.id))) {
      // 只保存一层快照，不递归携带历史画面。
      const { nodes, edges, groups, containers, width, height, layoutDirection } = previous;
      view.layoutSlots = { nodes, edges, groups, containers, width, height, layoutDirection };
    }
    return view;
  }
  let rightFaces;
  const generate = async (dir) => {
    let first, faces;
    if (!previous && dir === 'DOWN' && rightFaces) {
      // 横纵候选各自重新摆位和布线。无折行时只把分层方向上的端口提示转到纵向，
      // 省去一次只为推断端口而做的完整 ELK 布局。自递归仍固定用右、下两个口。
      const transpose = { EAST: 'SOUTH', WEST: 'NORTH', NORTH: 'WEST', SOUTH: 'EAST' };
      faces = rightFaces.map(([a, b], i) => edges[i].from === edges[i].to ? ['EAST', 'SOUTH'] : [transpose[a], transpose[b]]);
    } else if (!edges.length && !previous) {
      faces = [];
    } else {
      first = converted(await layoutGraph(graphOf(sized, edges, dir, null, false, group)), sized, edges);
      faces = facesOf(first);
      if (dir === 'RIGHT') rightFaces = faces;
    }
    if (previous) {
      const priorFaces = facesOf(previous);
      const oldFaces = new Map(previous.edges.map((e, i) => [edgeKey(e), priorFaces[i]]));
      edges.forEach((e, i) => { if (oldFaces.has(edgeKey(e))) faces[i] = oldFaces.get(edgeKey(e)); });
    }
    const graph = graphOf(sized, edges, dir, faces, true, group);
    if (previous && sized.some((n) => oldNodes.has(n.id))) seedInteractive(graph, previous, first);
    return { ...converted(await layoutGraph(graph), sized, edges), layoutDirection: dir };
  };
  let view = await generate(direction);
  if (!previous) {
    // 全部候选统一在整理干线后校验和评分，避免纵向/分层候选因未合并干线而被过早淘汰。
    const baseline = finalizeCandidate(view);
    view = baseline;
    let score = validLayout(baseline) ? quality(baseline) : Infinity;
    const consider = (candidate, checkSemantic = false) => {
      if (!candidate || !validLayout(candidate)) return;
      if (checkSemantic && !preservesSemanticOrder(baseline, candidate, edges)) return;
      const next = quality(candidate);
      if (next < score) { view = candidate; score = next; }
    };
    const downTask = generate('DOWN').then(finalizeCandidate);
    const buConfigs = edges.length
      ? [
          { rootDir: 'DOWN', dirDir: 'RIGHT', fileDir: 'AUTO' },
          { rootDir: 'RIGHT', dirDir: 'DOWN', fileDir: 'AUTO' },
          { rootDir: 'DOWN', dirDir: 'DOWN', fileDir: 'AUTO' },
        ]
      : [{ rootDir: 'DOWN', dirDir: 'RIGHT', fileDir: 'AUTO' }];
    const buTasks = group && sized.length <= 120 && edges.length <= 240
      ? buConfigs.map((cfg) => bottomUpCandidate(sized, edges, cfg))
      : [];
    const [downView, ...buViews] = await Promise.all([downTask, ...buTasks]);
    consider(downView);
    for (const cand of buViews) consider(cand, true);
  } else {
    mergeSharedRoutes(view);
  }
  if (!group) for (const n of view.nodes) delete n.group;
  if (group && rootLabel) {
    for (const box of [...view.containers, ...view.groups]) box.depth++;
    view.containers.unshift({ id: '', label: rootLabel, root: true, depth: 1, x: 0, y: 0, w: view.width, h: view.height });
  }
  return view;
}
