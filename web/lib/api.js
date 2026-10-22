/**
 * 后端接口封装：所有 HTTP 调用集中在这里，便于统一处理错误与取消
 */
import { state } from './state.js';

const get = (url) => fetch(url).then((r) => r.json());

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

/**
 * 回看模式下拦掉写操作。
 * 历史状态是重放出来的，如果这时还把改动写进当前库，用户会以为改的是过去，
 * 实际上改的是现在——所以干脆不允许，让他先点「回到最新」。
 */
const WRITE_OPS = new Set(['overlay', 'del', 'layout', 'orphans']);
const guardWrite = (name) => {
  if (state.at > 0 && WRITE_OPS.has(name)) {
    document.dispatchEvent(new CustomEvent('cg:review-blocked'));
    return Promise.resolve({ ok: false, error: 'review-mode' });
  }
  return null;
};

export const api = {
  /** 取子图：root 为空时由服务端挑选入口函数；at>0 时渲染历史某一刻的状态 */
  view({ root, roots, up = 0, down = 3, group = true, optimal = false, vars, hiddenVars, fixed = false, at = 0 }) {
    const q = new URLSearchParams({ down, up, group: group ? '1' : '0' });
    // 支持多入口：勾选多个函数时一起入图
    const list = (roots && roots.length ? roots : root ? [root] : []).filter(Boolean);
    if (list.length === 1) q.set('root', list[0]);
    else if (list.length > 1) q.set('roots', list.join(','));
    if (optimal) q.set('optimal', '1');
    if (fixed) q.set('fixed', '1');
    if (vars && vars.length) q.set('vars', vars.join(','));
    if (hiddenVars && hiddenVars.length) q.set('novars', hiddenVars.join(','));
    if (at > 0) q.set('at', String(at));
    return get('/api/view?' + q);
  },
  stats: () => get('/api/stats'),
  /** 当前工程身份（名字、路径、指纹是否变过） */
  project: () => get('/api/project'),
  /** 最近打开的工程列表 */
  projects: () => get('/api/projects'),
  /** 切换工程：传 id 或绝对路径，服务端重新解析并整体替换会话状态 */
  switchProject: (body) => post('/api/switch', body),
  /** 时间轴事件列表（倒序） */
  events: (limit = 200) => get('/api/events?limit=' + limit),
  /** 恢复到历史某一刻（会追加一条 restore_point 事件） */
  restore: (eventId) => post('/api/restore', { eventId }),
  /** 失效标注：库里指向已不存在的函数 / 连线的条目 */
  orphans: () => get('/api/orphans'),
  purgeOrphans: () => guardWrite('orphans') || post('/api/orphans/purge', {}),
  /** 全工程全局变量 / 常量清单 */
  vars: () => get('/api/vars'),
  tree: () => get('/api/tree'),
  search: (q) => get('/api/search?q=' + encodeURIComponent(q)),
  node: (id) => get('/api/node?id=' + encodeURIComponent(id)),
  /** 节点 / 连线的标注与变更分类 */
  overlay: (body) => guardWrite('overlay') || post('/api/overlay', body),
  /** 删除 / 恢复函数与连线 */
  del: (body) => guardWrite('del') || post('/api/delete', body),
  /** 手动布局存档 */
  layout: (body) => guardWrite('layout') || post('/api/layout', body),
  /** 按需数据流分析：out=它的写影响谁，in=谁的状态影响它 */
  dataflow: (fn, dir = 'out') =>
    get('/api/dataflow?fn=' + encodeURIComponent(fn) + '&dir=' + encodeURIComponent(dir)),
};
