// 生成多目录 / 多文件的 C 样本，用于验证分组布局的物理隔离
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || 'samples/multi';
const DIRS = [
  ['src/core', 8],
  ['src/drivers', 8],
  ['src/drivers/hal', 6],
  ['app', 4],
  ['app/tasks', 4],
];
const FNS_PER_FILE = 6;

fs.rmSync(OUT, { recursive: true, force: true });

let seed = 20261020;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const plan = [];
for (const [dir, n] of DIRS) {
  for (let f = 0; f < n; f++) {
    const base = dir.replace(/\//g, '_');
    const fns = [];
    for (let i = 0; i < FNS_PER_FILE; i++) fns.push(`Fn_${base}_${f}_${i}`);
    plan.push({ file: `${dir}/mod_${f}.c`, fns });
  }
}

const all = plan.flatMap((p) => p.fns.map((name) => ({ name, file: p.file })));

for (const p of plan) {
  const abs = path.join(OUT, p.file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const lines = ['#include "mod.h"', ''];
  p.fns.forEach((fn, i) => {
    lines.push(`void ${fn}(void)`);
    lines.push('{');
    lines.push(`    unsigned int v${i} = ${i}u;`);
    const calls = 1 + Math.floor(rnd() * 3);
    for (let c = 0; c < calls; c++) {
      const t = all[Math.floor(rnd() * all.length)];
      if (t && t.name !== fn) lines.push(`    ${t.name}();`);
    }
    lines.push(`    (void)v${i};`);
    lines.push('}');
    lines.push('');
  });
  fs.writeFileSync(abs, lines.join('\n'), 'utf8');
}

// 入口
const mainAbs = path.join(OUT, 'app/main.c');
fs.mkdirSync(path.dirname(mainAbs), { recursive: true });
const entry = [];
for (let i = 0; i < 6; i++) entry.push(`    ${all[Math.floor(rnd() * all.length)].name}();`);
fs.writeFileSync(mainAbs, `int main(void)\n{\n${entry.join('\n')}\n    return 0;\n}\n`, 'utf8');

console.log(`生成 ${plan.length + 1} 个文件 / ${all.length} 个函数 → ${OUT}`);
