/** 独立 HTML 导出：携带当前几何、详情数据与 GUI 原有模块，离线复用同一套绘制和交互。 */
import { state, cam, els, esc, THEME } from './state.js';
import { api } from './api.js';

export async function buildStandaloneHtml() {
  const view = structuredClone(state.view);
  const snapshot = { view, cam: { ...cam }, width: els.cv.clientWidth, height: els.cv.clientHeight,
    selected: state.selected, ctxBox: state.ctxBox && { ...state.ctxBox },
    vars: [...state.vars], hiddenVars: [...state.hiddenVars],
    theme: structuredClone(THEME) };
  const right = document.getElementById('right').cloneNode(true);
  right.removeAttribute('data-mode');
  right.querySelectorAll('.fsel').forEach(wrap => wrap.replaceWith(wrap.querySelector('select')));
  right.querySelectorAll('#secLabel, #pairFlowBar').forEach(panel => panel.remove());
  const css = [...document.querySelectorAll('style')].map((s) => s.textContent).join('\n');

  // 只收集此离线入口实际依赖的现有模块；统一模块地址，避免 file:// 下的相对导入和跨域限制。
  const sources = {};
  async function collect(url) {
    if (Object.hasOwn(sources, url)) return;
    sources[url] = '';
    const response = await fetch(url);
    if (!response.ok) throw new Error('读取导出模块失败：' + url);
    const dependencies = [];
    sources[url] = (await response.text()).replace(
      /^((?:import|export)\s+(?:[^'";]+?\sfrom\s*)?)['"]([^'"\r\n]+)['"]/gm,
      (match, prefix, spec) => {
        const dep = new URL(spec, location.origin + url).pathname;
        dependencies.push(dep);
        return prefix + JSON.stringify('https://callgraph.invalid' + dep);
      });
    await Promise.all(dependencies.map(collect));
  }
  const [, variables, details] = await Promise.all([
    collect('/lib/offline.js'), api.vars(),
    Promise.all(view.nodes.filter((n) => n.kind !== 'var').map(async (n) => [n.id, await api.node(n.id)])),
  ]);
  if (!variables.list) throw new Error(variables.error || '读取变量清单失败');
  const project = await api.project();
  if (state.view?.projectId !== view.projectId || project.id !== view.projectId) {
    throw new Error('导出过程中工程已切换，请重新导出');
  }
  snapshot.variables = variables.list;
  snapshot.details = Object.fromEntries(details);
  snapshot.project = { id: project.id, name: project.name, path: project.path };
  const title = view.nodes.find((n) => n.id === view.root)?.name || view.root || 'callgraph';
  const json = JSON.stringify({ snapshot, sources }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · TCU 调用关系图</title>
<style>${css}
#app { grid-template-columns: minmax(0, 1fr) 310px; grid-template-areas: "top top" "main right"; }
.offline-bar { display:flex; align-items:center; flex-wrap:wrap; gap:12px; padding:10px 14px; }
.offline-bar .hint { white-space:normal; }
</style></head><body>
<div id="app">
<header class="offline-bar"><b>TCU 调用关系图</b><span>${esc(title)}</span><button id="offlineFit">适应</button>
<button id="offlinePng">导出 PNG</button><button id="offlineSvg">导出 SVG</button>
<span class="hint">离线快照 · 滚轮上下移动 · Shift+滚轮左右移动 · Ctrl+滚轮缩放 · 双击节点 / 层级标题 / 连线后调整 · 空白处 / Esc 退出移动 · Ctrl+Z 撤销 · 变量勾选表示导出时的入图状态</span></header>
<main><canvas id="cv"></canvas>${document.getElementById('legend').outerHTML}<div id="tooltip"></div><div id="ctxMenu"></div></main>
${right.outerHTML}
</div><div hidden><input id="search"><ul id="results"></ul></div>
<script>
window.__EXPORT = ${json};
const imports = {};
for (const [url, source] of Object.entries(__EXPORT.sources)) {
  imports['https://callgraph.invalid' + url] = URL.createObjectURL(new Blob([source], {type:'text/javascript'}));
}
const map = document.createElement('script');
map.type = 'importmap'; map.textContent = JSON.stringify({imports}); document.head.append(map);
const entry = document.createElement('script');
entry.type = 'module'; entry.textContent = 'import "https://callgraph.invalid/lib/offline.js";'; document.body.append(entry);
</script></body></html>`;
}
