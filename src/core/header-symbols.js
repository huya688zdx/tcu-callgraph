import { expandSeq } from './preproc.js';
import { scanCalls } from './extract.js';

/** 头文件中的可调用宏作为可选入口；常量/包含保护不生成函数节点。 */
export function headerSymbols(parsed, resolveCallee, callableNames, headerMacros = new Map(), invocations = new Map()) {
  const symbols = [];
  for (const p of parsed) {
    if (!p.isHeader) continue;
    const context = new Map(headerMacros);
    for (const def of p.macros.values()) if (def.file === p.rel) context.set(def.name, def);
    for (const m of p.macros.values()) {
      if (m.file !== p.rel) continue;
      const id = `header::${p.rel}::${m.name}`;
      const calls = invocations.get(id) || [];
      let callable = m;
      let expanded = expandSeq(m.body, context);
      if (m.params === null && expanded.length === 1 && expanded[0].t === 'id') {
        const wrapper = context.get(expanded[0].v);
        if (wrapper?.params !== null && wrapper?.params !== undefined) {
          callable = wrapper;
          expanded = expandSeq(wrapper.body, context);
        }
      }
      let names = [];
      if (callable.params === null && expanded.length === 1 && expanded[0].t === 'id') {
        names = [expanded[0].v];
        if (!callableNames.has(names[0]) && !calls.length) continue;
      } else if (callable.params !== null) {
        const scanned = [];
        scanCalls(expanded, { macros: context, fnptr: new Map() }, scanned);
        names = [...new Set(scanned.map((c) => c.callee).filter((n) => n && !callable.params.includes(n)))];
      }
      if ((!names.length && !calls.length) || names.includes(m.name)) continue;
      const targetIds = calls.length ? [...new Set(calls.map((e) => e.to))] : names.map((n) => resolveCallee(n, p.rel));
      if (calls.length) names = [...new Set(calls.map((e) => e.callee))];
      symbols.push({ id, name: m.name, file: p.rel,
        line: m.line, params: m.params || [], kind: 'fn', headerSymbol: true,
        targetNames: names, targetIds,
        macroParams: m.params, raw: m.raw, cond: m.cond });
    }
  }
  return symbols;
}
