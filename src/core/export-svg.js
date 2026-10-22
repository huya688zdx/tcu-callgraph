/**
 * 服务端 SVG 导出：与 web/lib/svg.js 的画布样式保持一致。
 *
 * 为什么不直接复用 web/lib/svg.js：
 * 前端版本依赖 i18n / state / render 的运行时（updateGroups 等 DOM 前置条件），
 * 服务端没有这些。两边的绘制规则（容器→分组→连线→节点，颜色、圆角折线）
 * 必须手工同步——改样式时两个文件都要动，svg.js 顶部也有同样的提醒。
 *
 * 输入是 buildView 的返回值（含 x/y/w/h 坐标、groups、containers、路由折线），
 * 所以 MCP / HTTP 导出的图与界面上看到的是同一份布局。
 */
import { roundedPathD } from './routing.js';

const COLORS = {
  direct: '#9A9890',
  macro: '#D85A30',
  fnptr: '#7F77DD',
  manual: '#639922',
  unknown: '#C9C7BE',
};

/** 函数框背景色：既存 / 変更 / 追加 / 削除（与 web/lib/state.js 的 CHANGE_FILL 一致） */
const CHANGE_FILL = {
  existing: '#CCFFCC',
  modified: '#FFFF99',
  added: '#FFCCFF',
  deleted: '#BFBFBF',
};

/** 只接受 #RRGGBB：标注里的自定义颜色会被浏览器直接打开，必须挡掉注入 */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const shortFile = (f) => {
  if (!f) return '';
  const parts = String(f).split(/[\\/]/);
  return parts.slice(-2).join('/');
};

/** 与 i18n 的 node.external 对应；服务端不引入 i18n，写死中文 */
const EXTERNAL_LABEL = '外部符号';

/**
 * 生成整张视图的 SVG 文本。
 * @param {object} view buildView 的返回值（nodes / edges / groups / containers / width / height）
 * @param {object} [opts]
 * @param {string} [opts.title] 左上角标题（通常为工程名 / 入口函数），空则不画
 */
export function exportSvg(view, { title = '' } = {}) {
  const v = view || {};
  const pad = 24;

  // 实际内容范围（含手动布线 / 侧边车道），与前端导出同一套兜底
  let minX = 0;
  let minY = 0;
  let maxX = v.width || 480;
  let maxY = v.height || 260;
  for (const n of v.nodes || []) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.w);
    maxY = Math.max(maxY, n.y + n.h);
  }
  for (const e of v.edges || []) {
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

  if (title) {
    out.push(
      `<text x="${(ox + 4).toFixed(1)}" y="${(oy + 18).toFixed(1)}" font-size="14" font-weight="600" fill="#0C447C">${esc(title)}</text>`
    );
  }

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
        `<text x="${(g.x + 12).toFixed(1)}" y="${(g.y + 14).toFixed(1)}" font-size="13" font-weight="500" fill="#0C447C">${esc(g.label)}</text>`
      );
    }
  }

  for (const e of v.edges || []) {
    if (!Array.isArray(e.points) || e.points.length < 2) continue;
    const d = roundedPathD(e.points, 7);
    const c = COLORS[e.kind] || COLORS.direct;
    const dash = e.kind === 'macro' || e.kind === 'fnptr' ? ' stroke-dasharray="5 3"' : '';
    out.push(
      `<path d="${esc(d)}" fill="none" stroke="${c}" stroke-width="1.3"${dash} marker-end="url(#mk-${e.kind in COLORS ? e.kind : 'direct'})" data-from="${esc(e.from)}" data-to="${esc(e.to)}"/>`
    );
  }

  for (const n of v.nodes || []) {
    out.push(`<g data-id="${esc(n.id)}">`);
    // 与画布保持一致：按变更分类上色；自定义颜色只认 #RRGGBB
    const custom = HEX_COLOR.test(n.color || '') ? n.color : '';
    const fill =
      custom ||
      (n.external
        ? '#FAFAF7'
        : CHANGE_FILL[n.change] || CHANGE_FILL.existing);
    out.push(
      `<rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="8" fill="${esc(fill)}" stroke="#3A3A36" stroke-width="1" stroke-dasharray="5 3"/>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 - 7).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="12.5" font-weight="500" fill="#2C2C2A">${esc(n.name)}</text>`
    );
    out.push(
      `<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 + 10).toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="10.5" fill="#888780">${esc(n.external ? EXTERNAL_LABEL : shortFile(n.file) + ':' + n.line)}</text>`
    );
    out.push('</g>');
  }

  out.push('</svg>');
  return out.join('\n');
}
