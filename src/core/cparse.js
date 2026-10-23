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
  const key = `${abs}:${src ? src.length : 'disk'}`;
  const hit = treeCache.get(key);
  if (hit) return hit;
  const parser = await getParser();
  const text = src ?? fs.readFileSync(abs, 'utf8');
  const tree = parser.parse(text);
  const rec = { tree, root: tree.rootNode, src: text, rel };
  treeCache.set(key, rec);
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
  for (const node of root.namedChildren) {
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
      });
    }
  }
  return out;
}

/** 文件里所有函数定义：name -> function_definition 节点 */
export function collectFunctions(root) {
  const map = new Map();
  for (const node of root.namedChildren) {
    if (node.type !== 'function_definition') continue;
    const name = declaratorName(node.childForFieldName('declarator'));
    if (name && !map.has(name)) map.set(name, node);
  }
  return map;
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
 * 返回值：{ writes, reads }，都是 Map<变量名, { lines:Set, fields:Set, indirect:bool }>
 *
 * 判定口径：
 *   write      赋值左值（= 为纯写；+= 之类与 ++ -- 先读旧值，算读写）
 *   read       其余引用（裸标识符 x = g / g % n、成员链 g.a.b、下标 g[i]）
 *   escape     &g 取地址、g 作为实参传出去 —— 对方读写不可知，按「读 + 可能被写」保守处理
 */
export function collectAccesses(fnNode, isGlobal) {
  const writes = new Map();
  const reads = new Map();
  const locals = new Set();
  const aliases = new Map(); // 局部指针 -> 全局变量名

  const body = fnNode.childForFieldName('body');
  if (!body) return { writes, reads, locals };

  // 形参名
  const params = fnNode.childForFieldName('declarator')?.childForFieldName('parameters');
  if (params) {
    for (const p of params.namedChildren) {
      const nm = declaratorName(p);
      if (nm) locals.add(nm);
    }
  }

  const touch = (map, name, node, extra = {}) => {
    let rec = map.get(name);
    if (!rec) {
      rec = { lines: new Set(), fields: new Set(), indirect: false };
      map.set(name, rec);
    }
    rec.lines.add(node.startPosition.row + 1);
    if (extra.field) rec.fields.add(extra.field);
    if (extra.indirect) rec.indirect = true;
  };

  const classify = (node, mode) => {
    const base = baseIdentifier(node);
    if (!base || base.type !== 'identifier') return;
    const name = base.text;
    const fieldNode = node.type === 'field_expression' ? node.childForFieldName('field') : null;
    const field = fieldNode ? fieldNode.text : null;

    if (locals.has(name)) {
      const target = aliases.get(name);
      if (!target) return; // 纯局部变量，与全局无关
      // 通过指向全局的局部指针访问：*p = ... / p->f = ...
      if (mode === 'write' || mode === 'rw') touch(writes, target, node, { field, indirect: true });
      if (mode !== 'write') touch(reads, target, node, { field, indirect: true });
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
      case 'assignment_expression': {
        // 复合赋值（+= 之类）先读旧值再写，左值按读写；= 才是纯写
        const op = n.childForFieldName('operator')?.text;
        classify(n.childForFieldName('left'), op === '=' ? 'write' : 'rw');
        visit(n.childForFieldName('right'), 'read');
        return;
      }
      case 'update_expression': {
        classify(n.childForFieldName('argument'), 'rw');
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
        for (const a of args ? args.namedChildren : []) visit(a, 'escape');
        visit(n.childForFieldName('function'), 'read');
        return;
      }
      case 'field_expression':
      case 'subscript_expression': {
        // 整个访问链只记一次，避免 g.a.b 重复计数
        classify(n, mode);
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
          if (d.type === 'init_declarator') {
            const init = d.childForFieldName('value');
            if (init && init.type === 'pointer_expression' && init.text.trimStart().startsWith('&')) {
              const t = baseIdentifier(init.childForFieldName('argument'));
              if (t && t.type === 'identifier' && isGlobal(t.text)) aliases.set(nm, t.text);
            } else if (init && init.type === 'identifier' && isGlobal(init.text)) {
              // 局部指针 = 全局数组名之类的退化情形
              aliases.set(nm, init.text);
            }
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

  // 先扫一遍局部声明，避免「先使用后声明」被误判（C 里声明都在块首，问题不大）
  visit(body, 'read');
  return { writes, reads, locals };
}
