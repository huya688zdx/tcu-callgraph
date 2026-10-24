/**
 * 全局状态与常量：画布 DOM 引用、视图状态、配色、小工具函数
 * 所有模块共享同一个 state / cam 对象（引用可变，不做整体替换）
 */
const els = {
  cv: document.getElementById('cv'),
  ctx: document.getElementById('cv').getContext('2d'),
  search: document.getElementById('search'),
  depth: document.getElementById('depth'),
  updepth: document.getElementById('updepth'),
  fit: document.getElementById('fit'),
  resetLayout: document.getElementById('resetLayout'),
  groupMode: document.getElementById('groupMode'),
  stats: document.getElementById('stats'),
  results: document.getElementById('results'),
  detail: document.getElementById('detail'),
  edges: document.getElementById('edges'),
  rootName: document.getElementById('rootName'),
  tooltip: document.getElementById('tooltip'),
  restoreDeleted: document.getElementById('restoreDeleted'),
  ctxMenu: document.getElementById('ctxMenu'),
  vars: document.getElementById('vars'),
  secDetail: document.getElementById('secDetail'),
  secEdges: document.getElementById('secEdges'),
  secVars: document.getElementById('secVars'),
  secLabel: document.getElementById('secLabel'),
  labelPanel: document.getElementById('labelPanel'),
};

const state = {
  view: null,
  /** 当前入口函数（多选时是第一个） */
  root: null,
  /** 当前所有入口函数（文件树多选时会有多个） */
  roots: [],
  /** 当前点选的框：{ kind:'file'|'dir', id } —— 右侧变量面板按它过滤 */
  ctxBox: null,
  /** 手动勾选要显示在图里的全局变量 id */
  vars: new Set(),
  /** 手动取消勾选（即使视图里有函数引用它也不显示） */
  hiddenVars: new Set(),
  /** 时间轴回看：0 表示看当前状态，>0 表示看这个事件之后的历史状态 */
  at: 0,
  selected: null,
  hover: null,
  down: 3,
  up: 0,
  group: true,
  selectedEdge: null,
  /** 选中的连线标签（存连线 key，与 selectedEdge 并存：标签属于连线） */
  selectedLabel: null,
  dragSeg: null,
  dragEnd: null,
  dragNode: null,
  dragLabel: null,
  dragStart: null,
  dragMoved: false,
  panning: false,
  /** 本次拖拽是否已经产生位移（用于区分「点击」和「拖动」） */
  panMoved: false,
  /** 平移时上一次 pointer 的客户端坐标 { x, y }（clientX/clientY） */
  last: null,
  linkFrom: null,
  linkPos: null,
  /** 点击标题后的短暂高亮：{ box, until, dur } */
  flash: null,
};

const cam = { x: 0, y: 0, k: 1 };

/** 最近的删除记录栈，Ctrl+Z 可以逐次恢复 */
const deleteStack = [];

const COLORS = {
  direct: '#9A9890',
  macro: '#D85A30',
  fnptr: '#7F77DD',
  manual: '#639922',
  unknown: '#C9C7BE',
};

/** 函数框背景色：既存 / 変更 / 追加 / 削除 */
const CHANGE_FILL = {
  existing: '#CCFFCC',
  modified: '#FFFF99',
  added: '#FFCCFF',
  deleted: '#BFBFBF',
};

/** 连线颜色：原有黑、新增红（删除沿用原色，另加 X 标记） */
const EDGE_COLOR = {
  existing: '#2C2C2A',
  added: '#D9303E',
  deleted: '#2C2C2A',
};

const FONT = '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';

const shortFile = (f) => {
  if (!f) return '';
  const parts = String(f).split(/[\\/]/);
  return parts.slice(-2).join('/');
};

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const nodeById = (id) => (state.view ? state.view.nodes.find((n) => n.id === id) : null);

const edgeKey = (e) => `${e.from}->${e.to}:${e.line}`;
export {
  els,
  state,
  cam,
  deleteStack,
  COLORS,
  CHANGE_FILL,
  EDGE_COLOR,
  FONT,
  shortFile,
  esc,
  nodeById,
  edgeKey,
};
