// 端到端测试：工程切换 + 时间轴回看
// 用法: node scripts/e2e-session.mjs [url]
// 不传 url 时自动拉起 src/server.js（临时库，跑完自动关掉）
import { launchCdp } from './lib/cdp.mjs';
import { launchServer } from './lib/server.mjs';

const argUrl = process.argv[2] || '';
const server = argUrl ? null : await launchServer({ target: 'samples/tcu' });
const baseUrl = (argUrl || server.baseUrl).replace(/\/+$/, '');
const cdp = await launchCdp({ url: baseUrl + '/', width: 1600, height: 1000 });
const { evaluate, waitFor, click, pressKey, screenshot } = cdp;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

const check = (label, cond, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures.push(label);
};

const post = (p, body) =>
  fetch(baseUrl + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

/** 找一个函数节点在页面上的中心坐标，用于点击 */
const nodePoint = (predicate = "n.kind !== 'var'") =>
  evaluate(`(() => {
    const v = window.__cg.view;
    const c = window.__cg.cam;
    if (!v) return null;
    const n = v.nodes.find((n) => ${predicate});
    if (!n) return null;
    const r = document.getElementById('cv').getBoundingClientRect();
    return {
      id: n.id, name: n.name,
      x: r.left + c.x + (n.x + n.w / 2) * c.k,
      y: r.top + c.y + (n.y + n.h / 2) * c.k,
    };
  })()`);

try {
  await waitFor('!!(window.__cg && window.__cg.view)', { timeout: 20000 });
  await sleep(800);

  const err0 = await evaluate('document.body.getAttribute("data-err")');
  console.log('页面错误:', err0 || '无');
  if (err0) failures.push('页面报错: ' + err0);

  // ---- 测试1：工程面板列出工程并切换 ----
  console.log('\n[测试1] 打开工程面板，切到 demo');
  const curName = await evaluate("document.getElementById('projectBtn').textContent.trim()");
  await evaluate("document.getElementById('projectBtn').click()");
  await sleep(500);
  const rows = await evaluate(`[...document.querySelectorAll('#projectList .proj')].map(r => ({
    name: r.querySelector('.nm').textContent.trim(),
    current: r.classList.contains('current'),
  }))`);
  console.log('  工程列表:', JSON.stringify(rows));
  check('面板里有工程卡片', rows.length >= 1);
  check('当前工程被标出', rows.some((r) => r.current));

  // 切到 demo：服务端按 cwd 解析相对路径，所以直接填相对路径即可
  await evaluate(`(() => {
    document.getElementById('projectPath').value = 'samples/demo';
    document.getElementById('projectOpen').click();
  })()`);
  await waitFor("document.getElementById('projectBtn').textContent.trim().startsWith('demo')", {
    timeoutMs: 20000,
  });
  const afterSwitch = await evaluate(`(() => ({
    btn: document.getElementById('projectBtn').textContent.trim(),
    files: document.querySelectorAll('#tree .tn').length,
    fns: (window.__cg.view || {}).nodes?.length || 0,
  }))()`);
  console.log('  切换后:', JSON.stringify(afterSwitch));
  check('工程按钮变成 demo', afterSwitch.btn.startsWith('demo'));
  check('视图已重载', afterSwitch.fns > 0);
  await screenshot('out/session-switched.png');

  // 切回 tcu
  console.log('\n[测试2] 切回 tcu');
  await evaluate("document.getElementById('projectBtn').click()");
  await sleep(500);
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#projectList .proj')];
    const tcu = rows.find(r => r.querySelector('.nm').textContent.trim().startsWith('tcu'));
    (tcu || rows[0]).click();
  })()`);
  await waitFor("document.getElementById('projectBtn').textContent.trim().startsWith('tcu')", {
    timeoutMs: 20000,
  });
  check('已切回 tcu', true);

  // ---- 测试3：写一条标注，时间轴里能看到 ----
  console.log('\n[测试3] 写入标注并检查时间轴');
  await post('/api/overlay', { nodeId: 'main.c::main', data: { note: '时间轴用例' } });
  await evaluate("document.getElementById('timelineBtn').click()");
  await sleep(600);
  const evs = await evaluate(`[...document.querySelectorAll('#timelineList .ev')].map(r => ({
    id: Number(r.dataset.id), txt: r.querySelector('.txt').textContent,
  }))`);
  console.log('  事件:', JSON.stringify(evs.slice(0, 3)));
  check('时间轴出现标注事件', evs.some((e) => e.txt.includes('时间轴用例')));
  const baseEvent = evs[evs.length - 1];
  check('存在历史起点', !!baseEvent && baseEvent.txt.includes('打开工程'));
  await screenshot('out/session-timeline.png');

  // ---- 测试4：回看到起点，标注消失 ----
  console.log('\n[测试4] 点最早一条进入回看');
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#timelineList .ev')];
    rows[rows.length - 1].click();
  })()`);
  await sleep(900);
  const reviewing = await evaluate(`(() => ({
    at: window.__cg.at,
    bar: document.getElementById('reviewBar').classList.contains('show'),
    note: (window.__cg.view.nodes.find(n => n.id === 'main.c::main') || {}).note,
  }))()`);
  console.log('  回看状态:', JSON.stringify(reviewing));
  check('进入回看模式', reviewing.at > 0 && reviewing.bar);
  check('回看画面里没有刚写的标注', !reviewing.note);
  await screenshot('out/session-review.png');

  // ---- 测试5：回看模式下删除被拦 ----
  console.log('\n[测试5] 回看模式下尝试删除，应被拦截');
  const pt = await nodePoint();
  if (pt) {
    await click(pt.x, pt.y);
    await sleep(250);
    await pressKey({ key: 'Delete', code: 'Delete', vk: 46 });
    await sleep(500);
    const blocked = await evaluate(`document.getElementById('reviewBar').classList.contains('blocked')`);
    check('横幅给出拦截提示', blocked);
    await evaluate("document.getElementById('reviewExit').click()");
    await sleep(700);
    const stillThere = await evaluate(`!!window.__cg.view.nodes.find(n => n.id === ${JSON.stringify(pt.id)})`);
    check('节点没有被真的删掉', stillThere, pt.id);
  } else {
    console.log('  跳过：当前视图没有函数节点');
  }

  // ---- 测试6：恢复到此 ----
  console.log('\n[测试6] 再回看起点，恢复到此');
  await evaluate("document.getElementById('timelineBtn').click()");
  await sleep(600);
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#timelineList .ev')];
    rows[rows.length - 1].click();
  })()`);
  await sleep(900);
  await evaluate("document.getElementById('reviewRestore').click()");
  await sleep(1200);
  const restored = await evaluate(`(() => ({
    at: window.__cg.at,
    bar: document.getElementById('reviewBar').classList.contains('show'),
    note: (window.__cg.view.nodes.find(n => n.id === 'main.c::main') || {}).note,
  }))()`);
  console.log('  恢复后:', JSON.stringify(restored));
  check('恢复后退出回看', restored.at === 0 && !restored.bar);
  check('标注已被回滚', !restored.note);

  // ---- 测试7：失效标注提示与清理 ----
  console.log('\n[测试7] 造一条失效标注，从工程面板清理');
  await post('/api/overlay', { nodeId: 'gone.c::Removed', data: { note: '这个函数已经不存在了' } });
  await evaluate("document.getElementById('projectBtn').click()");
  await sleep(800);
  const orphanShown = await evaluate(`(() => {
    const box = document.getElementById('orphanBox');
    return {
      show: box.classList.contains('show'),
      text: box.textContent.replace(/\\s+/g, ' ').trim(),
    };
  })()`);
  console.log('  提示框:', JSON.stringify(orphanShown));
  check('工程面板提示失效标注', orphanShown.show && orphanShown.text.includes('失效标注'));
  await screenshot('out/session-orphans.png');

  await evaluate("document.getElementById('orphanClean').click()");
  await sleep(1500);
  const afterClean = await evaluate(`(() => {
    const box = document.getElementById('orphanBox');
    return { show: box.classList.contains('show') };
  })()`);
  check('清理后提示消失', !afterClean.show);
  const orphansLeft = await fetch(baseUrl + '/api/orphans').then((r) => r.json());
  check('库里确实没有孤儿了', orphansLeft.total === 0, `total=${orphansLeft.total}`);
  await evaluate(`document.querySelector('.modal-close[data-close=projectModal]')?.click()`);

} catch (err) {
  console.log('❌ 异常:', err.message);
  failures.push(err.message);
} finally {
  try {
    await cdp.close();
  } catch {
    /* ignore */
  }
  if (server) await server.close();
}

console.log(failures.length ? `\n失败 ${failures.length} 项：${failures.join('; ')}` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
