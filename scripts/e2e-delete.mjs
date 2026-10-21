// 端到端测试：删除函数 / 删除连线 / 层级自动消失 / Ctrl+Z 恢复
// 用法: node scripts/e2e-delete.mjs [url]
// 不传 url 时自动拉起 src/server.js（端口由系统分配，跑完自动关掉）
// 注意：脚本只回滚自己删除的节点/连线，不会清空其它删除记录
import { launchCdp } from './lib/cdp.mjs';
import { launchServer } from './lib/server.mjs';

const argUrl = process.argv[2] || '';
const server = argUrl ? null : await launchServer({ target: 'samples/tcu' });
const baseUrl = (argUrl || server.baseUrl).replace(/\/+$/, '');
const cdp = await launchCdp({ url: baseUrl + '/', width: 1400, height: 950 });
const { evaluate, waitFor, click, pressKey } = cdp;

/** 等一个条件成立；超时返回 false（用于「本来就可能失败」的分支） */
const tryWaitFor = async (expression, opts) => {
  try {
    await waitFor(expression, opts);
    return true;
  } catch {
    return false;
  }
};

// 等页面把视图画出来（__cg.view 有值 = 视图已加载）
await waitFor('!!(window.__cg && window.__cg.view)');

const snapshot = () =>
  evaluate(`(() => {
    const v = window.__cg.view;
    return {
      nodes: v.nodes.length,
      edges: v.edges.length,
      files: (v.groups || []).map(g => g.id),
      containers: (v.containers || []).map(c => c.id),
      err: document.body.getAttribute('data-err'),
    };
  })()`);

/** 「恢复删除」按钮上的计数（没有删除记录时是 0） */
const deletedCount = async () => {
  const txt = await evaluate("document.getElementById('restoreDeleted').textContent");
  const m = /\((\d+)\)/.exec(txt || '');
  return m ? Number(m[1]) : 0;
};

/** 把某个节点滚到视野内并点击它 */
const clickNode = async (nodeId) => {
  const pos = await evaluate(`(() => {
    const v = window.__cg.view;
    const c = window.__cg.cam;
    const n = v.nodes.find(x => x.id === ${JSON.stringify(nodeId)});
    if (!n) return null;
    const r = document.getElementById('cv').getBoundingClientRect();
    return { x: r.left + c.x + (n.x + n.w/2) * c.k, y: r.top + c.y + (n.y + n.h/2) * c.k };
  })()`);
  if (!pos) return false;
  await click(pos.x, pos.y);
  return true;
};

// 只记录本脚本自己删掉的节点/连线，结束时逐个恢复
const deletedNodes = new Set();
const deletedEdges = new Set();
const failures = [];

try {
  const before = await snapshot();
  const delBefore = await deletedCount();
  console.log('初始:', before.nodes, '节点 /', before.edges, '边 /', before.files.length, '文件框');
  if (before.err) {
    console.log('页面错误:', before.err);
    failures.push('页面初始化报错: ' + before.err);
  }

  // ---- 测试1：删掉某个文件里的全部函数，该文件框应自动消失 ----
  const target = await evaluate(`(() => {
    const v = window.__cg.view;
    const byFile = new Map();
    for (const n of v.nodes) {
      if (!byFile.has(n.group)) byFile.set(n.group, []);
      byFile.get(n.group).push(n.id);
    }
    // 找函数最少（但非空）的文件，删起来快
    let best = null;
    for (const [f, ids] of byFile) if (!best || ids.length < best.ids.length) best = { file: f, ids };
    return best;
  })()`);

  console.log(`\n[测试1] 删光文件 ${target.file} 的 ${target.ids.length} 个函数`);
  for (const nid of target.ids) {
    if (!(await clickNode(nid))) {
      console.log('  节点已不在视图中，跳过', nid);
      continue;
    }
    const n0 = (await snapshot()).nodes;
    await pressKey({ key: 'Delete', code: 'Delete', vk: 46 });
    // 先记进回滚名单（哪怕后面等待失败，也要能把它恢复回去）
    deletedNodes.add(nid);
    // 删除后视图会异步重载：等节点数真的少了一个再继续
    const gone = await tryWaitFor(`window.__cg.view && window.__cg.view.nodes.length < ${n0}`, {
      timeoutMs: 8000,
    });
    if (!gone) {
      failures.push(`删除节点 ${nid} 后节点数没有减少（仍为 ${n0}）`);
      break;
    }
  }
  const after1 = await snapshot();
  const fileGone = !after1.files.includes(target.file);
  const btnAfterDel = await evaluate("document.getElementById('restoreDeleted').textContent");
  console.log(`  剩余: ${after1.nodes} 节点 / ${after1.files.length} 文件框`);
  console.log(`  文件框 ${target.file} 已消失: ${fileGone ? '✅' : '❌'}`);
  console.log(`  「恢复删除」按钮: ${btnAfterDel}`);
  if (after1.err) console.log('  页面错误:', after1.err);
  if (!fileGone) failures.push(`删除 ${target.file} 全部函数后文件框仍在`);
  if (after1.err) failures.push('删除后页面报错: ' + after1.err);

  // ---- 测试2：Ctrl+Z 逐次恢复 ----
  console.log(`\n[测试2] 连按 ${target.ids.length} 次 Ctrl+Z 恢复删除`);
  let cur = after1.nodes;
  for (let i = 0; i < target.ids.length; i++) {
    await pressKey({ key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 });
    // 每次撤销后节点数应 +1；等不到就停，别空转
    const back = await tryWaitFor(`window.__cg.view && window.__cg.view.nodes.length > ${cur}`, {
      timeoutMs: 8000,
    });
    if (!back) {
      failures.push(`第 ${i + 1} 次 Ctrl+Z 后节点数没有恢复（仍为 ${cur}）`);
      break;
    }
    cur++;
  }
  const after2 = await snapshot();
  const btnAfterUndo = await evaluate("document.getElementById('restoreDeleted').textContent");
  console.log(`  恢复后: ${after2.nodes} 节点 / ${after2.files.length} 文件框`);
  console.log(`  「恢复删除」按钮: ${btnAfterUndo}`);
  console.log(`  结论: ${after2.nodes === before.nodes ? '✅ 全部恢复' : '❌ 未完全恢复'}`);
  // 计数应回到测试开始前的样子（用户本来就有删除记录时不能要求归零）
  const delAfter = await deletedCount();
  console.log(`  按钮计数已回到初始值 ${delBefore}: ${delAfter === delBefore ? '✅' : '❌ 仍显示 ' + delAfter}`);
  if (after2.nodes !== before.nodes) failures.push(`Ctrl+Z 后节点数 ${after2.nodes}，期望 ${before.nodes}`);
  if (delAfter !== delBefore) failures.push(`Ctrl+Z 后删除计数 ${delAfter}，期望 ${delBefore}`);

  // ---- 测试3：删除一条连线（逐段尝试，避开节点）----
  const edgeCandidates = await evaluate(`(() => {
    const v = window.__cg.view;
    const c = window.__cg.cam;
    const r = document.getElementById('cv').getBoundingClientRect();
    const out = [];
    for (const e of v.edges) {
      const pts = e.points || [];
      for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        // 该点若落在任何节点内，跳过（节点点击优先）
        const onNode = v.nodes.some(n => mx >= n.x && mx <= n.x + n.w && my >= n.y && my <= n.y + n.h);
        if (onNode) continue;
        out.push({
          key: e.from + '->' + e.to + ':' + e.line,
          x: r.left + c.x + mx * c.k,
          y: r.top + c.y + my * c.k,
        });
      }
    }
    return { list: out.slice(0, 12), total: v.edges.length };
  })()`);

  let edgeDone = false;
  for (const cand of edgeCandidates.list) {
    await click(cand.x, cand.y);
    // 选中是同步发生的，等一小会儿确认「确实选中了什么」
    const picked = await tryWaitFor(
      '!!(window.__cg.selected && (window.__cg.selected.edge || window.__cg.selected.node))',
      { timeoutMs: 500 }
    );
    const sel = picked ? await evaluate('window.__cg.selected') : null;
    if (sel && sel.edge) {
      console.log(`\n[测试3] 删除连线 (${sel.edge})`);
      console.log(`  边数: ${edgeCandidates.total}`);
      const e0 = (await snapshot()).edges;
      await pressKey({ key: 'Delete', code: 'Delete', vk: 46 });
      // 先记进回滚名单
      deletedEdges.add(sel.edge);
      // 删除后视图会异步重载：等边数真的少了一条再读结果
      const gone = await tryWaitFor(`window.__cg.view && window.__cg.view.edges.length < ${e0}`, {
        timeoutMs: 8000,
      });
      const after3 = await snapshot();
      console.log(`  删除后: ${after3.edges}`);
      console.log(`  结论: ${after3.edges === edgeCandidates.total - 1 ? '✅ 已删除' : '⚠️ 边数未按预期减少'}`);
      if (!gone) failures.push(`删除连线 ${sel.edge} 后边数没有减少（仍为 ${e0}）`);
      if (after3.edges !== edgeCandidates.total - 1) {
        failures.push(`删除连线后边数 ${after3.edges}，期望 ${edgeCandidates.total - 1}`);
      }
      edgeDone = true;
      break;
    }
  }
  if (!edgeDone) console.log('\n[测试3] 跳过：没有可点中的连线（都被节点挡住）');
} finally {
  // 只回滚本脚本删掉的记录；绝不使用 clear:true 清空用户的其它删除标记
  try {
    if (deletedNodes.size || deletedEdges.size) {
      const payload = { restore: true, nodes: [...deletedNodes], edges: [...deletedEdges] };
      await evaluate(
        `fetch('/api/delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: ${JSON.stringify(
          JSON.stringify(payload)
        )} }).then(r => r.json())`
      );
      console.log(`\n已回滚本脚本删除的 ${deletedNodes.size} 个节点 / ${deletedEdges.size} 条连线`);
    }
  } catch (err) {
    console.error('回滚删除记录失败：', err.message);
    process.exitCode = 1;
  }
  await cdp.close();
  if (server) await server.close();
  if (failures.length) {
    console.error(`\n失败 ${failures.length} 项：`);
    for (const f of failures) console.error('  - ' + f);
    process.exitCode = 1;
  }
}
