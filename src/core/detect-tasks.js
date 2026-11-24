/**
 * 从源码模型里自动找 TASK / コール順 线索（服务端检测，界面与 MCP 共用）。
 *
 * 规则是启发式的，**宁缺毋滥**：这里只出「建议清单」（带证据），应用与否由
 * 人在面板里勾选 / AI 判断后经 cg_annotate 落地——不直接改库。
 *
 * 依据的固件惯用写法（samples/tcu 为原型）：
 * 1. 任务函数：名字自带周期 —— Task_10ms / xxx_100ms_Task / cyclic_5ms；
 * 2. 调度入口：ISR / Handler / main 主循环调用任务函数；
 *    「入口 → 任务」这条边挂 TASK:xx 标签；
 * 3. コール順：按同一调用者内各被调函数首次出现的位置编号，重复调用不占序号。
 *    宏间接调用（CALL(Task_10ms)）与函数指针在解析期已还原成普通边，这里不用管。
 */

import { projectTasks } from './task-periods.js';
import { formatPeriod } from '../../web/lib/period-text.js';

/** 名字里的周期：Task_10ms / 100ms_task / cyclic_5ms → { n: 10, unit: 'ms' } */
const PERIOD_IN_NAME = /(\d+)\s*(ms|us|µs|s)(?=$|_)/i;
/** 任务函数名：Task_xxx / xxx_task / cyclic_xxx / periodic_xxx */
const TASK_NAME = /(^|_)(task|cyclic|periodic)(_|$)/i;
/** 中断入口：xxx_isr / xxx_handler / irq_xxx / xxx_interrupt */
const ISR_NAME = /(^|_)(isr|handler|irq|interrupt)(_|$)/i;

const MAX_TASKS = 8;
const MAX_SUGGESTIONS = 40;
const CALL_RANK = { direct: 3, macro: 2, fnptr: 1 };

const shortName = (id) => String(id).split('::').pop();
const edgeKeyOf = (e) => `${e.from}->${e.to}:${e.line}`;
const NO_CALLEE = { v: '' };

/** 名字里能提出周期就是任务函数；只有 Task/cyclic 字样而无周期的也算（周期留空） */
function taskPeriodOf(name) {
  const m = PERIOD_IN_NAME.exec(String(name));
  if (!m) return null;
  const unit = m[2].toLowerCase();
  return { text: `TASK:${m[1]}${unit === 'µs' ? 'us' : unit}`, why: `函数名带周期 ${m[0]}` };
}

/** 嵌套实参调用不按标识符出现顺序猜执行顺序，留给用户手动标注。 */
export function hasNestedCall(tokens, calls) {
  const names = new Set(calls.flatMap((e) => [
    e.callee || shortName(e.to), e.macroChain?.[0], e.via?.split(' > ')[0],
    e.kind === 'fnptr' ? e.via?.split('.').pop() : null,
  ]).filter(Boolean));
  const stack = [];
  let enclosingCalls = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].v === '(') {
      const call = names.has(tokens[i - 1]?.v);
      if (call && enclosingCalls) return true;
      stack.push(call);
      if (call) enclosingCalls++;
    } else if (tokens[i].v === ')' && stack.pop()) enclosingCalls--;
  }
  return false;
}

/** 成员调用要等函数指针表齐全后匹配，保留括号及其前的名字供调用顺序检测。 */
export function callNestingTokens(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.v === '(') {
      const prev = tokens[i - 1];
      result.push(prev?.t === 'id' ? prev : NO_CALLEE, token);
    } else if (token.v === ')') result.push(token);
  }
  return result;
}

/**
 * @param {object} model 解析模型（src/core/index.js loadModel 的产物）
 * @param {string|null} from 只检测该调用者；为空时扫描工程
 * @returns {{ok:true, suggestions:Array, tasks:Array, skipped:Array}} 建议按调用者及源码顺序排列
 */
export function detectTasks(model, from = null) {
  if (!model || !model._index) return { ok: true, suggestions: [], tasks: [], skipped: [] };
  const fns = model.functions || [];
  const out = (id) => model._index.outAdj.get(id) || [];
  const byId = model._index.byId;

  // ---- 1. 任务函数与 ISR ----
  const tasks = []; // { id, period, isIsr }
  const isrs = [];
  const recognized = new Map(projectTasks(model).map(task => [task.id, task]));
  for (const fn of fns) {
    const task = recognized.get(fn.id);
    const p = task?.us ? { text: 'TASK:' + formatPeriod(task.us).replace(' ', '').replace('µs', 'us'), why: task.source }
      : taskPeriodOf(fn.name);
    if (p && TASK_NAME.test(fn.name)) tasks.push({ id: fn.id, period: p });
    else if (p && ISR_NAME.test(fn.name)) isrs.push({ id: fn.id, period: p });
    else if (p) tasks.push({ id: fn.id, period: p });
    else if (task || TASK_NAME.test(fn.name)) tasks.push({ id: fn.id, period: null });
    else if (ISR_NAME.test(fn.name)) isrs.push({ id: fn.id, period: null });
  }

  const suggestions = [];
  const push = (s) => {
    if (suggestions.length < MAX_SUGGESTIONS) suggestions.push(s);
  };
  const seenEdges = new Set();

  const fileLine = (id) => {
    const fn = byId.get(id);
    return fn ? `${fn.file}:${fn.line}` : '';
  };

  // ---- 2. 「调度入口 → 任务」的边挂 TASK（仅限能明确识别出周期的任务，不猜测未知周期） ----
  for (const task of tasks) {
    if (seenEdges.size >= MAX_TASKS) break;
    const period = task.period || taskPeriodOf(shortName(task.id));
    if (!period) continue;
    const callers = (model._index.inAdj.get(task.id) || []).filter(c => !from || c.from === from);
    // 优先 ISR / main 这类调度者；没有就取第一个调用者
    const scheduler =
      callers.find((c) => ISR_NAME.test(shortName(c.from)) || shortName(c.from) === 'main') ||
      callers.find((c) => !TASK_NAME.test(shortName(c.from))) ||
      callers[0];
    if (!scheduler) continue;
    const key = edgeKeyOf(scheduler);
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    push({
      kind: 'task',
      preset: 'task',
      edgeKey: key,
      from: scheduler.from,
      to: scheduler.to,
      line: scheduler.line,
      text: period.text,
      note: `${shortName(scheduler.from)} 调度 ${shortName(task.id)}`,
      evidence: `${fileLine(task.id)} · ${period.why}`,
    });
  }

  // ---- 3. 每个调用者独立编号；变量引用不属于函数调用 ----
  const skipped = [];
  for (const fn of fns) {
    if (from && fn.id !== from) continue;
    const calls = out(fn.id).filter((e) => Object.hasOwn(CALL_RANK, e.kind))
      .sort((a, b) => a.line - b.line);
    if (calls.length < 2) continue;
    if (fn.hasNestedCalls ?? hasNestedCall(fn.bodyTokens || [], calls)) {
      skipped.push({ from: fn.id, reason: '当前函数含嵌套实参调用，コール順 请手动标注' });
      continue;
    }
    // 每个被调函数只记录首次调用，后续重复调用不占序号。
    const byTarget = new Map();
    for (const e of calls) {
      let group = byTarget.get(e.to);
      if (!group) {
        group = { edge: e, order: byTarget.size + 1, firstLine: e.line };
        byTarget.set(e.to, group);
      }
      // 与 subgraph 的代表边规则一致，保证建议能匹配当前画布。
      if (CALL_RANK[e.kind] > CALL_RANK[group.edge.kind]) group.edge = e;
    }
    for (const { edge: e, order, firstLine } of byTarget.values()) {
      push({
        kind: 'call', preset: 'call', edgeKey: edgeKeyOf(e),
        from: e.from, to: e.to, line: e.line,
        text: `コール順${order}`, note: '',
        evidence: `${fn.file}:${firstLine} · ${fn.name} 内首次调用顺序 ${order}（源码顺序，分支按条件执行）`,
      });
    }
  }

  return {
    ok: true,
    suggestions,
    skipped,
    tasks: [...tasks, ...isrs].slice(0, MAX_TASKS * 2).map((x) => ({
      id: x.id,
      name: shortName(x.id),
      period: x.period ? x.period.text : null,
    })),
  };
}
