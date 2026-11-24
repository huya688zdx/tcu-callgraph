import test from 'node:test';
import assert from 'node:assert/strict';
import { beginBoxResize, resizeBox, cancelBoxResize, shrinkBoxToFit } from '../web/lib/hierarchy.js';

function makeSampleView() {
  return {
    width: 900,
    height: 600,
    nodes: [
      { id: 'src/a.c::f1', group: 'src/a.c', x: 60, y: 100, w: 120, h: 40 },
      { id: 'src/b.c::f2', group: 'src/b.c', x: 420, y: 100, w: 120, h: 40 },
    ],
    edges: [],
    groups: [
      { id: 'src/a.c', label: 'a.c', x: 40, y: 60, w: 260, h: 280 },
      { id: 'src/b.c', label: 'b.c', x: 400, y: 60, w: 160, h: 120 },
    ],
    containers: [
      { id: 'src', label: 'src', depth: 1, x: 24, y: 24, w: 620, h: 420 },
      { id: '', label: 'root', depth: 0, root: true, x: 0, y: 0, w: 900, h: 600 },
    ],
  };
}

test('手动拖拽底边和右边可消除目录容器下方的空白，并受子框边界约束', () => {
  const view = makeSampleView();
  const dir = view.containers[0];
  const drag = beginBoxResize(view, { kind: 'dir', box: dir }, 'se');

  // 向下拉回 -200：底部子框最底在 60+280=340，加上 pad=10 → 最小底边 350（h >= 326）
  const moved = resizeBox(drag, -40, -200);
  assert.equal(moved, true);
  assert.equal(dir.y + dir.h, 350, '不能裁掉内部文件框，最小停在子框底边 + 10px');
  assert.equal(dir.x + dir.w, 604, '右边向左收缩 40px');
  assert.equal(drag.changed, true);

  // 取消拖拽应恢复原尺寸
  cancelBoxResize(drag);
  assert.equal(dir.w, 620);
  assert.equal(dir.h, 420);
});

test('手动放大文件框会自动撑开祖先目录容器，且不能与同级文件框重叠', () => {
  const view = makeSampleView();
  const fileA = view.groups[0];
  const dir = view.containers[0];

  // 尝试向右扩大超过 fileB (x=400, overlap gap=12 → 最多到 388)
  const dragE = beginBoxResize(view, { kind: 'file', box: fileA }, 'e');
  resizeBox(dragE, 200, 0);
  assert.ok(fileA.x + fileA.w + 12 <= view.groups[1].x, '不能撞到右侧同级文件框');

  // 向下拉大文件框超出目录容器底部（24+420=444），应自动撑开 dir 与 root
  const dragS = beginBoxResize(view, { kind: 'file', box: fileA }, 's');
  resizeBox(dragS, 0, 220);
  assert.equal(fileA.h, 500);
  assert.ok(dir.y + dir.h >= fileA.y + fileA.h + 10, '祖先目录容器应自动向下扩展');
  assert.ok(view.height >= dir.y + dir.h, '视图高度同步更新');
});

test('shrinkBoxToFit 递归收缩目录及内部文件框，消除多余空白且绝不反向撑大', () => {
  const view = makeSampleView();
  const fileA = view.groups[0];
  const dir = view.containers[0];
  const root = view.containers[1];

  const changed = shrinkBoxToFit(view, { kind: 'dir', box: root });
  assert.equal(changed, true);
  // fileA 只有 f1 (60,100,120,40)，最小边距 8/32 → 收缩后应为 x=52, y=68, w=136, h=80
  assert.equal(fileA.x, 52);
  assert.equal(fileA.y, 68);
  assert.equal(fileA.w, 136);
  assert.equal(fileA.h, 80);
  // dir 高度不再保留下方 200+ 像素空白
  assert.ok(dir.h < 200, `收缩后目录高度应紧凑，实际=${dir.h}`);
  assert.ok(view.height < 350, `收缩后画布总高度应同步收紧，实际=${view.height}`);

  // 再次对已紧凑的框执行收缩，必须返回 false 且绝不反向放大
  const prev = { x: fileA.x, y: fileA.y, w: fileA.w, h: fileA.h };
  assert.equal(shrinkBoxToFit(view, { kind: 'file', box: fileA }), false);
  assert.deepEqual({ x: fileA.x, y: fileA.y, w: fileA.w, h: fileA.h }, prev);
});

test('多层嵌套向左上拉伸保留各层目录标题边距，且已有重叠不可被拉大', () => {
  const view = {
    width: 900,
    height: 600,
    nodes: [{ id: 'a/b/f.c::fn', group: 'a/b/f.c', x: 160, y: 180, w: 120, h: 40 }],
    edges: [],
    groups: [
      { id: 'a/b/f.c', label: 'f.c', x: 140, y: 140, w: 180, h: 120 },
      // 故意与 f.c 已有 15px 重叠的同级文件框
      { id: 'a/b/g.c', label: 'g.c', x: 305, y: 140, w: 150, h: 120 },
    ],
    containers: [
      { id: 'a/b', label: 'b', depth: 2, x: 130, y: 108, w: 340, h: 170 },
      { id: 'a', label: 'a', depth: 1, x: 120, y: 76, w: 360, h: 212 },
      { id: '', label: 'root', depth: 0, root: true, x: 0, y: 0, w: 900, h: 600 },
    ],
  };
  const fileF = view.groups[0];
  const dirAB = view.containers[0];
  const dirA = view.containers[1];

  // 向左上拉伸 f.c：a/b 与 a 必须逐层保持 10px 左边距与 32px 顶边距
  const dragNW = beginBoxResize(view, { kind: 'file', box: fileF }, 'nw');
  resizeBox(dragNW, -30, -30);
  assert.ok(dirAB.x <= fileF.x - 10 && dirAB.y <= fileF.y - 32, '内层目录保留边距');
  assert.ok(dirA.x <= dirAB.x - 10 && dirA.y <= dirAB.y - 32, '外层目录保留标题区边距');

  // 尝试把 f.c 向右拉大去加重与 g.c 的已有重叠：必须被拦截
  const origW = fileF.w;
  const dragE = beginBoxResize(view, { kind: 'file', box: fileF }, 'e');
  resizeBox(dragE, 120, 0);
  assert.equal(fileF.w, origW, '已有重叠绝不能被进一步拉大');
});
