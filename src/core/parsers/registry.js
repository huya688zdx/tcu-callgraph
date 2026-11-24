import { builtinParser } from './builtin-parser.js';
import { dotParser } from './dot-parser.js';
import { clangParser } from './clang-parser.js';

const parsers = new Map();

/** parse(target, { sourceFiles, scan, parserOptions }) 可同步返回 GraphIR，也可以返回 Promise。 */
export function registerParser(parser) {
  if (!parser || typeof parser.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(parser.id)
      || typeof parser.name !== 'string' || !parser.name || typeof parser.parse !== 'function'
      || typeof parser.available !== 'function') {
    throw new TypeError('解析器必须提供 id、name、available 和 parse');
  }
  if (parsers.has(parser.id)) throw new Error(`解析器已注册：${parser.id}`);
  const registered = Object.freeze({ ...parser });
  parsers.set(parser.id, registered);
  return registered;
}

export const getParser = (id = 'builtin') => parsers.get(id);
export const listParsers = () => [...parsers.values()];

export function resolveParserForTarget(target, parserId = 'builtin') {
  const id = /\.(dot|gv)$/i.test(target) ? 'dot' : parserId;
  const parser = getParser(id);
  if (!parser) throw new Error(`未知解析器：${id}`);
  if (id === 'dot' && !/\.(dot|gv)$/i.test(target)) throw new Error('DOT 解析器仅适用于 .dot / .gv 文件');
  return parser;
}

for (const parser of [builtinParser, dotParser, clangParser]) registerParser(parser);
