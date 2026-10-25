/** HTML 离线导出验收：同画布像素、完整侧栏、连续拖动及撤销。运行：node scripts/e2e-html.mjs */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchServer } from './lib/server.mjs';
import { launchCdp } from './lib/cdp.mjs';

const server = await launchServer({ target: 'samples/tcu' });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-html-'));
let gui, offline;
const geometry = `JSON.stringify({nodes:__cg.view.nodes.map(({id,x,y,w,h})=>({id,x,y,w,h})),
  edges:__cg.view.edges.map(({from,to,points})=>({from,to,points})),groups:__cg.view.groups,containers:__cg.view.containers},
  (key,value)=>typeof value==='number'?Math.round(value*1000)/1000:value)`;
async function move(page, kind, dx, dy) {
  const p = await page.evaluate(`(() => {
    const b = ${kind === 'node' ? "__cg.view.nodes.find(n=>n.name==='main')" : "__cg.view.groups.find(g=>g.id==='main.c')"};
    const r = document.getElementById('cv').getBoundingClientRect(), c = __cg.cam;
    return {x:r.left+c.x+(b.x+${kind === 'node' ? 'b.w/2' : '20'})*c.k,
      y:r.top+c.y+(b.y+${kind === 'node' ? 'b.h/2' : '12'})*c.k,k:c.k};
  })()`);
  await page.drag(p.x, p.y, p.x + dx * p.k, p.y + dy * p.k, { steps: 5 });
}
try {
  gui = await launchCdp({ url: server.baseUrl, width: 1560, height: 1000 });
  await gui.waitFor('window.__cg?.view?.nodes?.length>0');
  await move(gui, 'group', 0, 60);
  await gui.evaluate(`(async()=>{
    const {state}=await import('/lib/state.js'); const {renderDetail,renderVars}=await import('/lib/panels.js');
    state.selected='can.c::Can_SendGearStatus'; state.ctxBox={kind:'file',id:'can.c'};
    state.view.edges[0].labels=[{id:'export-test',preset:'task',text:'TASK:2ms',dx:0,dy:0}];
    state.view.edges[0].change='added'; state.hover=null; state.flash=null; state.recent=null;
    await renderDetail(state.selected); renderVars(); (await import('/lib/render.js')).draw();
  })()`);
  const baseline = await gui.evaluate(geometry);
  const canvas = await gui.evaluate(`({w:cv.clientWidth,h:cv.clientHeight,png:cv.toDataURL()})`);
  const panel = await gui.evaluate(`['detail','vars','edges'].map(id=>document.getElementById(id).textContent)`);
  const html = await gui.evaluate(`(async()=>{const {buildStandaloneHtml}=await import('/lib/html.js');return await buildStandaloneHtml()})()`);
  const file = path.join(temp, 'callgraph.html'); fs.writeFileSync(file, html);
  const expected = [];
  for (const [kind, dx, dy] of [['node',10,30], ['node',-5,20], ['group',0,80]]) {
    await move(gui, kind, dx, dy); expected.push(await gui.evaluate(geometry));
  }
  assert.notEqual(expected[0], baseline, 'GUI 确实发生移动');
  await server.close(); // 本地服务关闭后才打开导出页，证明运行时完全离线。
  offline = await launchCdp({ url: pathToFileURL(file).href, width: 1310, height: 1000 });
  await offline.waitFor('window.__cg?.view?.nodes?.length>0');
  await offline.evaluate(`window.__errors=[];addEventListener('error',e=>__errors.push(e.message));
    addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));`);
  const bar = await offline.evaluate('document.querySelector("header").getBoundingClientRect().height');
  await offline.send('Emulation.setDeviceMetricsOverride', { width: canvas.w + 310,
    height: canvas.h + bar, deviceScaleFactor: 1, mobile: false });
  await offline.waitFor(`cv.clientHeight===${canvas.h}`);
  // 尺寸改变后保留同一世界坐标中心，以相同画布大小比较绘制像素。
  await offline.evaluate(`(async()=>{Object.assign(__cg.cam,__EXPORT.snapshot.cam);
    (await import('https://callgraph.invalid/lib/render.js')).draw()})()`);
  assert.equal(await offline.evaluate(geometry), baseline, '手动布局和全部折线原样导出');
  assert.equal(await offline.evaluate('cv.toDataURL()'), canvas.png, 'GUI 与 HTML 的画布像素完全相同');
  assert.deepEqual(await offline.evaluate(`['detail','vars','edges'].map(id=>document.getElementById(id).textContent)`), panel,
    '右侧详情、未入图常量、类型及读写计数和调用关系一致');
  assert.equal(await offline.evaluate(`!![...document.querySelectorAll('.var-row')].find(r=>r.dataset.id==='var::g_ops_cvt')`), true);
  await offline.screenshot('out/html-export/initial.png');
  let i = 0;
  for (const [kind, dx, dy] of [['node',10,30], ['node',-5,20], ['group',0,80]]) {
    await move(offline, kind, dx, dy);
    assert.equal(await offline.evaluate(geometry), expected[i++], '相同拖动产生相同布局与正交路线');
  }
  await offline.pressKey({ key:'z', code:'KeyZ', vk:90, modifiers:2 });
  assert.equal(await offline.evaluate(geometry), expected[1], '离线撤销恢复节点和折线');
  assert.deepEqual(await offline.evaluate('__errors'), []);
  await offline.screenshot('out/html-export/after-drag.png');
  console.log('通过：离线运行、初始像素一致、完整侧栏、重复拖动/层级移动及撤销与 GUI 一致');
} finally {
  if (offline) await offline.close();
  if (gui) await gui.close();
  await server.close();
  fs.rmSync(temp, { recursive:true, force:true });
}
