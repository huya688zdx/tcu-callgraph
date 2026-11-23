// 同一调用者按源码语句分组。单链嵌套实参先于外层调用，同级实参保留在同一组。
const cache = new WeakMap();
const callKinds = new Set(['direct', 'macro', 'fnptr']);

export function assignCallGroups(tokens, calls) {
  if (!calls.length) return;
  if (calls.length === 1) { calls[0].orderGroup = 1; return; }
  const sites = new Map(), closeParen = new Map(), stack = [];
  let statement = 0;
  for (const [i, token] of tokens.entries()) {
    sites.set(`${token.line}:${token.col}`, { i, statement });
    if (token.v === '(') stack.push(i);
    if (token.v === ')') closeParen.set(stack.pop(), i);
    if (token.v === ';' || token.v === '{' || token.v === '}') statement++;
  }

  const statements = [];
  let prior;
  for (const call of calls) {
    const site = sites.get(`${call.line}:${call.col}`);
    if (!statements.length || site?.statement !== prior) statements.push([]);
    statements.at(-1).push({ call, i: site?.i });
    prior = site?.statement;
  }
  let ordinal = 0;
  for (const entries of statements) {
    const nested = entries.length > 1 && entries.every(({ call, i }, n) => {
      if (tokens[i]?.v !== call.callee || tokens[i + 1]?.v !== '(') return false;
      if (!n) return true;
      const parent = entries[n - 1].i;
      return parent < i && i < closeParen.get(parent + 1);
    });
    if (nested) {
      for (const { call } of entries.reverse()) call.orderGroup = ++ordinal;
    } else {
      ordinal++;
      for (const { call } of entries) call.orderGroup = ordinal;
    }
  }
}

export function callSequence(model, id) {
  if (!cache.has(model)) cache.set(model, new Map());
  const sequences = cache.get(model);
  if (sequences.has(id)) return sequences.get(id);
  const groups = [];
  for (const call of model._index.outAdj.get(id) || []) {
    if (!call.orderGroup || !callKinds.has(call.kind)) continue;
    const index = call.orderGroup - 1;
    (groups[index] ||= []).push({ to: call.to, name: call.callee, line: call.line, cond: call.cond });
  }
  sequences.set(id, groups);
  return groups;
}

export function callNumbers(groups) {
  const byTarget = new Map();
  if (!groups.length || groups.length === 1 && groups[0].length === 1) return byTarget;
  groups.forEach((calls, i) => {
    for (const to of new Set(calls.map(c => c.to))) {
      if (!byTarget.has(to)) byTarget.set(to, []);
      byTarget.get(to).push(String(i + 1) + (calls.length > 1 ? '*' : ''));
    }
  });
  return byTarget;
}
