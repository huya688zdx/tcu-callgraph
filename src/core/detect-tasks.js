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
 * 3. コール順：从任务出发按调用链先序编号，链上每条边挂 コール順n。
 *    宏间接调用（CALL(Task_10ms)）与函数指针在解析期已还原成普通边，这里不用管。
 */

/** 名字里的周期：Task_10ms / 100ms_task / cyclic_5ms → { n: 10, unit: 'ms' } */
const PERIOD_IN_NAME = /(\d+)\s*(ms|us|µs|s)\b/i;
/** 任务函数名：Task_xxx / xxx_task / cyclic_xxx / periodic_xxx */
const TASK_NAME = /(^|_)(task|cyclic|periodic)(_|$)/i;
/** 中断入口：xxx_isr / xxx_handler / irq_xxx / xxx_interrupt */
const ISR_NAME = /(^|_)(isr|handler|irq|interrupt)(_|$)/i;

const MAX_TASKS = 8;
const MAX_CHAIN_EDGES = 12;
const MAX_SUGGESTIONS = 40;

const shortName = (id) => String(id).split('::').pop();
const edgeKeyOf = (e) => `${e.from}->${e.to}:${e.line}`;

/** 名字里能提出周期就是任务函数；只有 Task/cyclic 字样而无周期的也算（周期留空） */
function taskPeriodOf(name) {
  const m = PERIOD_IN_NAME.exec(String(name));
  if (!m) return null;
  const unit = m[2].toLowerCase();
  return { text: `TASK:${m[1]}${unit === 'µs' ? 'us' : unit}`, why: `函数名带周期 ${m[0]}` };
}

/**
 * @param {object} model 解析模型（src/core/index.js loadModel 的产物）
 * @returns {{ok:true, suggestions:Array, tasks:Array}} suggestions 按先行后序排列
 */
export function detectTasks(model) {
  if (!model || !model._index) return { ok: true, suggestions: [], tasks: [] };
  const fns = model.functions || [];
  const out = (id) => model._index.outAdj.get(id) || [];
  const byId = model._index.byId;

  // ---- 1. 任务函数与 ISR ----
  const tasks = []; // { id, period, isIsr }
  const isrs = [];
  for (const fn of fns) {
    const p = taskPeriodOf(fn.name);
    if (p && TASK_NAME.test(fn.name)) tasks.push({ id: fn.id, period: p });
    else if (p && ISR_NAME.test(fn.name)) isrs.push({ id: fn.id, period: p });
    else if (p) tasks.push({ id: fn.id, period: p });
    else if (TASK_NAME.test(fn.name)) tasks.push({ id: fn.id, period: null });
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

  // ---- 2. 「调度入口 → 任务」的边挂 TASK ----
  for (const task of tasks.slice(0, MAX_TASKS)) {
    const period = task.period || taskPeriodOf(shortName(task.id)) || { text: 'TASK:?', why: '任务函数（周期未知）' };
    const callers = model._index.inAdj.get(task.id) || [];
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

  // ---- 3. 任务调用链先序编号挂 コール順 ----
  for (const task of tasks.slice(0, MAX_TASKS)) {
    let order = 0;
    let walked = 0;
    const visit = (id, depth) => {
      if (depth > 4 || walked > MAX_CHAIN_EDGES) return;
      for (const e of out(id)) {
        if (walked > MAX_CHAIN_EDGES) return;
        walked++;
        order++;
        const key = edgeKeyOf(e);
        if (!seenEdges.has(key)) {
          seenEdges.add(key);
          push({
            kind: 'call',
            preset: 'call',
            edgeKey: key,
            from: e.from,
            to: e.to,
            line: e.line,
            text: `コール順${order}`,
            note: '',
            evidence: `${fileLine(e.from)} · ${shortName(task.id)} 链上第 ${order} 步`,
          });
        } else {
          order--; // 已挂过的边不占序号
        }
        visit(e.to, depth + 1);
      }
    };
    visit(task.id, 0);
  }

  return {
    ok: true,
    suggestions,
    tasks: [...tasks, ...isrs].slice(0, MAX_TASKS * 2).map((x) => ({
      id: x.id,
      name: shortName(x.id),
      period: x.period ? x.period.text : null,
    })),
  };
}
