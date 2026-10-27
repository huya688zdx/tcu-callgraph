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
  resetLayout: document.getElementById('resetLayout'),
  groupMode: document.getElementById('groupMode'),
  stats: document.getElementById('stats'),
  results: document.getElementById('results'),
  detail: document.getElementById('detail'),
  edges: document.getElementById('edges'),
  rootName: document.getElementById('rootName'),
  tooltip: document.getElementById('tooltip'),
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
  /** Ctrl+A 选择同类型、同样式的组件，保存匹配的节点 / 连线 / 标签集合。 */
  multiSelection: null,
  /** 双击后才允许移动节点、层级或调整连线；普通单击不解锁。 */
  moveTarget: null,
  dragSeg: null,
  dragEnd: null,
  dragNode: null,
  dragBox: null,
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
  /** 本次新加入的节点和连线，呼吸提示到期后自动清除。 */
  recent: null,
};

const cam = { x: 0, y: 0, k: 1 };

/** 最近的删除记录栈，Ctrl+Z 可以逐次恢复 */
const deleteStack = [];

/**
 * 主题色：样式设置面板（appearance.js）直接改这里的值，改完 draw() 即生效。
 * 画布 render.js、图例、SVG 导出、离线导出全部读这一份，保证所见即所得。
 * 新增可调颜色时：这里加默认值 + appearance.js 的 SECTIONS 加一行。
 */
export const THEME = {
  /** 画布背景（body 背景 + 导出底色） */
  bg: '#F7F6F2',
  edge: {
    call: '#2C2C2A', // 函数调用
    var: '#2C2C2A', // 变量访问
    added: '#D9303E', // 新增边
    manual: '#639922', // 手动连线预览
    callDash: false, // 函数调用虚线（默认实线）
    varDash: true, // 变量访问虚线（默认虚线）
    selPulse: true, // 选中线柔光呼吸（样式面板可关）
  },
  node: {
    border: '#3A3A36', // 函数框描边
    varBorder: '#3A3A36', // 变量框描边
    externalBorder: '#D3D1C7', // 外部符号描边
    external: '#FAFAF7', // 外部符号底色
    selected: '#185FA5', // 选中高亮
    hover: '#378ADD', // 悬停高亮
    fnDash: true, // 函数框虚线（关 = 实线）
    varDash: false, // 变量框虚线（开 = 虚线）
  },
  /** 变更分类底色：既存 / 变更 / 追加 / 删除（画布右键分类菜单与图例同源） */
  fill: {
    existing: '#CCFFCC',
    modified: '#FFFF99',
    added: '#FFCCFF',
    deleted: '#BFBFBF',
  },
  /** 分组容器 / 手动分组框的底色与描边（画布按深度加透明度） */
  container: {
    fill: '#E6F1FB',
    stroke: '#6BA3E0',
  },
};

const isHexColor = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/** #RRGGBB → rgba(r,g,b,a)（容器按深度叠透明度用） */
export function hexToRgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** THEME 里的图例小色块与页面背景，改主题后同步一次 */
function syncThemeSideEffects() {
  document.body.style.background = THEME.bg;
  const chip = (id, c) => {
    const el = document.getElementById(id);
    if (el) el.style.borderTopColor = c;
  };
  chip('lg-call', THEME.edge.call);
  chip('lg-var', THEME.edge.var);
  chip('lg-added', THEME.edge.added);
  // 删除边沿用调用色、中央带 X：图例里画的是 SVG，所以走 color 而不是 border
  const delChip = document.getElementById('lg-del');
  if (delChip) delChip.style.color = THEME.edge.call;
}

/** 设置单个颜色（'fill.existing' 这类路径）。非法值拒绝，返回是否成功 */
export function setThemeColor(path, value) {
  if (!isHexColor(value)) return false;
  const keys = path.split('.');
  let obj = THEME;
  for (let i = 0; i < keys.length - 1; i++) {
    obj = obj[keys[i]];
    if (!obj || typeof obj !== 'object') return false;
  }
  const last = keys[keys.length - 1];
  if (typeof obj[last] !== 'string') return false;
  obj[last] = value.toLowerCase();
  syncThemeSideEffects();
  return true;
}

/** 设置布尔型主题项（框/线的虚实开关）。类型不符拒绝，返回是否成功 */
export function setThemeFlag(path, value) {
  const keys = path.split('.');
  let obj = THEME;
  for (let i = 0; i < keys.length - 1; i++) {
    obj = obj[keys[i]];
    if (!obj || typeof obj !== 'object') return false;
  }
  const last = keys[keys.length - 1];
  if (typeof obj[last] !== 'boolean' || typeof value !== 'boolean') return false;
  obj[last] = value;
  return true;
}

/** 批量应用（启动恢复 / 离线快照）：颜色与布尔开关各走各的校验，缺项保持默认 */
export function applyTheme(saved = {}, prefix = '') {
  for (const [key, value] of Object.entries(saved || {})) {
    const path = prefix + key;
    if (value && typeof value === 'object') applyTheme(value, path + '.');
    else if (typeof value === 'boolean') setThemeFlag(path, value);
    else setThemeColor(path, value);
  }
}

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
  FONT,
  shortFile,
  esc,
  nodeById,
  edgeKey,
};
