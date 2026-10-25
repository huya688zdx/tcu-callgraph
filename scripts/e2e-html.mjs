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
  await page.click(p.x, p.y);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 2 });
  }
  await page.drag(p.x, p.y, p.x + dx * p.k, p.y + dy * p.k, { steps: 5 });
}
async function exportsFrom(page, offline = false) {
  await page.evaluate(`window.__files=[];window.callgraph={saveExport:async(p)=>{
    const extension=p.name.split('.').pop();let content;
    if(extension==='svg')content=new TextDecoder().decode(p.bytes);
    else{const img=await createImageBitmap(new Blob([p.bytes]));const c=document.createElement('canvas');
      c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);content=[...ctx.getImageData(0,0,1,1).data]}
    __files.push({name:p.name,projectPath:p.projectPath,content});return{canceled:false};
  }};document.getElementById('${offline ? 'offlinePng' : 'exportPng'}').click();`);
  await page.waitFor('__files.length===1');
  await page.evaluate(`document.getElementById('${offline ? 'offlineSvg' : 'exportSvg'}').click()`);
  await page.waitFor('__files.length===2');
  assert.equal(await page.evaluate(`new DOMParser().parseFromString(__files[1].content,'image/svg+xml').querySelectorAll('parsererror').length`), 0,
    '导出的 SVG 是有效矢量文件');
  const files = await page.evaluate('__files');
  const theme = await page.evaluate(`(async()=>{
    const {THEME}=await import('${offline ? 'https://callgraph.invalid' : ''}/lib/state.js');return THEME;
  })()`);
  const rgb = (hex) => hex.slice(1).match(/../g).map((part) => parseInt(part, 16));
  assert.equal(files[0].name, 'tcu_main_间构成图.png');
  assert.equal(files[1].name, 'tcu_main_间构成图.svg');
  assert.deepEqual(files[0].content, [...rgb(theme.bg),255], 'PNG 底色不透明且与当前主题一致');
  const svgColors = files[1].content.replace(/\s/g, '');
  assert.ok(svgColors.includes(`rgba(${rgb(theme.container.stroke).join(',')},0.32)`), 'SVG 目录标题跟随主题');
  assert.ok(svgColors.includes(`rgba(${rgb(theme.container.stroke).join(',')},0.5)`), 'SVG 文件标题跟随主题');
  const colors = await page.evaluate(`(()=>{
    const svg=new DOMParser().parseFromString(__files[1].content,'image/svg+xml');
    const edge=svg.querySelector('path[data-from^="var::"],path[data-to^="var::"]');
    const marker=edge.getAttribute('marker-end').slice(5,-1);
    return {line:edge.getAttribute('stroke'),arrow:svg.getElementById(marker).querySelector('path').getAttribute('fill'),
      added:svg.querySelector('#mk-red path').getAttribute('fill')};
  })()`);
  assert.deepEqual(colors, {line:theme.edge.var,arrow:theme.edge.var,added:theme.edge.added}, '变量及新增边箭头与主题线色一致');
  // 恢复主题会规范十六进制大小写，比较颜色语义，避免把相同颜色误报为样式差异。
  return files.map((file) => ({ ...file, content: typeof file.content === 'string'
    ? file.content.replace(/\b(fill|stroke)="#[0-9a-f]{6}"/gi, (value) => value.toLowerCase()) : file.content }));
}
try {
  gui = await launchCdp({ url: server.baseUrl, width: 1560, height: 1000 });
  await gui.waitFor('window.__cg?.view?.nodes?.length>0');
  await gui.evaluate(`(async()=>{
    const {setThemeColor}=await import('/lib/state.js');
    setThemeColor('bg','#E1E8F0');setThemeColor('edge.var','#447788');
  })()`);
  await move(gui, 'group', 0, 60);
  await gui.evaluate(`(async()=>{
    const {state}=await import('/lib/state.js'); const {renderDetail,renderVars}=await import('/lib/panels.js');
    state.selected='can.c::Can_SendGearStatus'; state.ctxBox={kind:'file',id:'can.c'};
    state.view.edges[0].labels=[{id:'export-test',preset:'task',text:'TASK:2ms',dx:0,dy:0}];
    state.view.edges[0].change='added'; state.hover=null; state.flash=null; state.recent=null;
    await renderDetail(state.selected); renderVars(); (await import('/lib/render.js')).draw();
  })()`);
  assert.equal(await gui.evaluate(`(async()=>{
    const {state,cam}=await import('/lib/state.js'),{buildSVG}=await import('/lib/svg.js');
    const edge=state.view.edges[0],change=edge.change,k=cam.k;edge.change='deleted';
    cam.k=0.25;const small=buildSVG();cam.k=4;const large=buildSVG();
    cam.k=k;edge.change=change;return small===large;
  })()`), true, 'SVG 标题和删除标记不随画布缩放变化');
  const baseline = await gui.evaluate(geometry);
  const canvas = await gui.evaluate(`({w:cv.clientWidth,h:cv.clientHeight,png:cv.toDataURL()})`);
  const panel = await gui.evaluate(`['detail','vars','edges'].map(id=>document.getElementById(id).textContent)`);
  const guiExports = await exportsFrom(gui);
  assert.equal(await gui.evaluate(geometry), baseline, '导出 SVG 不修改手动布局和分组框');
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
  assert.deepEqual(await exportsFrom(offline, true), guiExports, 'GUI 与离线 HTML 使用相同命名、PNG 底色和 SVG 样式');
  await offline.screenshot('out/html-export/initial.png');
  let i = 0;
  for (const [kind, dx, dy] of [['node',10,30], ['node',-5,20], ['group',0,80]]) {
    await move(offline, kind, dx, dy);
    assert.equal(await offline.evaluate(geometry), expected[i++], '相同拖动产生相同布局与正交路线');
  }
  await offline.pressKey({ key:'z', code:'KeyZ', vk:90, modifiers:2 });
  assert.equal(await offline.evaluate(geometry), expected[1], '离线撤销恢复节点和折线');
  assert.notEqual((await exportsFrom(offline, true))[1].content, guiExports[1].content, '离线再次导出反映调整后的布局');
  // 普通浏览器没有 Electron 桥接时，也能实际下载这两种文件。
  await offline.send('Browser.setDownloadBehavior', { behavior:'allow', downloadPath:temp });
  await offline.evaluate(`delete window.callgraph;window.showSaveFilePicker=undefined;
    document.getElementById('offlinePng').click();document.getElementById('offlineSvg').click();`);
  const pngFile = path.join(temp, 'tcu_main_间构成图.png'), svgFile = path.join(temp, 'tcu_main_间构成图.svg');
  const deadline = Date.now() + 5000;
  while ((!fs.existsSync(pngFile) || !fs.existsSync(svgFile)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(fs.readFileSync(pngFile).subarray(1,4).toString(), 'PNG');
  assert.match(fs.readFileSync(svgFile,'utf8'), /<svg/);
  assert.deepEqual(await offline.evaluate('__errors'), []);
  await offline.screenshot('out/html-export/after-drag.png');
  console.log('通过：离线运行、初始像素一致、完整侧栏、重复拖动/层级移动及撤销与 GUI 一致');
} finally {
  if (offline) await offline.close();
  if (gui) await gui.close();
  await server.close();
  fs.rmSync(temp, { recursive:true, force:true });
}
