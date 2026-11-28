import assert from 'node:assert/strict';
import { loadModel, subgraph } from '../src/core/index.js';
import { layoutGrouped, textWidth } from '../src/core/layout.js';

const rootLabel = 'workspace_root_with_a_deliberately_long_project_title_for_layout_checks';
const longDir = 'directory_name_that_is_much_longer_than_its_child_function_nodes';
const longFile = 'source_file_name_that_is_much_longer_than_its_child_function_nodes.c';

const nodes = [
  { id: 'main', name: 'main', file: 'app/main.c' },
  { id: 'task10', name: 'Task_10ms', file: 'app/main.c' },
  { id: 'shift', name: 'Task_Shift', file: 'app/main.c' },
  { id: 'can-rpm', name: 'Can_GetRpm', file: `db/${longDir}/${longFile}` },
  { id: 'can-status', name: 'Can_SendGearStatus', file: `db/${longDir}/${longFile}` },
  { id: 'gear-apply', name: 'Gear_Apply', file: 'db/gear/gear.c' },
  { id: 'gear-check', name: 'Gear_CheckSpeed', file: 'db/gear/gear.c' },
  {
    id: 'fallback',
    name: 'Fallback_Function_With_An_Extremely_Long_Name_That_Must_Not_Be_Truncated',
    file: 'support/fallback.c',
  },
];

const edges = [
  ['main', 'task10'],
  ['task10', 'shift'],
  ['shift', 'can-rpm'],
  ['shift', 'can-status'],
  ['shift', 'gear-apply'],
  ['shift', 'gear-check'],
  ['gear-apply', 'fallback'],
  ['fallback', 'can-status'],
].map(([from, to], i) => ({ from, to, kind: 'direct', line: i + 1 }));

const laid = layoutGrouped(nodes, edges, { rootLabel });
const groups = laid.groups || [];
const containers = laid.containers || [];
const allBoxes = [...groups, ...containers];
const root = containers.find((box) => box.root);

assert(root, 'root directory must have a visible container');

for (const group of groups) {
  assert(
    group.w >= textWidth(group.label) + 24,
    `file title does not fit: ${group.label} (${group.w} < ${textWidth(group.label) + 24})`
  );
}

for (const container of containers) {
  const required = textWidth(container.label) + (container.root ? 44 : 28);
  assert(
    container.w >= required,
    `directory title does not fit: ${container.label} (${container.w} < ${required})`
  );
}

for (const node of laid.nodes) {
  const required = textWidth(`${node.name || node.id}()`) + 18;
  assert(node.w >= required, `function title does not fit: ${node.id}`);
}

const contains = (a, b) =>
  b.x >= a.x - 0.5 &&
  b.y >= a.y - 0.5 &&
  b.x + b.w <= a.x + a.w + 0.5 &&
  b.y + b.h <= a.y + a.h + 0.5;

const ancestor = (a, b) =>
  a.root || (!b.root && b.id !== a.id && b.id.startsWith(`${a.id}/`));

const separated = (a, b, gap = 12) =>
  a.x + a.w + gap <= b.x ||
  b.x + b.w + gap <= a.x ||
  a.y + a.h + gap <= b.y ||
  b.y + b.h + gap <= a.y;

function verifyHierarchy(boxes, context) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (ancestor(a, b)) assert(contains(a, b), `${context}: ${a.id} must contain ${b.id}`);
      else if (ancestor(b, a)) assert(contains(b, a), `${context}: ${b.id} must contain ${a.id}`);
      else assert(separated(a, b), `${context}: sibling levels ${a.id} and ${b.id} need 12px clearance`);
    }
  }
}

verifyHierarchy(allBoxes, 'synthetic');

const overlap = (a, b) =>
  a.x < b.x + b.w - 0.5 &&
  b.x < a.x + a.w - 0.5 &&
  a.y < b.y + b.h - 0.5 &&
  b.y < a.y + a.h - 0.5;

for (let i = 0; i < laid.nodes.length; i++) {
  for (let j = i + 1; j < laid.nodes.length; j++) {
    assert(!overlap(laid.nodes[i], laid.nodes[j]), `${laid.nodes[i].id} overlaps ${laid.nodes[j].id}`);
  }
}

for (const edge of laid.edges) {
  assert(edge.points?.length >= 2, `edge ${edge.from}->${edge.to} has no routed points`);
  for (let i = 0; i < edge.points.length - 1; i++) {
    const dx = Math.abs(edge.points[i + 1][0] - edge.points[i][0]);
    const dy = Math.abs(edge.points[i + 1][1] - edge.points[i][1]);
    assert(dx < 0.5 || dy < 0.5, `edge ${edge.from}->${edge.to} is not orthogonal`);
  }
}

function verifyEdgesAvoidNodeBodies(nodes, edges, context) {
  for (const edge of edges) {
    const points = edge.points || [];
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      for (const node of nodes) {
        if (node.id === edge.from || node.id === edge.to) continue;
        const crosses = Math.abs(y1 - y2) < 0.5
          ? y1 > node.y + 0.5 && y1 < node.y + node.h - 0.5 && Math.max(x1, x2) > node.x + 0.5 && Math.min(x1, x2) < node.x + node.w - 0.5
          : Math.abs(x1 - x2) < 0.5 && x1 > node.x + 0.5 && x1 < node.x + node.w - 0.5 && Math.max(y1, y2) > node.y + 0.5 && Math.min(y1, y2) < node.y + node.h - 0.5;
        assert(!crosses, `${context}: edge ${edge.from}->${edge.to} passes through ${node.id}`);
      }
    }
  }
}
verifyEdgesAvoidNodeBodies(laid.nodes, laid.edges, 'synthetic');

// The full samples tree has sibling branches at different depths. The old
// container padding pass expanded these frames after their parent packed them.
const model = loadModel('samples');
const graph = subgraph(model, 'tcu/gear.c::Gear_CheckSpeed', { up: 0, down: 1, maxNodes: 600 });
const sampleLayout = layoutGrouped(
  graph.nodes.map(({ bodyTokens, ...node }) => node),
  graph.edges,
  { rootLabel: 'samples' }
);
const sampleBoxes = [...sampleLayout.groups, ...sampleLayout.containers];
verifyHierarchy(sampleBoxes, 'sample regression');
verifyEdgesAvoidNodeBodies(sampleLayout.nodes, sampleLayout.edges, 'sample regression');

// 检查所有样例入口和深度。既验证同层间距，也验证目录每一级确实包住完整后代。
let checkedViews = 0;
for (const fn of model.functions) {
  for (const down of [1, 2, 3, 4]) {
    const view = subgraph(model, fn.id, { up: 0, down, maxNodes: 600 });
    if (!view.nodes.length) continue;
    const result = layoutGrouped(
      view.nodes.map(({ bodyTokens, ...node }) => node),
      view.edges,
      { rootLabel: 'samples' }
    );
    const boxes = [...result.groups, ...result.containers];
    verifyHierarchy(boxes, `${fn.id} down=${down}`);
    const groupById = new Map(result.groups.map((group) => [group.id, group]));
    for (const node of result.nodes) {
      const group = groupById.get(node.group);
      assert(group && contains(group, node), `${fn.id}: ${node.id} must stay inside ${node.group}`);
    }
    for (const group of result.groups) {
      assert(group.w >= textWidth(group.label) + 24, `${fn.id}: file title overflows ${group.label}`);
    }
    for (const container of result.containers) {
      const required = textWidth(container.label) + (container.root ? 44 : 28);
      assert(container.w >= required, `${fn.id}: directory title overflows ${container.label}`);
    }
    checkedViews++;
  }
}

const largeNodes = [];
for (let file = 0; file < 6; file++) {
  for (let fn = 0; fn < 2; fn++) {
    largeNodes.push({
      id: `branch${file}-fn${fn}`,
      name: `Function_${file}_${fn}`,
      file: `branch${file}/file${file}.c`,
    });
  }
}
const edgeSet = (from, to, count, startLine = 0) =>
  Array.from({ length: count }, (_, i) => ({ from, to, line: startLine + i + 1, kind: 'direct' }));
const biasFirstPair = layoutGrouped(
  largeNodes,
  [...edgeSet('branch0-fn0', 'branch5-fn0', 161), ...edgeSet('branch1-fn0', 'branch4-fn0', 1, 1000)],
  { rootLabel: 'large_root' }
);
const biasSecondPair = layoutGrouped(
  largeNodes,
  [...edgeSet('branch0-fn0', 'branch5-fn0', 1), ...edgeSet('branch1-fn0', 'branch4-fn0', 161, 1000)],
  { rootLabel: 'large_root' }
);
const positions = (layout) => layout.groups.map(({ id, x, y }) => `${id}:${x},${y}`).sort().join('|');
assert(
  positions(biasFirstPair) !== positions(biasSecondPair),
  'large-graph connection weights must influence file placement'
);
const pairDistance = (layout, a, b) => {
  const boxes = new Map(layout.groups.map((group) => [group.id, group]));
  const left = boxes.get(`branch${a}/file${a}.c`);
  const right = boxes.get(`branch${b}/file${b}.c`);
  return Math.abs(left.x + left.w / 2 - right.x - right.w / 2) + Math.abs(left.y + left.h / 2 - right.y - right.h / 2);
};
assert(
  pairDistance(biasFirstPair, 0, 5) < pairDistance(biasFirstPair, 1, 4) &&
    pairDistance(biasSecondPair, 1, 4) < pairDistance(biasSecondPair, 0, 5),
  'the more frequent cross-file pair should receive the closer placement'
);

console.log(
  `PASS: ${laid.nodes.length} synthetic nodes, ${checkedViews} sample views, ${sampleLayout.groups.length} sample files, ${sampleLayout.containers.length} sample containers`
);
