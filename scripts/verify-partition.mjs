/**
 * 分区式紧凑布局验证：
 *  1. 同一父目录下的兄弟框（文件框/目录框）互不重叠
 *  2. 目录容器严格包住其内部内容（层级嵌套成立）
 *  3. 整体宽高比合理（不再排成一列），报告各模块落位
 *  4. 节点互不重叠、边折线严格正交且齐全
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadModel, subgraph } from '../src/core/index.js';
import { layoutGrouped } from '../src/core/layout.js';

const target = process.argv[2] || 'samples/deep';
const model = loadModel(target);
const EPS = 0.51;

const overlap = (a, b, pad = 0) =>
  a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;

function check(laid, label) {
  let fail = 0;

  // 文件框互不重叠
  const gs = laid.groups || [];
  for (let i = 0; i < gs.length; i++) {
    for (let j = i + 1; j < gs.length; j++) {
      if (overlap(gs[i], gs[j], -2)) {
        console.log(`  !! 文件框重叠: ${gs[i].id} × ${gs[j].id}`);
        fail++;
      }
    }
  }

  // 目录容器包住内容（文件框 + 直接子容器），且兄弟目录容器不重叠
  const cs = (laid.containers || []).filter((c) => !c.root);
  for (const c of cs) {
    const kids = [
      ...gs.filter((g) => String(g.id).startsWith(c.id + '/')),
      ...cs.filter((k) => k !== c && String(k.id).startsWith(c.id + '/')),
    ];
    // 只检查直接子级（路径深度 +1）
    const direct = kids.filter((k) => {
      const rel = String(k.id).slice(c.id.length + 1);
      return !rel.includes('/');
    });
    for (const k of direct) {
      if (
        k.x < c.x - 1 ||
        k.y < c.y - 1 ||
        k.x + k.w > c.x + c.w + 1 ||
        k.y + k.h > c.y + c.h + 1
      ) {
        console.log(`  !! 容器没包住子级: ${c.id} ⊅ ${k.id}`);
        fail++;
      }
    }
  }
  const tops = cs.filter((c) => !cs.some((p) => p !== c && String(c.id).startsWith(p.id + '/')));
  for (let i = 0; i < tops.length; i++) {
    for (let j = i + 1; j < tops.length; j++) {
      if (overlap(tops[i], tops[j], -2)) {
        console.log(`  !! 顶层容器重叠: ${tops[i].id} × ${tops[j].id}`);
        fail++;
      }
    }
  }

  // 节点互不重叠
  const ns = laid.nodes;
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      if (overlap(ns[i], ns[j], -4)) {
        console.log(`  !! 节点重叠: ${ns[i].id} × ${ns[j].id}`);
        fail++;
        break;
      }
    }
  }

  // 边：折线齐全 + 严格正交
  let diag = 0;
  let noPts = 0;
  for (const e of laid.edges) {
    if (!e.points || e.points.length < 2) {
      noPts++;
      continue;
    }
    for (let i = 0; i < e.points.length - 1; i++) {
      const dx = Math.abs(e.points[i + 1][0] - e.points[i][0]);
      const dy = Math.abs(e.points[i + 1][1] - e.points[i][1]);
      if (dx > EPS && dy > EPS) {
        diag++;
        break;
      }
    }
  }
  if (noPts) {
    console.log(`  !! ${noPts} 条边缺折线`);
    fail++;
  }
  if (diag) {
    console.log(`  !! ${diag} 条边有斜线段`);
    fail++;
  }

  const ratio = laid.width / Math.max(1, laid.height);
  console.log(
    `[${label}] 节点 ${ns.length} / 边 ${laid.edges.length} / 文件框 ${gs.length} / 容器 ${cs.length}`
  );
  console.log(
    `  画布 ${Math.round(laid.width)}x${Math.round(laid.height)} 宽高比 ${ratio.toFixed(2)} 列数 ${laid.layers}`
  );
  for (const g of gs) {
    const pos = `${g.x < laid.width * 0.4 ? '左' : g.x > laid.width * 0.6 ? '右' : '中'}${
      g.y < laid.height * 0.4 ? '上' : g.y > laid.height * 0.6 ? '下' : '中'
    }`;
    console.log(`  ${pos}  ${g.id} (${Math.round(g.w)}x${Math.round(g.h)})`);
  }
  if (ratio < 0.55 && gs.length > 1) {
    console.log('  !! 整体仍然接近单列（宽高比过低）');
    fail++;
  }
  return fail === 0;
}

let allOk = true;
for (const fn of model.functions) {
  const g = subgraph(model, fn.id, { up: 1, down: 3 });
  if (g.edges.length < 4 || g.nodes.length < 6) continue;
  const clean = g.nodes.map(({ bodyTokens, ...rest }) => rest);
  const rootLabel = path.basename(target);
  const laid = layoutGrouped(clean, g.edges, { rootLabel });
  allOk = check(laid, `${fn.name}(${g.nodes.length}n/${g.edges.length}e)`) && allOk;
  break; // 每个样本只详细看一个代表视图
}

// 全函数全量视图
{
  const all = { ...model, functions: model.functions };
  const clean = model.functions.map(({ bodyTokens, ...rest }) => rest);
  const laid = layoutGrouped(clean, model.edges, { rootLabel: path.basename(target) });
  allOk = check(laid, '全量视图') && allOk;
}

console.log('\n==== ' + (allOk ? 'PASS' : 'FAIL') + ' ====');
if (!allOk) process.exit(1);
