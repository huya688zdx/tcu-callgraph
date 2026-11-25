import fs from 'node:fs';
import path from 'node:path';
import { parseFile, collectGlobals, collectFunctions, collectParameters, collectAccesses } from '../cparse.js';
import { decodeSource } from '../source-files.js';
import { taskDeclarations } from '../task-declarations.js';
import { lex } from '../lexer.js';
import { fileMacroScope, preprocess } from '../preproc.js';


// 联合体成员共享存储。保守识别含联合体的聚合类型；对无法解析的类型，工程中
// 存在联合体时不按字段排除，以免把真实依赖误报为不存在。
function unionTypeResolver(parsedFiles) {
  const types = new Map();
  let hasUnion = false;
  const register = (name, node) => {
    if (!types.has(name)) types.set(name, []);
    types.get(name).push(node);
  };
  const walk = (node) => {
    if (node.type === 'union_specifier') hasUnion = true;
    if (node.type === 'struct_specifier' || node.type === 'union_specifier') {
      const name = node.childForFieldName('name')?.text;
      if (name && node.childForFieldName('body')) register(`${node.type === 'struct_specifier' ? 'struct' : 'union'} ${name}`, node);
    }
    if (node.type === 'type_definition') {
      const alias = node.childForFieldName('declarator')?.text;
      if (alias) register(alias, node.childForFieldName('type'));
    }
    for (const child of node.namedChildren) walk(child);
  };
  for (const { root } of parsedFiles) walk(root);
  const contains = (node, seen) => {
    if (!node) return hasUnion;
    if (node.type === 'union_specifier') return true;
    if (node.type === 'type_identifier') return resolve(node.text, seen);
    if (node.type !== 'struct_specifier') return false;
    const body = node.childForFieldName('body');
    if (!body) return resolve(`struct ${node.childForFieldName('name')?.text}`, seen);
    return body.namedChildren.some((field) => field.type === 'field_declaration' && contains(field.childForFieldName('type'), seen));
  };
  const resolve = (name, seen = new Set()) => {
    if (name.startsWith('union ')) return true;
    if (seen.has(name)) return false;
    const next = new Set(seen); next.add(name);
    return types.has(name) ? types.get(name).some((node) => contains(node, next)) : hasUnion;
  };
  return (typeText) => {
    const name = typeText.replace(/\b(const|volatile)\b/g, '').trim();
    if (/^union\b/.test(name)) return true;
    const match = name.match(/^struct\s+([A-Za-z_]\w*)|^([A-Za-z_]\w*)$/);
    return match ? resolve(match[1] ? `struct ${match[1]}` : match[2]) : hasUnion;
  };
}

/** 比较与数据流复用同一份逐文件宏展开口径和原始行号。 */
export function analysisSources(model, { keepOriginal = true } = {}) {
  const cached = model._analysisSources;
  if (cached && (!keepOriginal || cached.sources.every(f => typeof f.src === 'string'))) return cached;
  const sources = [];
  let failedFiles = 0;
  for (const f of model.files) {
    if (f.manual) continue;
    try {
      sources.push({ ...f, src: decodeSource(model._sourceBuffers?.get(f.rel) ??
        fs.readFileSync(model._sourceFiles?.get(f.rel) || path.join(model.root, f.rel))) });
    } catch (err) {
      failedFiles++;
      console.warn(`[数据流] 读取失败，已跳过 ${f.rel}：`, err.message);
    }
  }
  const headerMacros = new Map();
  for (const f of sources.filter((f) => f.isHeader)) preprocess(lex(f.src, f.rel), headerMacros, f.rel);
  for (const f of sources) {
    const original = lex(f.src, f.rel);
    const taskDefs = taskDeclarations(f.src, original);
    f.src = taskDefs.source;
    const { tokens } = preprocess(taskDefs.names.size ? lex(f.src, f.rel) : original, fileMacroScope(headerMacros), f.rel, { expand: true });
    const parts = [];
    let line = 1;
    for (const tk of tokens) {
      if (tk.line > line) parts.push('\n'.repeat(tk.line - line));
      line = Math.max(line, tk.line);
      parts.push(tk.v, ' ');
      line += (tk.v.match(/\n/g) || []).length;
    }
    f.expanded = parts.join('');
    if (!keepOriginal) delete f.src;
  }
  return { sources, failedFiles };
}

/** 建立全工程的变量表 + 读写索引（带缓存） */
export async function buildBuiltinDataflow(model) {
  const parsedFiles = [];
  try {
    const defs = [];
    const keepOriginal = Boolean(model._keepAnalysisSources);
    let { sources, failedFiles } = analysisSources(model, { keepOriginal });
    if (keepOriginal) model._analysisSources = { sources: [...sources], failedFiles };
    const defsByName = new Map();
    const fnAccess = new Map(); // fnId -> { writes: Map, reads: Map }
    const readers = new Map(); // varId -> Set<fnId>
    const writers = new Map(); // varId -> Set<fnId>
    const addTo = (map, key, val) => {
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(val);
    };

    const fnsByFile = new Map();
    for (const fn of model.functions) {
      if (!fnsByFile.has(fn.file)) fnsByFile.set(fn.file, []);
      fnsByFile.get(fn.file).push(fn);
    }

    for (const f of sources) {
      let rec;
      try {
        rec = await parseFile(path.join(model.root, f.rel), f.rel, f.expanded);
      } catch (err) {
        failedFiles += 1;
        console.warn(`[数据流] 解析失败，已跳过 ${f.rel}：`, err.message);
        continue; // 单个文件解析失败不影响整体
      }
      parsedFiles.push({ file: f.rel, root: rec.root, tree: rec.tree });

      for (const g of collectGlobals(rec.root)) {
        const id = g.isStatic ? `var::${f.rel}::${g.name}` : `var::${g.name}`;
        const def = { ...g, id, file: f.rel };
        const prev = defsByName.get(g.name) || [];
        const same = prev.find((d) => d.id === id);
        if (same) {
          // extern 只是声明，真实定义优先
          if (same.isExtern && !g.isExtern) Object.assign(same, def);
          continue;
        }
        defs.push(def);
        defsByName.set(g.name, [...prev, def]);
      }
    }
    if (!keepOriginal && sources !== model._analysisSources?.sources) sources.length = 0;

    const containsUnion = unionTypeResolver(parsedFiles);
    for (const def of defs) def.containsUnion = containsUnion(def.typeText);

    // 先收齐声明与函数，再沿明确的实参将目标绑定到指针形参。
    const defsById = new Map(defs.map((d) => [d.id, d]));
    const records = new Map();
    for (const { file, root } of parsedFiles) {
      const fns = collectFunctions(root);
      const resolve = (name) => {
        const list = defsByName.get(name);
        if (!list || !list.length) return null;
        // 本文件的 static 优先，其次同名全局
        return list.find((d) => d.isStatic && d.file === file) || list.find((d) => !d.isStatic) || null;
      };

      for (const fn of fnsByFile.get(file) || []) {
        const node = fns.get(fn.name);
        if (!node) continue;
        records.set(fn.id, { id: fn.id, file, node, resolve, params: collectParameters(node), bindings: new Map() });
      }
    }
    const queue = [...records.keys()];
    const queued = new Set(queue);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      queued.delete(id);
      const rec = records.get(id);
      const acc = collectAccesses(rec.node, (name) => !!rec.resolve(name), {
        bindings: rec.bindings,
        isArray: (name) => !!rec.resolve(name)?.isArray,
        resolveCall: (name) => {
          const all = model._index.byName.get(name) || [];
          const local = all.find((f) => f.file === rec.file);
          const fn = local || all.find((f) => !f.isStatic);
          return fn ? records.get(fn.id) : null;
        },
      });
      const normalize = (accesses) => {
        const result = new Map();
        for (const [name, access] of accesses) {
          const d = defsById.get(name) || rec.resolve(name);
          if (!d) continue;
          const prev = result.get(d.id);
          result.set(d.id, prev ? {
            lines: new Set([...prev.lines, ...access.lines]),
            fields: new Set([...prev.fields, ...access.fields]),
            whole: prev.whole || access.whole,
            indirect: prev.indirect || access.indirect,
          } : access);
        }
        return result;
      };
      fnAccess.set(id, { writes: normalize(acc.writes), reads: normalize(acc.reads) });
      for (const call of acc.calls) {
        const callee = records.get(call.to);
        if (!callee.bindings.has(call.param)) callee.bindings.set(call.param, new Set());
        const targets = callee.bindings.get(call.param);
        const size = targets.size;
        for (const name of call.targets) {
          const d = defsById.get(name) || rec.resolve(name);
          if (d) targets.add(d.id);
        }
        // 目标集合只增不减，递归调用也会在不再产生新绑定时结束。
        if (targets.size > size && !queued.has(call.to)) {
          queued.add(call.to);
          queue.push(call.to);
        }
      }
    }
    for (const [id, acc] of fnAccess) {
      for (const varId of acc.writes.keys()) addTo(writers, varId, id);
      for (const varId of acc.reads.keys()) addTo(readers, varId, id);
    }

    const idx = {
      failedFiles,
      defs,
      byId: new Map(defs.map((d) => [d.id, d])),
      fnAccess,
      readers,
      writers,
    };
    if (failedFiles) {
      console.warn(`[数据流] 共跳过 ${failedFiles} 个文件，变量面板可能不完整`);
    }
    return idx;
  } finally {
    for (const { tree } of parsedFiles) tree.delete();
  }
}
