// 连线优化器：实测交叉与不允许合并的重叠，引导函数和变量摆位。
//
// 人工调图减少交叉的两招——挪函数位置、改出/入线面——各自对应搜索空间里的
// 一类候选移动；每个候选都把完整路由管线（并面、母线、通道避让）重跑一遍，
// 用真实的交叉与重叠评分裁决去留，而不是任何代理指标：
//   1. 面翻转：按（节点 × 出/入 × 线类型）整组换面，写成 faceHints 初值，
//      不锁死——并面与母线照常运行，提示是否成立由实测交叉数决定
//   2. 同组换位：交叉牵连的节点与同文件框伙伴（无分组则任意伙伴）交换坐标
//   3. 就近移位：挪到每个邻居旁的四个空位（组模式下不得跨出所在文件框）
// 硬约束：节点互不重叠；组模式节点留在本组框内；用户钉过的面、手动折线不动。
// 预算：评估次数 / 耗时双上限，超了立刻停；没有交叉和重叠时直接返回。

import { routeEdges, edgeStyleKey, routeOverlapConflicts } from './routing.js';

const FACES = ['top', 'bottom', 'left', 'right'];

const shareEndpoint = (h, v) =>
  h.edge.from === v.edge.from || h.edge.from === v.edge.to ||
  h.edge.to === v.edge.from || h.edge.to === v.edge.to;

function segmentsOf(edges) {
  const h = [];
  const v = [];
  for (const e of edges) {
    const pts = e.points || [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      if (Math.abs(y1 - y2) < 0.5) {
        h.push({ y: Math.round((y1 + y2) / 2), x1: Math.min(x1, x2), x2: Math.max(x1, x2), edge: e });
      } else if (Math.abs(x1 - x2) < 0.5) {
        v.push({ x: Math.round((x1 + x2) / 2), y1: Math.min(y1, y2), y2: Math.max(y1, y2), edge: e });
      }
    }
  }
  return { h, v };
}

function nodesOverlap(nodes) {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (
        a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 &&
        a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {Array} nodes 已就位的节点（x/y/w/h，可选 group）
 * @param {Array} edges 未布线或已布线的边（from/to/kind，可选 fromSide/toSide/custom）
 * @param {object} opts
 *   - groupBoxes: Map<groupId, {x,y,w,h}> 有则启用组内约束（组模式）
 *   - maxEvals / maxMs: 评估预算
 * @returns {{crossings, gained, evals, ms}} 结束时 edges 里已是最终采纳的布线
 */
export function optimizeCrossings(nodes, edges, opts = {}) {
  const maxEvals = opts.maxEvals ?? 1200;
  const maxMs = opts.maxMs ?? 1200;
  const groupBoxes = opts.groupBoxes || null;
  const t0 = Date.now();
  let evals = 0;
  const budgetLeft = () => evals < maxEvals && Date.now() - t0 < maxMs;

  // 用户钉过的面不允许优化器覆盖（hint 优先级低于钉面，但优化器干脆不碰更干净）
  const pinnedFrom = new Set(edges.filter((e) => e.fromSide));
  const pinnedTo = new Set(edges.filter((e) => e.toSide));
  const faceHints = new Map(); // edge -> { from?, to? }
  const byId = new Map(nodes.map((n) => [n.id, n]));

  // 一次评估 = 完整重路由 + 交叉计数（routeLengthAndCrossings 同口径的判定，
  // 交点去重、共端点的边对不算、共享干线折线不重复计段）
  const analyze = () => {
    evals++;
    routeEdges(nodes, edges, { faceHints });
    const { h, v } = segmentsOf(edges);
    const points = new Set();
    const hits = new Map();
    for (const s of h) {
      for (const t of v) {
        if (t.x <= s.x1 + 0.5 || t.x >= s.x2 - 0.5 || s.y <= t.y1 + 0.5 || s.y >= t.y2 - 0.5) continue;
        if (shareEndpoint(s, t)) continue;
        points.add(`${t.x},${s.y}`);
        for (const e of [s.edge, t.edge]) {
          for (const id of [e.from, e.to]) hits.set(id, (hits.get(id) || 0) + 1);
        }
      }
    }
    const overlaps = routeOverlapConflicts(edges);
    for (const [id, length] of overlaps.hits) hits.set(id, (hits.get(id) || 0) + length / 40);
    return { crossings: points.size, hits, score: points.size * 360 + overlaps.length * 4 };
  };

  let state = analyze();
  let best = state.score;
  const before0 = state.crossings;
  if (!best) return { crossings: 0, gained: 0, evals, ms: Date.now() - t0 };

  const hotNodes = () =>
    [...state.hits.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id)).filter(Boolean);

  // 组模式硬约束：任何候选移动后所有节点仍须落在本组文件框内——
  // 换位双方尺寸不同时互换左上角可能把较大的那个挤出框外，
  // fitGroups 随后会扩框、可能压到相邻文件框
  const insideBoxes = () => {
    if (!groupBoxes) return true;
    for (const n of nodes) {
      const gb = groupBoxes.get(n.group);
      if (!gb) continue;
      if (n.x < gb.x - 0.5 || n.y < gb.y - 0.5 || n.x + n.w > gb.x + gb.w + 0.5 || n.y + n.h > gb.y + gb.h + 0.5) {
        return false;
      }
    }
    return true;
  };

  // 试一次候选：apply() 改状态，restore() 回退；采纳与否由交叉和重叠评分裁决
  const tryCandidate = (apply, restore) => {
    if (!budgetLeft()) return false;
    apply();
    if (nodesOverlap(nodes) || !insideBoxes()) {
      restore();
      return false;
    }
    const trial = analyze();
    if (trial.score < best) {
      best = trial.score;
      state = trial;
      return true;
    }
    restore();
    return false;
  };

  let improved = true;
  while (improved && budgetLeft() && best > 0) {
    improved = false;

    // ---- 1) 面翻转：整组换出/入面 ----
    for (const n of hotNodes()) {
      if (best === 0 || !budgetLeft()) break;
      for (const dir of ['from', 'to']) {
        const groups = new Map();
        for (const e of edges) {
          if (e.custom) continue;
          if (dir === 'from' ? e.from !== n.id : e.to !== n.id) continue;
          if (dir === 'from' ? pinnedFrom.has(e) : pinnedTo.has(e)) continue;
          const k = edgeStyleKey(e);
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k).push(e);
        }
        for (const list of groups.values()) {
          let done = false;
          for (const f of FACES) {
            if (done || !budgetLeft()) break;
            const snap = list.map((e) => faceHints.get(e));
            done = tryCandidate(
              () => {
                for (const e of list) faceHints.set(e, { ...(faceHints.get(e) || {}), [dir]: f });
              },
              () => {
                list.forEach((e, i) => {
                  const b = snap[i];
                  if (b) faceHints.set(e, b);
                  else faceHints.delete(e);
                });
              }
            );
            if (done) improved = true;
          }
        }
      }
    }

    // ---- 2) 同组换位 ----
    if (best > 0 && budgetLeft()) {
      const tried = new Set();
      for (const n of hotNodes()) {
        if (best === 0 || !budgetLeft()) break;
        for (const m of nodes) {
          if (m === n) continue;
          if (groupBoxes && m.group !== n.group) continue;
          const key = n.id < m.id ? n.id + '\u0000' + m.id : m.id + '\u0000' + n.id;
          if (tried.has(key)) continue;
          tried.add(key);
          const ax = n.x;
          const ay = n.y;
          const bx = m.x;
          const by = m.y;
          if (
            tryCandidate(
              () => {
                n.x = bx;
                n.y = by;
                m.x = ax;
                m.y = ay;
              },
              () => {
                n.x = ax;
                n.y = ay;
                m.x = bx;
                m.y = by;
              }
            )
          ) {
            improved = true;
            break; // n 已经挪走，换下一个热点节点
          }
        }
      }
    }

    // ---- 3) 就近移位：邻居旁的四个空位（组内不跨框） ----
    if (best > 0 && budgetLeft()) {
      const neighborsOf = (n) => {
        const out = [];
        for (const e of edges) {
          if (e.from === n.id && byId.has(e.to)) out.push(byId.get(e.to));
          if (e.to === n.id && byId.has(e.from)) out.push(byId.get(e.from));
        }
        return [...new Set(out)];
      };
      for (const n of hotNodes()) {
        if (best === 0 || !budgetLeft()) break;
        const ox = n.x;
        const oy = n.y;
        const gb = groupBoxes?.get(n.group);
        for (const nb of neighborsOf(n)) {
          let done = false;
          for (const [cx, cy] of [
            [nb.x + nb.w + 34, nb.y + (nb.h - n.h) / 2],
            [nb.x - n.w - 34, nb.y + (nb.h - n.h) / 2],
            [nb.x + (nb.w - n.w) / 2, nb.y + nb.h + 34],
            [nb.x + (nb.w - n.w) / 2, nb.y - n.h - 34],
          ]) {
            if (done || !budgetLeft()) break;
            if (gb && (cx < gb.x + 6 || cy < gb.y + 6 || cx + n.w > gb.x + gb.w - 6 || cy + n.h > gb.y + gb.h - 6)) {
              continue; // 组模式：不得移出本组文件框
            }
            if (Math.abs(cx - ox) < 1 && Math.abs(cy - oy) < 1) continue;
            done = tryCandidate(
              () => {
                n.x = cx;
                n.y = cy;
              },
              () => {
                n.x = ox;
                n.y = oy;
              }
            );
            if (done) improved = true;
          }
          if (done) break;
        }
      }
    }
  }

  // 被否决的候选只恢复了位置和面提示，折线仍属于该候选；按最终采纳状态恢复布线。
  routeEdges(nodes, edges, { faceHints });
  return { crossings: state.crossings, gained: before0 - state.crossings, evals, ms: Date.now() - t0 };
}
