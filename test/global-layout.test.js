import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchCdp, resolveChromePath } from '../scripts/lib/cdp.mjs';
import { launchServer } from '../scripts/lib/server.mjs';

const projectName = 'TransmissionControllerCalibrationAndIntegration_第二制御系統';
const reader = 'ReadTransmissionTemperatureForHydraulicPressureCompensation';
const writer = 'UpdateTransmissionTemperatureForHydraulicPressureCompensation';
const variable = 'g_transmissionTemperatureForHydraulicPressureCompensation';
const filename = 'HydraulicPressureCompensationForTransmissionOperatingTemperature.c';
const profile = 'ProductionTransmissionHydraulicPressureCompensationCalibrationConfiguration.mak';
const bookmark = 'CalibrationReview_TransmissionHydraulicPressureCompensation_変速制御校正';
const languages = ['en', 'ja', 'zh-CN'];
// Electron 默认 / 最小窗口、最小窗口放大到 125% 和 200% 后的 CSS 视口、窄浏览器。
const viewports = [[1560, 960, 1], [1080, 680, 1], [864, 544, 1.25], [540, 340, 2], [390, 844, 1]];
const key = (browser, name, vk) => browser.pressKey({ key: name, code: name, vk, text: name === 'Enter' ? '\r' : undefined });
const element = selector => `document.querySelector(${JSON.stringify(selector)})`;

async function setViewport(browser, [width, height, deviceScaleFactor]) {
  await browser.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  await browser.waitFor(`devicePixelRatio === ${deviceScaleFactor} && cv.width === Math.round(cv.clientWidth * devicePixelRatio)`);
}

function projectFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, projectName);
  const sourceDir = path.join(root, 'src', 'TransmissionController');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, filename), [
    `int ${variable};`,
    `void ${writer}(void) { ${variable} = 42; }`,
    `int ${reader}(void) { return ${variable}; }`,
    `int main(void) { ${writer}(); return ${reader}(); }`,
  ].join('\n'));
  fs.writeFileSync(path.join(sourceDir, 'empty.c'), '// No functions\n');
  fs.writeFileSync(path.join(root, profile), `SRC = src/TransmissionController/${filename}\n`);
  return { dir, root };
}

// 使用浏览器命中测试，避免对裁在滚动容器外的菜单项调用 DOM click() 而误判通过。
async function click(browser, selector) {
  const el = element(selector);
  await browser.waitFor(`${el}?.getClientRects().length && !${el}.disabled`);
  await browser.evaluate(`${el}.scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
  const point = await browser.waitFor(`(() => {
    const e = ${el}, r = e.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    return e.contains(document.elementFromPoint(x, y)) && {x, y};
  })()`);
  await browser.click(point.x, point.y);
}

async function fits(browser, region, selector) {
  const result = await browser.evaluate(`(() => {
    const region = ${element(region)}, bounds = region.getBoundingClientRect();
    const controls = [...region.querySelectorAll(${JSON.stringify(selector)})].filter(e => e.checkVisibility());
    const issues = [];
    for (const e of controls) {
      const r = e.getBoundingClientRect();
      // 单行输入允许滚动编辑自己的值。按钮、文字和选项要完整可读。
      const clipped = !e.matches('input') && (e.scrollWidth > e.clientWidth + 2 || e.scrollHeight > e.clientHeight + 2);
      if (clipped || r.left < bounds.left - 1 || r.right > bounds.right + 1 || r.left < -1 || r.right > innerWidth + 1) {
        issues.push({ control: e.id || e.className || e.tagName, text: e.textContent.trim().slice(0, 100),
          left: Math.round(r.left), right: Math.round(r.right), available: e.clientWidth, content: e.scrollWidth });
      }
    }
    return { count: controls.length, issues, width: Math.round(bounds.width), lang: document.documentElement.lang };
  })()`);
  assert.ok(result.count, `${region} 无可见控件 ${selector}`);
  assert.deepEqual(result.issues, [], `${result.lang} ${region} (${result.width}px) ${selector}`);
}

async function switchLanguage(browser, lang) {
  await click(browser, '#styleBtn');
  await click(browser, `[data-language="${lang}"]`);
  await browser.waitFor(`document.documentElement.lang === '${lang}'`);
}

async function checkSettingsAndMenus(browser, lang) {
  await switchLanguage(browser, lang);
  await fits(browser, '#styleModal', '.appearance-tabs button, [data-language], #styleReset');
  await click(browser, '#appearanceCanvasTab');
  await fits(browser, '#styleBody', '.appearance-preview-node, .appearance-preview-edge, [data-preset], [data-color]');
  const overlap = await browser.evaluate(`(() => {
    return [...document.querySelectorAll('.appearance-preview-graph .appearance-preview-edge')].some(edge => {
      const label = document.createRange();
      label.selectNodeContents(edge.firstChild);
      const arrow = edge.querySelector('i').getBoundingClientRect();
      return [...label.getClientRects()].some(r => r.left < arrow.right && r.right > arrow.left &&
        r.top < arrow.bottom && r.bottom > arrow.top);
    });
  })()`);
  assert.equal(overlap, false, '预览箭头穿过了文字');
  await key(browser, 'Escape', 27);
  assert.equal(await browser.evaluate('projectBtn.textContent'), projectName);
  assert.ok((await browser.evaluate('projectBtn.title')).includes(projectName));
  await fits(browser, '.top-row', '.brand, #projectBtn, .tool-group button, #bookmarkBtn, #timelineBtn, summary, #styleBtn, #aiBtn');
  assert.ok(await browser.evaluate(`bookmarkSplit.clientWidth <= bookmarkBtn.offsetWidth + bookmarkQuickSave.offsetWidth + 1`),
    '书签按钮未覆盖分体控件的可点击区域');
  await click(browser, '#helpMenu summary');
  await key(browser, 'Tab', 9);
  assert.equal(await browser.evaluate("document.activeElement.matches('.help-popover')"), true);
  await fits(browser, '.help-popover', 'p, kbd');
  await key(browser, 'Escape', 27);
  assert.equal(await browser.evaluate('document.activeElement.id'), 'helpSummary');
  await click(browser, '#exportMenu summary');
  await fits(browser, '#exportMenu .tool-popover', 'button');
  await key(browser, 'Tab', 9);
  assert.equal(await browser.evaluate('document.activeElement.id'), 'exportSvg');
  assert.ok(await browser.evaluate(`(() => {
    const r = exportSvg.getBoundingClientRect();
    return exportSvg.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })()`), '导出按钮被工具栏裁切');
  await key(browser, 'Escape', 27);
}

async function checkProjectAndBuild(browser) {
  await click(browser, '#projectBtn');
  await browser.waitFor("projectList.querySelector('.proj.current .pt')");
  await fits(browser, '#projectModal', '.proj .nm, .proj .pt, .modal-foot button, #projectPath');
  await click(browser, '#projectModeCompare');
  await fits(browser, '#projectComparePane', 'button, .compare-row input, .git-compare-buttons');
  await click(browser, '#projectModeNormal');
  await key(browser, 'Escape', 27);
  await click(browser, '#buildConfigBtn');
  await browser.waitFor('!buildConfigApply.disabled && buildProfileSelect.options.length > 1');
  const trigger = '.fsel:has(> #buildProfileSelect) > button';
  await click(browser, trigger);
  await fits(browser, '.fsel-pop', '[role=option]');
  await key(browser, 'End', 35);
  await key(browser, 'Enter', 13);
  assert.ok((await browser.evaluate(`${element(trigger)}.textContent`)).includes(profile));
  await fits(browser, '#buildConfigModal', '.build-field .fsel-btn, .fsel-btn > span, .modal-foot button');
  await key(browser, 'Escape', 27);
}

async function checkBookmarkAndTimeline(browser) {
  await click(browser, '#bookmarkBtn');
  await browser.waitFor("bookmarkList.querySelector('.bm.is-active')");
  assert.ok((await browser.evaluate('bookmarkSummary.textContent')).includes(bookmark));
  await fits(browser, '#bookmarkModal', '.bm-summary > span, .bm .nm, .bm-actions button, .modal-foot input, .modal-foot button');
  await key(browser, 'Escape', 27);
  await click(browser, '#timelineBtn');
  await browser.waitFor("timelineList.querySelector('.ev.k-checkpoint .ev-review')");
  await fits(browser, '#timelineModal', '#tlChips button, #tlCheckpointInput, #tlCheckpointBtn, .ev-title, .ev-review');
  await click(browser, '.ev.k-checkpoint .ev-review');
  await browser.waitFor("reviewBar.classList.contains('show')");
  await fits(browser, 'main', '#legend span, #reviewText, #reviewBar button');
  assert.ok(await browser.evaluate('reviewBar.getBoundingClientRect().top >= legend.getBoundingClientRect().bottom'));
  await click(browser, '#reviewExit');
  await browser.waitFor("!reviewBar.classList.contains('show')");
}

async function checkDataflow(browser, id) {
  await browser.evaluate(`import('/lib/df.js').then(m => m.analyseDataflow(${JSON.stringify(id)}))`);
  await browser.waitFor("document.querySelector('#dataflow .df-relation')");
  await fits(browser, '#right', '.df-actions > *, .df-peer-name, .df-via, [data-df-variable] .detail-meta');
  assert.ok((await browser.evaluate('dataflow.textContent')).includes(writer));
  assert.ok((await browser.evaluate('dataflow.textContent')).includes(variable));
  await click(browser, '#dfFilter');
  await browser.send('Input.insertText', { text: variable });
  assert.ok(await browser.evaluate("document.querySelector('.df-relation:not([hidden])') !== null"));
  await click(browser, '#secDataflow [data-df=close]');
}

async function checkNavigation(browser) {
  await click(browser, '#shownFunctions');
  const result = `#results li[data-id$="::${reader}"]`;
  await browser.waitFor(`${element(result)}?.checkVisibility()`);
  await fits(browser, '#left', '#shownBatchBar button, #results .fn, #results .meta');
  await click(browser, result + ' .fn');
  await click(browser, '#shownFunctions');
  await click(browser, '[data-node-flowchart]');
  await browser.waitFor("flowchartCanvas.querySelector('svg')");
  await fits(browser, '#flowchartModal', '#flowchartCrumbs [aria-current], #flowchartTitle, .flowchart-toolbar button, .flowchart-toolbar label');
  await click(browser, '#flowchartFit');
  await click(browser, '#flowchartModal .modal-close');
}

async function checkCanvasAndTable(browser) {
  const point = await browser.evaluate(`(() => {
    cv.scrollIntoView({ block: 'center' });
    const r = cv.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    return { x, y, cameraY: __cg.cam.y, hit: document.elementFromPoint(x, y) === cv };
  })()`);
  assert.ok(point.hit, '画布中央无法接收滚轮');
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: point.x, y: point.y, deltaX: 0, deltaY: 40 });
  await browser.waitFor(`__cg.cam.y < ${point.cameraY} - 1`);
  await click(browser, '#aiBtn');
  await click(browser, '[data-ai-tab="chat"]');
  await browser.waitFor("document.querySelector('#aiMessages .ai-md-table')");
  assert.ok(await browser.evaluate(`(() => {
    const wrap = document.querySelector('#aiMessages .ai-table-wrap');
    wrap.scrollLeft = 100;
    return wrap.scrollLeft > 0 && aiMessages.scrollWidth <= aiMessages.clientWidth + 1;
  })()`), '宽表应在表格内部横向滚动');
  await click(browser, '#aiDrawerClose');
}

test('全局三语排版：真实工程、运行时切换、桌面缩放与离线导出', async t => {
  let chromePath;
  try { chromePath = resolveChromePath(); } catch { return t.skip('未安装 Chrome'); }
  const { dir, root } = projectFixture(t);
  const server = await launchServer({ target: root });
  t.after(server.close);
  const columns = Array.from({ length: 32 }, (_, i) => 'Calibration' + i);
  const table = [columns, columns.map(() => '---'), columns].map(row => '| ' + row.join(' | ') + ' |').join('\n');
  const project = await (await fetch(server.baseUrl + '/api/project')).json();
  const saved = await fetch(server.baseUrl + '/api/ai/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: project.id, activeId: 'layout', threads: [
      { id: 'layout', title: 'Calibration', messages: [{ role: 'assistant', text: table }] },
    ] }) });
  assert.equal(saved.status, 200);
  const browser = await launchCdp({ url: server.baseUrl, chromePath });
  t.after(browser.close);
  await browser.waitFor('window.__cg?.view && document.querySelector("#tree .tn.file")');
  const file = `.tn.file[data-path$="${filename}"]`;
  await browser.evaluate(`${element(file)}.focus()`);
  await key(browser, 'Enter', 13);
  const add = `.tn.fn[data-fnid$="::${reader}"] button`;
  await browser.waitFor(`${element(add)}?.getClientRects().length`);
  await browser.evaluate(`${element(add)}.focus()`);
  await key(browser, 'Enter', 13);
  assert.equal(await browser.evaluate("document.activeElement.matches('#ctxMenu button[data-i=\"0\"]')"), true);
  await key(browser, 'Escape', 27);
  assert.equal(await browser.evaluate(`document.activeElement === ${element(add)}`), true);
  await key(browser, 'Enter', 13);
  await key(browser, 'Tab', 9);
  await key(browser, 'Tab', 9);
  await key(browser, 'Enter', 13);
  await browser.waitFor(`__cg.view.roots.some(id => id.endsWith('::${reader}'))`);
  const id = await browser.evaluate(`__cg.view.nodes.find(n => n.name === '${reader}').id`);
  await click(browser, '#bookmarkBtn');
  await browser.evaluate(`bookmarkName.value = ${JSON.stringify(bookmark)}`);
  await click(browser, '#bookmarkSave');
  await browser.waitFor(`bookmarkBtn.textContent.includes(${JSON.stringify(bookmark)})`);
  await key(browser, 'Escape', 27);
  await click(browser, '#timelineBtn');
  await browser.evaluate(`tlCheckpointInput.value = ${JSON.stringify(bookmark)}`);
  await click(browser, '#tlCheckpointBtn');
  await browser.waitFor("timelineList.querySelector('.ev.k-checkpoint')");
  await key(browser, 'Escape', 27);

  for (const viewport of viewports) {
    const [width, height] = viewport;
    await setViewport(browser, viewport);
    for (const lang of languages) {
      await t.test(`${width}×${height} ${lang}`, async sub => {
        // 单个断言失败时恢复仍打开的弹层，后续场景能给出独立的布局诊断。
        sub.after(async () => {
          if (await browser.evaluate("!!document.querySelector('.modal.show, #aiDrawer.show, .tool-menu[open]')")) {
            await browser.send('Page.reload');
            await browser.waitFor('window.__cg?.view && document.querySelector("#tree .tn.file")');
          }
        });
        await checkSettingsAndMenus(browser, lang);
        await fits(browser, '#left', '.tn .nm, .tn .add-function, .tree-empty-toggle');
        assert.ok(await browser.evaluate('cv.clientWidth > 260 && cv.clientHeight > 150'), '画布被侧栏挤没');
        assert.equal(await browser.evaluate('app.scrollWidth > app.clientWidth + 1'), false);
        await checkNavigation(browser);
        await checkProjectAndBuild(browser);
        await checkBookmarkAndTimeline(browser);
        await checkDataflow(browser, id);
        await checkCanvasAndTable(browser);
      });
    }
  }

  for (const lang of languages) {
    await t.test(`导出并打开 ${lang} HTML`, async sub => {
      await switchLanguage(browser, lang);
      await key(browser, 'Escape', 27);
      // 仅接管原生保存文件对话框。读取实际导出按钮生成的字节。
      await browser.evaluate(`window.callgraph = { saveExport: ({ bytes }) => {
        window.exportedHtml = new TextDecoder().decode(bytes);
      } }; window.exportedHtml = null`);
      await click(browser, '#exportMenu summary');
      await click(browser, '#exportHtml');
      await browser.waitFor("window.exportedHtml?.startsWith('<!doctype html>')");
      const filePath = path.join(dir, lang + '.html');
      fs.writeFileSync(filePath, await browser.evaluate('window.exportedHtml'));
      const offline = await launchCdp({ chromePath });
      try {
        const nav = await offline.send('Page.navigate', { url: pathToFileURL(filePath).href });
        if (nav.result.errorText === 'net::ERR_BLOCKED_BY_ADMINISTRATOR') {
          sub.diagnostic('浏览器策略限制 file://，从仅提供该快照的本地 HTTP 服务打开。');
          const staticServer = http.createServer((req, res) => {
            if (req.url !== '/snapshot.html') { res.writeHead(404).end(); return; }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fs.readFileSync(filePath));
          });
          await new Promise(resolve => staticServer.listen(0, '127.0.0.1', resolve));
          sub.after(() => new Promise(resolve => staticServer.close(resolve)));
          await offline.send('Page.navigate', { url: `http://127.0.0.1:${staticServer.address().port}/snapshot.html` });
        } else {
          assert.equal(nav.result.errorText, undefined);
        }
        await offline.waitFor('window.__cg?.view');
        assert.equal(await offline.evaluate('document.documentElement.lang'), lang);
        for (const viewport of viewports) {
          await setViewport(offline, viewport);
          await fits(offline, 'header', 'b, span, button');
          await fits(offline, 'main', '#legend span');
          assert.ok(await offline.evaluate('cv.clientWidth > 260 && cv.clientHeight > 150'));
          await click(offline, '#offlineFit');
          assert.ok(await offline.evaluate(`__cg.view.nodes.some(n => n.name === '${reader}')`));
        }
      } finally {
        await offline.close();
      }
    });
  }

  await t.test('比较选择器与比较中的工程身份随语言、宽度更新', async () => {
    const before = path.join(dir, 'Calibration_比較前');
    const after = path.join(dir, 'Calibration_比較後');
    fs.cpSync(root, before, { recursive: true });
    fs.cpSync(root, after, { recursive: true });
    const source = path.join(after, 'src', 'TransmissionController', filename);
    fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace('= 42', '= 43'));
    await click(browser, '#projectBtn');
    await click(browser, '#projectModeCompare');
    await browser.evaluate(`compareBeforePath.value = ${JSON.stringify(before)}; compareAfterPath.value = ${JSON.stringify(after)}`);
    await click(browser, '#compareStart');
    await browser.waitFor("comparePickList.querySelector('.compare-pick-row') || compareError.textContent");
    assert.equal(await browser.evaluate('compareError.textContent'), '');
    for (const viewport of [viewports[0], viewports.at(-1)]) {
      await setViewport(browser, viewport);
      for (const lang of languages) {
        await browser.evaluate(`import('/i18n.js').then(m => m.setLang('${lang}'))`);
        await fits(browser, '#compareSelectModal', '.compare-pick-row label, .compare-pick-row .fsel-btn, .compare-pick-tools button, .modal-foot button');
      }
    }
    await click(browser, '#comparePickCore');
    await click(browser, '#comparePickApply');
    await browser.waitFor('__cg.view?.comparison && !compareSummary.hidden');
    for (const viewport of [viewports[0], viewports.at(-1)]) {
      await setViewport(browser, viewport);
      for (const lang of languages) {
        await switchLanguage(browser, lang);
        await key(browser, 'Escape', 27);
        await fits(browser, '.top-row', '#projectBtn, #compareSummary, #compareExit');
        assert.equal(await browser.evaluate('projectBtn.textContent'), projectName);
        assert.ok((await browser.evaluate('projectBtn.title')).includes(after));
      }
    }
    await click(browser, '#compareExit');
    await browser.waitFor('!__cg.view.comparison && compareSummary.hidden');
  });
});
