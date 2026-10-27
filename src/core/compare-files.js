import path from 'node:path';
import { listSourceFiles } from './index.js';

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !rel || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
};

/** 对照目录可以放在工程内部，但它们的源码不能再次进入基础工程。 */
export function comparisonFiles(projectPath, beforePath, afterPath) {
  if (inside(beforePath, afterPath) || inside(afterPath, beforePath) ||
      inside(projectPath, beforePath) || inside(projectPath, afterPath)) {
    throw new Error('before/after 不能互相包含，也不能包含总代码目录');
  }
  const filesOf = (root) => new Map(listSourceFiles(root).map((abs) => [path.relative(root, abs).replace(/\\/g, '/'), abs]));
  const baseFiles = new Map([...filesOf(projectPath)].filter(([, abs]) => !inside(abs, beforePath) && !inside(abs, afterPath)));
  const suffixes = new Map();
  for (const rel of baseFiles.keys()) {
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      if (!suffixes.has(suffix)) suffixes.set(suffix, []);
      suffixes.get(suffix).push(rel);
    }
  }
  const mappings = [];
  const match = (root, version) => {
    const mapped = new Map();
    for (const [rel, abs] of filesOf(root)) {
      let target = rel;
      if (!baseFiles.has(rel)) {
        const matches = [...(suffixes.get(rel) || [])];
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) {
          const suffix = parts.slice(i).join('/');
          if (baseFiles.has(suffix)) matches.push(suffix);
        }
        if (matches.length > 1) throw new Error(`${version}/${rel} 对应多个工程文件：${matches.join('、')}。请保留与总代码相同的目录层级`);
        if (matches.length === 1) target = matches[0];
      }
      if (mapped.has(target)) throw new Error(`${version} 中多个文件对应 ${target}，请检查对照目录层级`);
      mapped.set(target, abs);
      mappings.push({ version, source: rel, target, matched: baseFiles.has(target) });
    }
    return mapped;
  };
  return { baseFiles, beforeFiles: match(beforePath, 'before'), afterFiles: match(afterPath, 'after'), mappings };
}
