// OSEK 的 TASK(Name) 定义没有显式返回类型。保留源码行号，统一成两个解析器都能识别的签名。
export function taskDeclarations(source, tokens) {
  const names = new Set(), parts = [];
  let start = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.v !== 'TASK' || tokens[i + 1]?.v !== '(' || tokens[i + 2]?.t !== 'id' ||
        tokens[i + 3]?.v !== ')' || tokens[i + 4]?.v !== '{') continue;
    // 仅匹配独立定义，普通函数 void TASK(...) 仍使用原名。
    const prev = tokens[i - 1];
    if (prev && prev.t !== 'preproc' && ![';', '}'].includes(prev.v)) continue;
    const name = tokens[i + 2].v, end = tokens[i + 3];
    parts.push(source.slice(start, token.s), `void ${name}(void)`, '\n'.repeat(end.line - token.line));
    start = end.e;
    names.add(name);
  }
  return { names, source: names.size ? parts.join('') + source.slice(start) : source };
}
