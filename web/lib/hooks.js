/**
 * 跨模块回调钩子
 * 用来打断「面板/交互 → 入口」的循环依赖：入口模块启动时把实现填进来
 */
export const hooks = {
  /** 以某个函数为入口重新加载视图（支持传入多个 id） */
  loadView: () => {},
  /** 保留当前画布，加入指定函数的单向调用关系。 */
  expandFunction: async () => {},
  /** 刷新右侧节点详情 */
  renderDetail: () => {},
  /** 勾选 / 取消勾选一个全局变量 */
  toggleVar: () => {},
  /** 换工程后整体重载（统计 / 文件树 / 变量 / 视图） */
  reloadAll: async () => {},
  /** 在原图中加入明确选中的比较结果。 */
  applyComparison: async () => {},
  restoreComparison: async () => {},
  syncComparison: () => {},
  /** 应用一个书签：恢复入口集合、深度、模式并重新加载视图 */
  applyBookmark: async () => {},
};
