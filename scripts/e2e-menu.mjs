// 端到端测试：右键菜单标记函数变更分类 / 连线状态
// 用法: node scripts/e2e-menu.mjs [url]
// 不传 url 时自动拉起 src/server.js（端口由系统分配，跑完自动关掉）
// 注意：脚本只回滚自己改过的节点/连线，不会重置整个视图的标记
import { launchCdp } from './lib/cdp.mjs';
import { launchServer } from './lib/server.mjs';

const argUrl = process.argv[2] || '';
const server = argUrl ? null : await launchServer({ target: 'samples/tcu' });
const baseUrl = (argUrl || server.baseUrl).replace(/\/+$/, '');
const cdp = await launchCdp({ url: baseUrl + '/', width: 1400, height: 950 });
const { evaluate, waitFor, rightClick } = cdp;

const tryWaitFor = async (expression, opts) => {
  try {
    await waitFor(expression, opts);
    return true;
  } catch {
    return false;
  }
};

// 等页面把视图画出来
await waitFor('!!(window.__cg && window.__cg.view)');

const changed = [];
const failures = [];

try {
  const err0 = await evaluate('document.body.getAttribute("data-err")');
  console.log('页面错误:', err0 || '无');
  if (err0) failures.push('页面报错: ' + err0);

  // ---- 测试1：右键函数节点 → 选「追加モジュール」----
  const nodeInfo = await evaluate(`(() => {
    const v = window.__cg.view;
    const c = window.__cg.cam;
    const n = v.nodes.find(x => x.kind !== 'var');
    if (!n) return null;
    const r = document.getElementById('cv').getBoundingClientRect();
    return {
      id: n.id, name: n.name, change: n.change,
      x: r.left + c.x + (n.x + n.w / 2) * c.k,
      y: r.top + c.y + (n.y + n.h / 2) * c.k,
    };
  })()`);

  if (!nodeInfo) {
    console.log('没有可测试的函数节点');
  } else {
    console.log(`\n[测试1] 右键函数 ${nodeInfo.name}()，标记为「追加モジュール」`);
    await rightClick(nodeInfo.x, nodeInfo.y);
    const shown = await tryWaitFor("document.getElementById('ctxMenu').classList.contains('show')", {
      timeoutMs: 3000,
    });
    const menuShown = shown
      ? await evaluate(`(() => {
          const el = document.getElementById('ctxMenu');
          if (!el || !el.classList.contains('show')) return null;
          return { items: [...el.querySelectorAll('button')].map(b => b.textContent.trim()), title: el.querySelector('.title')?.textContent };
        })()`)
      : null;
    if (!menuShown) {
      console.log('  ❌ 右键菜单未出现');
      failures.push('右键函数节点未弹出菜单');
    } else {
      console.log(`  菜单标题: ${menuShown.title}`);
      console.log(`  菜单项: ${menuShown.items.join(' | ')}`);
      // 按文案选「追加モジュール」：菜单现在分「データ流分析 / 変更分類」两区，序号会变
      changed.push({ kind: 'node', id: nodeInfo.id, prev: nodeInfo.change || 'existing' });
      const picked = await evaluate(`(() => {
        const b = [...document.querySelectorAll('#ctxMenu button')].find(x => x.textContent.includes('追加'));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!picked) {
        failures.push('右键菜单里没有「追加」选项');
      } else {
        // 选完菜单项：状态立刻更新，菜单随之关闭
        const updated = await tryWaitFor(
          `(() => { const n = window.__cg.view.nodes.find(x => x.id === ${JSON.stringify(nodeInfo.id)});
            return n && n.change === 'added'; })()`,
          { timeoutMs: 3000 }
        );
        const after = await evaluate(`(() => {
          const n = window.__cg.view.nodes.find(x => x.id === ${JSON.stringify(nodeInfo.id)});
          return { change: n && n.change, menuOpen: document.getElementById('ctxMenu').classList.contains('show') };
        })()`);
        console.log(`  change: ${nodeInfo.change} -> ${after.change}`);
        console.log(`  结论: ${after.change === 'added' ? '✅ 已标记为追加' : '❌ 状态未更新'}`);
        console.log(`  菜单已关闭: ${after.menuOpen ? '❌' : '✅'}`);
        if (!updated) failures.push(`节点 ${nodeInfo.id} 未标记为 added`);
        if (after.menuOpen) failures.push('选择菜单项后菜单未关闭');
      }
    }
  }

  // ---- 测试2：右键连线 → 选「新增」----
  const edgeInfo = await evaluate(`(() => {
    const v = window.__cg.view;
    const c = window.__cg.cam;
    const r = document.getElementById('cv').getBoundingClientRect();
    for (const e of v.edges) {
      const pts = e.points || [];
      for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i+1][0]) / 2;
        const my = (pts[i][1] + pts[i+1][1]) / 2;
        const onNode = v.nodes.some(n => mx >= n.x && mx <= n.x + n.w && my >= n.y && my <= n.y + n.h);
        if (onNode) continue;
        return {
          key: e.from + '->' + e.to + ':' + e.line, change: e.change,
          x: r.left + c.x + mx * c.k, y: r.top + c.y + my * c.k,
        };
      }
    }
    return null;
  })()`);

  if (!edgeInfo) {
    console.log('\n[测试2] 跳过：没有可点的连线');
  } else {
    console.log(`\n[测试2] 右键连线，标记为「新增」`);
    await rightClick(edgeInfo.x, edgeInfo.y);
    const shown = await tryWaitFor("document.getElementById('ctxMenu').classList.contains('show')", {
      timeoutMs: 3000,
    });
    if (!shown) {
      console.log('  ❌ 菜单未出现');
      failures.push('右键连线未弹出菜单');
    } else {
      changed.push({ kind: 'edge', id: edgeInfo.key, prev: edgeInfo.change || 'existing' });
      const picked = await evaluate(`(() => {
        const b = [...document.querySelectorAll('#ctxMenu button')].find(x => x.textContent.trim() === '新增');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!picked) {
        failures.push('连线右键菜单里没有「新增」选项');
      } else {
        const updated = await tryWaitFor(
          `(() => { const v = window.__cg.view;
            const e = v.edges.find(x => (x.from + '->' + x.to + ':' + x.line) === ${JSON.stringify(edgeInfo.key)});
            return e && e.change === 'added'; })()`,
          { timeoutMs: 3000 }
        );
        const after = await evaluate(`(() => {
          const v = window.__cg.view;
          const e = v.edges.find(x => (x.from + '->' + x.to + ':' + x.line) === ${JSON.stringify(edgeInfo.key)});
          return { change: e && e.change };
        })()`);
        console.log(`  change: ${edgeInfo.change} -> ${after.change}`);
        console.log(`  结论: ${after.change === 'added' ? '✅ 已标记为新增' : '❌ 状态未更新'}`);
        if (!updated) failures.push(`连线 ${edgeInfo.key} 未标记为 added`);
      }
    }
  }
} finally {
  // 只回滚本脚本改过的节点/连线，恢复到测试前的值；不再批量重置整个视图
  try {
    for (const c of changed) {
      const body =
        c.kind === 'node'
          ? { nodeId: c.id, data: { change: c.prev } }
          : { edgeKey: c.id, data: { change: c.prev } };
      await evaluate(
        `fetch('/api/overlay', { method:'POST', headers:{'Content-Type':'application/json'}, body: ${JSON.stringify(
          JSON.stringify(body)
        )} })`
      );
    }
    if (changed.length) console.log(`\n已恢复本脚本修改的 ${changed.length} 处状态标记`);
  } catch (err) {
    console.error('恢复状态标记失败：', err.message);
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
