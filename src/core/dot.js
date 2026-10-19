/**
 * Graphviz DOT 解析器（digraph / graph 子集）
 * 支持：链式边、属性列表、node/edge 默认属性、subgraph cluster、注释、HTML-like label
 */

const ID_START = /[A-Za-z0-9_.\u00a0-\uffff]/;

function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      i++;
      continue;
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '#' && (i === 0 || src[i - 1] === '\n')) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < n) {
        if (src[j] === '\\') {
          const e = src[j + 1];
          if (e === 'n') out += '\n';
          else if (e === 'l') out += '\n';
          else if (e === 't') out += '\t';
          else if (e === '"') out += '"';
          else if (e === '\\') out += '\\';
          else out += e ?? '';
          j += 2;
          continue;
        }
        if (src[j] === '"') break;
        out += src[j];
        j++;
      }
      toks.push({ t: 'id', v: out, quoted: true });
      i = j + 1;
      continue;
    }

    if (c === '<') {
      let depth = 0;
      let j = i;
      for (; j < n; j++) {
        if (src[j] === '<') depth++;
        else if (src[j] === '>') {
          depth--;
          if (depth === 0) break;
        }
      }
      toks.push({ t: 'html', v: src.slice(i + 1, j) });
      i = j + 1;
      continue;
    }

    if (c === '-' && src[i + 1] === '>') {
      toks.push({ t: 'op', v: '->' });
      i += 2;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      toks.push({ t: 'op', v: '--' });
      i += 2;
      continue;
    }

    if ('{}[]=;,:'.includes(c)) {
      toks.push({ t: 'punct', v: c });
      i++;
      continue;
    }

    if (ID_START.test(c)) {
      let j = i;
      while (j < n && ID_START.test(src[j])) j++;
      toks.push({ t: 'id', v: src.slice(i, j) });
      i = j;
      continue;
    }

    i++;
  }

  return toks;
}

export function parseDot(src) {
  const toks = tokenize(src);
  let p = 0;

  const peek = (k = 0) => toks[p + k];
  const next = () => toks[p++];
  const is = (v) => peek() && peek().v === v;

  const graph = {
    name: '',
    directed: true,
    nodes: new Map(),
    edges: [],
    clusters: [],
    graphAttrs: {},
    nodeDefaults: {},
    edgeDefaults: {},
  };

  const clusterStack = [];

  const ensureNode = (id) => {
    if (!graph.nodes.has(id)) {
      graph.nodes.set(id, {
        id,
        label: id,
        attrs: { ...graph.nodeDefaults },
        cluster: clusterStack.length ? clusterStack[clusterStack.length - 1] : null,
        implicit: true,
      });
    }
    return graph.nodes.get(id);
  };

  const parseAttrList = () => {
    const attrs = {};
    if (!is('[')) return attrs;
    p++;
    while (p < toks.length && !is(']')) {
      if (is(',') || is(';')) {
        p++;
        continue;
      }
      const k = next();
      if (!k) break;
      if (is('=')) {
        p++;
        const v = next();
        attrs[k.v] = v ? v.v : '';
      } else {
        attrs[k.v] = true;
      }
    }
    if (is(']')) p++;
    return attrs;
  };

  const parseBody = () => {
    while (p < toks.length) {
      if (is('}')) {
        p++;
        return;
      }
      if (is(';')) {
        p++;
        continue;
      }

      const tk = peek();
      if (!tk) return;

      // subgraph / cluster
      if (tk.t === 'id' && tk.v.toLowerCase() === 'subgraph') {
        p++;
        let name = '';
        if (peek() && peek().t === 'id' && !is('{')) name = next().v;
        if (is('{')) {
          const cl = {
            id: name || `cluster_${graph.clusters.length}`,
            label: name || '',
            attrs: {},
            parent: clusterStack.length ? clusterStack[clusterStack.length - 1] : null,
          };
          graph.clusters.push(cl);
          clusterStack.push(cl.id);
          p++;
          parseBody();
          clusterStack.pop();
          if (cl.attrs.label) cl.label = cl.attrs.label;
          continue;
        }
        continue;
      }

      // node / edge / graph 默认属性
      if (tk.t === 'id' && ['node', 'edge', 'graph'].includes(tk.v) && peek(1) && peek(1).v === '[') {
        const kind = next().v;
        const attrs = parseAttrList();
        if (kind === 'node') Object.assign(graph.nodeDefaults, attrs);
        else if (kind === 'edge') Object.assign(graph.edgeDefaults, attrs);
        else Object.assign(graph.graphAttrs, attrs);
        continue;
      }

      // 语句：可能是 节点 / 链式边 / 图属性
      const parts = [];
      parts.push(next());

      // 图属性 / cluster 属性 key = value
      if (is('=')) {
        p++;
        const v = next();
        const key = parts[0].v;
        if (clusterStack.length) {
          const cid = clusterStack[clusterStack.length - 1];
          const cl = graph.clusters.find((c) => c.id === cid);
          if (cl) {
            cl.attrs[key] = v ? v.v : '';
            if (key === 'label') cl.label = v ? v.v : '';
          }
        } else {
          graph.graphAttrs[key] = v ? v.v : '';
        }
        continue;
      }

      // 链式边
      let chained = false;
      while (is('->') || is('--')) {
        const op = next().v;
        if (op === '--') graph.directed = false;
        const target = next();
        if (!target) break;
        parts.push(target);
        chained = true;
      }

      if (chained) {
        const attrs = { ...graph.edgeDefaults, ...parseAttrList() };
        for (let k = 0; k + 1 < parts.length; k++) {
          const from = parts[k].v;
          const to = parts[k + 1].v;
          ensureNode(from);
          ensureNode(to);
          graph.edges.push({
            from,
            to,
            attrs,
            label: attrs.label ?? '',
            cluster: clusterStack.length ? clusterStack[clusterStack.length - 1] : null,
          });
        }
        continue;
      }

      // 单个节点定义
      const id = parts[0].v;
      const node = ensureNode(id);
      node.implicit = false;
      const attrs = parseAttrList();
      Object.assign(node.attrs, attrs);
      if (attrs.label !== undefined) node.label = String(attrs.label);
      if (!node.cluster && clusterStack.length) node.cluster = clusterStack[clusterStack.length - 1];
    }
  };

  // 跳过 graph / digraph [strict] [name] {
  while (p < toks.length) {
    const tk = peek();
    if (!tk) break;
    if (tk.t === 'id' && ['strict', 'digraph', 'graph'].includes(tk.v.toLowerCase())) {
      if (tk.v.toLowerCase() === 'graph') graph.directed = false;
      p++;
      continue;
    }
    if (tk.t === 'id') {
      graph.name = tk.v;
      p++;
      continue;
    }
    if (tk.v === '{') {
      p++;
      break;
    }
    p++;
  }

  parseBody();
  return graph;
}

/** 把 DOT 图转成与 C 解析一致的 model 结构 */
export function modelFromDot(dot, fileLabel = '<dot>') {
  const functions = [];
  const idMap = new Map();

  for (const n of dot.nodes.values()) {
    const id = `dot::${n.id}`;
    idMap.set(n.id, id);
    functions.push({
      id,
      name: n.label || n.id,
      rawName: n.id,
      file: fileLabel,
      line: 0,
      params: [],
      isStatic: false,
      attrs: n.attrs,
      cluster: n.cluster,
    });
  }

  const edges = [];
  for (const e of dot.edges) {
    const from = idMap.get(e.from) || `dot::${e.from}`;
    const to = idMap.get(e.to) || `dot::${e.to}`;
    const label = typeof e.label === 'string' ? e.label : '';
    const isMacro = /via/i.test(label) || e.attrs.style === 'dashed';
    const isFnptr = /fnptr/i.test(label);
    edges.push({
      from,
      to,
      callee: e.to,
      kind: isFnptr ? 'fnptr' : isMacro ? 'macro' : 'direct',
      line: 0,
      cond: e.attrs.condition || undefined,
      via: label || undefined,
      attrs: e.attrs,
    });
  }

  const byId = new Map(functions.map((f) => [f.id, f]));
  const outAdj = new Map();
  const inAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from)) outAdj.set(e.from, []);
    outAdj.get(e.from).push(e);
    if (!inAdj.has(e.to)) inAdj.set(e.to, []);
    inAdj.get(e.to).push(e);
  }

  const clusters = dot.clusters.map((c) => ({ id: c.id, label: c.label || c.id, attrs: c.attrs }));

  return {
    root: fileLabel,
    generatedAt: new Date().toISOString(),
    elapsedMs: 0,
    source: 'dot',
    files: [{ rel: fileLabel, isHeader: false, bytes: 0 }],
    functions,
    externals: [],
    edges,
    macros: [],
    fnptrTables: [],
    includes: [],
    clusters,
    graphAttrs: dot.graphAttrs,
    _index: { byId, byName: new Map(), outAdj, inAdj },
  };
}
