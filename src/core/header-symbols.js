import { expandSeq } from './preproc.js';
import { scanCalls } from './extract.js';

/** 头文件中的可调用宏作为可选入口；常量/包含保护不生成函数节点。 */
export function headerSymbols(parsed, resolveCallee, callableNames) {
  const symbols = [];
  for (const p of parsed) {
    if (!p.isHeader) continue;
    for (const m of p.macros.values()) {
      if (m.file !== p.rel) continue;
      let callable = m;
      let expanded = expandSeq(m.body, p.macros);
      if (m.params === null && expanded.length === 1 && expanded[0].t === 'id') {
        const wrapper = p.macros.get(expanded[0].v);
        if (wrapper?.params !== null && wrapper?.params !== undefined) {
          callable = wrapper;
          expanded = expandSeq(wrapper.body, p.macros);
        }
      }
      let names;
      if (callable.params === null && expanded.length === 1 && expanded[0].t === 'id') {
        names = [expanded[0].v];
        if (!callableNames.has(names[0])) continue;
      } else if (callable.params !== null) {
        const calls = [];
        scanCalls(expanded, { macros: new Map(), fnptr: new Map() }, calls);
        names = [...new Set(calls.map((c) => c.callee).filter((n) => n && !callable.params.includes(n)))];
      } else continue;
      if (!names.length || names.includes(m.name)) continue;
      symbols.push({ id: `header::${p.rel}::${m.name}`, name: m.name, file: p.rel,
        line: m.line, params: m.params || [], kind: 'fn', headerSymbol: true,
        targetNames: names, targetIds: names.map((n) => resolveCallee(n, p.rel)),
        macroParams: m.params, raw: m.raw, cond: m.cond });
    }
  }
  return symbols;
}
