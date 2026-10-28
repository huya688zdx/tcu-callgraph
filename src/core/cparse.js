/**
 * C 语法解析层（tree-sitter WASM）
 * 相比手写词法分析，这里能拿到真正的 AST：赋值左值、自增、取地址、结构体成员访问
 * 都能准确区分，是数据流分析（def-use）的基础。
 *
 * 依赖两个 wasm 文件（不参与编译，Electron 里可直接跑）：
 *   node_modules/web-tree-sitter/tree-sitter.wasm        运行时
 *   node_modules/tree-sitter-wasms/out/tree-sitter-c.wasm C 语法
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

const RUNTIME_CANDIDATES = [
  'node_modules/web-tree-sitter/tree-sitter.wasm',
  'node_modules/web-tree-sitter/lib/tree-sitter.wasm',
  'node_modules/web-tree-sitter/debug/tree-sitter.wasm',
];
const GRAMMAR = 'node_modules/tree-sitter-wasms/out/tree-sitter-c.wasm';

let parserPromise = null;

/** 懒加载解析器；wasm 缺失时抛出可读的错误，由接口层转成提示 */
export function getParser() {
  if (!parserPromise) {
    parserPromise = (async () => {
      const grammarPath = path.join(ROOT, GRAMMAR);
      if (!fs.existsSync(grammarPath)) {
        throw new Error(`缺少 C 语法文件 ${GRAMMAR}，请执行 npm install`);
      }
      const runtime = RUNTIME_CANDIDATES.map((p) => path.join(ROOT, p)).find((p) => fs.existsSync(p));
      if (!runtime) throw new Error('缺少 tree-sitter.wasm 运行时，请重新执行 npm install');

      const { Parser, Language } = await import('web-tree-sitter');
      await Parser.init({ locateFile: () => runtime });
      const lang = await Language.load(grammarPath);
      const p = new Parser();
      p.setLanguage(lang);
      return p;
    })();
  }
  return parserPromise;
}

/** 文件级解析缓存：key 为绝对路径 */
const treeCache = new Map();

export async function parseFile(abs, rel, src) {
  const text = src ?? fs.readFileSync(abs, 'utf8');
  const hit = treeCache.get(abs);
  if (hit?.src === text) return hit;
  const parser = await getParser();
  const tree = parser.parse(text);
  const rec = { tree, root: tree.rootNode, src: text, rel };
  if (hit) hit.tree.delete();
  treeCache.set(abs, rec);
  return rec;
}

export function clearParseCache() {
  for (const rec of treeCache.values()) {
    try {
      rec.tree.delete();
    } catch {
      /* ignore */
    }
  }
  treeCache.clear();
}

// ---------------- AST 小工具 ----------------

const TYPE_NODES = new Set([
  'primitive_type',
  'type_identifier',
  'sized_type_specifier',
  'struct_specifier',
  'union_specifier',
  'enum_specifier',
  'type_qualifier',
  'storage_class_specifier',
  'attribute_specifier',
  'alignas_qualifier',
]);

const DECL_NODES = new Set([
  'identifier',
  'init_declarator',
  'pointer_declarator',
  'array_declarator',
  'function_declarator',
  'parenthesized_declarator',
  'attributed_declarator',
]);

/** 从声明符里取变量/函数名 */
export function declaratorName(n) {
  if (!n) return null;
  if (n.type === 'identifier') return n.text;
  if (n.type === 'function_declarator') return declaratorName(n.childForFieldName('declarator'));
  if (n.type === 'init_declarator' || n.type === 'pointer_declarator' || n.type === 'array_declarator') {
    return declaratorName(n.childForFieldName('declarator') || n.namedChildren[0]);
  }
  if (n.type === 'parenthesized_declarator' || n.type === 'attributed_declarator') {
    return declaratorName(n.namedChildren[0]);
  }
  return null;
}

/** 只穿过文件作用域的预处理节点，不进入函数体或结构体。 */
function* fileDeclarations(root) {
  for (const node of root.namedChildren) {
    if (node.type.startsWith('preproc_')) yield* fileDeclarations(node);
    else yield node;
  }
}

/** 声明符是否为函数（原型/定义），用来把函数声明从变量里剔除 */
function isFunctionDeclarator(n) {
  if (!n) return false;
  if (n.type === 'function_declarator') return true;
  if (n.type === 'init_declarator' || n.type === 'pointer_declarator' || n.type === 'array_declarator') {
    return isFunctionDeclarator(n.childForFieldName('declarator') || n.namedChildren[0]);
  }
  if (n.type === 'parenthesized_declarator' || n.type === 'attributed_declarator') {
    return isFunctionDeclarator(n.namedChildren[0]);
  }
  return false;
}

/**
 * 文件作用域的变量定义
 * 能处理 typedef 出来的自定义类型、无初始化的声明、一行多个声明符、数组与指针
 */
export function collectGlobals(root) {
  const out = [];
  for (const node of fileDeclarations(root)) {
    if (node.type !== 'declaration') continue;
    const decls = node.namedChildren.filter((c) => DECL_NODES.has(c.type));
    if (!decls.length) continue;
    if (decls.some((d) => isFunctionDeclarator(d))) continue; // 函数原型

    const words = node.children.map((c) => c.text);
    const typeNode = node.childForFieldName('type');
    const typeText = [typeNode ? typeNode.text : '', ...words.filter((w) => w === 'volatile' || w === 'const')]
      .filter(Boolean)
      .join(' ');

    for (const d of decls) {
      const name = declaratorName(d);
      if (!name) continue;
      out.push({
        name,
        line: d.startPosition.row + 1,
        typeText: typeText || words[0] || '',
        isStatic: words.includes('static'),
        isExtern: words.includes('extern'),
        isConst: words.includes('const'),
        hasInit: d.type === 'init_declarator',
        isArray: (d.type === 'init_declarator' ? d.childForFieldName('declarator') : d)?.type === 'array_declarator',
      });
    }
  }
  return out;
}

/** 文件里所有函数定义：name -> function_definition 节点 */
export function collectFunctions(root) {
  const map = new Map();
  for (const node of fileDeclarations(root)) {
    if (node.type !== 'function_definition') continue;
    const name = declaratorName(node.childForFieldName('declarator'));
    if (name && !map.has(name)) map.set(name, node);
  }
  return map;
}

/** 完整定义文本供差分使用；每个声明符携带共用类型，避免一行多变量互相牵连。 */
export function collectDefinitions(root) {
  const definitions = [];
  const other = [];
  for (const node of fileDeclarations(root)) {
    if (node.type === 'function_definition') {
      definitions.push({ name: declaratorName(node.childForFieldName('declarator')), kind: 'fn', text: node.text });
    } else if (node.type === 'declaration') {
      const decls = node.namedChildren.filter((c) => DECL_NODES.has(c.type));
      if (decls.some(isFunctionDeclarator)) { other.push(node.text); continue; }
      const common = node.namedChildren.filter((c) => TYPE_NODES.has(c.type)).map((c) => c.text).join(' ');
      for (const d of decls) definitions.push({ name: declaratorName(d), kind: 'var', text: `${common} ${d.text}`,
        isStatic: node.children.some((c) => c.text === 'static'), isExtern: node.children.some((c) => c.text === 'extern') });
    } else if (['type_definition', 'struct_specifier', 'enum_specifier', 'union_specifier'].includes(node.type)) {
      other.push(node.text);
    }
  }
  return { definitions, other };
}

/** 参数位置与指针/数组属性，用于绑定调用处的实参。 */
export function collectParameters(fnNode) {
  let decl = fnNode.childForFieldName('declarator');
  while (decl && decl.type !== 'function_declarator') decl = decl.childForFieldName('declarator');
  return (decl?.childForFieldName('parameters')?.namedChildren || [])
    .filter((p) => p.type === 'parameter_declaration')
    .map((p) => {
      const d = p.childForFieldName('declarator');
      return { name: declaratorName(d), pointer: d?.type === 'pointer_declarator' || d?.type === 'array_declarator' };
    });
}

/** 沿 field/subscript/pointer/paren 往下找到最底层的标识符 */
function baseIdentifier(n) {
  if (!n) return null;
  switch (n.type) {
    case 'identifier':
      return n;
    case 'field_expression':
      return baseIdentifier(n.childForFieldName('argument'));
    case 'subscript_expression':
      return baseIdentifier(n.childForFieldName('argument'));
    case 'pointer_expression':
      return baseIdentifier(n.childForFieldName('argument'));
    case 'parenthesized_expression':
    case 'cast_expression':
      return baseIdentifier(n.namedChildren[n.namedChildren.length - 1]);
    default:
      return null;
  }
}

/**
 * 收集一个函数体里对全局变量的读写
 * 返回值：{ writes, reads }，都是 Map<变量名, { lines:Set, fields:Set, whole:bool, indirect:bool }>
 *
 * 判定口径：
 *   write      赋值左值（= 为纯写；+= 之类与 ++ -- 先读旧值，算读写）
 *   read       其余引用（裸标识符 x = g / g % n、成员链 g.a.b、下标 g[i]）
 *   escape     未解析的 &g 取地址按「读 + 可能被写」处理；已解析调用由形参访问决定
 *   按值实参只读，不会因传参而改写原变量。
 */
export function collectAccesses(fnNode, isGlobal, { bindings = new Map(), resolveCall, isArray } = {}) {
  const writes = new Map();
  const reads = new Map();
  let locals = new Set();
  let aliases = new Map(bindings); // 局部指针/形参 -> 可能指向的全局变量
  const pointers = new Set();
  const calls = [];

  const body = fnNode.childForFieldName('body');
  if (!body) return { writes, reads, locals, calls };

  // 形参名
  for (const p of collectParameters(fnNode)) {
    if (p.name) locals.add(p.name);
    if (p.pointer) pointers.add(p.name);
  }

  const pointerTargets = (n) => {
    if (!n) return new Set();
    if (n.type === 'parenthesized_expression' || n.type === 'cast_expression') {
      return pointerTargets(n.namedChildren[n.namedChildren.length - 1]);
    }
    if (n.type === 'conditional_expression') {
      return new Set([...pointerTargets(n.childForFieldName('consequence')), ...pointerTargets(n.childForFieldName('alternative'))]);
    }
    if (n.type === 'pointer_expression' && n.text.trimStart().startsWith('&')) {
      const base = baseIdentifier(n.childForFieldName('argument'));
      return base && !locals.has(base.text) && isGlobal(base.text) ? new Set([base.text]) : new Set();
    }
    if (n.type === 'identifier') {
      if (locals.has(n.text)) return aliases.get(n.text) || new Set();
      if (isGlobal(n.text) && isArray?.(n.text)) return new Set([n.text]);
    }
    return new Set();
  };

  const touch = (map, name, node, extra = {}) => {
    let rec = map.get(name);
    if (!rec) {
      rec = { lines: new Set(), fields: new Set(), whole: false, indirect: false };
      map.set(name, rec);
    }
    rec.lines.add(node.startPosition.row + 1);
    if (extra.field) rec.fields.add(extra.field);
    else rec.whole = true;
    if (extra.indirect) rec.indirect = true;
  };

  const classify = (node, mode) => {
    const base = baseIdentifier(node);
    if (!base || base.type !== 'identifier') return;
    const name = base.text;
    const parts = [];
    let part = node;
    while (part) {
      if (part.type === 'field_expression') {
        const fieldNode = part.childForFieldName('field');
        if (fieldNode) parts.unshift(fieldNode.text);
        part = part.childForFieldName('argument');
      } else if (part.type === 'subscript_expression' || part.type === 'pointer_expression') {
        part = part.childForFieldName('argument');
      } else if (part.type === 'parenthesized_expression' || part.type === 'cast_expression') {
        part = part.namedChildren[part.namedChildren.length - 1];
      } else break;
    }
    const field = parts.length ? parts.join('.') : null;

    if (locals.has(name)) {
      // 只把解引用算作目标访问；p = 0 或转传 p 不会读写 *p。
      if (node.type === 'identifier') return;
      for (const target of aliases.get(name) || []) {
        if (mode === 'write' || mode === 'rw') touch(writes, target, node, { field, indirect: true });
        if (mode !== 'write') touch(reads, target, node, { field, indirect: true });
      }
      return;
    }
    if (!isGlobal(name)) return;

    if (mode === 'write' || mode === 'rw') touch(writes, name, node, { field });
    if (mode === 'read' || mode === 'rw' || mode === 'escape') touch(reads, name, node, { field });
    // escape 无法判断对方是否写，保守算作可能写
    if (mode === 'escape') touch(writes, name, node, { field, indirect: true });
  };

  const visit = (n, mode) => {
    if (!n) return;
    switch (n.type) {
      case 'compound_statement':
      case 'for_statement': {
        // 局部声明和指针别名只在当前作用域内有效，退出后恢复外层绑定。
        const outerLocals = locals, outerAliases = aliases;
        locals = new Set(locals);
        aliases = new Map(aliases);
        for (const child of n.namedChildren) visit(child, mode);
        locals = outerLocals;
        aliases = outerAliases;
        return;
      }
      case 'assignment_expression': {
        // 复合赋值（+= 之类）先读旧值再写，左值按读写；= 才是纯写
        const op = n.childForFieldName('operator')?.text;
        const left = n.childForFieldName('left');
        if (op === '=' && left?.type === 'identifier' && pointers.has(left.text)) {
          aliases.set(left.text, pointerTargets(n.childForFieldName('right')));
        }
        visit(n.childForFieldName('left'), op === '=' ? 'write' : 'rw');
        visit(n.childForFieldName('right'), 'read');
        return;
      }
      case 'update_expression': {
        visit(n.childForFieldName('argument'), 'rw');
        return;
      }
      case 'pointer_expression': {
        // &g 取地址：可能被调用方写
        if (n.text.trimStart().startsWith('&')) {
          classify(n.childForFieldName('argument'), 'escape');
          return;
        }
        classify(n, mode);
        return;
      }
      case 'call_expression': {
        const args = n.childForFieldName('arguments');
        const callee = n.childForFieldName('function');
        const target = callee?.type === 'identifier' && !locals.has(callee.text) ? resolveCall?.(callee.text) : null;
        for (const [i, a] of (args?.namedChildren || []).entries()) {
          const targets = pointerTargets(a);
          // 取地址不访问目标值，但下标和条件表达式仍会被求值。
          const visitAddress = (part) => {
            if (!part) return;
            if (part.type === 'conditional_expression') {
              visit(part.childForFieldName('condition'), 'read');
              visitAddress(part.childForFieldName('consequence'));
              visitAddress(part.childForFieldName('alternative'));
            } else if (part.type === 'parenthesized_expression' || part.type === 'cast_expression') {
              visitAddress(part.namedChildren[part.namedChildren.length - 1]);
            } else if (part.type === 'pointer_expression' && part.text.trimStart().startsWith('&')) {
              const indices = (n) => {
                if (n?.type === 'subscript_expression') visit(n.childForFieldName('index'), 'read');
                if (n?.type === 'subscript_expression' || n?.type === 'field_expression') indices(n.childForFieldName('argument'));
              };
              indices(part.childForFieldName('argument'));
            } else if (part.type !== 'identifier') visit(part, 'read');
          };
          if (target?.params[i]?.pointer && targets.size) {
            calls.push({ to: target.id, param: target.params[i].name, targets });
            visitAddress(a);
          } else if (!target && targets.size) {
            // 外部调用无法知道如何使用指针，保留可能读写的保守口径。
            for (const name of targets) {
              touch(reads, name, a, { indirect: true });
              touch(writes, name, a, { indirect: true });
            }
            visitAddress(a);
          } else visit(a, 'read');
        }
        visit(callee, 'read');
        return;
      }
      case 'field_expression':
      case 'subscript_expression': {
        // 整个访问链只记一次，避免 g.a.b 重复计数
        classify(n, mode);
        // 下标是独立的读取：g_buf[g_index] = x 也会读 g_index。
        const visitIndices = (part) => {
          if (!part) return;
          if (part.type === 'subscript_expression') visit(part.childForFieldName('index'), 'read');
          if (part.type === 'field_expression' || part.type === 'subscript_expression') {
            visitIndices(part.childForFieldName('argument'));
          }
        };
        visitIndices(n);
        return;
      }
      case 'identifier': {
        // 裸标识符引用：x = g、g % 100u、按值实参。
        // 此前 classify 只挂在成员/下标/取地址链上，裸读整条漏掉（demo 的 g_tick 链路断在读侧）
        classify(n, mode);
        return;
      }
      case 'declaration': {
        // 局部声明：收集变量名与「指向全局」的别名
        for (const d of n.namedChildren.filter((c) => DECL_NODES.has(c.type))) {
          const nm = declaratorName(d);
          if (!nm) continue;
          locals.add(nm);
          aliases.delete(nm);
          if (d.type === 'init_declarator' && d.childForFieldName('declarator')?.type === 'pointer_declarator') {
            const init = d.childForFieldName('value');
            pointers.add(nm);
            aliases.set(nm, pointerTargets(init));
          } else if (d.type === 'pointer_declarator') {
            pointers.add(nm);
          }
        }
        // 初始化表达式里仍可能引用全局
        for (const c of n.namedChildren) if (c.type === 'init_declarator') visit(c.childForFieldName('value'), 'read');
        return;
      }
      default: {
        for (const c of n.namedChildren) visit(c, mode);
      }
    }
  };

  // 按源码顺序访问，声明从出现位置起遮蔽外层同名变量。
  visit(body, 'read');
  return { writes, reads, locals, calls };
}
