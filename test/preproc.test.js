import test from 'node:test';
import assert from 'node:assert/strict';
import { lex } from '../src/core/lexer.js';
import { expandSeq, fileMacroScope, preprocess } from '../src/core/preproc.js';
import { scanCalls } from '../src/core/extract.js';

test('条件表达式按调用行替换函数宏，保留对象宏优先级与 defined 操作数', () => {
  const macros = fileMacroScope(new Map(), new Map(), { trackPositions: true });
  const { tokens } = preprocess(lex(`#define ENABLED(x) (x)
#define TEST ENABLED
#define A 1+2
#if TEST(1) && A*3 == 7 && defined(A) && defined ENABLED
first
#endif
#undef A
#if defined(A)
wrong
#elif ENABLED(!A)
second
#endif`), macros, 'test.c', { pruneInactive: true });
  assert.deepEqual(tokens.map(t => t.v), ['first', 'second']);
});

test('变参参与普通 ## 拼接时，只拼接交界处的两个 token', () => {
  const macros = new Map();
  preprocess(lex(`#define CALL(...) run_ ## __VA_ARGS__
#define NAMED(rest...) run_ ## rest
#define CAT(a, b) a ## b
#define WRAP(prefix, ...) wrap(prefix ## __VA_ARGS__)`), macros, 'test.c');
  const expand = (source) => expandSeq(lex(source), macros).map((token) => token.v);
  assert.deepEqual(expand('CALL(A)()'), ['run_A', '(', ')']);
  assert.deepEqual(expand('NAMED(A(), other())'), ['run_A', '(', ')', ',', 'other', '(', ')']);
  assert.deepEqual(expand('WRAP(, run_A())'), ['wrap', '(', 'run_A', '(', ')', ')']);
  assert.deepEqual(expand('WRAP(run_A)'), ['wrap', '(', 'run_A', ')']);
  assert.deepEqual(expand('CAT(run_, A())'), ['run_A', '(', ')']);
  assert.deepEqual(expandSeq(lex('CAT(1, 2) CAT(+, =)'), macros).map(({ t, v }) => [t, v]),
    [['num', '12'], ['punct', '+=']]);
  const calls = scanCalls(lex('CALL(A)()'), { macros }, []);
  assert.deepEqual(calls.map(({ callee, kind, via }) => [callee, kind, via]), [['run_A', 'macro', 'CALL']]);
});

test('GNU 逗号拼接只在变参省略时移除逗号', () => {
  const macros = new Map();
  preprocess(lex('#define LOG(tag, ...) notify(tag, ## __VA_ARGS__)'), macros, 'test.c');
  const expand = (source) => expandSeq(lex(source), macros).map((token) => token.v);
  assert.deepEqual(expand('LOG(tag)'), ['notify', '(', 'tag', ')']);
  assert.deepEqual(expand('LOG(tag,)'), ['notify', '(', 'tag', ',', ')']);
  assert.deepEqual(expand('LOG(tag, a(), b)'), ['notify', '(', 'tag', ',', 'a', '(', ')', ',', 'b', ')']);
});

test('预处理整数保留 64 位精度和无符号语义', () => {
  for (const expr of ['(1ULL << 32) == 4294967296ULL', '(0xffffffffU >> 31) == 1',
    '(~0ULL >> 63) == 1', '(1ULL << 63) > 0', '(-1 >> 1) == -1',
    '18446744073709551615ULL + 1 == 0', '(1 ? -1 : 0U) > 0']) {
    const result = preprocess(lex(`#if ${expr}\ncorrect\n#else\nwrong\n#endif`), new Map(), 'test.c', { pruneInactive: true });
    assert.deepEqual(result.tokens.map(t => t.v), ['correct'], expr);
  }
});

test('字符常量及转义参与条件求值', () => {
  for (const expr of ["MODE == 'A'", "'\\n' == 10", "'\\101' == 65", "'\\x41' == 'A'", "'\\\\' == 92", "'\\'' == 39"]) {
    const result = preprocess(lex(`#define MODE 'A'\n#if ${expr}\nyes\n#else\nno\n#endif`), new Map(), 'test.c', { pruneInactive: true });
    assert.deepEqual(result.tokens.map(t => t.v), ['yes'], expr);
  }
});

test('不能求值的预处理操作保留分支，并避免把条件重定义当成确定值', () => {
  const source = [
    '#define CHOICE 0',
    '#if __has_include("feature.h")', '#define CHOICE 1', 'maybe_present', '#else', 'maybe_missing', '#endif',
    '#if CHOICE', 'maybe_on', '#else', 'maybe_off', '#endif',
    '#if UNKNOWN_MACRO', 'inactive', '#endif',
  ].join('\n');
  const macros = fileMacroScope(new Map(), new Map(), { trackPositions: true });
  const result = preprocess(lex(source), macros, 'sample.c', { pruneInactive: true });
  assert.deepEqual(result.tokens.map(token => token.v), ['maybe_present', 'maybe_missing', 'maybe_on', 'maybe_off']);
});
