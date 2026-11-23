import { collectArgs } from './lexer.js';

// 任务名给出标称周期。沿整个工程的调用图传播，条件调用只表示可能运行于该任务。
const cache = new WeakMap();
const catalogs = new WeakMap();
const callKinds = new Set(['direct', 'macro', 'fnptr']);
const taskName = /(?:^|_)(?:task|cyclic|periodic|runnable)(?=_|\d|$)/i;
const period = /(\d+)\s*(ms|us|µs|s)(?=$|_)/i;
const unitUs = { s: 1000000, ms: 1000, us: 1, 'µs': 1 };

// 调度器显式指定的函数可使用任意名称。只解析能唯一绑定到定义的直接标识符。
const registrations = new Set(['xTaskCreate', 'xTaskCreateStatic', 'ActivateTask', 'ChainTask']);
export function collectTaskEvidence(fn, tokens) {
  const found = [];
  for (let i = 0; i < tokens.length; i++) {
    if (!registrations.has(tokens[i].v) || tokens[i + 1]?.v !== '(') continue;
    const start = i + (tokens[i + 2]?.v === '&' ? 3 : 2);
    if (tokens[start]?.t !== 'id' || ![',', ')'].includes(tokens[start + 1]?.v)) continue;
    found.push({ name: tokens[start].v, source: `${tokens[i].v} · ${fn.file}:${tokens[i].line}` });
  }
  const interval = delayInterval(fn, tokens);
  return found.length || interval ? { registrations: found, interval } : null;
}

export function applyTaskEvidence(fn, evidence, byName) {
  if (!evidence) return;
  for (const registration of evidence.registrations) {
    const candidates = byName.get(registration.name) || [];
    const local = candidates.filter(f => f.file === fn.file);
    const targets = local.length ? local : candidates.filter(f => !f.isStatic);
    if (targets.length === 1) targets[0].taskRegistration = registration.source;
  }
  if (evidence.interval) fn.delayInterval = evidence.interval;
}

export function captureTaskEvidence(fn, tokens, byName) {
  applyTaskEvidence(fn, collectTaskEvidence(fn, tokens), byName);
}

// DelayUntil 的第二实参是 tick 数。只有显式毫秒转换可以直接还原标称间隔。
function delayInterval(fn, tokens) {
  const intervals = new Set();
  let evidence = '';
  for (let i = 0; i < tokens.length; i++) {
    if (!['vTaskDelayUntil', 'xTaskDelayUntil'].includes(tokens[i].v)) continue;
    const [args] = collectArgs(tokens, i + 1);
    if (!args) continue;
    const arg = args[1] || [];
    if (arg.length !== 4 || arg[0].v !== 'pdMS_TO_TICKS' || arg[1].v !== '(' || arg[3].v !== ')' ||
        !/^[1-9]\d*[uUlL]*$/.test(arg[2].v)) return null;
    const us = parseInt(arg[2].v, 10) * 1000;
    if (!Number.isSafeInteger(us)) return null;
    intervals.add(us);
    evidence = `${tokens[i].v} · ${fn.file}:${tokens[i].line}`;
  }
  return intervals.size === 1 ? { us: [...intervals][0], evidence } : null;
}

/** 完整任务清单不受当前视图深度、检测建议条数或是否存在调用者限制。 */
export function projectTasks(model) {
  if (catalogs.has(model)) return catalogs.get(model);
  const tasks = [];
  for (const fn of model.functions) {
    const name = fn.rawName || fn.name;
    const words = name.replace(/([a-z])([A-Z])/g, '$1_$2');
    const match = period.exec(name);
    // 带明确周期的中断入口可以提供周期证据，普通中断不能推定为周期任务。
    if (!fn.taskRegistration && !fn.taskDeclaration && !taskName.test(words) &&
        !(match && /(?:^|_)(?:isr|irq|handler|interrupt)(?:_|$)/i.test(words))) continue;
    const value = match && Number(match[1]) * unitUs[match[2].toLowerCase()];
    const interval = fn.delayInterval;
    const origin = fn.taskRegistration || (fn.taskDeclaration ? `TASK(${name}) 定义` : '入口函数名');
    tasks.push({ id: fn.id, name: fn.name, file: fn.file, line: fn.line,
      us: interval?.us ?? (Number.isSafeInteger(value) && value > 0 ? value : null),
      source: interval ? origin + ' · ' + interval.evidence : origin });
  }
  tasks.sort((a, b) => (a.us ?? Infinity) - (b.us ?? Infinity) || a.id.localeCompare(b.id));
  catalogs.set(model, tasks);
  return tasks;
}

export function taskPeriods(model) {
  if (cache.has(model)) return cache.get(model);
  const contexts = new Map();
  for (const task of projectTasks(model)) {
    // 已从有周期的调用者进入的普通 *_Task 助手沿用调用上下文。
    // 显式声明或注册的独立任务即使周期未知，也保留它对下游的影响。
    if (!task.us && task.source === '入口函数名' && contexts.get(task.id)?.some(c => c.us)) continue;
    const source = { task: task.id, us: task.us };
    const queue = [task.id], seen = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (!contexts.has(id)) contexts.set(id, []);
      contexts.get(id).push(source);
      for (const e of model._index.outAdj.get(id) || []) {
        if (!callKinds.has(e.kind) || seen.has(e.to)) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  for (const list of contexts.values()) list.sort((a, b) => (a.us ?? Infinity) - (b.us ?? Infinity) || a.task.localeCompare(b.task));
  cache.set(model, contexts);
  return contexts;
}

// 比较图分别取两个完整版本的调用链，避免在合并后的边上串出跨版本任务。
export function withTaskPeriods(nodes, model, comparison) {
  const current = taskPeriods(comparison?.afterModel || model);
  const previous = comparison && taskPeriods(comparison.beforeModel);
  const entries = new Set(projectTasks(comparison?.afterModel || model).map(t => t.id));
  if (comparison) for (const task of projectTasks(comparison.beforeModel)) entries.add(task.id);
  return nodes.map(n => n.kind === 'var' || n.headerSymbol ? n : {
    ...n, taskEntry: entries.has(n.id), taskPeriods: current.get(n.id) || [],
    ...(previous ? { previousTaskPeriods: previous.get(n.id) || [] } : {}),
  });
}
