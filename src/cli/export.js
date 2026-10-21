import path from 'node:path';
import fs from 'node:fs';
import { loadModel } from '../core/index.js';
import { exportXlsx, exportSvg, exportHtml } from '../core/export.js';

const target = process.argv[2] || 'samples/tcu';
const outDir = path.resolve(process.argv[3] || 'out');
const root = path.resolve(target);

if (!fs.existsSync(root)) {
  console.error(`路径不存在: ${root}`);
  process.exit(1);
}

const model = loadModel(root);
console.log(`[加载] ${model.functions.length} 函数 / ${model.edges.length} 边`);

fs.mkdirSync(outDir, { recursive: true });

const t0 = Date.now();
const xlsx = await exportXlsx(model, path.join(outDir, 'callgraph.xlsx'));
console.log(`[Excel] ${xlsx}`);

const svg = exportSvg(model, path.join(outDir, 'callgraph.svg'));
console.log(`[SVG]   ${svg}`);

const html = exportHtml(model, path.join(outDir, 'callgraph.html'));
console.log(`[HTML]  ${html}`);

console.log(`[完成] ${Date.now() - t0} ms`);
