// 调试单个视图的固定布局层级几何
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ROOT_ID = process.argv[2];
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dbg-'));
const child = fork(path.join(ROOT, 'src/server.js'), ['samples/deep', '0'], {
  cwd: ROOT,
  env: { ...process.env, CALLGRAPH_DB: path.join(tmpDir, 'db.sqlite') },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
const port = await new Promise((res, rej) => {
  child.on('message', (m) => m?.ready && res(m.port));
  setTimeout(() => rej(new Error('timeout')), 20000);
});
const base = `http://127.0.0.1:${port}`;
const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => (await fetch(base + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})).json();

const root = encodeURIComponent(ROOT_ID);
const v0 = await get(`/api/view?root=${root}&group=1&down=3`);
const nodes = {};
if (process.argv[3] === 'foreign') {
  const ns = v0.nodes;
  const a = ns[0];
  const b = ns[ns.length - 1];
  const g = v0.groups.find((x) => x.id === b.group);
  nodes[a.id] = { x: g.x + 20, y: g.y + 40 };
  console.log(`钉 ${a.id} (${a.group}) 到 ${g.id} 内 (${(g.x + 20).toFixed(0)},${(g.y + 40).toFixed(0)})`);
} else {
  for (const n of v0.nodes) nodes[n.id] = { x: n.x, y: n.y };
}
await post('/api/layout', { root: ROOT_ID, mode: 'group', nodes });
const v5 = await get(`/api/view?root=${root}&group=1&down=3&optimal=1&fixed=1`);

console.log('== groups ==');
for (const g of v5.groups) console.log(`${g.id}  x=${g.x.toFixed(0)} y=${g.y.toFixed(0)} w=${g.w.toFixed(0)} h=${g.h.toFixed(0)} (bottom=${(g.y+g.h).toFixed(0)})`);
console.log('== containers ==');
for (const c of v5.containers) console.log(`${c.root ? '[root]' : ''}${c.id}  depth=${c.depth} x=${c.x.toFixed(0)} y=${c.y.toFixed(0)} w=${c.w.toFixed(0)} h=${c.h.toFixed(0)} (bottom=${(c.y+c.h).toFixed(0)})`);
console.log('== nodes (group, y) ==');
for (const n of v5.nodes) console.log(`${n.id}  ${n.group}  y=${n.y.toFixed(0)}..${(n.y+n.h).toFixed(0)}`);

const inter = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
for (const a of v5.containers.filter((c) => !c.root))
  for (const b of v5.containers.filter((c) => !c.root)) {
    if (a === b || b.id.startsWith(a.id + '/') || a.id.startsWith(b.id + '/')) continue;
    const ox = inter(a.x, a.x + a.w, b.x, b.x + b.w);
    const oy = inter(a.y, a.y + a.h, b.y, b.y + b.h);
    if (ox > 0.5 && oy > 0.5) console.log(`!! 容器重叠 ${a.id} × ${b.id}  ox=${ox.toFixed(1)} oy=${oy.toFixed(1)}`);
  }
child.kill();
setTimeout(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(0); }, 300);
