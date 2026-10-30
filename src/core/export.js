/**
 * 导出：Excel 多 sheet / 单文件 HTML / SVG
 */

import fs from 'node:fs';
import path from 'node:path';
import { stats } from './index.js';
import { layoutElk } from './layout-elk.js';
import { roundedPathD } from './routing.js';

export function buildSVGFromLayout(laid) {
  const pad = 24;
  const W = laid.width + pad * 2;
  const H = laid.height + pad * 2;
  const out = [];
  const C = { direct: '#2C2C2A', var: '#2C2C2A', added: '#D9303E' };

  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${-pad} ${-pad} ${W} ${H}" font-family="Segoe UI, Microsoft YaHei, sans-serif">`
  );
  out.push(`<title>TCU 调用关系图</title>`);
  out.push(`<rect x="${-pad}" y="${-pad}" width="${W}" height="${H}" fill="#F7F6F2"/>`);
  out.push('<defs>');
  for (const [k, c] of Object.entries(C)) {
    out.push(
      `<marker id="mk-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/></marker>`
    );
  }
  out.push('</defs>');

  for (const e of laid.edges) {
    const d = roundedPathD(e.points, 7);
    const style = e.change === 'added' ? 'added' : e.kind === 'var' ? 'var' : 'direct';
    const c = C[style];
    const dash = e.kind === 'var' ? ' stroke-dasharray="7 4"' : '';
    out.push(
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.3"${dash} marker-end="url(#mk-${style})" data-from="${esc(e.from)}" data-to="${esc(e.to)}"/>`
    );
  }

  for (const n of laid.nodes) {
    out.push(`<g data-id="${esc(n.id)}" data-name="${esc(n.displayName || n.name)}">`);
    out.push(
      `<rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="8" fill="${{existing:'#CCFFCC',modified:'#FFFF99',added:'#FFCCFF',deleted:'#BFBFBF'}[n.change] || '#fff'}" stroke="#B5D4F4" stroke-width="1"/>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 - 7).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="12.5" font-weight="500" fill="#2C2C2A">${esc(n.displayName || n.name)}</text>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 + 10).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10.5" fill="#888780">${esc(n.external ? '外部符号' : `${n.file}:${n.line}`)}</text>`
    );
    out.push('</g>');
  }

  out.push('</svg>');
  return out.join('\n');
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 内联进 <script> 的 JSON：转义 < 与 U+2028/2029。
 * 宏体、文件名里出现 "</script>" 时，不转义会提前闭合脚本块并把后续源码当 HTML 解析。
 */
function inlineJson(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export async function exportSvg(model, outPath, opts = {}) {
  const laid = await layoutElk(model.functions, model.edges, { group: false, ...opts });
  const svg = buildSVGFromLayout(laid);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg, 'utf8');
  return outPath;
}

/** 单文件 HTML：内嵌 SVG 与数据，双击即可离线查看 */
export async function exportHtml(model, outPath, opts = {}) {
  const laid = await layoutElk(model.functions, model.edges, { group: false, ...opts });
  const svg = buildSVGFromLayout(laid);
  const S = stats(model);

  const payload = {
    stats: {
      files: S.files,
      functions: S.functions,
      edges: S.edges,
      macros: S.macros,
      macroEdges: S.macroEdges,
      fnptrEdges: S.fnptrEdges,
      cycles: S.cycles,
    },
    nodes: laid.nodes.map((n) => ({
      id: n.id,
      name: n.displayName || n.name,
      file: n.file,
      line: n.line,
      change: n.change,
      detectedChange: n.detectedChange,
      statusSource: n.statusSource,
      fanIn: (model._index.inAdj.get(n.id) || []).length,
      fanOut: (model._index.outAdj.get(n.id) || []).length,
    })),
    edges: laid.edges.map((e) => ({
      from: e.from,
      to: e.to,
      callee: e.callee,
      kind: e.kind,
      line: e.line,
      via: e.via,
      cond: e.cond,
    })),
    macros: model.macros
      .filter((m) => m.raw && m.raw.trim())
      .map((m) => ({ name: m.name, params: m.params, raw: m.raw, file: m.file, line: m.line })),
  };

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>TCU 调用关系图</title>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#F7F6F2;color:#2C2C2A;display:grid;grid-template-columns:1fr 320px;grid-template-rows:48px 1fr;height:100vh;overflow:hidden}
header{grid-column:1/3;display:flex;align-items:center;gap:12px;padding:0 14px;background:#fff;border-bottom:1px solid rgba(0,0,0,.1)}
h1{font-size:14px;font-weight:500;margin:0}
input{height:30px;padding:0 10px;border:1px solid rgba(0,0,0,.16);border-radius:8px;font-size:13px;outline:none;width:220px}
#wrap{overflow:hidden;position:relative;cursor:grab}
#wrap.drag{cursor:grabbing}
#stage{transform-origin:0 0;position:absolute;left:0;top:0}
aside{background:#fff;border-left:1px solid rgba(0,0,0,.08);overflow:auto;padding:14px;font-size:12.5px}
aside h2{font-size:12px;font-weight:500;color:#5F5E5A;margin:0 0 8px}
.kv{display:flex;justify-content:space-between;padding:3px 0}
.kv b{font-weight:500;color:#185FA5}
.hint{color:#B4B2A9;font-size:11.5px;line-height:1.6}
.hit{opacity:.18}
.on rect{stroke:#185FA5!important;stroke-width:2.4!important}
.chip{display:inline-block;padding:1px 6px;border-radius:20px;font-size:10.5px;background:#E6F1FB;color:#0C447C;margin-right:4px}
.chip.m{background:#FAECE7;color:#993C1D}
.chip.f{background:#EEEDFE;color:#534AB7}
li{margin-bottom:6px;list-style:none}
ul{padding:0;margin:0}
</style></head>
<body>
<header><h1>TCU 调用关系图</h1><input id="q" placeholder="搜索函数名…"><span class="hint">滚轮缩放 · 拖拽平移 · 点击高亮</span></header>
<div id="wrap"><div id="stage">${svg}</div></div>
<aside>
<h2>概览</h2>
<div class="kv"><span>函数</span><b>${S.functions}</b></div>
<div class="kv"><span>调用边</span><b>${S.edges}</b></div>
<div class="kv"><span>经宏的边</span><b>${S.macroEdges}</b></div>
<div class="kv"><span>函数指针边</span><b>${S.fnptrEdges}</b></div>
<div class="kv"><span>宏定义</span><b>${S.macros}</b></div>
<div class="kv"><span>调用环</span><b>${S.cycles}</b></div>
<h2 style="margin-top:16px">选中</h2>
<div id="info" class="hint">点击图中节点查看</div>
<h2 style="margin-top:16px">宏定义（含调用）</h2>
<ul id="macros"></ul>
</aside>
<script>
const DATA = ${inlineJson(payload)};
const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const stage = document.getElementById('stage');
const wrap = document.getElementById('wrap');
let k = 1, tx = 0, ty = 0, dragging = false, moved = false, lx = 0, ly = 0;

function apply(){ stage.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + k + ')'; }
function fit(){
  const svg = stage.querySelector('svg');
  const W = wrap.clientWidth, H = wrap.clientHeight;
  const vb = svg.viewBox.baseVal;
  k = Math.min(W / vb.width, H / vb.height, 1.8) * 0.95;
  tx = (W - vb.width * k) / 2 - vb.x * k;
  ty = (H - vb.height * k) / 2 - vb.y * k;
  apply();
}
wrap.addEventListener('wheel', e => {
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const wx = (sx - tx) / k, wy = (sy - ty) / k;
  k = Math.min(4, Math.max(0.05, k * Math.exp(-e.deltaY * 0.0014)));
  tx = sx - wx * k; ty = sy - wy * k; apply();
}, { passive: false });
wrap.addEventListener('pointerdown', e => { dragging = true; moved = false; lx = e.clientX; ly = e.clientY; wrap.classList.add('drag'); });
wrap.addEventListener('pointermove', e => {
  if (!dragging) return;
  const dx = e.clientX - lx, dy = e.clientY - ly;
  if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
  tx += dx; ty += dy; lx = e.clientX; ly = e.clientY; apply();
});
wrap.addEventListener('pointerup', e => {
  dragging = false; wrap.classList.remove('drag');
  if (moved) return;
  const g = e.target.closest('g[data-id]');
  select(g ? g.dataset.id : null);
});
function select(id){
  document.querySelectorAll('g[data-id]').forEach(g => g.classList.toggle('on', g.dataset.id === id));
  const info = document.getElementById('info');
  if (!id) { info.textContent = '点击图中节点查看'; document.querySelectorAll('path').forEach(p => p.classList.remove('hit')); return; }
  const n = DATA.nodes.find(x => x.id === id);
  const out = DATA.edges.filter(e => e.from === id);
  const inc = DATA.edges.filter(e => e.to === id);
  const chip = e => e.kind === 'macro' ? '<span class="chip m">宏' + (e.via ? ':' + escHtml(e.via) : '') + '</span>' : e.kind === 'fnptr' ? '<span class="chip f">指针' + (e.via ? ':' + escHtml(e.via) : '') + '</span>' : '';
  info.innerHTML = '<div style="font-weight:500;font-size:13px;color:#2C2C2A;margin-bottom:2px">' + escHtml(n.name) + '</div>' +
    '<div style="margin-bottom:8px">' + escHtml(n.file) + ':' + n.line + ' · ↑' + n.fanIn + ' ↓' + n.fanOut + '</div>' +
    (out.length ? '<div style="margin-bottom:2px">调用：</div>' + out.map(e => '<div>→ ' + escHtml(e.callee) + ' <span style="color:#B4B2A9">:' + e.line + '</span> ' + chip(e) + '</div>').join('') : '') +
    (inc.length ? '<div style="margin-top:6px;margin-bottom:2px">被调用：</div>' + inc.map(e => '<div>← ' + escHtml((DATA.nodes.find(x => x.id === e.from) || {}).name) + ' <span style="color:#B4B2A9">:' + e.line + '</span> ' + chip(e) + '</div>').join('') : '');
  document.querySelectorAll('path[data-from]').forEach(p => {
    p.classList.toggle('hit', p.dataset.from !== id && p.dataset.to !== id);
  });
}
document.getElementById('macros').innerHTML = DATA.macros.map(m =>
  '<li><b>' + escHtml(m.name) + (m.params ? '(' + escHtml(m.params.join(',')) + ')' : '') + '</b><br><span style="color:#888780">' + escHtml(m.raw.slice(0, 70)) + '</span></li>'
).join('');
document.getElementById('q').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase();
  document.querySelectorAll('g[data-id]').forEach(g => {
    const hit = !q || (g.dataset.name || '').toLowerCase().includes(q);
    g.style.opacity = hit ? 1 : 0.12;
  });
});
window.addEventListener('resize', fit);
fit();
</script>
</body></html>`;

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

export { exportXlsx } from './export-xlsx.js';
