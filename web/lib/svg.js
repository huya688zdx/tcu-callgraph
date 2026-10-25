/**
 * 导出：SVG 构建与下载
 * 注意：这里的样式与 render.js 是两套实现，改动样式时两边都要动
 */
import { t } from '../i18n.js';
import { state, cam, els, FONT, THEME, hexToRgba, esc, shortFile } from './state.js';
import { labelLayout } from './edge-labels.js';
import { labelSvg } from '/core/labels.js';

/** 只接受 #RRGGBB：n.color 可经 /api/overlay 落库，导出的 SVG 会被浏览器直接打开 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function buildSVG() {
  const v = state.view;
  const labels = labelLayout(v);
  const pad = 24;

  // 实际内容范围（含手动布线 / 侧边车道）
  let minX = 0;
  let minY = 0;
  let maxX = v.width;
  let maxY = v.height;
  for (const n of [...v.nodes, ...(v.groups || []), ...(v.containers || []), ...labels.map((l) => l.rect)]) {
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
  const ox = minX - pad;
  const oy = minY - pad;
  const W = maxX - minX + pad * 2;
  const H = maxY - minY + pad * 2;

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="${ox} ${oy} ${W} ${H}" font-family="${esc(FONT)}">`
  );
  out.push(`<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="${THEME.bg}"/>`);
  out.push('<defs>');
  // 与画布一致：边的颜色只看变更分类（新增=红，其余深色），箭头跟着同色
  for (const [name, c] of [
    ['dark', THEME.edge.call],
    ['red', THEME.edge.added],
  ]) {
    out.push(
      `<marker id="mk-${name}" viewBox="-6 -3.3 6 6.6" refX="0" refY="0" markerWidth="6" markerHeight="6.6" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0L-6 3.3L-6 -3.3Z" fill="${c}"/></marker>`
    );
  }
  out.push('</defs>');

  if (v.containers) {
    // 浅的先画（外层容器垫底），与画布绘制顺序一致
    for (const c of [...v.containers].sort((a, b) => a.depth - b.depth)) {
      out.push(
        `<rect x="${c.x.toFixed(1)}" y="${c.y.toFixed(1)}" width="${c.w.toFixed(1)}" height="${c.h.toFixed(1)}" rx="14" fill="${hexToRgba(THEME.container.fill, 0.16 + Math.min(0.1, c.depth * 0.04))}" stroke="${hexToRgba(THEME.container.stroke, 0.55 + Math.min(0.25, c.depth * 0.08))}" stroke-width="1.4"/>`
      );
      const fs = Math.min(22, Math.max(12, 11 / cam.k)), bh = fs * 1.4;
      els.ctx.save(); els.ctx.font = `600 ${fs}px ${FONT}`;
      const tw = els.ctx.measureText(String(c.label)).width; els.ctx.restore();
      out.push(`<rect x="${c.x + 6}" y="${c.y + 4}" width="${tw + fs}" height="${bh}" rx="${bh / 2}" fill="${hexToRgba(THEME.container.stroke, 0.32)}" stroke="${hexToRgba(THEME.container.stroke, 0.55)}"/>`);
      out.push(`<text x="${c.x + 6 + fs * 0.5}" y="${c.y + 4 + bh / 2 + 0.5}" dominant-baseline="middle" font-size="${fs}" font-weight="600" fill="#0C447C">${esc(c.label)}</text>`);
    }
  }

  if (v.groups) {
    for (const [index, g] of v.groups.entries()) {
      out.push(
        `<rect x="${g.x.toFixed(1)}" y="${g.y.toFixed(1)}" width="${g.w.toFixed(1)}" height="${g.h.toFixed(1)}" rx="12" fill="${hexToRgba(THEME.container.fill, 0.45)}" stroke="${hexToRgba(THEME.container.stroke, 0.6)}" stroke-width="1.2"/>`
      );
      out.push(
        `<clipPath id="group-${index}"><rect x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="12"/></clipPath><rect x="${g.x}" y="${g.y}" width="${g.w}" height="26" fill="${hexToRgba(THEME.container.stroke, 0.5)}" clip-path="url(#group-${index})"/>`
      );
      out.push(
        `<text x="${(g.x + 12).toFixed(1)}" y="${(g.y + 14).toFixed(1)}" dominant-baseline="middle" font-size="${Math.min(26, Math.max(12, 11 / cam.k))}" font-weight="500" fill="#0C447C">${esc(g.label)}</text>`
      );
    }
  }

  for (let i = 0; i < v.edges.length; i++) {
    const e = v.edges[i];
    const d = (e.points || []).map(([x, y], j) => `${j ? 'L' : 'M'}${x} ${y}`).join(' ');
    // 与画布 drawEdge 相同：新增=红，变量访问=自己的线色（虚线），其余=调用色
    const c = e.change === 'added' ? THEME.edge.added : e.kind === 'var' ? THEME.edge.var : THEME.edge.call;
    // 变量访问=虚线，函数调用=实线（与画布 drawEdge 相同）
    const dash = e.kind === 'var' ? ' stroke-dasharray="7 4"' : '';
    const mk = e.change === 'added' ? 'mk-red' : 'mk-dark';
    out.push(
      `<path d="${esc(d)}" fill="none" stroke="${c}" stroke-width="1.4"${dash} marker-end="url(#${mk})" data-ei="${i}" data-from="${esc(e.from)}" data-to="${esc(e.to)}"/>`
    );
    if (e.change === 'deleted' && e.points?.length > 1) {
      const i = Math.max(1, Math.floor(e.points.length / 2));
      const a = e.points[i - 1], b = e.points[i], x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2, s = 5 / cam.k;
      out.push(`<path d="M${x - s} ${y - s}L${x + s} ${y + s}M${x + s} ${y - s}L${x - s} ${y + s}" stroke="#2C2C2A" stroke-width="${2.2 / cam.k}"/>`);
    }
  }

  for (const n of v.nodes) {
    const isVar = n.kind === 'var';
    out.push(`<g data-id="${esc(n.id)}">`);
    // 与画布保持一致：按变更分类上色，变量实线框、函数虚线框。
    const custom = HEX_COLOR.test(n.color || '') ? n.color : '';
    const fill =
      custom ||
      (n.external
        ? THEME.node.external
        : THEME.fill[n.change] || THEME.fill.existing);
    out.push(
      `<rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="8" fill="${esc(fill)}" stroke="${n.external ? THEME.node.externalBorder : THEME.node.border}" stroke-width="1"${isVar ? '' : ' stroke-dasharray="5 3"'}/>`
    );
    if (n.note) {
      out.push(`<circle cx="${(n.x + 8).toFixed(1)}" cy="${(n.y + 8).toFixed(1)}" r="3.2" fill="#EF9F27"/>`);
    }
    // 函数名带 ()、变量名不带；副标题：变量=类型，函数=文件:行号（与画布相同）
    const label = isVar ? n.name || n.id : `${n.name || n.id}()`;
    const sub = n.external
      ? t('node.external')
      : isVar
      ? n.typeText || t('node.variable')
      : `${shortFile(n.file)}:${n.line}`;
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 - 8).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="12.5" font-weight="500" fill="#2C2C2A">${esc(label)}</text>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 + 10).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10.5" fill="#888780">${esc(sub)}</text>`
    );
    out.push('</g>');
  }

  // 与画布相同：标签最后绘制，使用相同的测量、避让及颜色。
  for (const { label, rect } of labels) out.push(labelSvg(label, rect));

  out.push('</svg>');
  return out.join('\n');
}
export { buildSVG };
