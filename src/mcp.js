/**
 * 内置 MCP 服务器：让 AI 客户端直接读取调用图、调整标注 / 布局、导出图表。
 *
 * 形态选型（见 docs/mcp.md）：
 * - Streamable HTTP 传输，挂在主服务器的 /mcp 路径上，零新依赖；
 * - 工具实现全部桥接到进程内 HTTP API（fetch 127.0.0.1 的自己），
 *   与浏览器 UI 走完全相同的路径——校验、事件记录、持久化天然一致，
 *   时间轴里还能通过 actor=ai 区分出 AI 的改动。
 *
 * 权限模型（三档，默认只读）：
 * - off        MCP 整体禁用，只保留协议握手
 * - readonly   只读 + 导出（导出只写 out/ 产物，不改工程数据）
 * - readwrite  全量（标注 / 删除恢复 / 布局 / 切工程）
 *
 * 权限优先级：环境变量 CALLGRAPH_MCP > 库里 setting 表的 mcp.access > 默认 readonly。
 * UI 的「AI 访问」设置面板读写后者；环境变量留给测试 / 无头场景。
 *
 * 协议实现说明：
 * - 无会话模式（不返回 Mcp-Session-Id），每个 POST 独立处理；
 * - 支持批量 JSON-RPC（body 为数组）与通知（无 id → 202 空体，由调用方处理）；
 * - 不开 SSE，GET /mcp 由 server.js 直接回 405。
 */

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'tcu-callgraph', version: '0.2.0' };

export const ACCESS_LEVELS = ['off', 'readonly', 'readwrite'];

/** 环境变量覆盖值是否合法 */
export function validAccess(v) {
  return ACCESS_LEVELS.includes(String(v || '').toLowerCase());
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

// ---------------------------------------------------------------------------
// 工具定义
//
// 每个工具：name / description / access('read'|'write'|'export') /
// inputSchema(JSON Schema) / run(args, ctx)。
// ctx 提供 baseUrl 与 fetchImpl，run 统一返回 JSON 可序列化对象。
// ---------------------------------------------------------------------------

/** 桥接 GET：URLSearchParams 已编码好 */
async function get(ctx, pathAndQuery) {
  const res = await ctx.fetchImpl(`${ctx.baseUrl}${pathAndQuery}`);
  return res.json();
}

/** 桥接 POST：写操作统一带 actor:'ai'，时间轴据此区分 AI 与人工改动 */
async function post(ctx, path, body) {
  const res = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, actor: 'ai' }),
  });
  return res.json();
}

/**
 * 导出产物文件名统一校验：只允许 out/ 下的相对文件名。
 * 拒绝绝对路径、目录分隔符与 ..——MCP 的调用方是 AI，不该拿到任意路径写盘能力。
 */
function safeOutName(out, fallbackExt) {
  let name = String(out || '').trim();
  if (!name) return { name: `callgraph-${Date.now()}.${fallbackExt}` };
  if (/[\\/]|\.\./.test(name)) return { error: 'outPath 只能是 out/ 下的文件名' };
  return { name };
}

/**
 * 桥接「返回文件流」的导出端点：拿响应 buffer 写进 out/。
 */
async function downloadTo(ctx, pathAndQuery, outPath, fallbackExt) {
  const n = safeOutName(outPath, fallbackExt);
  if (n.error) return { ok: false, error: n.error };
  const res = await ctx.fetchImpl(`${ctx.baseUrl}${pathAndQuery}`);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: text || `导出失败：HTTP ${res.status}`, status: res.status };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const target = await ctx.writeOut(n.name, buf);
  return { ok: true, path: target, bytes: buf.length };
}

const TOOLS = [
  // ---- 读 ----
  {
    name: 'cg_stats',
    description: '当前工程的统计概览：函数数、调用数、宏、函数指针表、文件清单、环、已删除数量。',
    access: 'read',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, ctx) => get(ctx, '/api/stats'),
  },
  {
    name: 'cg_project',
    description: '当前打开的工程身份：名字、路径、指纹是否与上次扫描一致（changed=true 表示代码变过）。',
    access: 'read',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, ctx) => get(ctx, '/api/project'),
  },
  {
    name: 'cg_page',
    description:
      '用户页面当前正在看的视图：入口函数、展开深度、布局模式、选中的节点/连线、是否在回看历史。' +
      '想让改动直接出现在用户眼前时，先用它对齐上下文（比如按用户正在看的入口去 cg_view），' +
      '写操作会通过推送通道实时反映到打开的页面上。',
    access: 'read',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, ctx) => get(ctx, '/api/page'),
  },
  {
    name: 'cg_projects',
    description: '最近打开过的工程列表（含 id、名字、路径、是否固定、是否当前）。',
    access: 'read',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, ctx) => get(ctx, '/api/projects'),
  },
  {
    name: 'cg_tree',
    description: '当前工程的文件树：目录层级、每个文件里的函数清单。',
    access: 'read',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, ctx) => get(ctx, '/api/tree'),
  },
  {
    name: 'cg_search',
    description: '按函数名搜索，返回函数 id、所在文件行号、入度出度。后续工具都吃这里的 id。',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', description: '搜索词（函数名子串）' } },
      required: ['q'],
    },
    run: (a, ctx) => get(ctx, '/api/search?q=' + encodeURIComponent(String(a.q || ''))),
  },
  {
    name: 'cg_view',
    description:
      '取一张调用图视图：给定入口函数（不给则自动选入口），返回带坐标的节点、路由后的连线、文件分组框——这就是界面上画的同一份数据，也是 SVG 导出的输入。' +
      'root 不填时自动挑选入口函数。',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '入口函数 id（形如 "main.c::main"）' },
        roots: { type: 'array', items: { type: 'string' }, description: '多入口合并视图' },
        up: { type: 'integer', description: '向上展开层数（谁调用了它）', default: 0 },
        down: { type: 'integer', description: '向下展开层数（它调用了谁）', default: 3 },
        group: { type: 'boolean', description: '按文件分组布局', default: true },
      },
    },
    run: (a, ctx) => {
      const q = new URLSearchParams();
      const roots = (a.roots && a.roots.length ? a.roots : a.root ? [a.root] : []).filter(Boolean);
      if (roots.length === 1) q.set('root', roots[0]);
      else if (roots.length > 1) q.set('roots', roots.join(','));
      q.set('up', String(Math.max(0, Number(a.up ?? 0))));
      q.set('down', String(Math.max(0, Number(a.down ?? 3))));
      q.set('group', a.group === false ? '0' : '1');
      return get(ctx, '/api/view?' + q);
    },
  },
  {
    name: 'cg_node',
    description: '单个函数的详情：签名、文件行号、入边出边、已有标注。',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '函数 id（cg_search 的结果）' } },
      required: ['id'],
    },
    run: (a, ctx) => get(ctx, '/api/node?id=' + encodeURIComponent(String(a.id || ''))),
  },
  {
    name: 'cg_vars',
    description: '全工程全局变量 / 常量清单（变量节点的 id 从这里拿）。',
    access: 'read',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, ctx) => get(ctx, '/api/vars'),
  },
  {
    name: 'cg_shared_vars',
    description: '被多个函数共享的全局变量（跨函数数据耦合的风险点）。',
    access: 'read',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, ctx) => get(ctx, '/api/shared-vars'),
  },
  {
    name: 'cg_dataflow',
    description: '按需数据流分析：dir=out 看它写的变量影响哪些函数，dir=in 看谁的状态影响它。',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        fn: { type: 'string', description: '函数 id' },
        dir: { type: 'string', enum: ['in', 'out'], default: 'out' },
      },
      required: ['fn'],
    },
    run: (a, ctx) =>
      get(
        ctx,
        '/api/dataflow?fn=' + encodeURIComponent(String(a.fn || '')) + '&dir=' + (a.dir === 'in' ? 'in' : 'out')
      ),
  },
  {
    name: 'cg_orphans',
    description: '失效标注清单：库里指向已不存在的函数 / 连线 / 布局槽位的条目。',
    access: 'read',
    inputSchema: { type: 'object', properties: {} },
    run: (_a, ctx) => get(ctx, '/api/orphans'),
  },
  {
    name: 'cg_events',
    description: '时间轴事件列表（倒序）：标注、删除、布局、AI 改动（actor=ai）都能追溯，含恢复用的 eventId。',
    access: 'read',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: '最多返回条数', default: 50 } },
    },
    run: (a, ctx) => get(ctx, '/api/events?limit=' + Math.min(1000, Math.max(1, Number(a.limit || 50)))),
  },
  // ---- 写（需要 readwrite）----
  {
    name: 'cg_switch',
    description: '切换当前工程（按 id 或绝对路径）。切换后其他工具都作用在新工程上。',
    access: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', description: '工程 id（cg_projects 的结果）' },
        path: { type: 'string', description: '工程根目录绝对路径' },
      },
    },
    run: (a, ctx) => post(ctx, '/api/switch', { id: a.id, path: a.path }),
  },
  {
    name: 'cg_annotate',
    description:
      '给函数节点或连线写标注。data 支持的键：note(备注文字)、' +
      'color(底色，只能是固定四色：#CCFFCC=既存绿 / #FFFF99=変更黄 / #FFCCFF=追加粉 / #BFBFBF=削除灰，传 null 清除，别的值会被拒绝)、' +
      'tag(分类标签)、change(既存 existing / 変更 modified / 追加 added / 削除 deleted——底色规则由它驱动，按规则改框色优先用它)、' +
      'label(连线标签：{preset:"task"|"conn"|"call", text, border, color, num, dx, dy}，传 null 删除)。传 null 清除该键。' +
      '标注会实时推送到用户打开的页面上（无需刷新），并记入时间轴。',
    access: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: '函数 / 变量节点 id（与 edgeKey 二选一）' },
        edgeKey: { type: 'string', description: '连线 key，格式 "from->to:行号"' },
        data: {
          type: 'object',
          description: '标注内容',
          properties: {
            color: {
              enum: ['#CCFFCC', '#FFFF99', '#FFCCFF', '#BFBFBF', null],
              description: '底色固定四色（既存/変更/追加/削除），null=清除回落 change 分类色',
            },
            change: {
              enum: ['existing', 'modified', 'added', 'deleted', null],
              description: '变更分类：既存/変更/追加/削除',
            },
          },
        },
      },
      required: ['data'],
    },
    run: (a, ctx) => {
      if (!a.nodeId && !a.edgeKey) return { ok: false, error: 'nodeId 或 edgeKey 必须给一个' };
      return post(ctx, '/api/overlay', { nodeId: a.nodeId, edgeKey: a.edgeKey, data: a.data });
    },
  },
  {
    name: 'cg_delete',
    description:
      '从图上隐藏函数 / 连线（只记录，不动源码）：restore=false 删除、true 恢复、clear=true 恢复全部。',
    access: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        nodes: { type: 'array', items: { type: 'string' }, description: '要删除/恢复的函数 id 列表' },
        edges: { type: 'array', items: { type: 'string' }, description: '连线 key 列表（from->to:line）' },
        restore: { type: 'boolean', description: 'true=恢复，false=删除', default: false },
        clear: { type: 'boolean', description: 'true=恢复所有已删除项（忽略 nodes/edges）', default: false },
      },
    },
    run: (a, ctx) => post(ctx, '/api/delete', { nodes: a.nodes, edges: a.edges, restore: !!a.restore, clear: !!a.clear }),
  },
  {
    name: 'cg_save_layout',
    description:
      '保存手动布局：nodes 是 {函数id:{x,y}} 坐标表，edges 是连线的手动折线/端口覆盖，manual 是手工连线列表。' +
      '先 cg_view 拿到当前坐标，改完再整体存回。',
    access: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '该布局所属的入口函数 id（空字符串=自动布局视图）' },
        mode: { type: 'string', enum: ['group', 'flat'], description: '布局模式', default: 'group' },
        nodes: { type: 'object', description: '{函数id: {x, y}}' },
        edges: { type: 'object', description: '{连线key: {fromSide, toSide, custom, points}}' },
        manual: { type: 'array', items: { type: 'object' }, description: '手工连线 [{from, to}]' },
        clear: { type: 'boolean', description: 'true=清空该布局存档', default: false },
      },
    },
    run: (a, ctx) =>
      post(ctx, '/api/layout', {
        root: a.root,
        mode: a.mode === 'flat' ? 'flat' : 'group',
        nodes: a.nodes,
        edges: a.edges,
        manual: a.manual,
        clear: !!a.clear,
      }),
  },
  // ---- 导出（readonly 即可用：只写 out/ 产物目录）----
  {
    name: 'cg_export_svg',
    description:
      '导出当前视图为 SVG 文件（矢量图，和界面同布局同配色）。root 不填时自动挑入口。返回写入的文件路径。',
    access: 'export',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '入口函数 id（空=自动选择）' },
        up: { type: 'integer', default: 0 },
        down: { type: 'integer', default: 3 },
        group: { type: 'boolean', default: true },
        out: { type: 'string', description: '输出文件名（只能落在 out/ 下，如 "bus.svg"）' },
      },
    },
    run: async (a, ctx) => {
      const n = safeOutName(a.out, 'svg');
      if (n.error) return { ok: false, error: n.error };
      return post(ctx, '/api/export/svg', {
        root: a.root || '',
        up: Number(a.up ?? 0),
        down: Number(a.down ?? 3),
        group: a.group !== false,
        out: n.name,
      });
    },
  },
  {
    name: 'cg_export_xlsx',
    description: '导出整个调用关系为 Excel 表（函数清单 + 调用表 + 宏 + 函数指针）。返回写入的文件路径。',
    access: 'export',
    inputSchema: {
      type: 'object',
      properties: { out: { type: 'string', description: '输出文件名（只能落在 out/ 下）' } },
    },
    run: (a, ctx) => downloadTo(ctx, '/api/export/xlsx', a.out, 'xlsx'),
  },
  {
    name: 'cg_export_html',
    description: '导出指定入口的交互式 HTML 图页。返回写入的文件路径。',
    access: 'export',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string', description: '入口函数 id' },
        up: { type: 'integer', default: 0 },
        down: { type: 'integer', default: 3 },
        out: { type: 'string', description: '输出文件名（只能落在 out/ 下）' },
      },
      required: ['root'],
    },
    run: (a, ctx) =>
      downloadTo(
        ctx,
        '/api/export/html?root=' +
          encodeURIComponent(String(a.root || '')) +
          '&up=' + Math.max(0, Number(a.up ?? 0)) +
          '&down=' + Math.max(0, Number(a.down ?? 3)),
        a.out,
        'html'
      ),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** 工具在这个权限下是否可用：export 归入 readonly 一侧 */
const toolAllowed = (t, level) => {
  if (level === 'readwrite') return true;
  if (level === 'readonly') return t.access !== 'write';
  return false;
};

const accessHint = (level) =>
  level === 'off'
    ? 'MCP 已被设置为 off（禁用）。在界面「AI 访问」设置或 mcp.access 里改为 readonly / readwrite 后可用。'
    : level === 'readonly'
    ? '当前为只读权限（readonly）。写操作需要在「AI 访问」设置里开启 readwrite。'
    : '';

// ---------------------------------------------------------------------------
// 服务器实例
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string | (() => string)} opts.baseUrl 进程内桥接地址，如 http://127.0.0.1:5173。
 *   传函数则惰性求值——端口为 0（系统分配）时，listen 之前根本不知道真实端口
 * @param {() => string} opts.getAccess 返回当前生效权限（off/readonly/readwrite），
 *   每个请求都重新读——设置面板切换后立即生效
 * @param {(name: string, buf: Buffer) => Promise<string>} opts.writeOut 把导出产物写进 out/ 并返回绝对路径
 * @param {typeof fetch} [opts.fetchImpl] 测试注入
 */
export function createMcpServer({ baseUrl, getAccess, writeOut, fetchImpl = fetch }) {
  const ctx = {
    get baseUrl() {
      return String(typeof baseUrl === 'function' ? baseUrl() : baseUrl).replace(/\/$/, '');
    },
    fetchImpl,
    writeOut,
  };

  /** 处理单个 JSON-RPC 请求；通知（无 id）返回 null */
  async function handleOne(msg) {
    const id = msg?.id ?? null;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(id, -32600, '请求不是合法的 JSON-RPC 2.0 消息');
    }
    const level = getAccess();

    // initialize / ping 永远可用，让客户端至少能探测到服务与当前权限状态
    if (msg.method === 'initialize') {
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'TCU Callgraph：C 语言调用关系图工具。用户通常开着一个页面实时看图——先用 cg_page 看「用户正在看什么」，' +
          '再用 cg_search 找函数 id、cg_view 取视图，cg_annotate/cg_delete/cg_save_layout 调整（需要 readwrite），' +
          'cg_export_* 导出 SVG/Excel/HTML。你的写操作会实时推送到用户打开的页面上。' +
          '当前权限：' + level + (level !== 'readwrite' ? '。' + accessHint(level) : '。'),
      });
    }
    if (msg.method === 'ping') return rpcResult(id, {});

    if (msg.method.startsWith('notifications/')) return null; // 通知不回包

    if (msg.method === 'tools/list') {
      const tools = toolAllowed({ access: 'read' }, level)
        ? TOOLS.filter((t) => toolAllowed(t, level)).map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          }))
        : [];
      return rpcResult(id, {
        tools,
        ...(level === 'off' ? { _disabled: true, _hint: accessHint(level) } : {}),
      });
    }

    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      const tool = byName.get(name);
      if (level === 'off') {
        return rpcError(id, -32000, accessHint(level));
      }
      if (!tool) return rpcError(id, -32602, `未知工具：${name}`);
      if (!toolAllowed(tool, level)) {
        return rpcError(id, -32000, `工具 ${name} 需要更高权限。` + accessHint(level));
      }
      const args = msg.params?.arguments && typeof msg.params.arguments === 'object' ? msg.params.arguments : {};
      try {
        const result = await tool.run(args, ctx);
        // HTTP 层的错误（400/500 等）也带 ok:false，作为 isError 标记透传
        const isError = !!(result && result.ok === false && (result.error || result.status));
        return rpcResult(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 1) }],
          ...(isError ? { isError: true } : {}),
        });
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: String(err?.message || err) }],
          isError: true,
        });
      }
    }

    return rpcError(id, -32601, `方法不存在：${msg.method}`);
  }

  return {
    /** 处理 POST /mcp 的 body（对象或数组）。返回 { status, body }；body 为 null 时只回 202 */
    async handlePost(rawBody) {
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return { status: 400, body: rpcError(null, -32700, 'body 不是合法 JSON') };
      }
      const batch = Array.isArray(parsed);
      const messages = batch ? parsed : [parsed];
      if (!messages.length) return { status: 400, body: rpcError(null, -32600, '空批量请求' + '') };

      const replies = [];
      for (const m of messages) {
        const r = await handleOne(m);
        if (r) replies.push(r);
      }
      if (!replies.length) return { status: 202, body: null }; // 全是通知
      return { status: 200, body: batch ? replies : replies[0] };
    },
  };
}
