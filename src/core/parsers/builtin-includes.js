import path from 'node:path';
import { lex } from '../lexer.js';
import { fileMacroScope, preprocess } from '../preproc.js';

export function buildMacros(defines = []) {
  const macros = new Map();
  for (const raw of defines) {
    const [name, ...rest] = String(raw).split('=');
    if (!/^[A-Za-z_]\w*$/.test(name.trim())) continue;
    const value = rest.length ? rest.join('=').trim() : '1';
    macros.set(name.trim(), { name: name.trim(), params: null, body: lex(value, '<build-config>'),
      file: '<build-config>', line: 0, raw: value });
  }
  return macros;
}

/** 按编译单元顺序执行 include。头文件自己的行号与它在调用方引入宏的位置分别记录。 */
export function preprocessProfile(root, files, options, load, visit, expand = false) {
  const key = s => process.platform === 'win32' ? s.toLowerCase() : s;
  const byPath = new Map(files.filter(f => f.isHeader).map(f => [key(path.resolve(root, f.rel)), f]));
  const search = (options.includeDirs || []).map(dir => path.resolve(root, dir));
  if (!search.length) search.push(path.resolve(root));
  const forced = options.forcedIncludes || [];
  const predefined = buildMacros(options.defines);
  const inputs = new Map();
  const headers = new Map();

  function rememberHeader(file, input, result, scope) {
    let entry = headers.get(file);
    if (!entry) {
      entry = { lines: new Map(), includes: new Map(), changes: new Map(), scope, input };
      headers.set(file, entry);
    }
    // 同一头文件可能在不同翻译单元启用不同代码段，模型每行取首个有效上下文。
    const current = new Map();
    for (const tk of result.tokens) {
      if (entry.lines.has(tk.line)) continue;
      if (!current.has(tk.line)) current.set(tk.line, { scope, tokens: [] });
      current.get(tk.line).tokens.push(tk);
    }
    for (const [line, value] of current) entry.lines.set(line, value);
    for (const inc of result.includes) entry.includes.set(JSON.stringify([inc.line, inc.resolved, inc.target]), inc);
    for (const [name, def] of scope.changes) if (def?.file === file.rel) entry.changes.set(name, def);
  }

  for (const source of files) {
    if (source.isHeader) continue;
    const stack = new Set(), once = new Set();
    function processFile(file, base) {
      if (stack.has(file) || once.has(file)) return null;
      if (file.isHeader && !inputs.has(file)) inputs.set(file, load(file));
      const input = file.isHeader ? inputs.get(file) : load(file);
      if (!input) return null;
      stack.add(file);
      const scope = fileMacroScope(base, new Map(), { trackPositions: true });
      function include({ target, line }, quoted, fromDir = path.dirname(path.resolve(root, file.rel))) {
        for (const dir of quoted ? [fromDir, ...search] : search) {
          const header = byPath.get(key(path.resolve(dir, target.replaceAll('\\', '/'))));
          if (!header) continue;
          const changed = processFile(header, { get: name => scope.get(name, line) });
          if (changed) for (const [name, def] of changed) {
            if (def) scope.set(name, def, line);
            else scope.delete(name, line);
          }
          return header.rel;
        }
      }
      const implicit = [];
      if (!file.isHeader) forced.forEach((target, i) => {
        const entry = { file: file.rel, target, line: i - forced.length };
        entry.resolved = include(entry, true, root) ?? null;
        implicit.push(entry);
      });
      const result = preprocess(input.tokens, scope, file.rel, {
        expand, pruneInactive: true, onInclude: include, onPragmaOnce: () => once.add(file),
      });
      if (file.isHeader) rememberHeader(file, input, result, scope);
      else {
        result.includes.unshift(...implicit);
        visit(file, input, result, scope);
      }
      stack.delete(file);
      return scope.changes;
    }
    processFile(source, predefined);
  }
  for (const [file, entry] of headers) {
    const tokens = [...entry.lines].sort(([a], [b]) => a - b).flatMap(([, line]) => line.tokens);
    visit(file, entry.input, { tokens, includes: [...entry.includes.values()] }, {
      changes: entry.changes,
      get: (name, line) => (entry.lines.get(line)?.scope || entry.scope).get(name, line),
    });
  }
}
