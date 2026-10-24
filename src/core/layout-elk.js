// 应用和评估共用 ELK 的层级分组与四中点端口转换。
import { createRequire } from 'node:module';
import { textWidth } from './layout-metrics.js';
import { routeEdges, collectSegments } from './routing.js';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const elk = new ELK();
const styleKey = (e) => `${e.kind === 'var' || e.kind?.startsWith('df-') ? e.kind : 'direct'}|${e.change || 'existing'}`;
const edgeKey = (e) => `${e.from}->${e.to}:${e.line}|${e.kind}|${e.change || 'existing'}`;

export function graphOf(nodes, edges, direction, faces, separateStyles = false, group = true) {
  const root = { id: 'root', children: [], layoutOptions: {
    'elk.algorithm': 'layered', 'elk.direction': direction, 'elk.edgeRouting': 'ORTHOGONAL',
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN', 'elk.json.edgeCoords': 'ROOT',
    'elk.padding': '[top=40,left=40,bottom=40,right=40]', 'elk.aspectRatio': '1',
    'elk.spacing.nodeNode': '26', 'elk.layered.spacing.nodeNodeBetweenLayers': '52',
    'elk.layered.mergeEdges': 'false', 'elk.layered.mergeHierarchyEdges': 'false',
    'elk.randomSeed': '1',
  } };
  const boxes = new Map([['', root]]);
  for (const n of nodes) {
    const parts = group ? (n.file || 'unknown').split('/') : [];
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const key = parts.slice(0, i + 1).join('/');
      if (!boxes.has(key)) {
        const box = { id: 'box:' + key, label: parts[i], fileGroup: i === parts.length - 1,
          children: [], layoutOptions: { 'elk.padding': '[top=40,left=14,bottom=14,right=14]' } };
        parent.children.push(box);
        boxes.set(key, box);
      }
      parent = boxes.get(key);
    }
    const node = { id: n.id, width: n.w, height: n.h };
    if (faces) {
      node.layoutOptions = { 'elk.portConstraints': 'FIXED_POS' };
      // 按样式区分逻辑端口，坐标仍严格只有四个中点；防止引擎把不同样式当作同一超边。
      const styles = separateStyles ? [...new Set(edges.filter((e) => e.from === n.id || e.to === n.id).map(styleKey))] : [''];
      node.ports = styles.flatMap((style) => [['NORTH', n.w / 2, 0], ['SOUTH', n.w / 2, n.h], ['WEST', 0, n.h / 2], ['EAST', n.w, n.h / 2]]
        .map(([side, x, y]) => ({ id: n.id + ':' + side + ':' + style, x, y, width: 0, height: 0, layoutOptions: { 'elk.port.side': side } })));
    }
    parent.children.push(node);
  }
  root.edges = edges.map((e, i) => ({ id: 'e' + i,
    sources: [faces ? e.from + ':' + faces[i][0] + ':' + (separateStyles ? styleKey(e) : '') : e.from],
    targets: [faces ? e.to + ':' + faces[i][1] + ':' + (separateStyles ? styleKey(e) : '') : e.to] }));
  return root;
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
  view.edges = result.edges.map((e, i) => {
    if (e.sections?.length !== 1) throw new Error(`连线 ${e.id} 不是单段路径，需单独检查，不能拼接伪造折线`);
    const s = e.sections[0];
    return { ...edges[i], points: [s.startPoint, ...(s.bendPoints || []), s.endPoint].map((p) => [p.x, p.y]) };
  });
  return view;
}

export function facesOf(view) {
  const nodes = new Map(view.nodes.map((n) => [n.id, n]));
  const sideOf = (n, p) => [['NORTH', Math.abs(p[1] - n.y)], ['SOUTH', Math.abs(p[1] - n.y - n.h)],
    ['WEST', Math.abs(p[0] - n.x)], ['EAST', Math.abs(p[0] - n.x - n.w)]].sort((a, b) => a[1] - b[1])[0][0];
  return view.edges.map((e) => e.from === e.to ? ['EAST', 'SOUTH'] :
    [sideOf(nodes.get(e.from), e.points[0]), sideOf(nodes.get(e.to), e.points.at(-1))]);
}

/** 用当前画面的相对位置驱动 ELK 的交互式分层，不读取固定坐标存档。 */
function seedInteractive(graph, previous, initial) {
  const positions = (view) => new Map([
    ...view.nodes, ...(view.groups || []).map((n) => ({ ...n, id: 'box:' + n.id })),
    ...(view.containers || []).map((n) => ({ ...n, id: 'box:' + n.id })),
  ].map((n) => [n.id, n]));
  const old = positions(previous), fresh = positions(initial);
  const anchors = new Map(previous.nodes.map((n) => [n.id, n]));
  const bottoms = new Map((previous.groups || []).map((g) => [g.id, g.y + g.h + 26]));
  // 新节点优先延续同文件邻居的层次，放在已有内容下方，避免挤入旧顺序中间。
  for (const n of initial.nodes) {
    if (anchors.has(n.id)) continue;
    const box = old.get('box:' + n.file);
    if (!box) continue;
    const edge = initial.edges.find((e) => {
      const peer = anchors.get(e.from === n.id ? e.to : e.to === n.id ? e.from : null);
      return peer?.file === n.file;
    });
    const peer = edge && anchors.get(edge.from === n.id ? edge.to : edge.from);
    const x = peer ? edge.from === n.id ? peer.x - n.w - 52 : peer.x + peer.w + 52 : box.x + 14;
    const p = { ...n, x, y: bottoms.get(n.file) };
    fresh.set(n.id, p);
    anchors.set(n.id, p);
    bottoms.set(n.file, p.y + n.h + 26);
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
      n.x = p.x - ox;
      n.y = p.y - oy;
      (n.layoutOptions ||= {})['elk.position'] = `(${n.x},${n.y})`;
      if (n.children) walk(n, p.x, p.y);
    }
  };
  walk(graph);
}

export async function layoutElk(nodes, edges, { group = true, rootLabel = '', previous = null } = {}) {
  const ids = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const sized = nodes.map((n) => ({ ...n,
    w: n.w || Math.min(190, Math.max(120, textWidth(n.label || n.name || n.id) + 28 + (n.kind === 'var' ? 0 : 16))),
    h: n.h || (n.sub ? 58 : 44),
  }));
  const oldNodes = new Map((previous?.nodes || []).map((n) => [n.id, n]));
  const oldEdges = new Map((previous?.edges || []).map((e) => [edgeKey(e), e]));
  // 没有新增节点时不移动已有内容；新增关系只补连线，删除则留下原来的空位。
  if (previous && sized.every((n) => {
    const old = oldNodes.get(n.id);
    return old && old.file === n.file && old.w === n.w && old.h === n.h;
  })) {
    const files = new Set(sized.map((n) => n.file || 'unknown'));
    const view = { width: previous.width, height: previous.height,
      nodes: sized.map((n) => ({ ...n, x: oldNodes.get(n.id).x, y: oldNodes.get(n.id).y,
        ...(group ? { group: n.file || 'unknown' } : {}) })),
      edges: edges.map((e) => ({ ...e, points: oldEdges.get(edgeKey(e))?.points.map((p) => [...p]) })),
      groups: group ? (previous.groups || []).filter((g) => files.has(g.id)).map((g) => ({ ...g })) : [],
      containers: group ? (previous.containers || []).filter((c) => c.root ||
        [...files].some((file) => file.startsWith(c.id + '/'))).map((c) => ({ ...c })) : [],
    };
    const addedEdges = view.edges.filter((e) => !e.points);
    if (addedEdges.length) routeEdges(view.nodes, addedEdges, {
      existing: collectSegments(view.edges.filter((e) => e.points)),
    });
    for (const e of addedEdges) for (const [x, y] of e.points) {
      view.width = Math.max(view.width, x + 40);
      view.height = Math.max(view.height, y + 40);
    }
    for (const c of view.containers) if (c.root) {
      c.w = Math.max(c.w, view.width);
      c.h = Math.max(c.h, view.height);
    }
    return view;
  }
  const first = converted(await elk.layout(graphOf(sized, edges, 'RIGHT', null, false, group)), sized, edges);
  const faces = facesOf(first);
  if (previous) {
    const priorFaces = facesOf(previous);
    const oldFaces = new Map(previous.edges.map((e, i) => [edgeKey(e), priorFaces[i]]));
    edges.forEach((e, i) => { if (oldFaces.has(edgeKey(e))) faces[i] = oldFaces.get(edgeKey(e)); });
  }
  const graph = graphOf(sized, edges, 'RIGHT', faces, true, group);
  if (previous && sized.some((n) => oldNodes.has(n.id))) seedInteractive(graph, previous, first);
  const result = await elk.layout(graph);
  const view = converted(result, sized, edges);
  if (!group) for (const n of view.nodes) delete n.group;
  if (group && rootLabel) {
    for (const box of [...view.containers, ...view.groups]) box.depth++;
    view.containers.unshift({ id: '', label: rootLabel, root: true, depth: 1, x: 0, y: 0, w: view.width, h: view.height });
  }
  return view;
}
