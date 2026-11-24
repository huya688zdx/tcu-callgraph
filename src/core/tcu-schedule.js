import fs from 'node:fs';
import path from 'node:path';
import { collectArgs, lex } from './lexer.js';
import { matchBrace } from './extract.js';

const configCache = new WeakMap();
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
          if (validUs(us)) rows.push({ names, file, us, source: `C 调度表 · ${file}:${row[0].line}` });
          break;
        }
      }
    }
    i = end;
    start = end + 1;
  }
  return rows;
}

function oilSchedule(text, file) {
  const tokens = lex(text, file);
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
  for (const [chunk, close, tag] of text.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)(?:[\w.-]+:)?([\w.-]+)(?=[\s/>])[^>]*>|[^<]+|</g)) {
    const node = stack.at(-1);
    if (!tag) {
      if (!chunk.startsWith('<') && stack.length > 1) node.text += chunk;
    } else if (close) {
      if (node.tag !== tag) return;
      stack.pop();
    } else {
      const child = { tag, children: [], text: '' };
      node.children.push(child);
      if (!chunk.endsWith('/>')) stack.push(child);
    }
  }
  if (stack.length !== 1) return;
  const value = (node, tag) => node.children.find(child => child.tag === tag)?.text.trim();
  const visit = (node, prefix) => {
    const short = value(node, 'SHORT-NAME');
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
  return events.flatMap(({ ref, us, prefix, file }) => {
    const exact = runnables.filter(runnable => runnable.scope === ref || runnable.scope === prefix + '/' + ref);
    const short = ref.split('/').at(-1);
    const matches = exact.length ? exact : runnables.filter(runnable => runnable.short === short &&
      (!ref.includes('/') || runnable.scope === '/' + short));
    if (matches.length !== 1) return [];
    return [{ name: matches[0].name, us, source: `ARXML TimingEvent · ${file}` }];
  });
}

export function scheduleConfig(model) {
  if (configCache.has(model)) return configCache.get(model);
  const rows = [];
  const runnables = [], events = [];
  let tickUs;
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      const file = path.relative(model.root, abs).split(path.sep).join('/');
      const ext = path.extname(file).toLowerCase();
      if (!entry.isFile() || (!['.oil', '.arxml'].includes(ext) && file !== 'tcu-schedule.json')) continue;
      try {
        const text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '');
        if (ext === '.oil') {
          rows.push(...oilSchedule(text, file));
        } else if (ext === '.arxml') {
          collectArxml(text, file, runnables, events);
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
      } catch {
        // 单个配置无效时仍保留其他配置和源码证据。
      }
    }
  };
  if (model.root && typeof model.root === 'string') walk(model.root);
  rows.push(...arxmlSchedule(runnables, events));
  const config = { rows, tickUs };
  configCache.set(model, config);
  return config;
}
