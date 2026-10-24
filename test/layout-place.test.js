import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPartitioned, layoutGrouped } from '../src/core/layout.js';

// forceR：固定列内单元数时只排这一种结构，返回值带 R 与列数
test('layoutPartitioned 支持 forceR 固定列结构', () => {
  const items = [
    { id: 'a', name: 'a', w: 200, h: 100 },
    { id: 'b', name: 'b', w: 200, h: 100 },
    { id: 'c', name: 'c', w: 200, h: 100 },
    { id: 'd', name: 'd', w: 200, h: 100 },
  ];
  const edges = [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
  ];
  const laid = layoutPartitioned(items, edges, { forceR: items.length });
  assert.equal(laid.R, items.length, 'forceR=单元数 应单列');
  assert.equal(laid.columns, 1, '单列时列数为 1');
  const pos = [...laid.pos.values()];
  const sameX = new Set(pos.map((p) => p.x)).size === 1;
  assert.ok(sameX, '单列时所有单元同一起始 x');
});

// 度量驱动微调冒烟：两文件互调可降交叉的 fixture，layoutGrouped 正常产出且框不重叠
test('layoutGrouped 文件框排布微调正常产出', () => {
  const nodes = [
    { id: 'f1', label: 'f1', file: 'app/main.c' },
    { id: 'g1', label: 'g1', file: 'lib/util.c' },
    { id: 'g2', label: 'g2', file: 'lib/util.c' },
  ];
  const edges = [
    { from: 'f1', to: 'g1', kind: 'direct' },
    { from: 'f1', to: 'g2', kind: 'direct' },
  ];
  const res = layoutGrouped(nodes, edges, { rootLabel: 'proj' });
  assert.equal(res.groups.length, 2);
  for (let i = 0; i < res.groups.length; i++) {
    for (let j = i + 1; j < res.groups.length; j++) {
      const a = res.groups[i];
      const b = res.groups[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(ox <= 0.5 || oy <= 0.5, `文件框 ${a.id} 与 ${b.id} 不应重叠`);
    }
  }
});
