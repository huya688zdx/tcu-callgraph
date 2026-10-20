/**
 * 极简 i18n
 * 现阶段只启用 zh-CN，en 字典留空位便于后续补
 */

const dict = {
  'zh-CN': {
    'app.title': 'TCU 调用关系图',
    'search.placeholder': '搜索函数名，回车定位…',
    'depth.down1': '向下 1 层',
    'depth.down2': '向下 2 层',
    'depth.down3': '向下 3 层',
    'depth.down5': '向下 5 层',
    'depth.downAll': '向下全部',
    'depth.up0': '向上 0 层',
    'depth.up1': '向上 1 层',
    'depth.up2': '向上 2 层',
    'btn.fit': '适应',
    'btn.group': '文件分组',
    'btn.optimal': '最优布局',
    'btn.manualLayout': '手动布局',
    'btn.svg': '导出 SVG',
    'btn.png': 'PNG',
    'btn.html': 'HTML',
    'btn.xlsx': 'Excel',
    'btn.reset': '重置布局',
    'hint.zoom': '滚轮缩放 · 拖拽平移 · 双击下钻 · 拖节点自动重布线 · 选中连线拖线段调整走向 · 双击连线恢复自动',
    'panel.overview': '工程概览',
    'panel.results': '搜索结果',
    'panel.legend': '图例',
    'panel.detail': '节点详情',
    'panel.edges': '调用关系',
    'legend.call': '函数调用',
    'legend.var': '变量访问',
    'legend.added': '新增',
    'legend.deleted': '删除',
    'node.variable': '变量',
    'menu.change': '模块变更分类',
    'menu.dataflow': '数据流分析',
    'df.out': '数据流影响 → 谁读它写的变量',
    'df.in': '数据流来源 ← 谁写了它读的变量',
    'df.clear': '清除数据流叠加',
    'legend.dfWrite': '写入共享变量',
    'legend.dfRead': '读取共享变量',
    'menu.edge': '连线状态',
    'menu.dataflowOn': '显示数据流',
    'menu.dataflowOff': '隐藏数据流',
    'change.existing': '既存模块（无变更）',
    'change.modified': '变更模块',
    'change.added': '追加模块',
    'change.deleted': '删除模块',
    'edgeState.existing': '原有',
    'edgeState.added': '新增',
    'edgeState.deleted': '删除',
    'legend.dataflow': '数据流',
    'stat.files': '文件',
    'stat.functions': '函数',
    'stat.variables': '变量',
    'stat.edges': '调用边',
    'stat.calls': '调用记录',
    'btn.restoreDeleted': '恢复删除',
    'stat.macros': '宏定义',
    'stat.macroEdges': '经宏的边',
    'stat.fnptrEdges': '函数指针边',
    'stat.cycles': '调用环',
    'stat.maxFanOut': '最大扇出',
    'empty.search': '输入函数名开始搜索',
    'empty.noMatch': '没有匹配',
    'empty.detail': '点击图中节点查看详情',
    'empty.edges': '—',
    'empty.noEdges': '无调用关系',
    'detail.note': '备注 / 标注',
    'detail.notePlaceholder': '换挡策略入口，需在 ISR 中避免调用',
    'detail.color': '标记颜色',
    'detail.tag': '标签',
    'detail.tagPlaceholder': '如 ASIL-B / 10ms 周期',
    'detail.save': '保存标注',
    'detail.saved': '已保存',
    'edge.calledBy': '被调用',
    'edge.calls': '调用',
    'node.external': '外部符号',
    'node.static': 'static',
    'node.externalTag': '外部',
  },
  en: {},
};

let lang = 'zh-CN';

export function setLang(l) {
  if (dict[l]) lang = l;
}

export function getLang() {
  return lang;
}

export function t(key, vars) {
  let s = dict[lang]?.[key] ?? dict['zh-CN'][key] ?? key;
  if (vars) {
    for (const k of Object.keys(vars)) s = s.split(`{${k}}`).join(vars[k]);
  }
  return s;
}

export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  if (root === document) document.documentElement.lang = lang;
}
