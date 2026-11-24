import { createHash } from 'node:crypto';
import { lex } from './lexer.js';

/** 比较两个定义的源码 token（含预处理指令），忽略注释、排版和位置。 */
export function fingerprint(text) {
  const tokens = lex(text).flatMap(t => t.t === 'preproc'
    ? lex(t.v.slice(1)).map(p => [p.t, p.v])
    : [[t.t, t.v]]);
  return createHash('sha256').update(JSON.stringify(tokens)).digest('hex');
}
