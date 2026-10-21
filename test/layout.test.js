import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutGrouped } from '../src/core/layout.js';

// layoutGrouped 会直接改写传入 edges 的 points，因此每次都用全新 fixture
function fixture() {
  const nodes = [
    { id: 'a1', label: 'a1', file: 'src/core/a.c' },
    { id: 'a2', label: 'a2', file: 'src/core/a.c' },
    { id: 'b1', label: 'b1', file: 'src/core/b.c' },
    { id: 'b2', label: 'b2', file: 'src/core/b.c' },
    { id: 'c1', label: 'c1', file: 'src/drivers/hal/c.c' },
    { id: 'c2', label: 'c2', file: 'src/drivers/hal/c.c' },
  ];
  // 组内边 + 跨文件边 + 一条回边，确保跨组布线也被触发
  const edges = [
    { from: 'a1', to: 'a2', kind: 'direct' },
    { from: 'a2', to: 'b1', kind: 'direct' },
    { from: 'b1', to: 'b2', kind: 'direct' },
    { from: 'b2', to: 'c1', kind: 'direct' },
    { from: 'c1', to: 'c2', kind: 'direct' },
    { from: 'c2', to: 'a1', kind: 'direct' },
  ];
  return { nodes, edges };
}

const TOL = 0.5;

function overlap(a, b) {
  return (
    a.x < b.x + b.w - TOL &&
    b.x < a.x + a.w - TOL &&
    a.y < b.y + b.h - TOL &&
    b.y < a.y + a.h - TOL
  );
}

function contains(outer, inner) {
  return (
    inner.x >= outer.x - TOL &&
    inner.y >= outer.y - TOL &&
    inner.x + inner.w <= outer.x + outer.w + TOL &&
    inner.y + inner.h <= outer.y + outer.h + TOL
  );
}

const isAncestor = (parent, child) =>
  parent.root ? child.id !== '' : child.id.startsWith(parent.id + '/');

// 直接子级 = id 前缀匹配且剩余部分不再含 '/'；根容器的子级是顶层目录/文件框
function directChildren(parent, boxes) {
  const prefix = parent.root ? '' : parent.id + '/';
  return boxes.filter((b) => {
    if (b === parent || b.root) return false;
    if (!b.id.startsWith(prefix)) return false;
    const rest = b.id.slice(prefix.length);
    return rest.length > 0 && !rest.includes('/');
  });
}

test('layoutGrouped：节点落在所属文件框内，文件框两两不相交', () => {
  const { nodes, edges } = fixture();
  const res = layoutGrouped(nodes, edges);

  assert.equal(res.groups.length, 3, '三个文件应各得到一个文件框');
  assert.deepEqual(
    res.groups.map((g) => g.id).sort(),
    ['src/core/a.c', 'src/core/b.c', 'src/drivers/hal/c.c']
  );

  const groupById = new Map(res.groups.map((g) => [g.id, g]));
  assert.equal(res.nodes.length, 6);
  for (const node of res.nodes) {
    const g = groupById.get(node.group);
    assert.ok(g, `节点 ${node.id} 的 group 字段应指向一个已返回的文件框，实际为 ${node.group}`);
    assert.ok(node.x >= g.x - TOL, `${node.id} 左边越出 ${g.id}`);
    assert.ok(node.y >= g.y - TOL, `${node.id} 上边越出 ${g.id}`);
    assert.ok(node.x + node.w <= g.x + g.w + TOL, `${node.id} 右边越出 ${g.id}`);
    assert.ok(node.y + node.h <= g.y + g.h + TOL, `${node.id} 下边越出 ${g.id}`);
  }

  for (let i = 0; i < res.groups.length; i++) {
    for (let j = i + 1; j < res.groups.length; j++) {
      const a = res.groups[i];
      const b = res.groups[j];
      assert.ok(!overlap(a, b), `文件框 ${a.id} 与 ${b.id} 相交`);
    }
  }

  for (const e of res.edges) {
    assert.ok(e.points && e.points.length >= 2, `边 ${e.from}->${e.to} 的折线不应为空`);
  }
});

test('layoutGrouped：容器嵌套 —— 兄弟容器不相交，父容器包住直接子级', () => {
  const { nodes, edges } = fixture();
  const res = layoutGrouped(nodes, edges);

  assert.ok(res.containers.length >= 3, 'src / src/core / src/drivers / src/drivers/hal 应各自成容器');
  const byId = new Map(res.containers.map((c) => [c.id, c]));
  for (const id of ['src', 'src/core', 'src/drivers', 'src/drivers/hal']) {
    assert.ok(byId.has(id), `缺少目录容器 ${id}`);
  }

  // 互为祖先的两个容器天然重叠（父包住子），只对「无祖先关系」的容器断言不相交
  for (let i = 0; i < res.containers.length; i++) {
    for (let j = i + 1; j < res.containers.length; j++) {
      const a = res.containers[i];
      const b = res.containers[j];
      if (isAncestor(a, b) || isAncestor(b, a)) continue;
      assert.ok(!overlap(a, b), `目录容器 ${a.id} 与 ${b.id} 相交`);
    }
  }

  const allBoxes = [...res.groups, ...res.containers];
  for (const c of res.containers) {
    const kids = directChildren(c, allBoxes);
    assert.ok(kids.length > 0, `容器 ${c.id} 应有直接子级`);
    for (const k of kids) {
      assert.ok(contains(c, k), `容器 ${c.id} 没有包住直接子级 ${k.id}`);
    }
  }

  assert.ok(Number.isFinite(res.width) && res.width > 0, `width 应为正有限值，实际 ${res.width}`);
  assert.ok(Number.isFinite(res.height) && res.height > 0, `height 应为正有限值，实际 ${res.height}`);
});

test('layoutGrouped：给 rootLabel 时根容器包住全部内容且只出现一次', () => {
  const { nodes, edges } = fixture();
  const res = layoutGrouped(nodes, edges, { rootLabel: 'src' });

  const roots = res.containers.filter((c) => c.root);
  assert.equal(roots.length, 1, 'rootLabel 生效时应有且仅有一个根容器');
  const root = roots[0];
  assert.equal(root.label, 'src');
  assert.equal(root.id, '');

  for (const box of [...res.groups, ...res.containers.filter((c) => !c.root)]) {
    assert.ok(contains(root, box), `根容器没有包住 ${box.id}`);
  }
  for (const node of res.nodes) {
    assert.ok(contains(root, node), `根容器没有包住节点 ${node.id}`);
  }

  // 根容器引入的整体平移不应把内容推到负坐标
  for (const box of [...res.groups, ...res.containers]) {
    assert.ok(box.x >= 0 && box.y >= 0, `${box.id} 落到负坐标 (${box.x},${box.y})`);
  }
  assert.ok(res.offset && Number.isFinite(res.offset.dx) && Number.isFinite(res.offset.dy));
  assert.ok(res.width > root.x + root.w - 1, 'width 应覆盖根容器');
  assert.ok(res.height > root.y + root.h - 1, 'height 应覆盖根容器');
});
