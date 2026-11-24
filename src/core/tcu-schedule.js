import fs from 'node:fs';
import path from 'node:path';
import { collectArgs, lex } from './lexer.js';
import { matchBrace } from './extract.js';

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const scheduleName = /sched|task|cyclic|period|rate|table/i;
const periodField = /period|interval|cycle|rate|tick|^(?:ms|us)$/i;
const identifier = /^[A-Za-z_]\w*$/;

export function unwrap(tokens) {
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

export function numericConstant(tokens, findMacro, file) {
  const seen = new Set();
  let value = unwrap(tokens);
  while (value.length === 1) {
    const token = value[0];
    if (/^(?:0[xX][\da-fA-F]+|0[bB][01]+|0[0-7]*|[1-9]\d*)[uUlL]*$/.test(token)) {
      const number = token.replace(/[uUlL]+$/, '');
      const result = /^0[0-7]+$/.test(number) ? parseInt(number, 8) : Number(number);
      return Number.isSafeInteger(result) ? result : null;
    }
    const macro = findMacro(token);
    if (!macro || macro.params !== null || seen.has(token) ||
        (file && macro.file !== file && !/\.(h|hh|hpp)$/i.test(macro.file))) break;
    seen.add(token);
    value = unwrap(macro.body.map(t => t.v));
  }
  return null;
}

const validUs = value => Number.isSafeInteger(value) && value > 0;

/** 只扫描文件作用域的数组初始化，使用当前行可见的宏。 */
export function staticSchedule(tokens, file, macros) {
  const rows = [];
  const structures = new Map();
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].v === ';') start = i + 1;
    if (tokens[i].v !== '{') continue;
    const end = matchBrace(tokens, i);
    if (end < 0) break;
    const head = tokens.slice(start, i).map(t => t.v);
    const struct = head.indexOf('struct');
    if (struct !== -1 && head.length - struct <= 2) {
      const members = tokens.slice(i + 1, end).map(t => t.v).join(' ').split(';').slice(0, -1);
      const names = members.map(member => /\(\s*\*\s*(\w+)/.exec(member)?.[1] ||
        /\b(\w+)\s*(?:\[[^\]]*\])?\s*$/.exec(member)?.[1]);
      if (head[struct + 1]) structures.set(head[struct + 1], names);
      if (head.includes('typedef') && tokens[end + 1]?.t === 'id') structures.set(tokens[end + 1].v, names);
    }
    if (head.at(-1) === '=' && head.at(-2) === ']' && tokens[i + 1]?.v === '{') {
      const fields = /(?:^|_)(?:us|usec|microseconds)$|periodUs$/i;
      const members = head.map(word => structures.get(word)).find(Boolean) || [];
      for (const row of collectArgs(tokens, i)[0]) {
        if (row[0]?.v !== '{') continue;
        const values = collectArgs(row, 0)[0].map((field, index) => ({
          name: field[0]?.v === '.' && field[2]?.v === '=' ? field[1].v : members[index] || '',
          tokens: unwrap((field[0]?.v === '.' ? field.slice(3) : field).map(t => t.v)),
        }));
        if (![...head, ...values.map(field => field.name)].some(word => scheduleName.test(word))) continue;
        const names = values.map(({ tokens: parts }) => parts.join('').replace(/^&/, ''))
          .filter(name => identifier.test(name));
        if (!names.length) continue;
        const designated = values.filter(field => periodField.test(field.name));
        for (const field of designated.length ? designated : values.filter(field => !field.name)) {
          const number = numericConstant(field.tokens, name => macros.get(name, row[0].line), file);
          if (number == null) continue;
          const us = number * (fields.test(field.name) ? 1 : 1000);
          if (validUs(us)) rows.push({ names, file, line: row[0].line, us, source: `C 调度表 · ${file}:${row[0].line}` });
          break;
        }
      }
    }
    i = end;
    start = end + 1;
  }
  return rows;
}

export function applyStaticSchedule(rows, byName) {
  for (const { names, file, us, source } of rows) {
    const targets = new Set();
    for (const name of names) {
      const candidates = byName.get(name) || [];
      const local = candidates.filter(fn => fn.file === file);
      const visible = local.length ? local : candidates.filter(fn => !fn.isStatic);
      if (visible.length === 1) targets.add(visible[0]);
    }
    if (targets.size === 1) ([...targets][0].scheduleRows ??= []).push({ us, source });
  }
}

function oilSchedule(text, file) {
  const tokens = lex(text, file, 250000);
  const counters = new Map();
  const tasks = new Set();
  const alarms = [];
  for (let i = 0; i < tokens.length; i++) {
    const type = tokens[i].v;
    if (!['COUNTER', 'ALARM', 'TASK'].includes(type) ||
        tokens[i + 1]?.t !== 'id' || tokens[i + 2]?.v !== '{') continue;
    const name = tokens[i + 1].v;
    const end = matchBrace(tokens, i + 2);
    if (end < 0) break;
    const body = tokens.slice(i + 3, end).map(t => t.v).join(' ');
    if (type === 'TASK') tasks.add(name);
    if (type === 'COUNTER') {
      const seconds = /\bSECONDSPERTICK\s*=\s*([^;]+)/.exec(body)?.[1].replace(/\s/g, '');
      counters.set(name, seconds == null ? 1000 : Number(seconds) * 1000000);
    }
    if (type === 'ALARM') {
      const task = /\bACTION\s*=\s*ACTIVATETASK\s*\{\s*TASK\s*=\s*(\w+)\s*;/.exec(body)?.[1];
      const counter = /\bCOUNTER\s*=\s*(\w+)/.exec(body)?.[1];
      const cycles = /\bCYCLETIME\s*=\s*(\w+)\s*;/.exec(body)?.[1];
      if (task && cycles) alarms.push({ task, counter, cycles: numericConstant([cycles], () => null) });
    }
    i = end;
  }
  return alarms.flatMap(({ task, counter, cycles }) => {
    const us = Math.round(cycles * (counters.get(counter) ?? 1000));
    return tasks.has(task) && validUs(us) ? [{ name: task, us, source: `OIL 配置 · ${file}` }] : [];
  });
}

// 只提取 ARXML 元素及其文本，不读取外部实体或 DTD。
function collectArxml(text, file, runnables, events) {
  const root = { children: [] };
  const stack = [root];
  let elements = 0;
  const token = /<(\/?)(?:[\w.-]+:)?([\w.-]+)(?=[\s/>])[^<>]*>|[^<]+|</y;
  while (token.lastIndex < text.length) {
    const index = token.lastIndex;
    const terminator = text.startsWith('<!--', index) ? '-->' : text.startsWith('<?', index) ? '?>' : null;
    if (terminator) {
      const end = text.indexOf(terminator, index + 2);
      if (end < 0) throw new Error('ARXML 注释或处理指令未闭合');
      token.lastIndex = end + terminator.length;
      continue;
    }
    const [chunk, close, tag] = token.exec(text);
    const node = stack.at(-1);
    if (!tag) {
      if (chunk === '<') throw new Error('ARXML 含无效或不受支持的声明');
      if (stack.length > 1) node.text += chunk;
    } else if (close) {
      if (node.tag !== tag) throw new Error('ARXML 元素未正确闭合');
      stack.pop();
    } else {
      if (stack.length > 128 || ++elements > 200000) throw new Error('ARXML 超过嵌套或元素数量上限');
      const child = { tag, children: [], text: '' };
      node.children.push(child);
      if (!chunk.endsWith('/>')) stack.push(child);
    }
  }
  if (stack.length !== 1) throw new Error('ARXML 元素未闭合');
  const value = (node, tag) => node.children.find(child => child.tag === tag)?.text.trim();
  const visit = (node, prefix) => {
    const short = value(node, 'SHORT-NAME');
    if (short?.length > 1024) throw new Error('ARXML SHORT-NAME 超过长度上限');
    const scope = short ? prefix + '/' + short : prefix;
    if (node.tag === 'RUNNABLE-ENTITY' && short) {
      const name = value(node, 'SYMBOL') || short;
      if (identifier.test(name)) runnables.push({ scope, short, name });
    }
    if (node.tag === 'TIMING-EVENT') {
      const ref = value(node, 'START-ON-EVENT-REF') || value(node, 'RUNNABLE-REF');
      const us = Math.round(Number(value(node, 'PERIOD')) * 1000000);
      if (ref && validUs(us)) events.push({ ref, us, prefix, file });
    }
    for (const child of node.children) visit(child, scope);
  };
  visit(root, '');
}

function arxmlSchedule(runnables, events) {
  const byScope = Map.groupBy(runnables, r => r.scope);
  const byName = Map.groupBy(runnables, r => r.short);
  return events.flatMap(({ ref, us, prefix, file }) => {
    const relative = prefix + '/' + ref;
    const absoluteMatches = byScope.get(ref) || [];
    const relativeMatches = relative === ref ? [] : byScope.get(relative) || [];
    const count = absoluteMatches.length + relativeMatches.length;
    if (count > 1) return [];
    const fallback = count === 0 && !ref.includes('/') ? byName.get(ref) : undefined;
    const match = absoluteMatches[0] ?? relativeMatches[0] ?? (fallback?.length === 1 ? fallback[0] : undefined);
    return match ? [{ name: match.name, us, source: 'ARXML TimingEvent · ' + file }] : [];
  });
}

export function scheduleConfig(model) {
  if (model.scheduleConfig) return model.scheduleConfig;
  const rows = [];
  const runnables = [], events = [];
  const warnings = [];
  let tickUs, bytes = 0;
  const pending = typeof model.root === 'string' && model.root ? [model.root] : [];
  while (pending.length) {
    const dir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      const file = path.relative(model.root, abs).split(path.sep).join('/');
      const ext = path.extname(file).toLowerCase();
      if (!['.oil', '.arxml'].includes(ext) && file !== 'tcu-schedule.json') {
        if (entry.isDirectory()) pending.push(abs);
        continue;
      }
      try {
        const stat = fs.statSync(abs);
        if (!entry.isFile() || !stat.isFile()) throw new Error('调度配置必须是普通文件');
        if (stat.size > MAX_CONFIG_BYTES) throw new Error('调度配置超过 8 MiB');
        if (stat.size > MAX_TOTAL_BYTES - bytes) throw new Error('调度配置累计超过 32 MiB');
        bytes += stat.size;
        const text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
        if (ext === '.oil') {
          for (const row of oilSchedule(text, file)) rows.push(row);
        } else if (ext === '.arxml') {
          const fileRunnables = [], fileEvents = [];
          collectArxml(text, file, fileRunnables, fileEvents);
          for (const runnable of fileRunnables) runnables.push(runnable);
          for (const event of fileEvents) events.push(event);
        } else {
          const config = JSON.parse(text);
          if (validUs(config?.tickUs)) tickUs = config.tickUs;
          for (const task of Array.isArray(config?.tasks) ? config.tasks : []) {
            if (!task || typeof task.name !== 'string') continue;
            const us = task.periodUs ?? (typeof task.periodMs === 'number' ? Math.round(task.periodMs * 1000) : NaN);
            if (!validUs(us) && task.kind !== 'isr') continue;
            rows.push({ name: task.name, file: task.file, us: validUs(us) ? us : null, kind: task.kind,
              source: file, priority: 2 });
          }
        }
      } catch (error) {
        warnings.push({ file, error: error.message });
      }
    }
  }
  for (const row of arxmlSchedule(runnables, events)) rows.push(row);
  return (model.scheduleConfig = { rows, tickUs, warnings });
}
