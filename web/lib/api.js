/**
 * 后端接口封装：所有 HTTP 调用集中在这里，便于统一处理错误与取消
 */
import { state } from './state.js';

// 页面标识用于识别延迟到达的自身切换广播，不依赖请求是否已经结束。
export const clientId = crypto.randomUUID();

const REQUEST_TIMEOUT = 15_000;
const ANALYSIS_TIMEOUT = 300_000;
const MODEL_TIMEOUT = 200_000;
function request(url, init, parse, timeout = REQUEST_TIMEOUT) {
  const deadline = AbortSignal.timeout(timeout);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return fetch(url, { ...init, signal }).then(parse).catch(error => {
    if (signal.reason === deadline.reason && deadline.aborted) {
      throw new Error('请求超时，请重试');
    }
    throw error;
  });
}
const get = (url, { parse = parseJson, timeout, signal } = {}) => request(url, { signal }, parse, timeout);
let layoutWrites = Promise.resolve();
const chatWrites = new Map();

async function parseJson(response) {
  if (response.ok) return response.json();
  const body = await response.json().catch(() => null);
  return { ...body, ok: false, error: body?.error || `HTTP ${response.status}`, status: response.status };
}

async function parseView(response) {
  const view = await parseJson(response);
  if (!response.ok) return view;
  const revision = response.headers.get('X-Callgraph-Session');
  return revision === null ? view : { ...view, sessionRevision: Number(revision) };
}

const post = (url, body, { parse = parseJson, timeout, signal } = {}) =>
  request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Callgraph-Client': clientId,
      ...((body.projectId ?? state.view?.projectId) == null ? {} :
        { 'X-Callgraph-Project': String(body.projectId ?? state.view.projectId) }),
      ...(body.sessionRevision == null ? {} : { 'X-Callgraph-Session': String(body.sessionRevision) }) },
    body: JSON.stringify(body),
    signal,
  }, parse, timeout);

/**
 * 回看模式下拦掉写操作。
 * 历史状态是重放出来的，如果这时还把改动写进当前库，用户会以为改的是过去，
 * 实际上改的是现在——所以干脆不允许，让他先点「回到最新」。
 */
const WRITE_OPS = new Set(['overlay', 'del', 'layout', 'orphans', 'bookmarks', 'session', 'labels', 'viewEvent', 'manualNodes']);
const guardWrite = (name) => {
  if (state.view?.comparison && WRITE_OPS.has(name)) return Promise.resolve({ ok: false, error: '比较视图仅供查看' });
  if (state.at > 0 && WRITE_OPS.has(name)) {
    document.dispatchEvent(new CustomEvent('cg:review-blocked'));
    return Promise.resolve({ ok: false, error: 'review-mode' });
  }
  return null;
};

export const api = {
  /** 取子图：root 为空时由服务端挑选入口函数；at>0 时渲染历史某一刻的状态 */
  view({ root, roots, up = 1, down = 1, group = true, groupMode = group ? 'file' : 'flat', vars, hiddenVars, expansions = [], at = 0, previous = null,
    preview = false, empty = false, useSnapshot = false, signal }) {
    const q = new URLSearchParams({ down, up, group: groupMode === 'flat' ? '0' : '1', groupMode });
    if (preview) q.set('preview', '1');
    if (empty) q.set('empty', '1');
    if (useSnapshot) q.set('useSnapshot', '1');
    // 支持多入口：勾选多个函数时一起入图
    const list = (roots && roots.length ? roots : root ? [root] : []).filter(Boolean);
    if (list.length === 1) q.set('root', list[0]);
    else if (list.length > 1) q.set('roots', list.join(','));
    if (vars && vars.length) q.set('vars', vars.join(','));
    if (hiddenVars && hiddenVars.length) q.set('novars', hiddenVars.join(','));
    if (at > 0) q.set('at', String(at));
    const hasComma = [...(list.length > 1 ? list : []), ...(vars || []), ...(hiddenVars || [])]
      .some((id) => id.includes(','));
    if (!previous && !expansions.length && !hasComma && q.toString().length <= 6000) {
      return get('/api/view?' + q, { parse: parseView, timeout: ANALYSIS_TIMEOUT, signal });
    }
    for (const key of ['root', 'roots', 'vars', 'novars']) q.delete(key);
    // 只带本次画面的几何信息，不把标注缓存等绘制数据发回服务端。
    return post('/api/view?' + q, { projectId: previous?.projectId ?? state.view?.projectId,
      ...(empty ? { empty: true } : {}), ...(useSnapshot ? { useSnapshot: true } : {}),
      roots: list, vars: vars || [], hiddenVars: hiddenVars || [], expansions, previous: previous ? {
      projectId: previous.projectId, comparisonId: previous.comparison?.id, width: previous.width, height: previous.height, layoutDirection: previous.layoutDirection, groupMode: previous.groupMode,
      nodes: previous.nodes.map(({ id, file, group, x, y, w, h }) => ({ id, file, group, x, y, w, h })),
      edges: previous.edges.map(({ from, to, kind, line, change, points, custom, fromSide, toSide }) =>
        ({ from, to, kind, line, change, points, custom, fromSide, toSide })),
      groups: previous.groups || [], containers: previous.containers || [],
      layoutSlots: previous.layoutSlots,
    } : null }, { parse: parseView, timeout: ANALYSIS_TIMEOUT, signal });
  },
  stats: () => get('/api/stats?summary=1'),
  parsers: () => get('/api/parsers').then(result => result?.ok === false ? null : result).catch(() => null),
  setParser: parserId => post('/api/parsers', { parserId }, { timeout: ANALYSIS_TIMEOUT }),
  buildConfigs: () => get('/api/build-configs').then(result => result?.ok === false ? null : result).catch(() => null),
  saveBuildConfig: (body) => post('/api/build-configs', body, { timeout: ANALYSIS_TIMEOUT }),
  /** 当前工程身份（名字、路径、指纹是否变过） */
  project: () => get('/api/project'),
  /** 最近打开的工程列表 */
  projects: () => get('/api/projects'),
  renameProject: (id, name) => post('/api/projects/rename', { id, name }),
  removeProject: (id) => post('/api/projects/remove', { id }),
  /** 切换工程：传 id 或绝对路径，服务端重新解析并整体替换会话状态 */
  switchProject: (body) => post('/api/switch', body, { timeout: ANALYSIS_TIMEOUT }),
  gitStatus: () => get('/api/git/status'),
  compare: (body) => post('/api/compare', body, { timeout: ANALYSIS_TIMEOUT }),
  applyComparison: (body) => post('/api/compare/apply', body, { timeout: ANALYSIS_TIMEOUT }),
  comparisonStatus: (body) => post('/api/compare/status', body),
  cancelComparison: (previewId) => post('/api/compare/cancel', { previewId }),
  exitComparison: () => post('/api/compare/exit', {}),
  /** 时间轴事件列表：分页 + 过滤，只回 brief 不回完整载荷 */
  events: ({ limit = 50, before = 0, ops = [], q = '', level = '', bookmarkId = null } = {}) => {
    const p = new URLSearchParams({ limit: String(limit) });
    if (before) p.set('before', String(before));
    if (ops && ops.length) p.set('ops', ops.join(','));
    if (q) p.set('q', q);
    if (level) p.set('level', level);
    if (bookmarkId !== null && bookmarkId !== undefined && bookmarkId !== '') p.set('bookmarkId', String(bookmarkId));
    return get('/api/events?' + p);
  },
  /** 恢复到历史某一刻（会追加一条 restore_point 事件） */
  restore: (eventId) => post('/api/restore', { eventId }),
  recordViewEvent: (body) => guardWrite('viewEvent') || post('/api/view-event', body),
  saveCheckpoint: (checkpointName, view, ctx = {}) =>
    guardWrite('viewEvent') ||
    post('/api/view-event', {
      op: 'view.checkpoint',
      projectId: state.view?.projectId,
      label: checkpointName,
      view,
      ctx: { ...ctx, checkpointName, milestone: 1 },
    }),
  /** 失效标注：库里指向已不存在的函数 / 连线的条目 */
  orphans: () => get('/api/orphans'),
  purgeOrphans: () => guardWrite('orphans') || post('/api/orphans/purge', {}),
  /** 书签：保存的视图（入口集合 + 深度 + 模式） */
  bookmarks: () => get('/api/bookmarks'),
  saveBookmark: (body) => guardWrite('bookmarks') || post('/api/bookmarks', body),
  updateBookmark: (body) => guardWrite('bookmarks') || post('/api/bookmarks/update', body),
  renameBookmark: (id, name) => guardWrite('bookmarks') || post('/api/bookmarks/rename', { id, name }),
  deleteBookmark: (id) => guardWrite('bookmarks') || post('/api/bookmarks/delete', { id }),
  /** 导入 .cgx 会话（导出走浏览器直接下载，不需要接口封装） */
  importSession: (body) => guardWrite('session') || post('/api/session/import', body),
  /** 全工程全局变量 / 常量清单 */
  vars: () => get('/api/vars', { timeout: ANALYSIS_TIMEOUT }),
  tree: () => get('/api/tree'),
  search: (q) => get('/api/search?q=' + encodeURIComponent(q)),
  node: (id) => get('/api/node?id=' + encodeURIComponent(id)),
  flowchart(id, { version, expandMacros, projectId, comparisonId, signal }) {
    const query = new URLSearchParams({ id, version, expandMacros: expandMacros ? '1' : '0',
      projectId, comparisonId: comparisonId ?? '' });
    return get('/api/flowchart?' + query, { timeout: ANALYSIS_TIMEOUT, signal });
  },
  /** 节点 / 连线的标注与变更分类 */
  overlay: (body) => guardWrite('overlay') || post('/api/overlay', body),
  /** 删除 / 恢复函数与连线 */
  del: (body) => guardWrite('del') || post('/api/delete', body),
  /** 手动布局存档 */
  layout(body) {
    const blocked = guardWrite('layout');
    if (blocked) return blocked;
    const patch = { ...body, projectId: body.projectId ?? state.view?.projectId,
      sessionRevision: body.sessionRevision ?? state.view?.sessionRevision };
    // 连续撤销与重做的手工关系增量必须按触发顺序落库。
    const write = layoutWrites.then(() => post('/api/layout', patch));
    layoutWrites = write.catch(() => {});
    return write;
  },
  /** 手工添加 / 永久删除文件内的函数或变量（即使源码中不存在） */
  addManualNode: (body) => guardWrite('manualNodes') || post('/api/manual-nodes', body),
  deleteManualNode: (body) => guardWrite('manualNodes') || post('/api/manual-nodes/delete', body),
  /** 按需数据流分析：out=它的写影响谁，in=谁的状态影响它 */
  dataflow: (fn, dir = 'out') =>
    get('/api/dataflow?fn=' + encodeURIComponent(fn) + '&dir=' + encodeURIComponent(dir), { timeout: ANALYSIS_TIMEOUT }),
  pairDataflow: (a, b, { signal } = {}) => post('/api/dataflow/pair', {
    a,
    b,
    projectId: state.view?.projectId,
    comparisonId: state.view?.comparison?.id,
    sessionRevision: state.view?.sessionRevision,
  }, { timeout: ANALYSIS_TIMEOUT, signal }),
  /** AI 访问（MCP）权限：level ∈ off / readonly / readwrite */
  mcpConfig: () => get('/api/mcp-config'),
  setMcpConfig: (level) => post('/api/mcp-config', { level }),
  /** 内置直连 OpenAI 兼容模型配置、拉取模型、连通性测试、按工程隔离的对话管理与对话 */
  aiConfig: () => get('/api/ai/config'),
  saveAiConfig: (body) => post('/api/ai/config', body),
  aiChats: () => Promise.resolve(chatWrites.get(state.view?.projectId)).catch(() => {}).then(() => get('/api/ai/chats')),
  saveAiChats(body) {
    const id = body.projectId;
    const snapshot = structuredClone(body);
    const write = Promise.resolve(chatWrites.get(id)).catch(() => {}).then(async () => {
      const result = await post('/api/ai/chats', snapshot);
      if (!result?.ok) throw new Error(result?.error || '保存对话失败');
      return result;
    }).finally(() => {
      if (chatWrites.get(id) === write) chatWrites.delete(id);
    });
    chatWrites.set(id, write);
    return write;
  },
  compactChat: (body, signal) => post('/api/ai/compact', body, { timeout: MODEL_TIMEOUT, signal }),
  aiTurnChangeset: (turnId, projectId) => get('/api/ai/changeset?' + new URLSearchParams({ turnId, projectId })),
  aiUndoChangeset: (changesetId, language) => post('/api/ai/undo-changeset', { changesetId, language }),
  aiModels: (body, signal) => post('/api/ai/models', body, { timeout: MODEL_TIMEOUT, signal }),
  aiTest: (body) => post('/api/ai/test', body, { timeout: MODEL_TIMEOUT }),
  aiChat: (body, signal) =>
    fetch('/api/ai/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Callgraph-Client': clientId,
        ...(state.view?.projectId == null ? {} : { 'X-Callgraph-Project': String(state.view.projectId) }),
      },
      body: JSON.stringify(body),
      signal,
    }),
  /** 上报并保存当前页面状态，AI 经 cg_page 工具读取；退出时等待保存结果。 */
  reportPage: (body) => post('/api/page', body),
  savedPage: () => get('/api/page?saved=1'),
  /** 结合点编号模式：fixed=固定（新增挑空缺号）/ renumber=重排（删除后自动紧凑） */
  labelConfig: () => get('/api/labels/config'),
  setLabelConfig: (mode) => guardWrite('labels') || post('/api/labels/config', { mode }),
  /** 界面偏好：范围下拉的向下/向上层数（全局记忆，跨重启生效） */
  uiPrefs: () => get('/api/ui-prefs'),
  setUiPrefs: (body) => post('/api/ui-prefs', body),
  /** 结合点重排：把算好的新编号整体写回 */
  renumberConns: (items) => guardWrite('labels') || post('/api/labels/renumber', { items }),
  /** 自动检测 task/コール順 候选（服务端扫源码，返回建议清单，应用走 overlay） */
  detectTasks: (from) => get('/api/detect-tasks' + (from ? '?from=' + encodeURIComponent(from) : ''), { timeout: ANALYSIS_TIMEOUT }),
};
