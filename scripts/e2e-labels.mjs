// 连线标签的端到端验证：点连线出面板 → 加预设 → 自动编号 → 避让/贴线 → 拖动 → 删除 → 落库
// 用法: node scripts/e2e-labels.mjs
// 起一个临时库的 server + 无头 Chrome，不碰用户真实数据
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCdp } from './lib/cdp.mjs';
import { launchServer } from './lib/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOT = path.join(ROOT, 'out', 'labels-e2e.png');

const server = await launchServer({ target: 'samples/tcu' });
const cdp = await launchCdp({ url: server.baseUrl + '/', width: 1500, height: 980 });
const { evaluate, waitFor, click, pressKey, drag, screenshot } = cdp;

let ok = true;
const check = (cond, msg, extra) => {
  if (cond) console.log('  ✓ ' + msg);
  else {
    ok = false;
    console.log('  ✗ ' + msg + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
  }
};
const sleep = (ms) => evaluate(`new Promise((r) => setTimeout(r, ${ms}))`);

/**
 * 页内挑一条「好点」的连线：取各段中点里，离其它连线最远的那个
 * （样本里同一对函数常有两条平行边，随便点会命中隔壁那条）
 */
const PICK_EDGE = `(() => {
  const v = window.__cg.view, c = window.__cg.cam;
  const r = document.getElementById('cv').getBoundingClientRect();
  const segs = [];
  for (const e of v.edges) {
    if ((e.points || []).length < 2) continue;
    if (e.kind === 'var' || e.kind === 'dataflow') continue;
    if (e.label) continue;
    for (let i = 0; i < e.points.length - 1; i++) {
      const a = e.points[i], b = e.points[i + 1];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 60) continue;
      segs.push({ e, a, b, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
    }
  }
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
  };
  const inNode = (p) =>
    v.nodes.some((n) => p[0] >= n.x - 2 && p[0] <= n.x + n.w + 2 && p[1] >= n.y - 2 && p[1] <= n.y + n.h + 2);
  let best = null;
  for (const s of segs) {
    if (inNode(s.mid)) continue;
    let minD = Infinity;
    for (const o of segs) if (o.e !== s.e) minD = Math.min(minD, dist(s.mid, o.a, o.b));
    const d = minD * c.k;
    if (!best || d > best.d) best = { d, s };
  }
  if (!best) return null;
  const s = best.s;
  return {
    key: s.e.from + '->' + s.e.to + ':' + s.e.line,
    x: r.left + c.x + s.mid[0] * c.k,
    y: r.top + c.y + s.mid[1] * c.k,
    clearance: Math.round(best.d),
  };
})()`;

/** 标签与节点 / 标签的距离检查（页内算，避免坐标换算误差） */
const AUDIT = `(() => {
  const v = window.__cg.view;
  const labels = window.__cg.labels();
  const hit = (a, b, pad = 0) =>
    a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;
  const distTo = (p, pts) => {
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((p.x - ax) * dx + (p.y - ay) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t)));
    }
    return best;
  };
  const nodeHits = [];
  for (const l of labels) {
    if (!l.rect) continue;
    for (const n of v.nodes) if (hit(l.rect, n)) nodeHits.push([l.edge, n.id]);
  }
  const labelHits = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      if (labels[i].rect && labels[j].rect && hit(labels[i].rect, labels[j].rect)) {
        labelHits.push([labels[i].edge, labels[j].edge]);
      }
    }
  }
  const far = [];
  for (const l of labels) {
    if (!l.rect) continue;
    const e = v.edges.find((x) => x.from + '->' + x.to + ':' + x.line === l.edge);
    if (!e) continue;
    const c = { x: l.rect.x + l.rect.w / 2, y: l.rect.y + l.rect.h / 2 };
    const d = distTo(c, e.points || []);
    if (d > 64.5) far.push([l.edge, Math.round(d)]);
  }
  return { nodeHits, labelHits, far, count: labels.length, rects: labels.map((l) => l.rect) };
})()`;

/** 点一条线 + 点一个预设，返回这条线的 key */
async function addLabel(preset) {
  const pick = await evaluate(PICK_EDGE);
  if (!pick) throw new Error('没有可标注的连线');
  await click(pick.x, pick.y);
  await waitFor(`window.__cg.selected.edge === ${JSON.stringify(pick.key)}`, { timeoutMs: 5000 });
  await evaluate(`document.querySelector('.lbl-preset[data-preset="${preset}"]').click()`);
  await waitFor(
    `window.__cg.labels().some((l) => l.edge === ${JSON.stringify(pick.key)} && l.rect)`,
    { timeoutMs: 5000 }
  );
  return pick.key;
}

/** 标签矩形是世界坐标：换算成页面坐标才能点 */
const labelClientPoint = (idx) => `(() => {
  const c = window.__cg.cam;
  const r = document.getElementById('cv').getBoundingClientRect();
  const l = window.__cg.labels()[${idx}];
  if (!l || !l.rect) return null;
  return {
    key: l.edge,
    x: r.left + c.x + (l.rect.x + l.rect.w / 2) * c.k,
    y: r.top + c.y + (l.rect.y + l.rect.h / 2) * c.k,
  };
})()`;

await waitFor('!!(window.__cg && window.__cg.view)');

console.log('1) 点函数 / 变量不再出现标注表单');
const nodePt = await evaluate(`(() => {
  const v = window.__cg.view, c = window.__cg.cam;
  const r = document.getElementById('cv').getBoundingClientRect();
  const n = v.nodes.find((x) => x.kind !== 'var') || v.nodes[0];
  return { x: r.left + c.x + (n.x + n.w / 2) * c.k, y: r.top + c.y + (n.y + n.h / 2) * c.k, id: n.id };
})()`);
await click(nodePt.x, nodePt.y);
await waitFor(`!!document.querySelector('#detail .detail-title')`);
const detailHtml = await evaluate(`document.getElementById('detail').innerHTML`);
check(!/textarea|id="tag"|id="note"|保存标注/.test(detailHtml), '节点详情里已无备注 / 颜色 / 标签表单');
check(/detail-title/.test(detailHtml), '节点详情仍显示函数名与位置');
check(
  (await evaluate(`document.getElementById('secLabel').style.display`)) === 'none',
  '选中节点时标签面板隐藏'
);

console.log('2) 点连线 → 右侧出现标签面板');
const first = await evaluate(PICK_EDGE);
check(!!first, '找到可标注的连线', first);
await click(first.x, first.y);
await waitFor(`document.getElementById('secLabel').style.display !== 'none'`);
check(
  (await evaluate(`document.querySelectorAll('#labelPanel .lbl-preset').length`)) === 3,
  '面板里给出 3 个预设'
);

console.log('3) 预设一：黑框白底黑字 TASK:2ms');
await evaluate(`document.querySelector('.lbl-preset[data-preset="task"]').click()`);
await waitFor(`window.__cg.labels().length === 1 && !!window.__cg.labels()[0].rect`);
let labels = await evaluate('window.__cg.labels()');
check(labels[0].text === 'TASK:2ms', '默认文字是 TASK:2ms（可改）', labels[0].text);
check(labels[0].border === '#2C2C2A', '黑框', labels[0].border);
check(labels[0].rect && labels[0].rect.w > 0 && labels[0].rect.h > 0, '标签有实际体积', labels[0].rect);

console.log('4) 预设二：红框白底红字 結合点，编号自动且不重复');
await addLabel('conn');
await addLabel('conn');
labels = await evaluate('window.__cg.labels()');
const conns = labels.filter((l) => l.preset === 'conn');
check(conns.length === 2, '两条连线各有一个结合点', conns.map((l) => l.text));
check(
  conns.map((l) => l.text).sort().join(',') === '結合点：1,結合点：2',
  '结合点编号自动递增且不重复',
  conns.map((l) => l.text)
);
check(conns.every((l) => l.border === '#C0392B'), '结合点是红框', conns.map((l) => l.border));
check(
  (await evaluate(`document.getElementById('lblText').disabled`)) === true,
  '结合点的文字框不可手填'
);

console.log('5) 预设三：コール順 无边框黑字');
await addLabel('call');
labels = await evaluate('window.__cg.labels()');
const call = labels.find((l) => l.preset === 'call');
check(call && call.text === 'コール順', '文字是 コール順', call && call.text);
check(call && call.border === null, '无边框', call && call.border);

console.log('6) 自定义边框 / 文字颜色');
const editPt = await evaluate(labelClientPoint(0));
await click(editPt.x, editPt.y);
await waitFor(`window.__cg.selected.label === ${JSON.stringify(editPt.key)}`);
await evaluate(`(() => {
  const b = document.querySelector('#lblBorder');
  b.value = '#1f6feb';
  b.dispatchEvent(new Event('input', { bubbles: true }));
  b.dispatchEvent(new Event('change', { bubbles: true }));
  const c = document.querySelector('#lblColor');
  c.value = '#0b5fff';
  c.dispatchEvent(new Event('input', { bubbles: true }));
  c.dispatchEvent(new Event('change', { bubbles: true }));
})()`);
await sleep(400);
const edited = (await evaluate('window.__cg.labels()')).find((l) => l.edge === editPt.key);
check(edited.border === '#1f6feb', '边框颜色可自定义', edited.border);
check(edited.color === '#0b5fff', '文字颜色可自定义', edited.color);

console.log('7) 避让：标签不压函数框、不互相重叠、贴着线');
let audit = await evaluate(AUDIT);
check(audit.nodeHits.length === 0, '标签没有压住任何函数 / 变量框', audit.nodeHits);
check(audit.labelHits.length === 0, '标签之间不重叠', audit.labelHits);
check(audit.far.length === 0, '标签都在连线附近（≤64）', audit.far);

console.log('8) 拖动：可以挪动，但不会离开线太远');
const before = audit.rects[0];
const from = await evaluate(labelClientPoint(0));
await drag(from.x, from.y, from.x, from.y + 260);
await sleep(400);
audit = await evaluate(AUDIT);
check(audit.far.length === 0, '拖到远处后仍被拉回线附近', audit.far);
check(audit.nodeHits.length === 0, '拖动后也不压住节点', audit.nodeHits);
const after = audit.rects[0];
check(Math.abs(after.x - before.x) + Math.abs(after.y - before.y) > 2, '标签确实被拖动了', {
  before,
  after,
});

console.log('9) 单独选中标签并删除：只删标签，连线还在');
const edgesBefore = await evaluate('window.__cg.view.edges.length');
const target = await evaluate(labelClientPoint(0));
await click(target.x, target.y);
await waitFor(`window.__cg.selected.label === ${JSON.stringify(target.key)}`);
await pressKey({ key: 'Delete', code: 'Delete', vk: 46 });
await waitFor(`window.__cg.labels().length === 3`);
check(
  !(await evaluate('window.__cg.labels()')).some((l) => l.edge === target.key),
  '标签已删除'
);
check((await evaluate('window.__cg.view.edges.length')) === edgesBefore, '连线没有被一起删掉');
check(
  (await evaluate(`document.querySelectorAll('#labelPanel .lbl-preset').length`)) === 3,
  '删掉标签后面板回到「选预设」状态'
);

console.log('10) 刷新后标签仍在（已写入 SQLite）');
const sig = (l) => `${l.text}|${l.border}|${l.color}`;
const kept = (await evaluate('window.__cg.labels()')).map(sig).sort();
await evaluate('location.reload()');
await waitFor('!!(window.__cg && window.__cg.view)', { timeoutMs: 20000 });
await waitFor(`window.__cg.labels().length === ${kept.length}`);
const reloaded = (await evaluate('window.__cg.labels()')).map(sig).sort();
check(JSON.stringify(reloaded) === JSON.stringify(kept), '标签（含自定义颜色）落库并能重新读出', {
  kept,
  reloaded,
});

console.log('11) 删掉连线，标签跟着消失');
const victim = (await evaluate('window.__cg.labels()'))[0];
const edgesNow = await evaluate('window.__cg.view.edges.length');
const onLine = await evaluate(`(() => {
  const c = window.__cg.cam, v = window.__cg.view;
  const r = document.getElementById('cv').getBoundingClientRect();
  const key = ${JSON.stringify(victim.edge)};
  const e = v.edges.find((x) => x.from + '->' + x.to + ':' + x.line === key);
  if (!e || !e.points || e.points.length < 2) return null;
  const dist = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
  };
  const inNode = (p) =>
    v.nodes.some((n) => p[0] >= n.x - 3 && p[0] <= n.x + n.w + 3 && p[1] >= n.y - 3 && p[1] <= n.y + n.h + 3);
  const lb = window.__cg.labels().find((l) => l.edge === key);
  const inLabel = (p) =>
    !!lb && lb.rect && p[0] >= lb.rect.x - 3 && p[0] <= lb.rect.x + lb.rect.w + 3 && p[1] >= lb.rect.y - 3 && p[1] <= lb.rect.y + lb.rect.h + 3;
  const others = v.edges.filter((x) => x !== e && (x.points || []).length >= 2);
  let best = null;
  for (let i = 0; i < e.points.length - 1; i++) {
    const a = e.points[i], b = e.points[i + 1];
    for (const t of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (inNode(p) || inLabel(p)) continue;
      let clear = Infinity;
      for (const o of others) {
        for (let j = 0; j < o.points.length - 1; j++) clear = Math.min(clear, dist(p, o.points[j], o.points[j + 1]));
      }
      if (!best || clear > best.clear) best = { clear, p };
    }
  }
  if (!best) return null;
  return { x: r.left + c.x + best.p[0] * c.k, y: r.top + c.y + best.p[1] * c.k };
})()`);
await click(onLine.x, onLine.y);
await waitFor(`window.__cg.selected.edge === ${JSON.stringify(victim.edge)}`);
await pressKey({ key: 'Delete', code: 'Delete', vk: 46 });
await waitFor(`window.__cg.view.edges.length === ${edgesNow - 1}`);
check(
  !(await evaluate('window.__cg.labels()')).some((l) => l.edge === victim.edge),
  '连线删除后它的标签也不见了'
);
await evaluate('location.reload()');
await waitFor('!!(window.__cg && window.__cg.view)', { timeoutMs: 20000 });
await waitFor(`window.__cg.view.edges.length === ${edgesNow - 1}`);
check(
  !(await evaluate('window.__cg.labels()')).some((l) => l.edge === victim.edge),
  '刷新后依然没有（连线是删掉的状态）'
);

await screenshot(SHOT);
console.log('截图:', SHOT);

// 12) 撤销：标签是即时落库的，撤销必须把差异也写回，否则刷新后又变回来
console.log('12) 撤销标签');
{
  const before = (await evaluate('window.__cg.labels()')).length;
  const pick = await evaluate(PICK_EDGE);
  await click(pick.x, pick.y);
  await waitFor(`!!document.querySelector('.lbl-preset')`);
  await evaluate(`document.querySelector('.lbl-preset[data-preset="task"]').click()`);
  await sleep(600);
  check((await evaluate('window.__cg.labels()')).length === before + 1, '加了一条新标签');

  await pressKey({ key: 'z', code: 'KeyZ', vk: 90, modifiers: 2 }); // Ctrl+Z
  await sleep(800);
  check((await evaluate('window.__cg.labels()')).length === before, '撤销后画布上的标签消失');

  // 关键断言：刷新后不能复活。复活说明撤销只改了画布、没写回库
  await evaluate('location.reload()');
  await waitFor('!!(window.__cg && window.__cg.view)', { timeoutMs: 20000 });
  await sleep(600);
  check((await evaluate('window.__cg.labels()')).length === before, '刷新后标签仍是撤销后的状态（撤销已写回库）');
}

await cdp.close();
await server.close();
console.log(ok ? '\n全部通过' : '\n有检查失败');
process.exit(ok ? 0 : 1);
