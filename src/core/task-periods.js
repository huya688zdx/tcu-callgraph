import { collectArgs } from './lexer.js';
import { matchBrace } from './extract.js';
import { numericConstant, scheduleConfig, unwrap } from './tcu-schedule.js';

// 任务名给出标称周期。沿整个工程的调用图传播，条件调用只表示可能运行于该任务。
const cache = new WeakMap();
const catalogs = new WeakMap();
const callKinds = new Set(['direct', 'macro', 'fnptr']);
const taskName = /(?:^|_)(?:task|cyclic|periodic|runnable)(?=_|\d|$)/i;
const isrName = /(?:^|_)(?:isr|irq|handler|interrupt)(?=_|\d|$)/i;
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

const irqOff = /^(?:DisableAllInterrupts|__disable_irq)$/;
const irqOn = /^(?:EnableAllInterrupts|__enable_irq)$/;
const enter = /^(?:SuspendAllInterrupts|EnterCritical|taskENTER_CRITICAL|SchM_Enter_(.+))$/;
const leave = /^(?:ResumeAllInterrupts|ExitCritical|taskEXIT_CRITICAL|SchM_Exit_(.+))$/;
const lockFamily = (name, match) => match[1] ?? name.replace(/Suspend|Resume|Enter|Exit|ENTER|EXIT/, '');
const joinedLock = Symbol('保护方式随分支变化');
const mergeLocks = (target, ...paths) => {
  const common = [...paths[0]].map(([key, depth]) => [
    key, paths.reduce((min, path) => Math.min(min, path.get(key) || 0), depth),
  ]);
  const protectedOnEveryPath = paths.every(path => path.size > 0);
  target.clear();
  for (const [key, depth] of common) if (depth) target.set(key, depth);
  if (!target.size && protectedOnEveryPath) target.set(joinedLock, 1);
};

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function compatible(a, b) {
  if (a.counter !== b.counter || a.version !== b.version || a.rem == null || b.rem == null) return true;
  const divisor = gcd(a.divider, b.divider);
  return a.rem % divisor === b.rem % divisor;
}
const counterWrites = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '++', '--']);

function dividerCondition(parts, constant) {
  const condition = unwrap(parts.map(t => t.v));
  const operator = condition.findIndex(v => v === '==' || v === '>=');
  if (operator < 0) return null;
  const lhs = condition.slice(0, operator);
  const left = unwrap(lhs);
  const right = constant(condition.slice(operator + 1));
  if (right == null || !/^[A-Za-z_]\w*$/.test(left[0] === '++' ? left[1] : left[0])) return null;
  if (condition[operator] === '>=') {
    return left[0] === '++' && left.length === 2 && right > 1 ? { counter: left[1], divider: right, min: right, reset: true } : null;
  }
  const [counter, op, ...amount] = left;
  const n = constant(amount);
  if (op === '%' && n > 1) return { counter, divider: n, rem: right, impossible: right >= n };
  if (op === '&' && lhs[0] === '(' && n > 0 &&
      (BigInt(n) & (BigInt(n) + 1n)) === 0n && Number.isSafeInteger(n + 1)) {
    return { counter, divider: n + 1, mask: n, rem: right, impossible: right > n };
  }
  return null;
}

/** 按 C 语句确定分频分支范围，调用位置区分同一行的条件调用和无条件调用。 */
function schedulingEvidence(fn, tokens, fileMacros, calls) {
  const increments = new Map();
  const incrementLines = new Map();
  const writes = new Map();
  const dividers = [];
  const locals = new Set(fn.params || []);
  const staticLocals = new Set();
  const shadowed = new Set();
  const resets = new Map();
  const callSites = new Set(calls.map(c => `${c.line}:${c.col}`));
  const onceSites = new Set();
  const guardAccess = tokens.some(t => irqOff.test(t.v) || enter.test(t.v)) ? new Map() : null;
  let bypass = false;
  let blockDepth = 0;
  const recordIncrement = (counter, lines) => {
    increments.set(counter, (increments.get(counter) || 0) + 1);
    incrementLines.set(counter, lines);
  };
  const recordWrite = counter => writes.set(counter, (writes.get(counter) || 0) + 1);
  const numberAt = (parts, index) => numericConstant(parts, name => fileMacros?.get(name, tokens[index].line), fn.file);
  const value = i => tokens[i]?.v;
  const recordWrites = (first, last) => {
    for (let k = first; k < last; k++) {
      if (tokens[k].t !== 'id' || ['.', '->'].includes(value(k - 1))) continue;
      if (counterWrites.has(value(k + 1)) || ['++', '--'].includes(value(k - 1))) recordWrite(value(k));
    }
  };
  const visit = (i, end, depth, guards, locks, jumps) => {
    while (i < end) i = statement(i, end, depth, guards, locks, jumps);
  };
  const recordAccess = (i, end, guards, locks) => {
    for (let k = i; k < end; k++) {
      const t = tokens[k];
      if (t.t !== 'id') continue;
      if (guards.length && callSites.has(`${t.line}:${t.col}`)) dividers.push({
        line: t.line, col: t.col, gates: guards,
      });
      if (!guardAccess || value(k + 1) === '(') continue;
      if (!guardAccess.has(t.v)) guardAccess.set(t.v, new Map());
      const lines = guardAccess.get(t.v);
      lines.set(t.line, (lines.get(t.line) ?? true) && locks.size > 0);
    }
  };
  function statementEnd(i, end) {
    const op = value(i);
    if (op === '{') {
      const close = matchBrace(tokens, i);
      return close < 0 ? end : close + 1;
    }
    if (['if', 'for', 'while', 'switch'].includes(op) && value(i + 1) === '(') {
      const start = collectArgs(tokens, i + 1)[1];
      const next = statementEnd(start, end);
      return op === 'if' && value(next) === 'else' ? statementEnd(next + 1, end) : next;
    }
    if (op === 'do') {
      const next = statementEnd(i + 1, end);
      if (value(next) !== 'while' || value(next + 1) !== '(') return next;
      return Math.min(end, collectArgs(tokens, next + 1)[1] + 1);
    }
    while (i < end && value(i) !== ';') i++;
    return Math.min(i + 1, end);
  }

  function statement(i, end, depth, guards, locks, jumps) {
    const op = value(i);
    if (op === '{') {
      const close = matchBrace(tokens, i);
      if (close < 0) return end;
      blockDepth++;
      visit(i + 1, close, depth, guards, locks, jumps);
      blockDepth--;
      return close + 1;
    }
    if (['if', 'for', 'while', 'switch'].includes(op) && value(i + 1) === '(') {
      const [args, start] = collectArgs(tokens, i + 1);
      recordAccess(i + 2, Math.min(start - 1, end), guards, locks);
      recordWrites(i + 2, Math.min(start - 1, end));
      let gate = op === 'if' && args.length === 1 ? dividerCondition(args[0], p => numberAt(p, i)) : null;
      if (gate?.reset) {
        const close = value(start) === '{' ? matchBrace(tokens, start) : start;
        // 清零必须是进入该分支后执行的首条语句。
        const reset = close > start && value(start + 1) === gate.counter && value(start + 2) === '=' &&
          numberAt([value(start + 3)], start) === 0 && value(start + 4) === ';';
        if (reset && !depth && !bypass && !tokens[i].cond) {
          const increment = args[0].find(t => t.v === gate.counter);
          recordIncrement(gate.counter, [increment.line, tokens[start + 1].line]);
          resets.set(gate.counter, gate.divider);
        }
        else gate = null;
      }
      if (gate) {
        gate.version = writes.get(gate.counter) || 0;
        if (guards.some(previous => !compatible(previous, gate))) gate.impossible = true;
      }
      const nested = gate ? [...guards, gate] : guards;
      const yes = new Map(locks), no = new Map(locks);
      const branchJumps = op === 'if' ? jumps : { break: [], continue: op === 'switch' ? jumps?.continue : [] };
      if (op === 'while' || op === 'for') discardLoopLocks(start, statementEnd(start, end), yes);
      const next = statement(start, end, depth + 1, nested, yes, branchJumps);
      const after = op === 'if' && value(next) === 'else'
        ? statement(next + 1, end, depth + 1, guards, no, jumps) : next;
      const truth = op === 'if' && args.length === 1 ? numberAt(args[0].map(t => t.v), i) : null;
      if (gate?.impossible || truth === 0) mergeLocks(locks, no);
      else if (truth != null) mergeLocks(locks, yes);
      else mergeLocks(locks, yes, no, ...(op === 'if' ? [] : branchJumps.break),
        ...(op === 'while' || op === 'for' ? branchJumps.continue : []));
      return after;
    }
    if (op === 'do') {
      const start = i + 1;
      // do-while(0) 执行一次，其余循环可能以不同中断状态重入。
      const tail = statementEnd(start, end);
      const condition = value(tail) === 'while' && value(tail + 1) === '('
        ? collectArgs(tokens, tail + 1)[0][0] : null;
      if (!condition || numberAt(condition.map(t => t.v), i) !== 0) discardLoopLocks(start, tail, locks);
      const loopJumps = { break: [], continue: [] };
      const next = statement(start, end, depth + 1, guards, locks, loopJumps);
      mergeLocks(locks, locks, ...loopJumps.continue);
      if (value(next) !== 'while' || value(next + 1) !== '(') return next;
      const [, after] = collectArgs(tokens, next + 1);
      recordAccess(next + 2, Math.min(after - 1, end), guards, locks);
      recordWrites(next + 2, Math.min(after - 1, end));
      mergeLocks(locks, locks, ...loopJumps.break);
      return value(after) === ';' ? after + 1 : after;
    }
    if (op === 'case' || op === 'default' || value(i + 1) === ':') {
      let colon = i + 1;
      while (colon < end && value(colon) !== ':') colon++;
      locks.clear();
      return colon + 1;
    }
    let stop = i;
    while (stop < end && value(stop) !== ';') stop++;
    const parts = tokens.slice(i, stop).map(t => t.v);
    const lhs = parts.slice(0, parts.includes('=') ? parts.indexOf('=') : parts.length);
    const id = /^[A-Za-z_]\w*$/;
    const declaration = lhs.length >= 2 && id.test(lhs.at(-1)) &&
      lhs.every(word => id.test(word) || word === '*') && !['return', 'goto', 'case'].includes(lhs[0]);
    if (declaration) {
      // 内层同名声明可能与分频条件指向不同对象，不能用函数范围的名称配对。
      if (depth || blockDepth || locals.has(lhs.at(-1))) shadowed.add(lhs.at(-1));
      locals.add(lhs.at(-1));
      if (lhs.includes('static')) staticLocals.add(lhs.at(-1));
      // 初始化表达式也可能给已有计数器赋值。
      recordWrites(i + lhs.length + 1, stop);
    } else recordWrites(i, stop);
    if (depth === guards.length && !bypass && !tokens[i].cond) {
      // 整条调用语句仅受已识别的分频门控。循环、其他条件、短路和跳转可改变执行次数。
      const start = op === 'return' ? i + 1 : i;
      if (tokens[start]?.t === 'id' && value(start + 1) === '(' && collectArgs(tokens, start + 1)[1] === stop) {
        onceSites.add(`${tokens[start].line}:${tokens[start].col}`);
      }
    }
    if (!depth && !bypass && !tokens[i].cond) {
      if (parts.length === 2 && parts[0] === '++' && id.test(parts[1])) recordIncrement(parts[1], [tokens[i + 1].line]);
      if (parts.length === 2 && parts[1] === '++' && id.test(parts[0])) recordIncrement(parts[0], [tokens[i].line]);
      if (parts[1] === '+=' && id.test(parts[0]) && numberAt(parts.slice(2), i) === 1) recordIncrement(parts[0], [tokens[i].line]);
    }
    if (parts.some(word => ['return', 'goto'].includes(word))) bypass = true;
    recordAccess(i, stop, guards, locks);
    if (parts[1] === '(') {
      const open = enter.exec(op), close = leave.exec(op);
      if (!tokens[i].cond && irqOff.test(op)) locks.set('irq', 1);
      if (irqOn.test(op)) locks.clear();
      if (open && !tokens[i].cond) {
        const key = lockFamily(op, open);
        locks.set(key, (locks.get(key) || 0) + 1);
      }
      if (close) {
        locks.delete(joinedLock);
        const key = lockFamily(op, close), remaining = (locks.get(key) || 0) - 1;
        if (remaining > 0) locks.set(key, remaining);
        else locks.delete(key);
      }
    }
    if ((op === 'break' || op === 'continue') && !guards.some(gate => gate.impossible)) {
      jumps?.[op]?.push(new Map(locks));
    }
    if (['break', 'continue', 'goto', 'return'].includes(op)) locks.clear();
    return stop + 1;
  }
  function discardLoopLocks(start, end, locks) {
    for (let i = start; i < end; i++) {
      const op = value(i), close = leave.exec(op);
      if (irqOn.test(op)) locks.clear();
      if (close) {
        locks.delete(joinedLock);
        locks.delete(lockFamily(op, close));
      }
    }
  }
  visit(0, tokens.length, 0, [], new Map());
  // 向后跳转可以重复执行位于 goto 前的调用点。
  if (onceSites.size && !tokens.some(t => t.v === 'goto')) {
    for (const call of calls) if (call.kind === 'direct' && onceSites.has(`${call.line}:${call.col}`)) {
      call.onceWhenGatesMatch = true;
    }
  }
  const bindLocal = gate => ({ ...gate, local: locals.has(gate.counter) });
  const counterIncrements = [...increments].filter(([counter, count]) =>
    count === 1 && !shadowed.has(counter) && writes.get(counter) === (resets.has(counter) ? 2 : 1) &&
    (!locals.has(counter) || staticLocals.has(counter)))
    .map(([counter]) => bindLocal({ counter, lines: incrementLines.get(counter), resetDivider: resets.get(counter) }));
  const callDividers = dividers.map(({ line, col, gates }) => ({ line, col, gates: gates.map(({ version, ...gate }) => bindLocal(gate)) }));
  const criticalAccess = guardAccess && [...guardAccess].flatMap(([name, lines]) => {
    const guarded = [...lines].filter(([, protectedLine]) => protectedLine).map(([line]) => line);
    return guarded.length ? [[name, guarded]] : [];
  });
  return { counterIncrements, callDividers, criticalAccess };
}

export function collectTaskEvidence(fn, tokens, fileMacros, calls = []) {
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
      if (argument) {
        const delay = { api, argument: argument.map(t => t.v), inLoop: i < loopEnd,
          evidence: `${api} · ${fn.file}:${tokens[i].line}` };
        if (fileMacros) delay.resolved = resolveDelay(delay, name => fileMacros.get(name, tokens[i].line), fn.file);
        intervals.push(delay);
      }
    }
  }
  const evidence = schedulingEvidence(fn, tokens, fileMacros, calls);
  return found.length || intervals.length || evidence.counterIncrements.length || evidence.callDividers.length ||
    evidence.criticalAccess?.length ? { registrations: found, intervals, ...evidence } : null;
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
  if (evidence.counterIncrements.length) fn.counterIncrements = evidence.counterIncrements;
  if (evidence.callDividers.length) fn.callDividers = evidence.callDividers;
  if (evidence.criticalAccess?.length) fn.criticalAccess = evidence.criticalAccess;
}

export function captureTaskEvidence(fn, tokens, byName) {
  applyTaskEvidence(fn, collectTaskEvidence(fn, tokens), byName);
}

function resolveDelay({ api, argument, inLoop }, findMacro, file) {
  const arg = unwrap(argument);
  let ms = [];
  let budget = false;
  let requiresCmsisMillis = false;
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
      numerator.slice(minus + 1).some(token => /^[A-Za-z_]\w*$/.test(token) && numericConstant([token], findMacro, file) === null);
    ms = budget ? numerator.slice(0, minus) : numerator;
  } else if (api === 'osDelay') {
    ms = arg;
    requiresCmsisMillis = true;
  }
  const us = numericConstant(ms, findMacro, file) * 1000;
  return { us: Number.isSafeInteger(us) && us > 0 ? us : null, budget, requiresCmsisMillis };
}

function delayInterval(fn, delays, macros, cmsisMillis) {
  const intervals = delays.map(delay => {
    const { us, budget, requiresCmsisMillis } = delay.resolved ?? resolveDelay(delay, name => macros.get(name), fn.file);
    return { us: requiresCmsisMillis && !cmsisMillis ? null : us, budget, evidence: delay.evidence };
  });
  // 明确的循环预算优先于分支中的等待，例如诊断暂停时的 tick 延时。
  const budgets = intervals.filter(delay => delay.budget && delay.us);
  const values = budgets.length ? budgets : intervals;
  // 多次等待可能顺序执行，参数相同也不足以确定循环周期。
  return values.length === 1 && values[0].us ? values[0] : null;
}

/** 完整任务清单不受当前视图深度、检测建议条数或是否存在调用者限制。 */
export function projectTasks(model) {
  if (catalogs.has(model)) return catalogs.get(model);
  const tasks = [];
  const config = new Map();
  for (const row of scheduleConfig(model).rows) {
    const candidates = model._index.byName.get(row.name) || [];
    const targets = row.file ? candidates.filter(fn => fn.file === row.file) : candidates;
    if (targets.length !== 1) continue;
    const id = targets[0].id;
    if (!config.has(id)) config.set(id, []);
    config.get(id).push(row);
  }
  const macros = new Map((model.macros || []).map(macro => [macro.name, macro]));
  const cmsisMillis = new Set((model.includes || [])
    .filter(entry => /(?:^|[/\\])cmsis_os\.h$/i.test(entry.target)).map(entry => entry.file));
  for (const fn of model.functions) {
    const name = fn.rawName || fn.name;
    const words = name.replace(/([A-Z])([A-Z][a-z])/g, '$1_$2').replace(/([a-z])([A-Z])/g, '$1_$2');
    const match = period.exec(name);
    const taskDelays = fn.taskDelays || [];
    const loopDelays = taskDelays.filter(delay => delay.inLoop);
    // 无限循环里的延时能标记独立任务，即使注册包装通过普通调用进入该函数。
    const kind = fn.isrDeclaration || isrName.test(words) ? 'isr' : 'task';
    const rows = config.get(fn.id) || fn.scheduleRows || [];
    if (!rows.length && !fn.taskRegistration && !fn.taskDeclaration && !taskName.test(words) &&
        !loopDelays.length && kind !== 'isr' && !(match && /(?:^|_)main(?=_|\d|$)/i.test(words))) continue;
    const value = match && Number(match[1]) * unitUs[match[2].toLowerCase()];
    const interval = taskDelays.length
      ? delayInterval(fn, loopDelays.length ? loopDelays : taskDelays, macros, cmsisMillis.has(fn.file))
      : fn.delayInterval;
    const origin = fn.taskRegistration || (fn.isrDeclaration ? `中断入口声明 · ${name}` : fn.taskDeclaration ? `TASK(${name}) 定义`
      : loopDelays.length ? '循环任务' : '入口函数名');
    const nominal = interval?.us ?? (Number.isSafeInteger(value) && value > 0 ? value : null);
    const priority = rows.reduce((max, row) => Math.max(max, row.priority || 0), 0);
    const selected = rows.filter(row => (row.priority || 0) === priority);
    const evidence = selected.length || fn.taskRegistration || fn.isrDeclaration || fn.taskDeclaration || loopDelays.length
      ? 'source' : 'name-hint';
    const seen = new Set();
    for (const row of selected.length ? selected : [{ us: nominal, source: interval ? origin + ' · ' + interval.evidence : origin }]) {
      const us = row.us ?? nominal;
      const entryKind = row.kind === 'isr' ? 'isr' : kind;
      const key = `${entryKind}:${us}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ id: fn.id, name: fn.name, file: fn.file, line: fn.line, us, kind: entryKind, source: row.source, evidence });
    }
  }
  tasks.sort((a, b) => (a.us ?? Infinity) - (b.us ?? Infinity) || a.id.localeCompare(b.id));
  catalogs.set(model, tasks);
  return tasks;
}

function lcm(a, b) {
  if (!a || !b) return a || b;
  return a / gcd(a, b) * b;
}

const contextOrder = (a, b) => (a.us ?? Infinity) - (b.us ?? Infinity) || a.task.localeCompare(b.task);
const contextKey = c => `${c.task}:${c.kind}:${c.us}`;

/** 只有全局计数器的分频需要全工程写者证据，局部静态计数不触发按需 AST。 */
export function needsCounterAnalysis(model) {
  return !model._df && model.functions.some(fn => fn.callDividers?.some(site => site.gates.some(g => !g.local)));
}

export function taskPeriods(model) {
  const cached = cache.get(model);
  if (cached && cached.df === model._df) return cached.contexts;
  const collected = new Map();
  const tasks = projectTasks(model);
  const byEntry = new Map();
  for (const task of tasks) {
    if (!byEntry.has(task.id)) byEntry.set(task.id, []);
    byEntry.get(task.id).push(task);
  }
  const tickOwners = new Map();
  const ownIncrements = new Map();
  const df = model._df;
  const complete = df?.fnAccess && !df.failedFiles && !model.warnings?.length &&
    model.functions.every(fn => df.fnAccess.has(fn.id));
  const gatesByFn = new Map();
  for (const fn of model.functions) {
    for (const inc of fn.counterIncrements || []) {
      if (!inc.local) {
        if (!complete || !inc.variable) continue;
        const writers = df.writers.get(inc.variable);
        const write = df.fnAccess.get(fn.id)?.writes.get(inc.variable);
        const definition = df.byId.get(inc.variable);
        // 只认实际绑定的变量和完整写者集，未解析的取地址写入也会打断分频。
        if (!definition || definition.isExtern || writers?.size !== 1 || !writers.has(fn.id) ||
            !write || write.indirect || !inc.lines || [...write.lines].some(line => !inc.lines.includes(line))) continue;
      }
      if (!ownIncrements.has(fn.id)) ownIncrements.set(fn.id, []);
      ownIncrements.get(fn.id).push(inc);
      if (inc.local || inc.resetDivider) continue;
      if (!tickOwners.has(inc.variable)) tickOwners.set(inc.variable, []);
      tickOwners.get(inc.variable).push(fn.id);
    }
    if (fn.callDividers) gatesByFn.set(fn.id, new Map(fn.callDividers.map(site =>
      [`${site.line}:${site.col}`, site.gates])));
  }
  const { tickUs } = scheduleConfig(model);
  const ticks = new Map();
  const incomingCalls = new Map();
  for (const edge of model.edges) if (callKinds.has(edge.kind) && !edge.headerReference) {
    incomingCalls.set(edge.to, (incomingCalls.get(edge.to) || 0) + 1);
  }
  for (const [variable, owners] of tickOwners) {
    if (owners.length !== 1) continue;
    const entries = (byEntry.get(owners[0]) || []).filter(task => task.us);
    if (incomingCalls.has(owners[0])) continue;
    if (entries.length === 1) ticks.set(variable, entries[0]);
    else if (!entries.length && tickUs) ticks.set(variable, { id: owners[0], us: tickUs,
      kind: byEntry.get(owners[0])?.[0]?.kind || 'task', source: 'tcu-schedule.json · tickUs' });
  }

  function propagate(id, source) {
    const queue = [{ id, source, once: !!source && !incomingCalls.has(id) && byEntry.get(id)?.length === 1 }];
    const seen = new Set();
    for (let i = 0; i < queue.length; i++) {
      const { id, source, once } = queue[i];
      const key = JSON.stringify([id, source?.us, source?.kind, !!source?.dividers, once]);
      if (seen.has(key)) continue;
      seen.add(key);
      if (source) {
        if (!collected.has(id)) collected.set(id, []);
        collected.get(id).push(source);
      }
      const fn = model._index.byId.get(id);
      for (const edge of model._index.outAdj.get(id) || []) {
        if (!callKinds.has(edge.kind) || edge.headerReference) continue;
        const gates = gatesByFn.get(id)?.get(`${edge.line}:${edge.col}`) || [];
        if (gates.some(gate => gate.impossible)) continue;
        let us = source?.us, tick;
        const evidence = [];
        for (const gate of gates) {
          const own = ownIncrements.get(fn.id)?.some(inc => inc.counter === gate.counter && inc.local === gate.local &&
            (!inc.resetDivider || gate.reset));
          const owner = !own && !gate.local && ticks.get(gate.variable);
          const basis = own && once ? source?.us : owner?.us;
          if (!(basis > 0)) continue;
          const next = lcm(us, basis * gate.divider);
          if (!Number.isSafeInteger(next)) continue;
          us = next;
          tick ||= owner;
          evidence.push({ counter: gate.counter, divider: gate.divider, file: fn.file, line: edge.line, col: edge.col });
        }
        const nextOnce = once && edge.onceWhenGatesMatch === true && evidence.length === gates.length &&
          incomingCalls.get(edge.to) === 1 && !byEntry.has(edge.to);
        if (!evidence.length) {
          if (source) queue.push({ id: edge.to, source, once: nextOnce });
          continue;
        }
        // 已有独立入口提供同一周期时，避免把主循环的 tick 再当成一个任务。
        if (!source && byEntry.get(edge.to)?.some(task => task.us === us)) continue;
        const base = source ?? { task: tick.id, kind: tick.kind, source: tick.source };
        const prior = base.dividers || [];
        if (prior.some(item => item.file === fn.file && item.line === edge.line && item.col === edge.col)) continue;
        queue.push({ id: edge.to, once: nextOnce, source: { ...base, us, dividers: [...prior, ...evidence] } });
      }
    }
  }

  for (const task of tasks.filter(task => task.us)) {
    propagate(task.id, { task: task.id, us: task.us, kind: task.kind, source: task.source });
  }
  if (ticks.size) for (const fn of model.functions) {
    if (/^main$/i.test(fn.name) && gatesByFn.has(fn.id) && !byEntry.get(fn.id)?.some(task => task.us)) {
      propagate(fn.id, null);
    }
  }
  for (const task of tasks.filter(task => !task.us)) {
    // 已从有周期的调用者进入的普通 *_Task 助手沿用调用上下文。
    // 显式声明或注册的独立任务即使周期未知，也保留它对下游的影响。
    if (task.kind !== 'isr' && task.source === '入口函数名' && collected.get(task.id)?.some(c => c.us)) continue;
    propagate(task.id, { task: task.id, us: task.us, kind: task.kind, source: task.source });
  }
  const contexts = new Map([...collected].map(([id, list]) => {
    const direct = new Map();
    for (const c of list) if (!c.dividers && c.us) {
      direct.set(c.kind, Math.min(c.us, direct.get(c.kind) ?? Infinity));
    }
    const unique = new Map();
    for (const c of list) {
      // 更快的无分频路径已能触发该函数；ISR 与普通任务仍是不同执行上下文。
      if (c.dividers && c.us >= (direct.get(c.kind) ?? Infinity)) continue;
      const key = contextKey(c);
      if (!unique.has(key) || !c.dividers) unique.set(key, c);
    }
    return [id, [...unique.values()].sort(contextOrder)];
  }));
  cache.set(model, { df, contexts });
  return contexts;
}

export function periodLabels(contexts) {
  const values = [...new Set(contexts.map(c => c.us).filter(us => us > 0))].sort((a, b) => a - b);
  return values.map(us => us % 1000000 === 0 ? `${us / 1000000}s` : us >= 1000 ? `${us / 1000}ms` : `${us}µs`);
}

export function nodeTaskPeriods(model, node, contexts = taskPeriods(model)) {
  if (node.kind !== 'var') return contexts.get(node.id) || [];
  const peers = new Set([...(model._df?.readers.get(node.id) || []), ...(model._df?.writers.get(node.id) || [])]);
  return [...new Map([...peers].flatMap(id => contexts.get(id) || []).map(c => [contextKey(c), c])).values()]
    .sort(contextOrder);
}

function crossPeriod(model, node, contexts) {
  const df = model._df;
  if (!df) return null;
  const peers = (index, mode) => [...(index.get(node.id) || [])].flatMap(id => {
    const periods = (contexts.get(id) || []).filter(c => c.us || c.kind === 'isr');
    return periods.length ? [{ id, mode, periods }] : [];
  });
  const writers = peers(df.writers, 'writes'), readers = peers(df.readers, 'reads');
  const signature = c => `${c.kind === 'isr' ? 'isr' : 'task'}:${c.us}`;
  const wp = writers.flatMap(peer => peer.periods), rp = readers.flatMap(peer => peer.periods);
  const rates = new Set([...wp, ...rp].map(signature));
  if (!wp.length || !rp.length || rates.size < 2) return null;
  const values = periods => [...new Set(periods.map(c => c.us).filter(us => us > 0))].sort((a, b) => a - b);
  const hasIsr = periods => periods.some(c => c.kind === 'isr');
  const protectedAccess = [...writers, ...readers].every(({ id, mode }) => {
    const lines = df.fnAccess?.get(id)?.[mode]?.get(node.id)?.lines;
    const guarded = model._index.byId.get(id)?.criticalAccess?.find(([name]) => name === node.name)?.[1];
    return Boolean(lines?.size && guarded && [...lines].every(line => guarded.includes(line)));
  });
  return { writerUs: values(wp), readerUs: values(rp), hasIsr: hasIsr(wp) || hasIsr(rp), protected: protectedAccess };
}

// 比较图分别取两个完整版本的调用链，避免在合并后的边上串出跨版本任务。
export function withTaskPeriods(nodes, model, comparison) {
  const after = comparison?.afterModel || model;
  const current = taskPeriods(after);
  const previous = comparison && taskPeriods(comparison.beforeModel);
  const entries = new Set(projectTasks(comparison?.afterModel || model).map(t => t.id));
  if (comparison) for (const task of projectTasks(comparison.beforeModel)) entries.add(task.id);
  return nodes.map(n => {
    if (n.headerSymbol || (n.kind === 'var' && !comparison && !after._df)) return n;
    const periods = nodeTaskPeriods(after, n, current);
    const isIsr = periods.some(c => c.kind === 'isr');
    const cross = n.kind === 'var' && crossPeriod(after, n, current);
    return { ...n, taskEntry: entries.has(n.id), taskPeriods: periods,
      ...(n.kind === 'var' ? (cross ? { crossPeriod: cross } : {}) : {
        isIsr, multiRate: new Set(periods.map(c => c.us).filter(Boolean)).size > 1 ||
          (isIsr && periods.some(c => c.kind !== 'isr' && c.us > 0)),
      }),
      ...(previous ? { previousTaskPeriods: nodeTaskPeriods(comparison.beforeModel, n, previous) } : {}),
    };
  });
}
