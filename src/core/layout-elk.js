// 应用和评估共用 ELK 的层级分组与四中点端口转换。
import { createRequire } from 'node:module';
import { textWidth } from './layout.js';
const require = createRequire(import.meta.url);
const ELK = require('elkjs/lib/elk.bundled.js');
const elk = new ELK();
const styleKey = (e) => `${e.kind === 'var' || e.kind?.startsWith('df-') ? e.kind : 'direct'}|${e.change || 'existing'}`;

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
  return view.edges.map((e) => [sideOf(nodes.get(e.from), e.points[0]), sideOf(nodes.get(e.to), e.points.at(-1))]);
}

export async function layoutElk(nodes, edges, { group = true, rootLabel = '' } = {}) {
  const ids = new Set(nodes.map((n) => n.id));
  edges = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const sized = nodes.map((n) => ({ ...n,
    w: n.w || Math.min(190, Math.max(120, textWidth(n.label || n.name || n.id) + 28 + (n.kind === 'var' ? 0 : 16))),
    h: n.h || (n.sub ? 58 : 44),
  }));
  const first = converted(await elk.layout(graphOf(sized, edges, 'RIGHT', null, false, group)), sized, edges);
  const result = await elk.layout(graphOf(sized, edges, 'RIGHT', facesOf(first), true, group));
  const view = converted(result, sized, edges);
  if (!group) for (const n of view.nodes) delete n.group;
  if (group && rootLabel) {
    for (const box of [...view.containers, ...view.groups]) box.depth++;
    view.containers.unshift({ id: '', label: rootLabel, root: true, depth: 1, x: 0, y: 0, w: view.width, h: view.height });
  }
  return view;
}
