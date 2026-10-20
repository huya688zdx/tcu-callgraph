/**
 * 导出：SVG 构建与下载
 * 注意：这里的样式与 render.js 是两套实现，改动样式时两边都要动
 */
import { t } from '../i18n.js';
import { state, COLORS, esc, shortFile } from './state.js';
import { updateGroups } from './render.js';
import { roundedPathD } from '/core/routing.js';
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function buildSVG() {
  const v = state.view;
  updateGroups(); // 分组框跟随当前节点位置
  const pad = 24;

  // 实际内容范围（含手动布线 / 侧边车道）
  let minX = 0;
  let minY = 0;
  let maxX = v.width;
  let maxY = v.height;
  for (const n of v.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const e of v.edges) {
    for (const p of e.points || []) {
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  const ox = -pad - Math.min(0, minX);
  const oy = -pad - Math.min(0, minY);
  const W = maxX - minX + pad * 2;
  const H = maxY - minY + pad * 2;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${ox} ${oy} ${W} ${H}" font-family="Segoe UI, Microsoft YaHei, sans-serif">`
  );
  out.push(`<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="#F7F6F2"/>`);
  out.push('<defs>');
  for (const [k, c] of Object.entries(COLORS)) {
    out.push(
      `<marker id="mk-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/></marker>`
    );
  }
  out.push('</defs>');

  if (v.containers) {
    // 浅的先画（外层容器垫底），与画布绘制顺序一致
    for (const c of [...v.containers].sort((a, b) => a.depth - b.depth)) {
      out.push(
        `<rect x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" width="${c.w.toFixed(1)}" height="${c.h.toFixed(1)}" rx="14" fill="rgba(230,241,251,${(0.16 + Math.min(0.1, c.depth * 0.04)).toFixed(2)})" stroke="rgba(107,163,224,${(0.55 + Math.min(0.25, c.depth * 0.08)).toFixed(2)})" stroke-width="1.4"/>`
      );
      out.push(
        `<text x="${(c.x + 12).toFixed(1)}" y="${(c.y + 18).toFixed(1)}" font-size="13" font-weight="600" fill="#0C447C">${esc(c.label)}</text>`
      );
    }
  }

  if (v.groups) {
    for (const g of v.groups) {
      out.push(
        `<rect x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" rx="12" fill="rgba(230,241,251,0.45)" stroke="#B5D4F4" stroke-width="1.2"/>`
      );
      out.push(
        `<path d="M ${g.x.toFixed(1)} ${(g.y + 26).toFixed(1)} H ${(g.x + g.w).toFixed(1)}" stroke="none"/>`
      );
      out.push(
        `<text x="${(g.x + 12).toFixed(1)}" y="${(g.y + 14).toFixed(1)}" font-size="13" font-weight="500" fill="#0C447C">${esc(g.label)}</text>`
      );
    }
  }

  for (const e of v.edges) {
    const d = roundedPathD(e.points, 7);
    const c = COLORS[e.kind] || COLORS.direct;
    const dash = e.kind === 'macro' || e.kind === 'fnptr' ? ' stroke-dasharray="5 3"' : '';
    out.push(
      `<path d="${d}" fill="none" stroke="${c}" stroke-width="1.3"${dash} marker-end="url(#mk-${e.kind in COLORS ? e.kind : 'direct'})" data-from="${esc(e.from)}" data-to="${esc(e.to)}"/>`
    );
  }

  for (const n of v.nodes) {
    out.push(`<g data-id="${esc(n.id)}">`);
    out.push(
      `<rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="8" fill="${n.color || '#fff'}" stroke="#B5D4F4" stroke-width="1"/>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 - 7).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="12.5" font-weight="500" fill="#2C2C2A">${esc(n.name)}</text>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 + 10).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10.5" fill="#888780">${esc(n.external ? t('node.external') : shortFile(n.file) + ':' + n.line)}</text>`
    );
    out.push('</g>');
  }

  out.push('</svg>');
  return out.join('\n');
}
export { download, buildSVG };
