/** 生成 flat 布局 SVG（用于布局算法前后对比） */
import { loadModel, subgraph } from '../src/core/index.js';
import { layoutElk } from '../src/core/layout-elk.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const model = loadModel('samples/tcu');
const g = subgraph(model, 'main.c::main', { up: 0, down: 3, maxNodes: 600 });
const clean = g.nodes.map(({ bodyTokens, ...rest }) => rest);
const laid = await layoutElk(clean, g.edges, { group: false });

const pad = 30;
let maxX = 0;
let maxY = 0;
for (const n of laid.nodes) {
  maxX = Math.max(maxX, n.x + n.w);
  maxY = Math.max(maxY, n.y + n.h);
}
for (const e of laid.edges) for (const p of e.points || []) {
  maxX = Math.max(maxX, p[0]);
  maxY = Math.max(maxY, p[1]);
}
const W = maxX + pad;
const H = maxY + pad;

const out = [];
out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, Microsoft YaHei, sans-serif">`);
out.push(`<rect width="${W}" height="${H}" fill="#F7F6F2"/>`);
for (const e of laid.edges) {
  const pts = e.points || [];
  if (pts.length < 2) continue;
  const d = 'M ' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L ');
  const c = e.kind === 'macro' ? '#D85A30' : e.kind === 'fnptr' ? '#7F77DD' : '#9A9890';
  out.push(`<path d="${d}" fill="none" stroke="${c}" stroke-width="1.2" opacity="0.85"/>`);
}
for (const n of laid.nodes) {
  out.push(`<rect x="${n.x.toFixed(1)}" y="${n.y.toFixed(1)}" width="${n.w}" height="${n.h}" rx="7" fill="${n.external ? '#FAFAF7' : '#fff'}" stroke="${n.external ? '#D3D1C7' : '#B5D4F4'}" stroke-width="1"/>`);
  out.push(`<text x="${(n.x + n.w / 2).toFixed(1)}" y="${(n.y + n.h / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="12" fill="#2C2C2A">${n.name || n.id}</text>`);
}
out.push('</svg>');
const outFile = process.argv[2] || path.join(os.tmpdir(), 'layout-preview.svg');
fs.writeFileSync(outFile, out.join('\n'), 'utf8');
console.log(`written: ${Math.round(W)}x${Math.round(H)}, nodes=${laid.nodes.length}, edges=${laid.edges.length} → ${outFile}`);
