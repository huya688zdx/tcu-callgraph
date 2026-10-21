/**
 * 后端接口封装：所有 HTTP 调用集中在这里，便于统一处理错误与取消
 */
const get = (url) => fetch(url).then((r) => r.json());

const post = (url, body) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json());

export const api = {
  /** 取子图：root 为空时由服务端挑选入口函数 */
  view({ root, roots, up = 0, down = 3, group = true, optimal = false, vars, hiddenVars, fixed = false }) {
    const q = new URLSearchParams({ down, up, group: group ? '1' : '0' });
    // 支持多入口：勾选多个函数时一起入图
    const list = (roots && roots.length ? roots : root ? [root] : []).filter(Boolean);
    if (list.length === 1) q.set('root', list[0]);
    else if (list.length > 1) q.set('roots', list.join(','));
    if (optimal) q.set('optimal', '1');
    if (fixed) q.set('fixed', '1');
    if (vars && vars.length) q.set('vars', vars.join(','));
    if (hiddenVars && hiddenVars.length) q.set('novars', hiddenVars.join(','));
    return get('/api/view?' + q);
  },
  stats: () => get('/api/stats'),
  /** 全工程全局变量 / 常量清单 */
  vars: () => get('/api/vars'),
  tree: () => get('/api/tree'),
  search: (q) => get('/api/search?q=' + encodeURIComponent(q)),
  node: (id) => get('/api/node?id=' + encodeURIComponent(id)),
  /** 节点 / 连线的标注与变更分类 */
  overlay: (body) => post('/api/overlay', body),
  /** 删除 / 恢复函数与连线 */
  del: (body) => post('/api/delete', body),
  /** 手动布局存档 */
  layout: (body) => post('/api/layout', body),
  /** 按需数据流分析：out=它的写影响谁，in=谁的状态影响它 */
  dataflow: (fn, dir = 'out') =>
    get('/api/dataflow?fn=' + encodeURIComponent(fn) + '&dir=' + encodeURIComponent(dir)),
};
