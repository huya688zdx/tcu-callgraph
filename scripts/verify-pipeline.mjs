// 复现「层级之间重叠」：走真实服务端管线（含手动布局存档），检查文件框/目录容器碰撞
// 用法: node scripts/verify-pipeline.mjs [样本目录] [--scenario drag|fixed|vars]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const TARGET = args.find((a) => !a.startsWith('--')) || 'samples/deep';
const SCENARIO = (args.find((a) => a.startsWith('--scenario=')) || '--scenario=all').split('=')[1];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pipe-'));
const dbPath = path.join(tmpDir, 'callgraph.db');
const child = fork(path.join(ROOT, 'src/server.js'), [TARGET, '0'], {
  cwd: ROOT,
  env: { ...process.env, CALLGRAPH_DB: dbPath },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('启动超时\n' + log)), 30000);
  child.on('message', (m) => {
    if (m?.ready) { clearTimeout(t); resolve(m.port); }
  });
  child.on('exit', () => reject(new Error('提前退出\n' + log)));
});
const base = `http://127.0.0.1:${port}`;

const get = async (p) => (await fetch(base + p)).json();
const post = async (p, body) => (await fetch(base + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})).json();

const inter = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
const overlapBox = (a, b) => {
  const ox = inter(a.x, a.x + a.w, b.x, b.x + b.w);
  const oy = inter(a.y, a.y + a.h, b.y, b.y + b.h);
  return ox > 0.5 && oy > 0.5 ? { ox, oy } : null;
};
const isAncestor = (a, b) => a.root ? b.id !== '' : b.id.startsWith(a.id + '/');

function checkView(view, label) {
  const bad = [];
  const files = view.groups || [];
  const dirs = (view.containers || []).filter((c) => !c.root);
  for (let i = 0; i < files.length; i++)
    for (let j = i + 1; j < files.length; j++) {
      const o = overlapBox(files[i], files[j]);
      if (o) bad.push(`文件框重叠 ${files[i].id} × ${files[j].id} (${o.ox.toFixed(1)}×${o.oy.toFixed(1)})`);
    }
  for (let i = 0; i < dirs.length; i++)
    for (let j = i + 1; j < dirs.length; j++) {
      if (isAncestor(dirs[i], dirs[j]) || isAncestor(dirs[j], dirs[i])) continue;
      const o = overlapBox(dirs[i], dirs[j]);
      if (o) bad.push(`容器重叠 ${dirs[i].id} × ${dirs[j].id} (${o.ox.toFixed(1)}×${o.oy.toFixed(1)})`);
    }
  for (const c of dirs)
    for (const f of files) {
      if (f.id.startsWith(c.id + '/')) continue;
      const o = overlapBox(c, f);
      if (o) bad.push(`容器压文件 ${c.id} 压 ${f.id} (${o.ox.toFixed(1)}×${o.oy.toFixed(1)})`);
    }
  // 节点脱离所属文件框
  const gById = new Map(files.map((g) => [g.id, g]));
  for (const n of view.nodes || []) {
    const g = gById.get(n.group);
    if (!g) continue;
    if (n.x < g.x - 1 || n.y < g.y - 1 || n.x + n.w > g.x + g.w + 1 || n.y + n.h > g.y + g.h + 1)
      bad.push(`节点出框 ${n.id} 出 ${g.id}`);
  }
  if (bad.length) {
    console.log(`\n❌ ${label}`);
    for (const b of bad.slice(0, 20)) console.log('   ' + b);
    if (bad.length > 20) console.log(`   … 共 ${bad.length} 处`);
  }
  return bad.length;
}

// ---- 收集入口函数 ----
const tree = await get('/api/tree');
const entries = [];
const walkT = (n) => {
  for (const c of n.children || []) walkT(c);
  for (const f of (n.functions || []).slice(0, 3)) entries.push(f.id);
};
walkT(tree);
console.log(`样本 ${TARGET}：取 ${Math.min(entries.length, 20)} 个入口逐个测`);

let totalBad = 0;
let tested = 0;
const run = async (scenario) => {
  for (const root of entries.slice(0, 20)) {
    tested++;
    // 1) 干净视图
    const v0 = await get(`/api/view?root=${encodeURIComponent(root)}&group=1&down=3`);
    if (v0.empty || !v0.groups?.length) continue;

    if (scenario === 'clean') {
      totalBad += checkView(v0, `[clean] ${root}`);
      continue;
    }

    if (scenario === 'depth') {
      // 固定布局（默认开启）下切深度：down=2 的坐标存档被 down=5 的新视图复用
      const v2 = await get(`/api/view?root=${encodeURIComponent(root)}&group=1&down=2`);
      if (v2.empty || !v2.groups?.length) continue;
      const nodes = {};
      for (const n of v2.nodes) {
        nodes[n.id] = { x: n.x, y: n.y }; // 合法位置：当前自动布局坐标原样保存
      }
      await post('/api/layout', { root, mode: 'group', nodes });
      const v5 = await get(`/api/view?root=${encodeURIComponent(root)}&group=1&down=5&optimal=1&fixed=1`);
      totalBad += checkView(v5, `[fixed 切深度 2→5] ${root}`);
      const v3 = await get(`/api/view?root=${encodeURIComponent(root)}&group=1&down=3&optimal=1&fixed=1`);
      totalBad += checkView(v3, `[fixed 切深度 2→3] ${root}`);
      await post('/api/layout', { root, mode: 'group', clear: true });
    }

    if (scenario === 'drag') {
      // 2) 模拟用户把每个节点拖到文件框内边缘（前端 clamp 允许的位置）并保存
      const nodes = {};
      for (const n of v0.nodes) {
        const g = v0.groups.find((x) => x.id === n.group);
        if (!g) continue;
        // 拖到框顶（贴 header 下沿）与框左/右边缘 —— 前端允许的极限位置
        nodes[n.id] = { x: g.x + 8, y: g.y + 32 };
      }
      await post('/api/layout', { root, mode: 'group', nodes });
      const v1 = await get(`/api/view?root=${encodeURIComponent(root)}&group=1&down=3&optimal=1`);
      totalBad += checkView(v1, `[drag 后] ${root}`);
      // 清掉存档，避免影响后续入口
      await post('/api/layout', { root, mode: 'group', clear: true });
    }

    if (scenario === 'fixed') {
      // 3) 固定布局：把一个节点钉到别的文件框区域（陈旧/跨深度存档），再开 fixed
      const nodes = {};
      const ns = v0.nodes;
      if (ns.length >= 2) {
        const a = ns[0];
        const b = ns[ns.length - 1];
        if (a.group !== b.group) {
          const g = v0.groups.find((x) => x.id === b.group);
          nodes[a.id] = { x: g.x + 20, y: g.y + 40 }; // a 落进 b 的框
        }
      }
      await post('/api/layout', { root, mode: 'group', nodes });
      const v1 = await get(`/api/view?root=${encodeURIComponent(root)}&group=1&down=3&optimal=1&fixed=1`);
      totalBad += checkView(v1, `[fixed 钉到别框] ${root}`);
      await post('/api/layout', { root, mode: 'group', clear: true });
    }

    if (scenario === 'vars') {
      // 4) 勾选全局变量后（wantVars 补节点），之前拖过的存档坐标回填
      const varsList = (await get('/api/vars')).list || [];
      const pick = varsList.slice(0, 3).map((v) => v.id);
      if (!pick.length) continue;
      const nodes = {};
      for (const n of v0.nodes) {
        const g = v0.groups.find((x) => x.id === n.group);
        if (g) nodes[n.id] = { x: g.x + 8, y: g.y + 32 };
      }
      await post('/api/layout', { root, mode: 'group', nodes });
      const v1 = await get(
        `/api/view?root=${encodeURIComponent(root)}&group=1&down=3&optimal=1&vars=${pick.map(encodeURIComponent).join(',')}`
      );
      totalBad += checkView(v1, `[drag 后加变量] ${root}`);
      await post('/api/layout', { root, mode: 'group', clear: true });
    }
  }
};

const scenarios = SCENARIO === 'all' ? ['clean', 'drag', 'fixed', 'vars', 'depth'] : [SCENARIO];
for (const s of scenarios) {
  console.log(`\n===== 场景 ${s} =====`);
  await run(s);
}

console.log(`\n共测 ${tested} 个入口 × ${scenarios.length} 场景，问题视图数合计标记 ${totalBad ? '见上' : 0}`);
child.kill();
setTimeout(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(totalBad ? 1 : 0);
}, 300);
