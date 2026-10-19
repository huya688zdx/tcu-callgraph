/**
 * 导出：Excel 多 sheet / 单文件 HTML / SVG
 */

import fs from 'node:fs';
import path from 'node:path';
import { stats, tarjan } from './index.js';
import { layout } from './layout.js';
import { roundedPathD } from './routing.js';

const KIND_LABEL = { direct: '直接调用', macro: '经宏调用', fnptr: '函数指针', unknown: '未知' };

async function exportXlsxLegacy(model, outPath) {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = 'TCU CallGraph';
  wb.created = new Date();

  const S = stats(model);
  const { byId, outAdj, inAdj } = model._index;

  // ---- 概览 ----
  const ov = wb.addWorksheet('概览');
  ov.columns = [
    { header: '指标', key: 'k', width: 24 },
    { header: '数值', key: 'v', width: 46 },
  ];
  ov.getRow(1).font = { bold: true };
  const rows = [
    ['工程根目录', model.root],
    ['文件数', S.files],
    ['函数数', S.functions],
    ['外部符号', S.externals],
    ['调用边总数', S.edges],
    ['经宏的边', S.macroEdges],
    ['函数指针边', S.fnptrEdges],
    ['宏定义数', S.macros],
    ['最大扇出', `${S.maxFanOut}  (${S.maxFanOutFn})`],
    ['最大扇入', `${S.maxFanIn}  (${S.maxFanInFn})`],
    ['调用环组数', S.cycles],
    ['解析耗时', `${S.elapsedMs} ms`],
    ['生成时间', new Date().toLocaleString('zh-CN')],
  ];
  rows.forEach((r) => ov.addRow({ k: r[0], v: r[1] }));

  // ---- 函数表 ----
  const fnSheet = wb.addWorksheet('函数');
  fnSheet.columns = [
    { header: '函数名', key: 'name', width: 30 },
    { header: '文件', key: 'file', width: 26 },
    { header: '行号', key: 'line', width: 8 },
    { header: '扇入', key: 'fanIn', width: 8 },
    { header: '扇出', key: 'fanOut', width: 8 },
    { header: 'static', key: 'isStatic', width: 8 },
    { header: '参数', key: 'params', width: 26 },
    { header: '条件编译', key: 'cond', width: 26 },
    { header: '备注', key: 'note', width: 34 },
  ];
  fnSheet.getRow(1).font = { bold: true };
  for (const f of model.functions) {
    fnSheet.addRow({
      name: f.name,
      file: f.file,
      line: f.line,
      fanIn: (inAdj.get(f.id) || []).length,
      fanOut: (outAdj.get(f.id) || []).length,
      isStatic: f.isStatic ? 'Y' : '',
      params: (f.params || []).join(', '),
      cond: f.cond || '',
      note: '',
    });
  }
  fnSheet.autoFilter = { from: 'A1', to: `I${fnSheet.rowCount}` };
  fnSheet.views = [{ state: 'frozen', ySplit: 1 }];

  // ---- 调用边 ----
  const edSheet = wb.addWorksheet('调用边');
  edSheet.columns = [
    { header: '调用方', key: 'from', width: 30 },
    { header: '被调方', key: 'to', width: 30 },
    { header: '文件', key: 'file', width: 22 },
    { header: '调用点行号', key: 'line', width: 12 },
    { header: '类型', key: 'kind', width: 12 },
    { header: '宏 / 指针来源', key: 'via', width: 30 },
    { header: '条件编译', key: 'cond', width: 26 },
  ];
  edSheet.getRow(1).font = { bold: true };
  for (const e of model.edges) {
    const fromFn = byId.get(e.from);
    edSheet.addRow({
      from: fromFn ? fromFn.name : e.from,
      to: e.callee,
      file: fromFn ? fromFn.file : '',
      line: e.line || '',
      kind: KIND_LABEL[e.kind] || e.kind,
      via: e.via || '',
      cond: e.cond || '',
    });
  }
  edSheet.autoFilter = { from: 'A1', to: `G${edSheet.rowCount}` };
  edSheet.views = [{ state: 'frozen', ySplit: 1 }];

  // ---- 宏表 ----
  const macSheet = wb.addWorksheet('宏定义');
  macSheet.columns = [
    { header: '宏名', key: 'name', width: 24 },
    { header: '参数', key: 'params', width: 20 },
    { header: '宏体', key: 'raw', width: 62 },
    { header: '定义位置', key: 'where', width: 26 },
    { header: '条件编译', key: 'cond', width: 24 },
    { header: '展开出的调用', key: 'calls', width: 40 },
  ];
  macSheet.getRow(1).font = { bold: true };
  for (const m of model.macros) {
    if (!m.raw || !m.raw.trim()) continue;
    const calls = [
      ...new Set(
        model.edges
          .filter((e) => e.macroChain && e.macroChain.includes(m.name))
          .map((e) => e.callee)
      ),
    ];
    macSheet.addRow({
      name: m.name,
      params: m.params ? m.params.join(', ') : '(对象宏)',
      raw: m.raw,
      where: `${m.file}:${m.line}`,
      cond: m.cond || '',
      calls: calls.join(', '),
    });
  }

  // ---- 函数指针表 ----
  if (model.fnptrTables.length) {
    const fpSheet = wb.addWorksheet('函数指针表');
    fpSheet.columns = [
      { header: '表变量', key: 'table', width: 24 },
      { header: '成员', key: 'field', width: 22 },
      { header: '实际函数', key: 'fn', width: 30 },
    ];
    fpSheet.getRow(1).font = { bold: true };
    for (const t of model.fnptrTables) {
      for (const [k, v] of Object.entries(t.map)) {
        fpSheet.addRow({ table: t.name, field: k, fn: v });
      }
    }
  }

  // ---- 调用环 ----
  const sccs = tarjan(model).filter((c) => c.length > 1);
  if (sccs.length) {
    const cySheet = wb.addWorksheet('调用环');
    cySheet.columns = [
      { header: '组', key: 'g', width: 8 },
      { header: '成员', key: 'm', width: 80 },
    ];
    cySheet.getRow(1).font = { bold: true };
    sccs.forEach((c, i) => cySheet.addRow({ g: i + 1, m: c.join(' → ') }));
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await wb.xlsx.writeFile(outPath);
  return outPath;
}

export function buildSVGFromLayout(laid) {
  const pad = 24;
  const W = laid.width + pad * 2;
  const H = laid.height + pad * 2;
  const out = [];
  const C = { direct: '#9A9890', macro: '#D85A30', fnptr: '#7F77DD', unknown: '#C9C7BE' };

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
    const c = C[e.kind] || C.direct;
    const dash = e.kind !== 'direct' ? ' stroke-dasharray="5 3"' : '';
    out.push(
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.3"${dash} marker-end="url(#mk-${e.kind in C ? e.kind : 'direct'})" data-from="${esc(e.from)}" data-to="${esc(e.to)}"/>`
    );
  }

  for (const n of laid.nodes) {
    out.push(`<g data-id="${esc(n.id)}" data-name="${esc(n.name)}">`);
    out.push(
      `<rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="8" fill="#fff" stroke="#B5D4F4" stroke-width="1"/>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 - 7).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="12.5" font-weight="500" fill="#2C2C2A">${esc(n.name)}</text>`
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

export function exportSvg(model, outPath, opts = {}) {
  const laid = layout(model.functions, model.edges, opts);
  const svg = buildSVGFromLayout(laid);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, svg, 'utf8');
  return outPath;
}

/** 单文件 HTML：内嵌 SVG 与数据，双击即可离线查看 */
export function exportHtml(model, outPath, opts = {}) {
  const laid = layout(model.functions, model.edges, opts);
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
      name: n.name,
      file: n.file,
      line: n.line,
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
const DATA = ${JSON.stringify(payload)};
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
  const chip = e => e.kind === 'macro' ? '<span class="chip m">宏' + (e.via ? ':' + e.via : '') + '</span>' : e.kind === 'fnptr' ? '<span class="chip f">指针' + (e.via ? ':' + e.via : '') + '</span>' : '';
  info.innerHTML = '<div style="font-weight:500;font-size:13px;color:#2C2C2A;margin-bottom:2px">' + n.name + '</div>' +
    '<div style="margin-bottom:8px">' + n.file + ':' + n.line + ' · ↑' + n.fanIn + ' ↓' + n.fanOut + '</div>' +
    (out.length ? '<div style="margin-bottom:2px">调用：</div>' + out.map(e => '<div>→ ' + e.callee + ' <span style="color:#B4B2A9">:' + e.line + '</span> ' + chip(e) + '</div>').join('') : '') +
    (inc.length ? '<div style="margin-top:6px;margin-bottom:2px">被调用：</div>' + inc.map(e => '<div>← ' + (DATA.nodes.find(x => x.id === e.from) || {}).name + ' <span style="color:#B4B2A9">:' + e.line + '</span> ' + chip(e) + '</div>').join('') : '');
  document.querySelectorAll('path[data-from]').forEach(p => {
    p.classList.toggle('hit', p.dataset.from !== id && p.dataset.to !== id);
  });
}
document.getElementById('macros').innerHTML = DATA.macros.map(m =>
  '<li><b>' + m.name + (m.params ? '(' + m.params.join(',') + ')' : '') + '</b><br><span style="color:#888780">' + m.raw.slice(0, 70) + '</span></li>'
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
