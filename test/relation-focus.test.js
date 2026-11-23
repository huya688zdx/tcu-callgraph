import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALLER_COLOR,
  CALLEE_COLOR,
  BIDIR_COLOR,
  mixHex,
  roleColor,
  classifySelectionRelations,
} from '../web/lib/relation-focus.js';

test('mixHex 按比例线性混色并在非法颜色时安全回退', () => {
  assert.equal(mixHex('#F7F6F2', '#2C2C2A', 0), '#f7f6f2');
  assert.equal(mixHex('#F7F6F2', '#2C2C2A', 1), '#2c2c2a');
  assert.equal(mixHex('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(mixHex('bad', '#2C2C2A', 0.5), '#2C2C2A');
  assert.equal(roleColor('in'), CALLER_COLOR);
  assert.equal(roleColor('out'), CALLEE_COLOR);
  assert.equal(roleColor('both'), BIDIR_COLOR);
});

test('classifySelectionRelations 区分调用者、被调用者、互调、自递归与数据流方向', () => {
  const nodes = [
    { id: 'caller', group: 'app/a.c' },
    { id: 'sel', group: 'bsw/core/s.c' },
    { id: 'callee', group: 'bsw/d.c' },
    { id: 'mutual', group: 'bsw/core/m.c' },
    { id: 'var_rw', group: 'bsw/state.c' },
    { id: 'var_r', group: 'bsw/state.c' },
    { id: 'var_df', group: 'bsw/state.c' },
    { id: 'var_unk', group: 'bsw/state.c' },
    { id: 'other', group: 'hal/unused.c' },
  ];
  const edges = [
    { from: 'caller', to: 'sel', kind: 'direct', line: 1 },
    { from: 'sel', to: 'callee', kind: 'direct', line: 2 },
    { from: 'sel', to: 'mutual', kind: 'direct', line: 3 },
    { from: 'mutual', to: 'sel', kind: 'direct', line: 4 },
    { from: 'sel', to: 'sel', kind: 'direct', line: 5 },
    { from: 'sel', to: 'var_r', kind: 'var', via: '读', line: 6 },
    { from: 'sel', to: 'var_rw', kind: 'var', via: '读写', line: 7 },
    { from: 'var_df', to: 'sel', kind: 'df-read', line: 8 },
    { from: 'sel', to: 'var_unk', kind: 'var', line: 9 },
    { from: 'caller', to: 'other', kind: 'direct', line: 10 },
  ];
  const res = classifySelectionRelations({ nodes, edges }, 'sel');
  assert.equal(res.edgeRoles.get(edges[0]), 'in');
  assert.equal(res.edgeRoles.get(edges[1]), 'out');
  assert.equal(res.edgeRoles.get(edges[2]), 'out');
  assert.equal(res.edgeRoles.get(edges[3]), 'in');
  assert.equal(res.edgeRoles.get(edges[4]), 'out');
  assert.equal(res.edgeRoles.get(edges[5]), 'in');
  assert.equal(res.edgeRoles.get(edges[6]), 'both');
  assert.equal(res.edgeRoles.get(edges[7]), 'in');
  assert.equal(res.edgeRoles.get(edges[8]), 'neutral');
  assert.equal(res.edgeRoles.has(edges[9]), false);

  assert.equal(res.nodeRoles.get('caller'), 'in');
  assert.equal(res.nodeRoles.get('callee'), 'out');
  assert.equal(res.nodeRoles.get('mutual'), 'both');
  assert.equal(res.nodeRoles.get('var_r'), 'in');
  assert.equal(res.nodeRoles.get('var_rw'), 'both');
  assert.equal(res.nodeRoles.get('var_df'), 'in');
  assert.equal(res.nodeRoles.get('var_unk'), 'neutral');
  assert.equal(res.nodeRoles.has('other'), false);

  assert.ok(res.activeBoxes.has('app/a.c'));
  assert.ok(res.activeBoxes.has('app'));
  assert.ok(res.activeBoxes.has('bsw/core/s.c'));
  assert.ok(res.activeBoxes.has('bsw/core'));
  assert.ok(res.activeBoxes.has('bsw'));
  assert.equal(res.activeBoxes.has('hal/unused.c'), false);
  assert.equal(res.activeBoxes.has('hal'), false);

  // 选中 df-read 的源变量节点时，应正确识别为向外读取流（out）
  const varRes = classifySelectionRelations({ nodes, edges }, 'var_df');
  assert.equal(varRes.edgeRoles.get(edges[7]), 'out');
  assert.equal(varRes.nodeRoles.get('sel'), 'out');

  const varReadRes = classifySelectionRelations({ nodes, edges }, 'var_r');
  assert.equal(varReadRes.edgeRoles.get(edges[5]), 'out');
  assert.equal(varReadRes.nodeRoles.get('sel'), 'out');
});
