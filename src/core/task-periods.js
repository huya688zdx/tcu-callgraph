import { collectArgs } from './lexer.js';
import { matchBrace } from './extract.js';

// 任务名给出标称周期。沿整个工程的调用图传播，条件调用只表示可能运行于该任务。
const cache = new WeakMap();
const catalogs = new WeakMap();
const callKinds = new Set(['direct', 'macro', 'fnptr']);
const taskName = /(?:^|_)(?:task|cyclic|periodic|runnable)(?=_|\d|$)/i;
const schedulerName = /(?:^|_)(?:main|isr|irq|handler|interrupt)(?=_|\d|$)/i;
const period = /(\d+)\s*(ms|us|µs|s)(?=$|_)/i;
const unitUs = { s: 1000000, ms: 1000, us: 1, 'µs': 1 };

// 调度器显式指定的函数可使用任意名称。只解析能唯一绑定到定义的直接标识符。
const registrations = new Set([
  'xTaskCreate', 'xTaskCreatePinnedToCore', 'xTaskCreateStatic', 'xTaskCreateStaticPinnedToCore',
  'osThreadNew', 'osTimerNew', 'ActivateTask', 'ChainTask',
]);
const delays = new Map([
  ['vTaskDelay', 0], ['vTaskDelayUntil', 1], ['xTaskDelayUntil', 1], ['osDelay', 0],
]);

export function collectTaskEvidence(fn, tokens) {
  const found = [];
  const intervals = [];
  let loopEnd = -1;
  for (let i = 0; i < tokens.length; i++) {
    const api = tokens[i].v;
    if (tokens[i + 1]?.v !== '(') continue;
    if (api === 'while' || api === 'for') {
      const [args, body] = collectArgs(tokens, i + 1);
      const condition = unwrap(args[0]?.map(t => t.v) || []).join('');
      if (api === 'while' ? /^(?:1[uUlL]*|true)$/.test(condition) : condition === ';;') {
        let end = body;
        if (tokens[body]?.v === '{') end = matchBrace(tokens, body);
        else while (end < tokens.length && tokens[end].v !== ';') end++;
        loopEnd = Math.max(loopEnd, end);
      }
    } else if (registrations.has(api)) {
      const [args] = collectArgs(tokens, i + 1);
      const callback = unwrap(args[0]?.map(t => t.v) || []).join('');
      const name = /^&?([A-Za-z_]\w*)$/.exec(callback)?.[1];
      if (name) found.push({ name, source: `${api} · ${fn.file}:${tokens[i].line}` });
    } else if (delays.has(api)) {
      const [args] = collectArgs(tokens, i + 1);
      const argument = args[delays.get(api)];
      if (argument) intervals.push({ api, argument: argument.map(t => t.v), inLoop: i < loopEnd,
        evidence: `${api} · ${fn.file}:${tokens[i].line}` });
    }
  }
  return found.length || intervals.length ? { registrations: found, intervals } : null;
}

export function applyTaskEvidence(fn, evidence, byName) {
  if (!evidence) return;
  for (const registration of evidence.registrations) {
    const candidates = byName.get(registration.name) || [];
    const local = candidates.filter(f => f.file === fn.file);
    const targets = local.length ? local : candidates.filter(f => !f.isStatic);
    if (targets.length === 1) targets[0].taskRegistration = registration.source;
  }
  if (evidence.intervals.length) fn.taskDelays = evidence.intervals;
}

export function captureTaskEvidence(fn, tokens, byName) {
  applyTaskEvidence(fn, collectTaskEvidence(fn, tokens), byName);
}

// 只剥除包住整个表达式的括号，保留子表达式的优先级。
function unwrap(tokens) {
  while (tokens[0] === '(' && tokens.at(-1) === ')') {
    let depth = 1;
    let i = 1;
    for (; i < tokens.length && depth; i++) {
      if (tokens[i] === '(') depth++;
      if (tokens[i] === ')') depth--;
    }
    if (i !== tokens.length || depth) break;
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}

function numericConstant(tokens, macros, file) {
  const seen = new Set();
  let value = unwrap(tokens);
  while (value.length === 1) {
    const text = value[0];
    if (/^(?:0[xX][\da-fA-F]+|0[0-7]*|[1-9]\d*)[uUlL]*$/.test(text)) {
      const number = text.replace(/[uUlL]+$/, '');
      return /^0[0-7]+$/.test(number) ? parseInt(number, 8) : Number(number);
    }
    const macro = macros.get(text);
    if (!macro || macro.params !== null || seen.has(text) ||
        (macro.file !== file && !/\.(h|hh|hpp)$/i.test(macro.file))) break;
    seen.add(text);
    value = unwrap(macro.body.map(t => t.v));
  }
  return null;
}

function delayInterval(fn, delays, macros, cmsisMillis) {
  const intervals = delays.map(({ api, argument, evidence, inLoop }) => {
    const arg = unwrap(argument);
    let ms = [];
    let budget = false;
    if (arg[0] === 'pdMS_TO_TICKS' && arg[1] === '(') {
      ms = arg.slice(1);
    } else if (arg.at(-2) === '/' && arg.at(-1) === 'portTICK_PERIOD_MS') {
      const numerator = unwrap(arg.slice(0, -2));
      // 周期预算减去本轮耗时，例如 (STEP_TIME - elapsed) / portTICK_PERIOD_MS。
      let depth = 0;
      const minus = numerator.findIndex(token => {
        if (token === '(') depth++;
        if (token === ')') depth--;
        return !depth && token === '-';
      });
      budget = inLoop && arg[0] === '(' && minus > 0 &&
        numerator.slice(minus + 1).some(token => /^[A-Za-z_]\w*$/.test(token) &&
          numericConstant([token], macros, fn.file) === null);
      ms = budget ? numerator.slice(0, minus) : numerator;
    } else if (api === 'osDelay' && cmsisMillis) {
      ms = arg;
    }
    const us = numericConstant(ms, macros, fn.file) * 1000;
    return { us: Number.isSafeInteger(us) && us > 0 ? us : null, evidence, budget };
  });
  // 明确的循环预算优先于分支中的等待，例如诊断暂停时的 tick 延时。
  const budgets = intervals.filter(delay => delay.budget && delay.us);
  const values = budgets.length ? budgets : intervals;
  const first = values[0];
  return first?.us && values.every(delay => delay.us === first.us) ? first : null;
}

/** 完整任务清单不受当前视图深度、检测建议条数或是否存在调用者限制。 */
export function projectTasks(model) {
  if (catalogs.has(model)) return catalogs.get(model);
  const tasks = [];
  const macros = new Map((model.macros || []).map(macro => [macro.name, macro]));
  const cmsisMillis = new Set((model.includes || [])
    .filter(entry => /(?:^|[/\\])cmsis_os\.h$/i.test(entry.target)).map(entry => entry.file));
  for (const fn of model.functions) {
    const name = fn.rawName || fn.name;
    const words = name.replace(/([a-z])([A-Z])/g, '$1_$2');
    const match = period.exec(name);
    const taskDelays = fn.taskDelays || [];
    const loopDelays = taskDelays.filter(delay => delay.inLoop);
    // 无限循环里的延时能标记独立任务，即使注册包装通过普通调用进入该函数。
    if (!fn.taskRegistration && !fn.taskDeclaration && !taskName.test(words) && !loopDelays.length &&
        !(match && schedulerName.test(words))) continue;
    const value = match && Number(match[1]) * unitUs[match[2].toLowerCase()];
    const interval = taskDelays.length
      ? delayInterval(fn, loopDelays.length ? loopDelays : taskDelays, macros, cmsisMillis.has(fn.file))
      : fn.delayInterval;
    const origin = fn.taskRegistration || (fn.taskDeclaration ? `TASK(${name}) 定义`
      : loopDelays.length ? '循环任务' : '入口函数名');
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

export function periodLabels(contexts) {
  const values = [...new Set(contexts.map(c => c.us).filter(us => us > 0))].sort((a, b) => a - b);
  return values.map(us => us % 1000000 === 0 ? `${us / 1000000}s` : us >= 1000 ? `${us / 1000}ms` : `${us}µs`);
}

export function nodeTaskPeriods(model, node, contexts = taskPeriods(model)) {
  if (node.kind !== 'var') return contexts.get(node.id) || [];
  const peers = new Set([...(model._df?.readers.get(node.id) || []), ...(model._df?.writers.get(node.id) || [])]);
  return [...new Map([...peers].flatMap(id => contexts.get(id) || []).map(c => [c.task, c])).values()]
    .sort((a, b) => (a.us ?? Infinity) - (b.us ?? Infinity) || a.task.localeCompare(b.task));
}

// 比较图分别取两个完整版本的调用链，避免在合并后的边上串出跨版本任务。
export function withTaskPeriods(nodes, model, comparison) {
  const current = taskPeriods(comparison?.afterModel || model);
  const previous = comparison && taskPeriods(comparison.beforeModel);
  const entries = new Set(projectTasks(comparison?.afterModel || model).map(t => t.id));
  if (comparison) for (const task of projectTasks(comparison.beforeModel)) entries.add(task.id);
  return nodes.map(n => n.headerSymbol || (n.kind === 'var' && !comparison) ? n : {
    ...n, taskEntry: entries.has(n.id), taskPeriods: nodeTaskPeriods(comparison?.afterModel || model, n, current),
    ...(previous ? { previousTaskPeriods: nodeTaskPeriods(comparison.beforeModel, n, previous) } : {}),
  });
}
