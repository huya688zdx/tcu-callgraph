// 应用和评估共用 ELK 的层级分组与四中点端口转换。
import { createRequire } from 'node:module';
import { tarjan } from './index.js';
import { numberedCallLabel } from './labels.js';
import { periodLabels } from './task-periods.js';
import { textWidth, routeScore, directoryWhitespace, improveEdgeRoutes, mergeSharedRoutes } from './layout-metrics.js';
import { edgeStyleKey, routeEdges, collectSegments, pathBlockedByNodes, pathCrossesBody, routeOverlapConflicts,
  incompatibleOverlap, straightConnection, shortPortDeficit, nearFacing, portAt } from './routing.js';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const elk = new ELK();
const TOP_PADDING = 32;
const ROOT_PAD = 24;
const BOX_PAD = 10;
const NODE_GAP = 18;
const LAYER_GAP = 36;
// 小文件沿用原间距；从第九个成员起逐步留出并行走线和标注的空间。
const fileClearance = count => Math.min(24, Math.max(0, Math.ceil((count - 8) / 4)) * 4);
const MODEL_ORDER = 'elk.layered.considerModelOrder.strategy';
const edgeKey = (e) => `${e.from}->${e.to}:${e.line}|${e.kind}|${e.change || 'existing'}`;
const isReverseFlow = (e) => (e.kind === 'var' || e.kind === 'df-read') && e.via === '读';
const flowSource = (e) => isReverseFlow(e) ? e.to : e.from;
const flowTarget = (e) => isReverseFlow(e) ? e.from : e.to;
function explicitRank(e) {
  const raw = e.labels ?? e.label;
  const label = raw && numberedCallLabel(Array.isArray(raw) ? raw : [raw]);
  return label ? Number(label.text.trim().slice(4)) : parseInt(e.callNumbers?.[0], 10) || Number(e.orderGroup) || 0;
}
const callRank = e => explicitRank(e) || e.line || 0;

function modelOrder(nodes, edges) {
  const incoming = new Map(), callers = new Map(), files = new Map(nodes.map(n => [n.id, n.file]));
  const external = new Map(), levels = new Map();
  for (const e of edges) {
    if (e.kind === 'var' || e.kind === 'dataflow' || e.kind?.startsWith('df-')) continue;
    if (!callers.has(e.from)) callers.set(e.from, []);
    callers.get(e.from).push(e.to);
    if (files.get(e.from) !== files.get(e.to)) {
      if (!external.has(e.to)) external.set(e.to, []);
      external.get(e.to).push(e.from);
    }
    incoming.set(e.to, Math.min(incoming.get(e.to) ?? Infinity, callRank(e)));
  }
  const queue = nodes.filter(n => n.taskEntry || !incoming.has(n.id)).map(n => n.id);
  for (const id of queue) levels.set(id, 0);
  for (let i = 0; i < queue.length; i++) for (const target of callers.get(queue[i]) || []) {
    if (levels.has(target)) continue;
    levels.set(target, levels.get(queue[i]) + 1);
    queue.push(target);
  }
  const ranked = nodes.map((n) => ({
    id: n.id,
    role: n.kind === 'var' ? 2 : n.taskEntry ? 0 : 1,
    neighbor: Math.min(...(external.get(n.id) || []).map(id => levels.get(id) ?? Infinity)),
    call: incoming.get(n.id) ?? 0,
    period: (n.taskPeriods || []).reduce((min, { us }) => Number.isInteger(us) && us > 0 ? Math.min(min, us) : min, Infinity),
  }));
  ranked.sort((a, b) => a.role - b.role || a.call - b.call || a.neighbor - b.neighbor || a.period - b.period);
  return new Map(ranked.map(({ id }, i) => [id, i]));
}

/** 递归环同层，把跨文件调用、写入和读取一起投影到有向无环的分量图上。 */
function flowDepths(nodes, edges) {
  const links = edges.map(e => ({ from: flowSource(e), to: flowTarget(e) }));
  const outAdj = new Map(nodes.map(n => [n.id, []]));
  for (const link of links) outAdj.get(link.from).push(link);
  const components = tarjan({ functions: nodes, edges: links, _index: { outAdj } }).reverse();
  const depth = new Map();
  for (const component of components) {
    const members = new Set(component);
    const current = Math.max(...component.map(id => depth.get(id) || 0));
    for (const id of component) {
      depth.set(id, current);
      for (const { to } of outAdj.get(id)) {
        if (!members.has(to)) depth.set(to, Math.max(depth.get(to) || 0, current + 1));
      }
    }
  }
  return depth;
}

// ELK 会把共用逻辑端口的边排成干线。每一面按收发方向和线型设口，
// 同组调用可以先汇集再分支，调用记录仍各自保留完整的端点与路径。
function fixedPorts(nodes, edges, faces, separateStyles) {
  const ports = new Map();
  const nodeIds = new Set(nodes.map((n) => n.id));
  const requests = new Map();
  const compass = { top: 'NORTH', bottom: 'SOUTH', left: 'WEST', right: 'EAST' };
  let nextPort = 0;
  const port = (node, side, role, style, pin) => {
    side = compass[pin] || side;
    if (!requests.has(node)) requests.set(node, new Map());
    const sides = requests.get(node);
    if (!sides.has(side)) sides.set(side, new Map());
    const styles = sides.get(side);
    if (!styles.has(style)) styles.set(style, { ports: [], count: 0, pinned: false, call: style.startsWith('direct|') });
    const request = styles.get(style);
    request.count++;
    request.pinned ||= !!compass[pin];
    if (!ports.has(node)) ports.set(node, new Map());
    const list = ports.get(node);
    const key = JSON.stringify([side, role, style]);
    if (!list.has(key)) {
      let id;
      do { id = 'port:' + nextPort++; } while (nodeIds.has(id));
      list.set(key, { id, side });
      request.ports.push(list.get(key));
    }
    return list.get(key).id;
  };
  const pairs = edges.map((e, i) => {
    const style = separateStyles ? edgeStyleKey(e) : '';
    const reverse = isReverseFlow(e);
    return [port(flowSource(e), faces[i][reverse ? 1 : 0], 'out', style, reverse ? e.toSide : e.fromSide),
      port(flowTarget(e), faces[i][reverse ? 0 : 1], 'in', style, reverse ? e.fromSide : e.toSide)];
  });
  // 先留出原先各面的主样式。发生争用时才把其他样式移到空闲中点，钉面优先。
  for (const sides of requests.values()) {
    const free = Object.values(compass).filter(side => !sides.has(side));
    for (const styles of sides.values()) {
      const ranked = [...styles.values()].sort((a, b) => Number(b.pinned) - Number(a.pinned) ||
        b.count - a.count || Number(b.call) - Number(a.call));
      for (const request of ranked.slice(1)) {
        if (request.pinned || !free.length) continue;
        const side = free.shift();
        for (const p of request.ports) p.side = side;
      }
    }
  }
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
  const counts = new Map();
  for (const n of nodes) counts.set(n.file || 'unknown', (counts.get(n.file || 'unknown') || 0) + 1);
  const boxes = new Map([['', root]]);
  const fixed = faces && fixedPorts(nodes, edges, faces, separateStyles);
  for (const n of nodes) {
    const parts = group ? (n.file || 'unknown').split('/') : [];
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (!boxes.has(key)) {
        const fileGroup = i === parts.length - 1;
        const extra = fileGroup ? fileClearance(counts.get(key)) : 0;
        const pad = BOX_PAD + extra / 2;
        const box = { id: 'box:' + key, label: parts[i], fileGroup,
          children: [], layoutOptions: { 'elk.padding': `[top=${TOP_PADDING + extra / 2},left=${pad},bottom=${pad},right=${pad}]`,
            ...(extra > 0 && { 'elk.spacing.nodeNode': String(NODE_GAP + extra),
              'elk.layered.spacing.nodeNodeBetweenLayers': String(LAYER_GAP + extra),
              'elk.spacing.componentComponent': String(NODE_GAP + extra) }),
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

/** 比较走线、相连节点距离、画布比例与目录间留白。 */
function quality(view, routed = true) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  let distSum = 0, projectedWire = 0, edgeCnt = 0;
  for (const e of view.edges) {
    if (e.from === e.to) continue;
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) continue;
    const dx = Math.abs(a.x + a.w / 2 - b.x - b.w / 2), dy = Math.abs(a.y + a.h / 2 - b.y - b.h / 2);
    distSum += Math.hypot(dx, dy);
    projectedWire += dx + dy + (dx > 0.5 && dy > 0.5 ? NODE_GAP * 2 : 0);
    edgeCnt++;
  }
  const avgDist = edgeCnt ? distSum / edgeCnt : 0;
  const aspect = Math.max(1, view.width) / Math.max(1, view.height);
  return (routed ? routeScore(view.edges) : projectedWire / 50) +
    140 * Math.log(aspect) ** 2 + Math.sqrt(view.width * view.height) / 40 + avgDist * 0.22 +
    Math.sqrt(directoryWhitespace(view)) * 0.25;
}

// 两端所属框及其祖先可以通行。其余框只取最外层，一个障碍即可覆盖其所有子项。
function siblingBarriers(view) {
  const boxes = [...view.groups, ...view.containers].filter(b => !b.root);
  const cache = new Map();
  return (a, b) => {
    const key = JSON.stringify(a < b ? [a, b] : [b, a]);
    if (!cache.has(key)) {
      const owns = id => [a, b].some(group => group === id || group?.startsWith(id + '/'));
      cache.set(key, boxes.filter(box => {
        const slash = box.id.lastIndexOf('/');
        return !owns(box.id) && (slash < 0 || owns(box.id.slice(0, slash)));
      }));
    }
    return cache.get(key);
  };
}

export function validLayout(view) {
  const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 &&
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
  for (let i = 0; i < view.nodes.length; i++) for (let j = i + 1; j < view.nodes.length; j++) {
    if (overlap(view.nodes[i], view.nodes[j])) return false;
  }
  const boxes = [...view.groups, ...view.containers];
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    if (!boxes[i].root && !boxes[j].root && !boxes[i].id.startsWith(boxes[j].id + '/') && !boxes[j].id.startsWith(boxes[i].id + '/') &&
        overlap(boxes[i], boxes[j])) return false;
  }
  const inside = (child, parent) => child.x > parent.x && child.y > parent.y &&
    child.x + child.w < parent.x + parent.w && child.y + child.h < parent.y + parent.h;
  const groupById = new Map(view.groups.map((g) => [g.id, g]));
  for (const n of view.nodes) {
    if (!n.group && !view.groups.length) continue;
    const g = groupById.get(n.group);
    if (!g || !inside(n, g)) return false;
  }
  const boxById = new Map(boxes.map((b) => [b.id, b]));
  for (const b of boxes) {
    const slash = b.id.lastIndexOf('/');
    if (!b.root && (slash > 0 || boxById.has(''))) {
      const parent = boxById.get(slash > 0 ? b.id.slice(0, slash) : '');
      if (!parent || !inside(b, parent)) return false;
    }
  }
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  const barriers = siblingBarriers(view);
  const onPort = (n, p) => n && p && [[n.x + n.w / 2, n.y], [n.x + n.w / 2, n.y + n.h],
    [n.x, n.y + n.h / 2], [n.x + n.w, n.y + n.h / 2]].some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-6);
  return view.edges.every((e) => {
    const pts = e.points;
    if (!pts || pts.length < 2 || pts.some(([x, y], i) => !Number.isFinite(x) || !Number.isFinite(y) ||
        (i && Math.abs(x - pts[i-1][0]) > 1e-6 && Math.abs(y - pts[i-1][1]) > 1e-6))) return false;
    if (!onPort(byId.get(e.from), pts[0]) || !onPort(byId.get(e.to), pts.at(-1))) return false;
    if (e.from === e.to) {
      if (Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) <= 0.5) return false;
      if (new Set(pts.map((p) => p[0])).size <= 1 || new Set(pts.map((p) => p[1])).size <= 1) return false;
    }
    return !barriers(byId.get(e.from).group, byId.get(e.to).group).some(box => pathCrossesBody(pts, box)) &&
      !pathBlockedByNodes(pts, view.nodes, new Set([e.from, e.to])) &&
      !view.nodes.some((n) => pathCrossesBody(pts, n));
  }) && !routeOverlapConflicts(view.edges, { differentStylesOnly: true }).length;
}

// 端点所属框及其祖先允许进出。每对文件只构造一次兄弟框障碍，需绕行的同组边一起布线。
function avoidSiblingBoxes(view, subset = view.edges) {
  const boxes = [...view.groups, ...view.containers].filter(b => !b.root);
  const conflicts = routeOverlapConflicts(view.edges, { differentStylesOnly: true }).byEdge;
  if (!conflicts.size && !boxes.length) return;
  const nodes = new Map(view.nodes.map(n => [n.id, n]));
  const barriers = siblingBarriers(view);
  const pairs = new Map();
  for (const edge of subset) {
    if (!edge.points?.length) continue;
    const a = nodes.get(edge.from).group, b = nodes.get(edge.to).group;
    const key = JSON.stringify(a < b ? [a,b] : [b,a]);
    if (!pairs.has(key)) {
      pairs.set(key, { a, b, obstacles: barriers(a, b), edges: [] });
    }
    const pair = pairs.get(key);
    if ((!edge.custom && conflicts.has(edge)) || pair.obstacles.some(box => pathCrossesBody(edge.points, box))) pair.edges.push(edge);
  }
  const groupDirections = new Map(view.groups.map(g => [g.id, g.layoutDirection]));
  for (const { a, b, obstacles, edges } of pairs.values()) {
    if (!edges.length) continue;
    const trials = edges.map(e => ({ ...e, points: e.points.map(p => [...p]) }));
    const batch = new Set(edges);
    const inside = view.nodes.filter(n => !boxes.length || n.group === a || n.group === b);
    routeEdges([...inside, ...obstacles.map(box => ({ ...box, id: Symbol(box.id) }))], trials,
      { layoutDirection: view.layoutDirection, groupDirections, optimizeFaces: true,
        existing: collectSegments(view.edges.filter(e => !batch.has(e))) });
    trials.forEach((trial, i) => { if (!trial.blocked) edges[i].points = trial.points; });
  }
}

function finishRoutes(view, subset = view.edges) {
  if (!subset.length) return;
  avoidSiblingBoxes(view, subset);
  mergeSharedRoutes(view, subset);
  const conflicts = () => routeOverlapConflicts(view.edges, { differentStylesOnly: true }).byEdge;
  let remaining = conflicts();
  if (!remaining.size) return;
  // 当不同文件对争用同一端口时，固定其余边单独重试，只接受异色重合长度下降的路线。
  for (const e of subset.filter(e => remaining.has(e)).sort((a, b) => remaining.get(b) - remaining.get(a))) {
    if (!remaining.has(e)) continue;
    const before = e.points;
    avoidSiblingBoxes(view, [e]);
    const next = conflicts();
    if ((next.get(e) || 0) < remaining.get(e)) remaining = next;
    else e.points = before;
  }
}

function finalizeCandidate(view) {
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  improveEdgeRoutes(view, view.edges, (e) => byId.get(e.from)?.file !== byId.get(e.to)?.file);
  finishRoutes(view);
  return fitRoutedBounds(view);
}

/** 保护基准布局已成立的同级显式调用顺序与跨顶层容器数据流向。 */
function preservesSemanticOrder(baseline, candidate, edges) {
  const posMap = (view, axis) => new Map(view.nodes.map((n) => [n.id, n[axis]]));
  const nodeById = new Map(baseline.nodes.map((n) => [n.id, n]));
  const baseCross = posMap(baseline, baseline.layoutDirection === 'RIGHT' ? 'y' : 'x');
  const candCross = posMap(candidate, candidate.layoutDirection === 'RIGHT' ? 'y' : 'x');
  const byCaller = new Map();
  for (const e of edges) {
    if (e.from === e.to || e.kind === 'var' || e.kind === 'dataflow' || e.kind?.startsWith('df-')) continue;
    if (!explicitRank(e)) continue;
    if (!byCaller.has(e.from)) byCaller.set(e.from, new Map());
    const targets = byCaller.get(e.from);
    targets.set(e.to, Math.min(targets.get(e.to) ?? Infinity, callRank(e)));
  }
  for (const targets of byCaller.values()) {
    if (targets.size < 2) continue;
    const ordered = [...targets.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
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
      const variable = flowSource(e);
      if (!readers.has(variable)) readers.set(variable, []);
      readers.get(variable).push(flowTarget(e));
    }
  }
  for (const [varId, ws] of writers) {
    const rs = readers.get(varId);
    if (!rs) continue;
    for (const w of ws) for (const r of rs) {
      if (w === r) continue;
      // 同一模块的访问可在调用链侧翼表达，三个不同模块的写→变量→读仍沿主流向。
      const files = [w, varId, r].map(id => nodeById.get(id)?.file || 'unknown');
      if (new Set(files).size !== 3) continue;
      if (baseMain.get(w) < baseMain.get(varId) && baseMain.get(varId) < baseMain.get(r)) {
        if (!(candMain.get(w) < candMain.get(varId) && candMain.get(varId) < candMain.get(r))) return false;
      }
    }
  }
  return true;
}

/** 逻辑分组路径供拖动和嵌套校验使用，节点仍保留源码文件路径。 */
function periodGroups(nodes, edges) {
  const periods = n => [...new Set((n.taskPeriods || []).map(p => p.us).filter(us => Number.isFinite(us) && us > 0))];
  const laneOf = n => {
    const values = periods(n);
    const irq = /isr|irq|handler|interrupt/i;
    if (n.isIsr || n.kind === 'isr' || n.taskPeriods?.some(p => p.isIsr || p.kind === 'isr')) return 'isr';
    if (!values.length && (irq.test(n.name || n.id.split('::').at(-1)) ||
      n.taskPeriods?.some(p => irq.test(p.task?.split('::').at(-1))))) return 'isr';
    return values.length > 1 ? 'multi' : values.length ? String(values[0]) : 'init';
  };
  const paths = new Map(), boxes = new Map(), peers = new Map();
  const byId = new Map(nodes.map(n => [n.id, n]));
  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    if ((a.kind === 'var') === (b.kind === 'var')) continue;
    const [v, f] = a.kind === 'var' ? [a, b] : [b, a];
    if (!peers.has(v.id)) peers.set(v.id, new Set());
    peers.get(v.id).add(f);
  }
  const labels = { isr: 'ISR / 中断级', multi: '⚡ 多周期共用', init: '初始化 / 通用', signals: '共享信号区 (Shared Signals)' };
  const linked = new Set();
  for (const n of nodes) {
    let lane = laneOf(n), section = 'functions';
    if (n.kind === 'var') {
      const users = [...(peers.get(n.id) || [])], lanes = new Set(users.map(laneOf));
      const modules = new Set(users.map(f => f.file).filter(Boolean));
      if (n.file) modules.add(n.file);
      const shared = lanes.size > 1 || modules.size > 1 || lanes.has('multi') || lane === 'multi';
      lane = shared ? 'signals' : [...lanes][0] || lane;
      section = shared ? 'signals' : 'state';
      if (shared) for (const id of lanes) linked.add(id);
    }
    const key = 'period-' + lane, path = key + '/' + section;
    paths.set(n.id, path);
    const periodUs = Number(lane) || null;
    boxes.set(key, { label: labels[lane] || '⏱ ' + periodLabels([{ us: periodUs }])[0] + ' 周期',
      kind: lane === 'signals' ? 'signal-bus' : 'period-lane', periodUs });
    boxes.set(path, { label: { functions: '函数', state: '局部状态', signals: '共享变量' }[section] });
  }
  const rank = key => ({ 'period-isr': 0, 'period-multi': Number.MAX_VALUE, 'period-init': Infinity }[key] ?? boxes.get(key).periodUs);
  const lanes = [...boxes.keys()].filter(k => !k.includes('/') && k !== 'period-signals')
    .sort((a, b) => rank(a) - rank(b));
  if (boxes.has('period-signals')) {
    const indices = [...linked].map(k => lanes.indexOf('period-' + k)).filter(i => i >= 0);
    const position = indices.length ? Math.floor((Math.min(...indices) + Math.max(...indices)) / 2) + 1 : lanes.length;
    lanes.splice(position, 0, 'period-signals');
  }
  return { paths, boxes, lanes };
}

/** 自底向上逐层排布文件或逻辑泳道，再对整图布线。 */
function reusePeriodPositions(box, previousNodes, previousGroups) {
  const group = previousGroups.get(box.id);
  if (!group) return;
  const fixed = [], fresh = [];
  for (const node of box.leafNodes) {
    const old = previousNodes.get(node.id);
    const pos = box.relPos.get(node.id);
    if (old?.group === box.id && old.w === node.w && old.h === node.h) {
      pos.x = old.x - group.x;
      pos.y = old.y - group.y;
      fixed.push({ ...pos, w: node.w, h: node.h });
    } else fresh.push({ node, pos });
  }
  if (!fixed.length) return;
  // 变更节点遇到固定节点时，放入泳道内的新行，避免覆盖手动位置。
  let below = Math.max(box.h, ...fixed.map(p => p.y + p.h)) + NODE_GAP;
  for (const { node, pos } of fresh) {
    if (fixed.some(p => pos.x < p.x + p.w + NODE_GAP && pos.x + node.w + NODE_GAP > p.x &&
        pos.y < p.y + p.h + NODE_GAP && pos.y + node.h + NODE_GAP > p.y)) {
      pos.y = below;
      below += node.h + NODE_GAP;
    }
  }
  for (const node of box.leafNodes) {
    const { x, y } = box.relPos.get(node.id);
    box.w = Math.max(box.w, x + node.w + 14);
    box.h = Math.max(box.h, y + node.h + 14);
  }
}

// 在四个相邻通道中试排。每条轨道按访问重心排序，前推再回压以满足间距和边界。
function placeStateWing(box, states, peers, external, origin) {
  const base = box.functionBox;
  const { pad, top, gap } = box;
  const local = new Map(box.leafNodes.filter(n => base.pos.has(n.id)).map(n => {
    const p = base.pos.get(n.id);
    return [n.id, [p.x + n.w / 2, p.y + n.h / 2]];
  }));
  const access = states.map(n => (peers.get(n.id) || []).flatMap(id => {
    if (local.has(id)) return [{ xy: local.get(id), local: true }];
    const p = external?.get(id);
    return p ? [{ xy: [p.x - origin.x, p.y - origin.y], local: false }] : [];
  }));
  const pack = (side, members) => {
    const horizontal = side === 'bottom' || side === 'top';
    const axis = horizontal ? 0 : 1, cross = 1 - axis;
    const size = horizontal ? 'w' : 'h', thickness = horizontal ? 'h' : 'w';
    const start = horizontal ? pad : top;
    const extent = Math.max(base[size] - start - pad, ...members.map(i => states[i][size]),
      Math.sqrt(members.reduce((area, i) => area + (states[i].w + gap) * (states[i].h + gap), 0)));
    const items = members.map(i => ({ n: states[i], i, center: access[i].length
      ? access[i].reduce((sum, a) => sum + a.xy[axis], 0) / access[i].length : start + extent / 2 }))
      .sort((a, b) => a.center - b.center);
    const rows = [];
    let used = 0;
    for (const item of items) {
      if (!rows.length || used + item.n[size] > extent) { rows.push([]); used = 0; }
      rows.at(-1).push(item);
      used += item.n[size] + gap;
    }
    const shift = [0, 0];
    const depth = rows.reduce((d, row) => d + gap + Math.max(...row.map(it => it.n[thickness])), 0);
    const before = side === 'left' || side === 'top';
    if (before) shift[cross] = depth;
    const dims = [base.w, base.h];
    dims[axis] = Math.max(dims[axis], extent + start + pad);
    dims[cross] += depth;
    let offset = before ? (horizontal ? top : pad) : base[thickness] - pad + gap;
    const positions = new Map();
    for (const row of rows) {
      let low = start;
      for (const item of row) {
        item.at = Math.max(low, Math.round(item.center - item.n[size] / 2));
        low = item.at + item.n[size] + gap;
      }
      let high = start + extent;
      for (const it of row.slice().reverse()) {
        const at = Math.min(it.at, high - it.n[size]);
        high = at - gap;
        const x = horizontal ? at : offset, y = horizontal ? offset : at;
        positions.set(it.n.id, { x, y });
      }
      offset += Math.max(...row.map(it => it.n[thickness])) + gap;
    }
    return { positions, dims, shift };
  };
  let best;
  const consider = ({ positions, dims, shift }) => {
    let wire = 0;
    for (const [i, n] of states.entries()) {
      const p = positions.get(n.id);
      for (const peer of access[i]) {
        wire += Math.abs(p.x + n.w / 2 - peer.xy[0] - (peer.local ? shift[0] : 0)) +
          Math.abs(p.y + n.h / 2 - peer.xy[1] - (peer.local ? shift[1] : 0));
      }
    }
    const score = wire + Math.sqrt(dims[0] * dims[1]) + 20 * Math.abs(Math.log(dims[0] / dims[1]));
    if (!best || score < best.score) best = { score, positions, dims, shift };
  };
  const indices = [...states.keys()];
  for (const side of ['bottom', 'right', 'top', 'left']) consider(pack(side, indices));
  // 访问者位于函数块两端时也比较双侧通道。两条对侧通道分属互不相交的半平面。
  for (const axis of [0, 1]) {
    const size = axis === 0 ? base.w : base.h;
    const before = [], after = [];
    for (const i of indices) {
      const links = access[i];
      const center = links.length ? links.reduce((sum, p) => sum + p.xy[axis], 0) / links.length : size / 2;
      (center < size / 2 ? before : after).push(i);
    }
    if (!before.length || !after.length) continue;
    const first = pack(axis ? 'top' : 'left', before);
    const second = pack(axis ? 'bottom' : 'right', after);
    for (const [id, p] of second.positions) {
      first.positions.set(id, { x: p.x + first.shift[0], y: p.y + first.shift[1] });
    }
    first.dims[axis] += second.dims[axis] - size;
    first.dims[1 - axis] = Math.max(first.dims[1 - axis], second.dims[1 - axis]);
    consider(first);
  }
  box.relPos = best.positions;
  for (const [id, p] of base.pos) box.relPos.set(id, { x: p.x + best.shift[0], y: p.y + best.shift[1] });
  [box.w, box.h] = best.dims;
}

async function bottomUpCandidate(sized, edges, { rootDir, dirDir, fileDir, packMain = false, period = null, previous = null, cache = new Map(), deferRouting = false }) {
  const order = modelOrder(sized, edges);
  let depths;
  const peers = new Map(sized.map(n => [n.id, []]));
  for (const e of edges) {
    if (e.from === e.to) continue;
    peers.get(e.from).push(e.to);
    peers.get(e.to).push(e.from);
  }
  const root = { id: '', label: '', children: new Map(), leafNodes: [] };
  let boxCount = 0;
  for (const n of sized) {
    const parts = (period?.paths.get(n.id) || n.file || 'unknown').split('/');
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
  if (!period && boxCount < 2 && sized.length <= 120 && !sized.some(n => n.kind === 'var')) {
    const broad = fileClearance(sized.length) > 0 || (sized.length >= 6 && (!edges.length || [...peers.values()].some(list => new Set(list).size >= 5)));
    if (!broad) return null;
  }
  // 单子目录只是外层包装，主方向应在第一个有兄弟框的目录生效。
  let mainBox = root;
  while (mainBox.children.size === 1 && !mainBox.leafNodes.length) {
    const child = mainBox.children.values().next().value;
    if (child.fileGroup) break;
    mainBox = child;
  }
  // 多个并列目录可以沿两轴摆放，避免层级链占满整个主轴。
  if (packMain && mainBox.children.size < 3) return null;

  async function layoutBox(box, depth, dirOverride = null) {
    const childItems = [];
    for (const child of box.children.values()) {
      childItems.push({ id: 'box:' + child.id, isBox: true, ref: child, width: child.w, height: child.h, ord: child.minOrd });
    }
    const hasFunctions = box.leafNodes.some(n => n.kind !== 'var');
    const states = [];
    for (const n of box.leafNodes) {
      if (hasFunctions && n.kind === 'var') { states.push(n); continue; }
      childItems.push({ id: n.id, isBox: false, ref: n, width: n.w, height: n.h, ord: order.get(n.id) ?? 0 });
    }
    box.minOrd = Math.min(...childItems.map((c) => c.ord));

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

    childItems.sort((a, b) => a.ord - b.ord);

    const hybrid = fileDir === 'AUTO';
    const isRoot = depth === 0;
    const extra = box.fileGroup ? fileClearance(box.leafNodes.length) : 0;
    const sidePad = box.pad = isRoot ? ROOT_PAD : 14 + extra / 2;
    const top = box.top = TOP_PADDING + extra / 2;
    box.gap = NODE_GAP + extra;
    const direction = box.fileGroup ? (fileDir === 'AUTO' ? rootDir : fileDir) : box === mainBox ? rootDir : dirDir;
    if (period && !box.fileGroup) {
      const index = child => isRoot ? period.lanes.indexOf(child.ref.id) : Number(child.ref.id.endsWith('/state'));
      childItems.sort((a, b) => index(a) - index(b));
      let y = TOP_PADDING;
      box.relPos = new Map();
      for (const item of childItems) {
        box.relPos.set(item.id, { x: sidePad, y });
        y += item.height + LAYER_GAP;
      }
      box.w = Math.max(0, ...childItems.map(it => it.width)) + sidePad * 2;
      if (!isRoot) box.w = Math.max(box.w, textWidth(period.boxes.get(box.id).label) + sidePad * 2);
      box.h = y - (childItems.length ? LAYER_GAP : 0) + sidePad;
      box.usedDir = 'RIGHT';
      return;
    }
    if (childItems.length === 1 && !states.length) {
      const item = childItems[0];
      box.w = item.width + sidePad * 2;
      box.h = item.height + top + sidePad;
      box.relPos = new Map([[item.id, { x: sidePad, y: top }]]);
      box.usedDir = dirOverride || direction;
      return;
    }
    const pad = `[top=${top},left=${sidePad},bottom=${sidePad},right=${sidePad}]`;
    const gap = box.fileGroup ? 16 + extra : hybrid ? 20 : 30;
    // 同一外部调用者显式编号的一组孤立目标需要共用一层，避免矩形装箱把顺序折到下一行。
    if (!period && agg.size === 0 && !states.length) {
      const calls = new Map();
      for (const e of edges) {
        const target = memberOf.get(e.to), rank = explicitRank(e);
        if (!target || !rank || memberOf.has(e.from) || e.kind === 'var' || e.kind?.startsWith('df-')) continue;
        if (!calls.has(e.from)) calls.set(e.from, new Map());
        const ranks = calls.get(e.from);
        ranks.set(target, Math.min(rank, ranks.get(target) ?? Infinity));
      }
      const before = new Map(childItems.map(c => [c.id, new Set()]));
      for (const ranks of calls.values()) {
        let previous = [], current = [], rank;
        for (const [id, next] of [...ranks].sort((a, b) => a[1] - b[1])) {
          if (rank !== next) { previous = current; current = []; rank = next; }
          for (const prior of previous) before.get(id).add(prior);
          current.push(id);
        }
      }
      if ([...before.values()].some(set => set.size)) {
        const remaining = new Set(childItems);
        const sequence = [];
        while (remaining.size) {
          const next = [...remaining].find(c => !before.get(c.id).size);
          if (!next) break;
          sequence.push(next);
          remaining.delete(next);
          for (const prior of before.values()) prior.delete(next.id);
        }
        childItems.splice(0, childItems.length, ...sequence, ...remaining);
        const horizontal = rootDir === 'RIGHT';
        let x = sidePad, y = top;
        box.relPos = new Map();
        for (const item of childItems) {
          box.relPos.set(item.id, { x, y });
          if (horizontal) y += item.height + gap;
          else x += item.width + gap;
        }
        box.w = horizontal ? Math.max(...childItems.map(c => c.width)) + 2 * sidePad : x - gap + sidePad;
        box.h = horizontal ? y - gap + sidePad : Math.max(...childItems.map(c => c.height)) + top + sidePad;
        box.usedDir = rootDir;
        return;
      }
    }
    const serialLayer = !period && box.fileGroup && agg.size && new Set([...agg.values()].map(e => e.s)).size === agg.size &&
      new Set([...agg.values()].map(e => e.t)).size === agg.size;
    const layerGap = box.fileGroup ? (serialLayer ? 20 : 28) + extra : hybrid ? 30 : 44;
    const pack = packMain && box === mainBox;
    // 文件内的局部边不足以把函数分层时，使用整图的调用/读写深度约束 ELK。
    // 同层节点仍按调用序和外部访问者的位置排列，没有关系的文件仍可装箱。
    const sparse = extra > 0 && agg.size * 2 < childItems.length;
    if (sparse) depths ||= flowDepths(sized, edges);
    const levels = sparse ? [...new Set(childItems.filter(c => peers.get(c.id)?.length).map(c => depths.get(c.id)))].sort((a, b) => a - b) : [];
    const partitioned = levels.length > 0;

    const solve = async (dir, packed) => {
      if (packed) {
        return elk.layout({
          id: 'g:' + box.id,
          layoutOptions: {
            'elk.algorithm': 'rectpacking',
            'elk.padding': pad,
            'elk.spacing.nodeNode': String(hybrid ? gap : box.fileGroup ? gap : LAYER_GAP),
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
          'elk.spacing.componentComponent': String(box.fileGroup ? box.gap : 28),
          ...(partitioned && { 'elk.partitioning.activate': 'true', 'elk.separateConnectedComponents': 'false',
            'elk.layered.crossingMinimization.forceNodeModelOrder': 'true' }),
          'elk.aspectRatio': '1.0',
          'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH',
          'elk.layered.compaction.connectedComponents': 'true',
          'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
          'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
          'elk.layered.thoroughness': '7',
          'elk.randomSeed': '1',
        },
        children: childItems.map((it) => ({ id: it.id, width: it.width, height: it.height,
          ...(partitioned && { layoutOptions: { 'elk.partitioning.partition': String(Math.max(0, levels.indexOf(depths.get(it.id)))) } }) })),
        edges: aggList.map((a, idx) => ({
          id: 'ae' + idx, sources: [a.s], targets: [a.t],
          layoutOptions: { 'elk.layered.priority.shortness': String(Math.min(10, a.count)) },
        })),
      });
    };

    const signature = JSON.stringify([sidePad, gap, layerGap, box.fileGroup, childItems.map(c => [c.id, c.width, c.height]), [...agg.values()]]);
    const run = (dir, packed) => {
      const key = (packed ? 'grid' : dir) + signature;
      if (!cache.has(key)) cache.set(key, solve(dir, packed));
      return cache.get(key);
    };
    let usedDir = dirOverride || direction;
    let best = await run(usedDir, (!agg.size && !partitioned) || pack);
    if (hybrid && !dirOverride && agg.size && !pack && box !== mainBox) {
      const other = direction === 'RIGHT' ? 'DOWN' : 'RIGHT';
      // 投影到本层的真实边同时反映链深、扇出和文件之间的访问频率。
      // 父层水平组合时偏好窄框；父层垂直组合时偏好宽框。
      const target = (box.fileGroup ? rootDir : direction) === 'RIGHT' ? 0.85 : 1.65;
      const localStates = new Set(states.map(n => n.id));
      const boundary = [];
      for (const e of edges) {
        if (localStates.has(e.from) || localStates.has(e.to)) continue;
        const source = memberOf.get(flowSource(e)), target = memberOf.get(flowTarget(e));
        if (source && !target) boundary.push({ id: source, incoming: false });
        if (!source && target) boundary.push({ id: target, incoming: true });
      }
      const localCost = result => {
        const centers = new Map(result.children.map(c => [c.id, [c.x + c.width/2, c.y + c.height/2]]));
        let wire = 0, count = 0;
        for (const { s, t, count: weight } of agg.values()) {
          const a = centers.get(s), b = centers.get(t);
          wire += weight * (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]));
          count += weight;
        }
        const axis = rootDir === 'RIGHT' ? 0 : 1, span = axis ? result.height : result.width;
        const access = boundary.reduce((sum, port) => {
          const coordinate = centers.get(port.id)[axis];
          return sum + (port.incoming ? coordinate : span - coordinate);
        }, 0);
        return (wire + 0.5 * access) / (count + 0.5 * boundary.length) + Math.sqrt(result.width * result.height) * 0.25 +
          65 * Math.log(result.width / result.height / target) ** 2;
      };
      const alt = await run(other, false);
      if (localCost(alt) < localCost(best)) { best = alt; usedDir = other; }
      // 星形图单独保留调用者所在的层，只折叠对面的兄弟节点。
      const sources = new Set([...agg.values()].map(e => e.s)), targets = new Set([...agg.values()].map(e => e.t));
      if (childItems.length >= 6 && (sources.size === 1 || targets.size === 1) &&
          new Set([...sources, ...targets]).size === childItems.length) {
        const fanout = sources.size === 1;
        const hub = fanout ? sources.values().next().value : targets.values().next().value;
        const grid = await run(usedDir, true);
        const branches = grid.children.filter(c => c.id !== hub);
        const center = grid.children.find(c => c.id === hub);
        const left = Math.min(...branches.map(c => c.x)), top = Math.min(...branches.map(c => c.y));
        const w = Math.max(...branches.map(c => c.x + c.width)) - left, h = Math.max(...branches.map(c => c.y + c.height)) - top;
        for (const dir of ['RIGHT', 'DOWN']) {
          const horizontal = dir === 'RIGHT';
          const width = horizontal ? w + layerGap + center.width : Math.max(w, center.width);
          const height = horizontal ? Math.max(h, center.height) : h + layerGap + center.height;
          const x = horizontal ? (fanout ? center.width + layerGap : 0) : (width - w)/2;
          const y = horizontal ? (height - h)/2 : (fanout ? center.height + layerGap : 0);
          const children = branches.map(c => ({ ...c, x: sidePad + x + c.x - left, y: box.top + y + c.y - top }));
          children.push({ ...center,
            x: sidePad + (horizontal ? (fanout ? 0 : w + layerGap) : (width - center.width)/2),
            y: box.top + (horizontal ? (height - center.height)/2 : (fanout ? 0 : h + layerGap)) });
          const wrapped = { width: width + 2 * sidePad, height: height + box.top + sidePad, children };
          if (localCost(wrapped) < localCost(best)) { best = wrapped; usedDir = dir; }
        }
      } else if (!box.fileGroup && childItems.length >= 6 && agg.size * 2 < childItems.length) {
        const grid = await run(usedDir, true);
        if (localCost(grid) < localCost(best)) best = grid;
      }
    }
    box.w = best.width;
    box.h = best.height;
    box.relPos = new Map(best.children.map(c => [c.id, { x: c.x, y: c.y }]));
    if (states.length) {
      box.states = states;
      box.functionBox = { pos: box.relPos, w: box.w, h: box.h };
      placeStateWing(box, states, peers, null, null);
    }
    if (pack && agg.size) {
      // 网格没有固定主轴，用调用最多的目录对确定流向。
      const { s, t } = [...agg.values()].reduce((a, b) => a.count >= b.count ? a : b);
      const children = new Map(best.children.map((c) => [c.id, c]));
      const a = children.get(s), b = children.get(t);
      const dx = Math.abs(a.x + a.width / 2 - b.x - b.width / 2);
      const dy = Math.abs(a.y + a.height / 2 - b.y - b.height / 2);
      usedDir = dx >= dy ? 'RIGHT' : 'DOWN';
    }
    box.usedDir = usedDir;
  }

  const previousNodes = new Map(previous?.nodes.map(n => [n.id, n]));
  const previousGroups = new Map(previous?.groups.map(g => [g.id, g]));
  async function pass1(box, depth) {
    await Promise.all([...box.children.values()].map((child) => pass1(child, depth + 1)));
    await layoutBox(box, depth);
    if (period && box.fileGroup) reusePeriodPositions(box, previousNodes, previousGroups);
  }
  await pass1(root, 0);

  const absPos = new Map(), origins = new Map();
  const computeAbs = (box, ox, oy) => {
    origins.set(box.id, { x: ox, y: oy });
    box.members = box.leafNodes.map(n => n.id);
    for (const child of box.children.values()) {
      const p = box.relPos.get('box:' + child.id);
      computeAbs(child, ox + p.x, oy + p.y);
      box.members.push(...child.members);
    }
    for (const n of box.leafNodes) {
      const p = box.relPos.get(n.id);
      absPos.set(n.id, { x: ox + p.x + n.w / 2, y: oy + p.y + n.h / 2 });
    }
  };
  computeAbs(root, 0, 0);

  async function pass2(box, depth) {
    const prevW = box.w, prevH = box.h;
    let childChanged = false;
    for (const child of box.children.values()) if (await pass2(child, depth + 1)) childChanged = true;
    if (childChanged) await layoutBox(box, depth, box.usedDir);
    const origin = origins.get(box.id);
    computeAbs(box, origin.x, origin.y);
    if (box.states) {
      placeStateWing(box, box.states, peers, absPos, origins.get(box.id));
    } else {
      // 固定每个子项的层，沿横切轴对齐真实端点。边界取当前框内剩余空间，
      // 与主轴投影重叠的兄弟限制可移动区间，因此不会挤进邻框。
      const vertical = box.usedDir === 'DOWN';
      const [main, size, cross, breadth] = vertical ? ['y','h','x','w'] : ['x','w','y','h'];
      const children = [...box.children.values()].map(c => ({ id: 'box:' + c.id, w: c.w, h: c.h, ids: c.members }));
      children.push(...box.leafNodes.map(n => ({ id: n.id, w: n.w, h: n.h, ids: [n.id] })));
      const owner = new Map(children.flatMap(c => c.ids.map(id => [id, c.id])));
      const ordered = new Map();
      for (const e of edges) {
        if (!owner.has(e.to) || !explicitRank(e)) continue;
        if (!ordered.has(e.from)) ordered.set(e.from, new Set());
        ordered.get(e.from).add(owner.get(e.to));
      }
      const locked = new Set([...ordered.values()].filter(set => set.size > 1).flatMap(set => [...set]));
      if (children.length > 1) {
        const anchorsFor = c => {
          let dx = 0, dy = 0, count = 0;
          c.anchors = [];
          for (const id of c.ids) for (const peer of peers.get(id)) {
            if (owner.get(peer) === c.id) continue;
            const self = absPos.get(id), p = absPos.get(peer);
            c.anchors.push(c.pos[cross] + p[cross] - self[cross]);
            dx += p.x - self.x;
            dy += p.y - self.y;
            count++;
          }
          c.weight = count;
          c.goal = { x: c.pos.x + dx / (count || 1), y: c.pos.y + dy / (count || 1) };
        };
        const move = (c, pos) => {
          const dx = pos.x - c.pos.x, dy = pos.y - c.pos.y;
          for (const id of c.ids) {
            const p = absPos.get(id);
            p.x += dx; p.y += dy;
          }
          c.pos = pos;
          box.relPos.set(c.id, pos);
        };
        for (const c of children) {
          c.pos = box.relPos.get(c.id);
          anchorsFor(c);
        }
        // 同尺寸槽位可以交换。纯变量框可同时沿两轴匹配外部读写重心。
        const varsOnly = box.fileGroup && box.leafNodes.every(n => n.kind === 'var');
        const cost = (c, pos) => varsOnly
          ? c.weight * ((pos.x - c.goal.x) ** 2 + (pos.y - c.goal.y) ** 2)
          : c.weight * Math.abs(pos[cross] - c.goal[cross]);
        for (let i = 0; i < children.length; i++) for (let j = i+1; j < children.length; j++) {
          const a = children[i], b = children[j];
          if (locked.has(a.id) || locked.has(b.id) || a.w !== b.w || a.h !== b.h || (!varsOnly && a.pos[main] !== b.pos[main])) continue;
          if (cost(a, b.pos) + cost(b, a.pos) >= cost(a, a.pos) + cost(b, b.pos)) continue;
          const old = a.pos;
          move(a, b.pos);
          move(b, old);
        }
        const pad = box.pad;
        for (const c of children) {
          if (!c.weight || locked.has(c.id)) continue;
          // 另一端可能已换槽或对齐；使用其当前位置，避免两个近共线节点相互错过。
          anchorsFor(c);
          let lo = vertical ? pad : box.top, hi = box[breadth] - pad - c[breadth];
          for (const other of children) {
            if (c === other || c.pos[main] + c[size] <= other.pos[main] || other.pos[main] + other[size] <= c.pos[main]) continue;
            if (other.pos[cross] < c.pos[cross]) lo = Math.max(lo, other.pos[cross] + other[breadth] + box.gap);
            else hi = Math.min(hi, other.pos[cross] - c[breadth] - box.gap);
          }
          if (lo > hi) continue;
          // 重心给出对齐建议，中位数最小化曼哈顿距离。保留已直连的端口可省去两个弯。
          c.anchors.sort((a, b) => a - b);
          const costAt = x => c.anchors.reduce((sum, a) => sum + Math.abs(a - x) + (Math.abs(a - x) > 1e-6 ? NODE_GAP : 0), 0);
          let bestCost = costAt(c.pos[cross]);
          let bestAt = c.pos[cross];
          const near = c.anchors.filter(at => Math.abs(at - c.pos[cross]) <= box.gap);
          for (const at of [c.goal[cross], c.anchors[Math.floor(c.anchors.length / 2)], ...new Set(near)]) {
            const x = Math.max(lo, Math.min(hi, at)), cost = costAt(x);
            if (cost < bestCost - 1e-6) { bestAt = x; bestCost = cost; }
          }
          if (bestAt !== c.pos[cross]) move(c, { ...c.pos, [cross]: bestAt });
        }
      }
    }
    return Math.abs(box.w - prevW) > 0.5 || Math.abs(box.h - prevH) > 0.5;
  }
  if (edges.length && fileDir === 'AUTO' && !period) await pass2(root, 0);

  const view = { nodes: [], groups: [], containers: [], width: root.w, height: root.h,
    layoutDirection: mainBox.children.size === 1 ? mainBox.children.values().next().value.usedDir :
      packMain && fileDir === 'AUTO' ? mainBox.usedDir : rootDir };
  const flatten = (box, ox, oy, depth) => {
    for (const child of box.children.values()) {
      const p = box.relPos.get('box:' + child.id);
      const x = ox + p.x, y = oy + p.y;
      const entry = { id: child.id, label: child.label, x, y, w: child.w, h: child.h, depth, ...(fileDir === 'AUTO' && { layoutDirection: child.usedDir }), ...period?.boxes.get(child.id) };
      (child.fileGroup ? view.groups : view.containers).push(entry);
      flatten(child, x, y, depth + 1);
    }
    for (const n of box.leafNodes) {
      const p = box.relPos.get(n.id);
      view.nodes.push({ ...n, x: ox + p.x, y: oy + p.y, group: box.id,
        ...(fileDir === 'AUTO' && { layoutDirection: box.usedDir }) });
    }
  };
  flatten(root, 0, 0, 1);
  if (period) view.containers.sort((a, b) => a.y - b.y);

  view.edges = edges;
  return deferRouting ? view : routeCandidate(view);
}

function routeCandidate(view) {
  const edges = view.edges;
  // 克隆边送入路由器，避免写入临时属性破坏输出契约。
  const routed = edges.map(e => e.custom && e.points ? { ...e, points: e.points.map(p => [...p]) } : { ...e });
  const byId = new Map(view.nodes.map((n) => [n.id, n]));
  view.edges = routed;
  const groupDirections = new Map(view.groups.map(g => [g.id, g.layoutDirection]));
  routeEdges(view.nodes, routed, { layoutDirection: view.layoutDirection, groupDirections,
    optimizeFaces: true });
  improveEdgeRoutes(view, routed, (e) => byId.get(e.from)?.file !== byId.get(e.to)?.file);
  const bad = routed.filter((e) => e.blocked ||
    pathBlockedByNodes(e.points, view.nodes, new Set([e.from, e.to])) ||
    pathCrossesBody(e.points, byId.get(e.from)) || pathCrossesBody(e.points, byId.get(e.to)));
  if (bad.length) improveEdgeRoutes(view, bad, () => true);
  finishRoutes(view);
  view.edges = edges.map((e, i) => ({ ...e, points: routed[i].points }));

  return fitRoutedBounds(view);
}

function fitRoutedBounds(view) {
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

function withRoot(view, rootLabel) {
  if (rootLabel) {
    for (const box of [...view.containers, ...view.groups]) box.depth++;
    view.containers.unshift({ id: '', label: rootLabel, root: true, depth: 1, x: 0, y: 0, w: view.width, h: view.height });
  }
  return view;
}

export async function layoutElk(nodes, edges, { group = true, groupMode = 'file', rootLabel = '', previous = null } = {}) {
  const ids = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const sized = nodes.map((n) => ({ ...n,
    w: n.w || Math.min(190, Math.max(120, Math.max(textWidth(n.label || n.name || n.id),
      textWidth((n.targetNames || []).join(' / '))) + 28 + (n.kind === 'var' ? 0 : 16))),
    h: n.h || (n.sub ? 58 : 44),
  }));
  if (group && groupMode === 'period') {
    const view = await bottomUpCandidate(sized, edges, { rootDir: 'RIGHT', fileDir: 'RIGHT', dirDir: 'DOWN',
      period: periodGroups(sized, edges), previous: previous?.groupMode === 'period' ? previous : null });
    view.groupMode = 'period';
    return withRoot(view, rootLabel);
  }
  if (previous?.groupMode === 'period' || previous?.containers?.some(box => box.kind === 'period-lane')) previous = null;
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
    const groupDirections = new Map(previous.groups?.map(g => [g.id, g.layoutDirection]));
    const directories = new Set();
    for (const file of files) {
      for (let slash = file.lastIndexOf('/'); slash >= 0; slash = file.lastIndexOf('/', slash - 1)) {
        directories.add(file.slice(0, slash));
        if (!slash) break;
      }
    }
    const view = { width: previous.width, height: previous.height, layoutDirection: direction,
      nodes: sized.map((n) => ({ ...n, x: oldNodes.get(n.id).x, y: oldNodes.get(n.id).y,
        ...(group ? { group: n.file || 'unknown' } : {}),
        ...(group && groupDirections.get(n.file || 'unknown') && { layoutDirection: groupDirections.get(n.file || 'unknown') }) })),
      edges: edges.map((e) => {
        const old = oldEdges.get(edgeKey(e));
        return { ...e, points: old?.points.map((p) => [...p]),
          custom: old?.custom ?? e.custom, fromSide: old?.fromSide ?? e.fromSide, toSide: old?.toSide ?? e.toSide };
      }),
      groups: group ? (previous.groups || []).filter((g) => files.has(g.id)).map((g) => ({ ...g })) : [],
      containers: group ? (previous.containers || []).filter((c) => c.root || directories.has(c.id)).map((c) => ({ ...c })) : [],
    };
    const saved = view.edges.filter(e => e.points);
    const conflicts = routeOverlapConflicts(saved, { differentStylesOnly: true }).byEdge;
    const barriers = siblingBarriers(view);
    const byId = new Map(view.nodes.map(n => [n.id, n]));
    const reroute = [], polish = [];
    for (const e of view.edges) {
      if (!e.points) { reroute.push(e); continue; }
      const a = byId.get(e.from), b = byId.get(e.to), boxes = barriers(a.group, b.group);
      if ((!e.custom && conflicts.has(e)) || boxes.some(box => pathCrossesBody(e.points, box)) ||
          view.nodes.some(n => pathCrossesBody(e.points, n))) { reroute.push(e); continue; }
      if (e.custom || e.from === e.to || e.points.length < 3) continue;
      const direct = straightConnection(e, a, b);
      if (direct && !pathBlockedByNodes(direct.points, view.nodes, new Set([a.id, b.id])) &&
          !boxes.some(box => pathCrossesBody(direct.points, box)) &&
          !saved.some(other => other !== e && incompatibleOverlap({ ...e, points: direct.points }, other))) {
        e.points = direct.points;
      } else if (!e.fromSide && !e.toSide && shortPortDeficit(e.points)) {
        const faces = nearFacing(a, b);
        if (faces && [portAt(a, faces[0]), portAt(b, faces[1])].some((port, i) => {
          const end = i ? e.points.at(-1) : e.points[0];
          return port[0] !== end[0] || port[1] !== end[1];
        })) polish.push(e);
      }
    }
    if (reroute.length) {
      const moving = new Set(reroute);
      routeEdges(view.nodes, reroute, { existing: collectSegments(saved.filter(e => !moving.has(e))),
        layoutDirection: direction, groupDirections });
    }
    const changed = [...reroute, ...polish];
    improveEdgeRoutes(view, changed, () => false);
    finishRoutes(view, changed);
    for (const e of changed) for (const [x, y] of e.points) {
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
    const result = converted(await layoutGraph(graph), sized, edges);
    if (!group) for (const n of result.nodes) delete n.group;
    return { ...result, layoutDirection: dir };
  };
  const medium = group && (sized.length > 120 || edges.length > 240) && sized.length <= 400 && edges.length <= 900;
  if (!previous && medium) {
    const serial = edges.length === sized.length - 1 && new Set(edges.map(e => e.from)).size === edges.length &&
      new Set(edges.map(e => e.to)).size === edges.length && !sized.some(n => n.kind === 'var');
    const cache = new Map();
    const configs = serial ? [
      { rootDir: 'RIGHT', dirDir: 'DOWN', fileDir: 'RIGHT', packMain: true },
      { rootDir: 'RIGHT', dirDir: 'DOWN', fileDir: 'RIGHT' },
    ] : [
      { rootDir: 'RIGHT', dirDir: 'DOWN', fileDir: 'RIGHT' },
      { rootDir: 'RIGHT', dirDir: 'DOWN', fileDir: 'AUTO', packMain: true },
      { rootDir: 'RIGHT', dirDir: 'DOWN', fileDir: 'AUTO' },
      { rootDir: 'DOWN', dirDir: 'RIGHT', fileDir: 'AUTO' },
    ];
    // 大图先比较未布线的矩形和端点。只对通过顺序检查的优先候选做整图路由。
    const candidates = [];
    for (const cfg of configs) {
      const candidate = await bottomUpCandidate(sized, edges, { ...cfg, cache, deferRouting: true });
      if (!candidate) continue;
      if (serial) {
        if (validLayout(routeCandidate(candidate))) return withRoot(candidate, rootLabel);
      } else if (!candidates.length || preservesSemanticOrder(candidates[0].view, candidate, edges)) {
        candidates.push({ view: candidate, score: quality(candidate, false) });
      }
    }
    for (const { view } of candidates.sort((a, b) => a.score - b.score)) {
      if (validLayout(routeCandidate(view))) return withRoot(view, rootLabel);
    }
  }
  let view = await generate(direction);
  if (!previous) {
    // 全部候选统一在整理干线后校验和评分，避免纵向/分层候选因未合并干线而被过早淘汰。
    const baseline = finalizeCandidate(view);
    view = baseline;
    let score = validLayout(baseline) ? quality(baseline) : Infinity;
    const consider = candidate => {
      if (!candidate || !validLayout(candidate)) return;
      if (!preservesSemanticOrder(baseline, candidate, edges)) return;
      const next = quality(candidate);
      if (next < score) {
        view = candidate;
        score = next;
      }
    };
    const downTask = generate('DOWN').then(finalizeCandidate);
    const cache = new Map();
    const buConfigs = edges.length ? [
      { rootDir: 'RIGHT', dirDir: 'DOWN' }, { rootDir: 'DOWN', dirDir: 'RIGHT' },
      { rootDir: 'RIGHT', dirDir: 'DOWN', packMain: true },
      { rootDir: 'RIGHT', dirDir: 'DOWN', fileDir: 'RIGHT' },
    ] : [{ rootDir: 'DOWN', dirDir: 'RIGHT' }];
    const buTasks = group && sized.length <= 120 && edges.length <= 240
      ? buConfigs.map(cfg => bottomUpCandidate(sized, edges, { fileDir: 'AUTO', ...cfg, cache }))
      : [];
    const [downView, ...buViews] = await Promise.all([downTask, ...buTasks]);
    consider(downView);
    for (const cand of buViews) consider(cand);
    if (!Number.isFinite(score)) {
      // ELK 极窄通道偶尔压住节点。保留几何候选，用避障网格重建全部边再校验。
      for (const candidate of [baseline, downView, ...buViews]) {
        if (!candidate) continue;
        candidate.edges = edges;
        const repaired = routeCandidate(candidate);
        if (validLayout(repaired)) { view = repaired; break; }
      }
      if (!validLayout(view)) throw new Error('无法为当前节点生成有效的正交布局');
    }
    // 最后仅对获选画面的真实交点做局部换面，无需在每个候选中重复搜索。
    improveEdgeRoutes(view, view.edges, () => true, true);
  } else {
    mergeSharedRoutes(view);
  }
  if (!group) for (const n of view.nodes) delete n.group;
  return withRoot(view, group && rootLabel);
}
