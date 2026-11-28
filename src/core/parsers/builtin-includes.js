import fs from 'node:fs';
import path from 'node:path';
import { COMPILER_DEFINE, profileIncludeOptions } from '../build-config.js';
import { fileMacroScope, parseMacroDefinition, preprocess } from '../preproc.js';

const cStandardVersions = new Map([
  ['iso9899:199409', '199409L'],
  ['c99', '199901L'], ['gnu99', '199901L'], ['c9x', '199901L'], ['gnu9x', '199901L'],
  ['iso9899:1999', '199901L'], ['iso9899:199x', '199901L'],
  ['c11', '201112L'], ['gnu11', '201112L'], ['c1x', '201112L'], ['gnu1x', '201112L'],
  ['c17', '201710L'], ['gnu17', '201710L'], ['c18', '201710L'], ['gnu18', '201710L'],
  ['iso9899:2011', '201112L'], ['iso9899:2017', '201710L'], ['iso9899:2018', '201710L'],
  ['c23', '202311L'], ['gnu23', '202311L'],
]);

export function buildMacros(defines = [], macros = new Map()) {
  for (const raw of defines) {
    const option = String(raw).trim();
    if (!COMPILER_DEFINE.test(option)) continue;
    const [declaration, ...rest] = option.split('=');
    const value = rest.length ? rest.join('=').trim() : '1';
    const def = parseMacroDefinition(declaration.trim() + ' ' + value, '<build-config>', 0);
    if (def) macros.set(def.name, def);
  }
  return macros;
}

export function profilePredefinedMacros(file, config) {
  const stdVersion = cStandardVersions.get(config.languageStandard);
  const macros = buildMacros([
    ...(path.extname(file) === '.c' ? ['__STDC__=1'] : []),
    ...(stdVersion ? ['__STDC_VERSION__=' + stdVersion] : []),
  ]);
  const macroArgs = config.macroArgs || [];
  for (let i = 0; i < macroArgs.length; i += 2) {
    if (macroArgs[i] === '-U') macros.set(macroArgs[i + 1], null);
  }
  return buildMacros(config.defines, macros);
}

/** 按编译单元顺序执行 include。头文件自己的行号与它在调用方引入宏的位置分别记录。 */
export function preprocessProfile(root, files, options, load, visit, expand = false) {
  const key = s => process.platform === 'win32' ? s.toLowerCase() : s;
  const uniqueDirs = dirs => {
    const seen = new Set();
    return dirs.filter(dir => {
      const normalized = key(dir);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  };
  const byPath = new Map((options.availableFiles || files).map(f => [key(path.resolve(root, f.rel)), f]));
  const inputs = new Map();
  const headers = new Map();
  const compiled = new Set();

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
    const config = options.compilationUnits?.[source.rel] || options;
    const workingDirectory = path.resolve(root, config.workingDirectory || options.workingDirectory || '.');
    const includeOptions = profileIncludeOptions(config);
    const dirsFor = flag => includeOptions.filter(([kind]) => kind === flag).map(([, dir]) => path.resolve(root, dir));
    const system = dirsFor('-isystem');
    const after = dirsFor('-idirafter');
    const systemKeys = new Set([...system, ...after].map(key));
    const search = uniqueDirs([...dirsFor('-I').filter(dir => !systemKeys.has(key(dir))), ...system, ...after]);
    if (!includeOptions.length) search.push(workingDirectory);
    const quotedSearch = uniqueDirs([...dirsFor('-iquote'), ...search]);
    const forced = [...(config.macroIncludes || []).map(target => [target, true]),
      ...(config.forcedIncludes || []).map(target => [target, false])];
    const predefined = profilePredefinedMacros(source.rel, config);

    const stack = new Set(), once = new Set();
    let unresolvedIncludes = false;
    const markUnresolved = () => { unresolvedIncludes = true; };
    function processFile(file, base, macroOnly = false, origin) {
      const fileKey = key(file.rel);
      if (stack.has(fileKey) || once.has(fileKey)) return null;
      if (file.isHeader && !inputs.has(file)) inputs.set(file, load(file));
      const input = file.isHeader ? inputs.get(file) : load(file);
      if (!input) {
        markUnresolved();
        return null;
      }
      stack.add(fileKey);
      const scope = fileMacroScope(base, new Map(), { trackPositions: true });
      function include({ target, line }, quoted, next, uncertain, fromDir = path.dirname(path.resolve(root, file.rel)), macrosOnly = macroOnly) {
        const resume = next && origin;
        const dirs = resume ? origin.dirs : quoted ? [fromDir, ...quotedSearch] : search;
        const supplyingDir = resume ? key(origin.dirs[origin.index]) : null;
        let mayBeExternal = !quoted;
        for (let index = resume ? origin.index + 1 : 0; index < dirs.length; index++) {
          if (supplyingDir !== null && key(dirs[index]) === supplyingDir) continue;
          const abs = path.resolve(dirs[index], target.replaceAll('\\', '/'));
          const absKey = key(abs);
          const relative = path.relative(root, abs);
          const external = relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative);
          mayBeExternal ||= external;
          let header = byPath.get(absKey);
          if (header && !header.isHeader) {
            header = { ...header, isHeader: true };
            byPath.set(absKey, header);
          } else if (!header && options.allowUnlistedIncludes !== false &&
              (external || options.allowLocalIncludes) && fs.statSync(abs, { throwIfNoEntry: false })?.isFile()) {
            header = { abs, rel: path.relative(root, abs).replaceAll('\\', '/'), isHeader: true };
            byPath.set(absKey, header);
          }
          if (!header) { if (external || options.allowLocalIncludes) options.onMissingInclude?.(abs); continue; }
          const changed = processFile(header, {
            get: name => scope.get(name, line),
            isUnknown: name => scope.isUnknown(name, line),
          }, macrosOnly, { dirs, index });
          if (changed) for (const [name, def] of changed) {
            if (uncertain || def === undefined) scope.forget(name, line);
            else if (def) scope.set(name, def, line);
            else scope.delete(name, line);
          }
          return header.rel;
        }
        if (mayBeExternal) markUnresolved();
      }
      const implicit = [];
      if (!file.isHeader) forced.forEach(([target, macrosOnly], i) => {
        const entry = { file: file.rel, target, line: i - forced.length };
        entry.resolved = include(entry, true, false, false, workingDirectory, macrosOnly) ?? null;
        implicit.push(entry);
      });
      const result = preprocess(input.tokens, scope, file.rel, {
        expand, pruneInactive: true, onInclude: include, onPragmaOnce: () => once.add(fileKey),
        hasUnresolvedIncludes: () => unresolvedIncludes, onUnresolvedInclude: markUnresolved,
      });
      if (file.isHeader) {
        if (!macroOnly) options.onHeaderContext?.(file, input, result.tokens, scope, source.rel, result.includes);
        rememberHeader(file, input, macroOnly ? { ...result, tokens: [] } : result, scope);
      }
      else {
        result.includes.unshift(...implicit);
        visit(file, input, result, scope);
        compiled.add(fileKey);
      }
      stack.delete(fileKey);
      return scope.changes;
    }
    processFile(source, {
      get: name => predefined.get(name),
      // 编译器和目标平台的保留宏无法从构建参数完整推断。
      isUnknown: name => !predefined.has(name) && /^(?:__|_[A-Z])/.test(name),
    });
  }
  for (const [file, entry] of headers) {
    if (compiled.has(key(file.rel))) continue;
    const tokens = [...entry.lines].sort(([a], [b]) => a - b).flatMap(([, line]) => line.tokens);
    visit(file, entry.input, { tokens, includes: [...entry.includes.values()] }, {
      changes: entry.changes,
      get: (name, line) => (entry.lines.get(line)?.scope || entry.scope).get(name, line),
    });
  }
}
