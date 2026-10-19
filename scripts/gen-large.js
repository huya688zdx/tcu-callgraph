import fs from 'node:fs';
import path from 'node:path';

const N = Number(process.argv[2] || 3000);
const out = process.argv[3] || 'samples/large';

fs.mkdirSync(out, { recursive: true });

const parts = [];
parts.push('#ifndef BIG_CONFIG_H');
parts.push('#define BIG_CONFIG_H');
parts.push('#define STEP(x)  F_0((x) + 1)');
parts.push('#define CALL2(a,b) do { a(); b(); } while (0)');
parts.push('#endif');
fs.writeFileSync(path.join(out, 'config.h'), parts.join('\n'), 'utf8');

const lines = [];
lines.push('#include "config.h"');
lines.push('');
for (let i = 0; i < N; i++) {
  lines.push(`int F_${i}(int a);`);
}
lines.push('');

for (let i = 0; i < N; i++) {
  lines.push(`int F_${i}(int a)`);
  lines.push('{');
  lines.push('    int r = a;');
  for (let j = 1; j <= 3; j++) {
    const t = (i * 7 + j * 13 + 1) % N;
    lines.push(`    r += F_${t}(r + ${j});`);
  }
  if (i % 10 === 0) {
    lines.push('    r += STEP(r);');
  }
  lines.push('    return r;');
  lines.push('}');
  lines.push('');
}

fs.writeFileSync(path.join(out, 'big.c'), lines.join('\n'), 'utf8');

const kb = fs.statSync(path.join(out, 'big.c')).size / 1024;
console.log(`生成 ${N} 个函数，${kb.toFixed(0)} KB → ${path.join(out, 'big.c')}`);
