/**
 * 本地持久化层：单个 SQLite 库，按工程隔离。
 *
 * 为什么不是 JSON 文件：
 * - 一个 overlay.json 装不下多个工程，节点 id 又是「文件::函数」，换个工程同名文件就串味；
 * - 时间轴需要按 (project, ts) 翻页查询，JSON 每次都得全量解析。
 *
 * 为什么用 node:sqlite 而不是 better-sqlite3：
 * 内置模块零依赖，不需要按 Electron ABI 重编译原生模块。
 *
 * 数据分层原则（见 docs/superpowers/specs/2026-10-22-persistence-design.md）：
 * 只存「输入」——标注、删除、手工布局、视图参数、操作事件；
 * 不存「派生」——自动布局坐标、路由折线、文件框几何都由这些输入算出来。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { serialize, deserialize } from 'node:v8';
import { DatabaseSync } from 'node:sqlite';
import { normalizeExpansions } from './expansion.js';

const SCHEMA_VERSION = 4;

/**
 * v2 新增的表：书签。
 * 单独抽成常量，SCHEMA（新库全量建）和 migrate 的 v1→v2 分支（老库补差量）
 * 都引用同一份 DDL——两处各写一遍，改表时漏掉一边就会出现
 * 「新库能用、老库报 no such table」，这类错只有老用户会踩到。
 */
const BOOKMARK_DDL = `
CREATE TABLE IF NOT EXISTS bookmark (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  roots      TEXT NOT NULL DEFAULT '[]',
  up         INTEGER NOT NULL DEFAULT 1,
  down       INTEGER NOT NULL DEFAULT 1,
  grouped    INTEGER NOT NULL DEFAULT 1,
  vars       TEXT NOT NULL DEFAULT '[]',
  expansions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, name)
);
CREATE INDEX IF NOT EXISTS bookmark_by_project ON bookmark(project_id, updated_at DESC);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  path        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  fingerprint TEXT,
  git_remote  TEXT,
  git_commit  TEXT,
  created_at  INTEGER NOT NULL,
  opened_at   INTEGER NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  note        TEXT,
  cover       TEXT
);

CREATE TABLE IF NOT EXISTS annotation (
  project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  data        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (project_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS deleted (
  project_id  INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  PRIMARY KEY (project_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS layout (
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  view_key   TEXT NOT NULL,
  mode       TEXT NOT NULL,
  nodes      TEXT NOT NULL DEFAULT '{}',
  edges      TEXT NOT NULL DEFAULT '{}',
  manual     TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, view_key, mode)
);

CREATE TABLE IF NOT EXISTS view_state (
  project_id INTEGER PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  roots      TEXT,
  up         INTEGER,
  down       INTEGER,
  grouped    INTEGER,
  zoom       REAL,
  pan_x      REAL,
  pan_y      REAL,
  selected   TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS event (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  actor      TEXT NOT NULL DEFAULT 'user',
  op         TEXT NOT NULL,
  target     TEXT,
  before     TEXT,
  after      TEXT,
  ctx        TEXT
);
CREATE INDEX IF NOT EXISTS event_by_project ON event(project_id, ts, seq);
CREATE INDEX IF NOT EXISTS event_by_project_id ON event(project_id, id DESC);

CREATE TABLE IF NOT EXISTS snapshot (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  label      TEXT,
  kind       TEXT NOT NULL DEFAULT 'auto',
  event_id   INTEGER,
  state      BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS parse_cache (
  fingerprint TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  stats       TEXT,
  model       BLOB
);

${BOOKMARK_DDL}

CREATE TABLE IF NOT EXISTS setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const nowMs = () => Date.now();

/** 空 overlay：与旧 out/overlay.json 结构保持一致，前端和 buildView 都不用改 */
export const emptyOverlay = () => ({
  nodes: {},
  edges: {},
  notes: [],
  deleted: { nodes: {}, edges: {} },
  layout: {},
});

/**
 * 默认数据目录：跟 Electron 的 app.getPath('userData') 对齐。
 * 两边必须指向同一个地方，否则 `npm run serve` 和 `npm start` 会各自读写一份库，
 * 症状是「命令行里标的注，桌面版打开就没了」。
 */
function defaultDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'tcu-callgraph');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'tcu-callgraph');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'tcu-callgraph');
}

/**
 * 库文件位置，优先级：
 *   1. 显式传参 / CALLGRAPH_DB
 *   2. Electron 主进程注入的 userData 目录（CALLGRAPH_USER_DATA）
 *   3. 平台默认数据目录（与 Electron userData 同一位置）
 */
export function resolveDbPath({ explicit, userData } = {}) {
  if (explicit) return path.resolve(explicit);
  if (process.env.CALLGRAPH_DB) return path.resolve(process.env.CALLGRAPH_DB);
  const dir = userData || process.env.CALLGRAPH_USER_DATA;
  if (dir) return path.join(path.resolve(dir), 'callgraph.db');
  return path.join(defaultDataDir(), 'callgraph.db');
}

/**
 * 工程内容指纹：文件清单 + 字节数的 hash。
 * 不用 mtime 是因为它会被 git checkout / 复制目录整体刷新，误报太多；
 * 不读文件内容是因为大工程每次启动全量读一遍代价太高。
 * 纯注释改动不会改变指纹——那种改动本来也不改变调用图。
 */
export function fingerprintFiles(files = []) {
  const h = createHash('sha1');
  const list = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const f of list) {
    h.update(`${f.rel}\u0000${f.bytes}\u0000${f.isHeader ? 1 : 0}\n`);
  }
  return h.digest('hex');
}

/**
 * 解析缓存的 key。
 * 和工程指纹分开：这里必须带上 mtime，否则「大小没变的改写」会命中旧缓存，
 * 图就永远停在改动前。工程指纹不带 mtime，是为了避免 git checkout 之类的
 * 时间戳抖动让界面上一直挂个「代码已变更」的星号。
 */
export function cacheKey(files = [], focus = '') {
  const h = createHash('sha1');
  h.update('analyzed-model-v3-headers\0');
  const list = [...files].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const f of list) {
    h.update(`${f.rel}\u0000${f.bytes}\u0000${f.mtimeMs ?? 0}\u0000${f.isHeader ? 1 : 0}\n`);
  }
  if (focus) h.update(`focus\u0000${focus}\n`);
  return h.digest('hex');
}

const parse = (s, fallback) => {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
};

const str = (s) => JSON.stringify(s ?? null);

const toBookmark = (r) => ({
  id: r.id,
  name: r.name,
  roots: parse(r.roots, []),
  up: r.up,
  down: r.down,
  group: !!r.grouped,
  vars: parse(r.vars, []),
  expansions: parse(r.expansions, []),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const toEvent = (r) => ({
  id: r.id,
  ts: r.ts,
  seq: r.seq,
  actor: r.actor,
  op: r.op,
  target: r.target,
  before: parse(r.before, null),
  after: parse(r.after, null),
  ctx: parse(r.ctx, null),
});

const cnt = (v) => (Array.isArray(v) ? v.length : v && typeof v === 'object' ? Object.keys(v).length : 0);

/**
 * 时间轴一行的轻量摘要。
 * 前端拿它渲染「main.c::main → 追加 · 备注「…」」这种文案，
 * 不需要完整的 before/after——那才是列表卡顿的来源。
 */
function briefOf(e) {
  const a = e.after || {};
  const brief = {};
  // 会话导入的 after 是整份 overlay（回放要用），直接数节点会得出
  // 「导入后一共有多少个节点」，那不是用户想看的；改用随事件带的 summary
  if (e.op === 'session.import') {
    const s = a.summary || {};
    brief.import = {
      annotations: Number(s.annotations) || 0,
      layout: Number(s.layout) || 0,
      bookmarks: Number(s.bookmarks) || 0,
    };
    if (s.sameCode === false) brief.codeMismatch = 1;
    return brief;
  }
  if (a.change !== undefined) brief.change = a.change;
  if (a.note !== undefined) brief.note = String(a.note).slice(0, 80);
  if (a.tag !== undefined) brief.tag = String(a.tag).slice(0, 40);
  if (a.color !== undefined) brief.color = 1;
  const n = cnt(a.nodes);
  const m = cnt(a.edges);
  if (n) brief.nodes = n;
  if (m) brief.edges = m;
  if (Array.isArray(a.manual) && a.manual.length) brief.manual = a.manual.length;
  if (a.clear) brief.clear = 1;
  if (e.op === 'orphan.purge') {
    brief.total =
      cnt(a.annotations) +
      cnt(a.deleted) +
      cnt(a.layoutSlots) +
      (a.layoutNodes || []).reduce((s, x) => s + cnt(x.ids), 0);
  }
  if (e.op === 'bookmark.save' && Array.isArray(a.roots)) brief.roots = a.roots.length;
  return brief;
}

/** 把一条事件应用到 overlay 上（时间轴回放的唯一入口，必须和写接口一一对应） */
function applyEvent(ov, e) {
  const after = e.after || {};
  switch (e.op) {
    // 携带全量状态的节点：直接整体替换
    case 'baseline':
    case 'restore_point':
    case 'import':
    // 会话导入同样是「把这一刻的整个状态钉下来」：它的 after 里带着导入后的
    // 全量 overlay，不回放的话 at=这一刻 会显示成导入前的样子，
    // restore 还会把导入进来的标注一起抹掉
    case 'session.import': {
      if (!after.nodes && !after.layout && !after.deleted) return;
      ov.nodes = { ...(after.nodes || {}) };
      ov.edges = { ...(after.edges || {}) };
      ov.deleted = {
        nodes: { ...((after.deleted || {}).nodes || {}) },
        edges: { ...((after.deleted || {}).edges || {}) },
      };
      ov.layout = { ...(after.layout || {}) };
      return;
    }
    case 'node.annotate':
    case 'edge.annotate': {
      const bucket = e.op === 'node.annotate' ? ov.nodes : ov.edges;
      const merged = { ...(bucket[e.target] || {}), ...after };
      for (const k of Object.keys(merged)) if (merged[k] === null) delete merged[k];
      if (Object.keys(merged).length) bucket[e.target] = merged;
      else delete bucket[e.target];
      return;
    }
    case 'labels.renumber': {
      // after = { edgeKey: 重排后的整组 labels }，与 edge.annotate 同一套键级合并
      for (const [k, labels] of Object.entries(after)) {
        if (!Array.isArray(labels)) continue;
        const merged = { ...(ov.edges[k] || {}), labels, label: null };
        for (const key of Object.keys(merged)) if (merged[key] === null) delete merged[key];
        if (Object.keys(merged).length) ov.edges[k] = merged;
        else delete ov.edges[k];
      }
      return;
    }
    case 'delete': {
      for (const id of after.nodes || []) ov.deleted.nodes[id] = 1;
      for (const k of after.edges || []) ov.deleted.edges[k] = 1;
      return;
    }
    case 'delete.restore': {
      for (const id of after.nodes || []) delete ov.deleted.nodes[id];
      for (const k of after.edges || []) delete ov.deleted.edges[k];
      return;
    }
    case 'delete.clear': {
      ov.deleted = { nodes: {}, edges: {} };
      return;
    }
    case 'layout.save': {
      const slot = ov.layout[e.target] || { nodes: {}, edges: {}, manual: [] };
      if (after.nodes) Object.assign(slot.nodes, after.nodes);
      if (after.edges) Object.assign(slot.edges, after.edges);
      if (after.manual) slot.manual = after.manual;
      ov.layout[e.target] = slot;
      return;
    }
    case 'layout.clear': {
      delete ov.layout[e.target];
      return;
    }
    case 'orphan.purge': {
      for (const a of after.annotations || []) {
        delete (a.kind === 'node' ? ov.nodes : ov.edges)[a.id];
      }
      for (const d of after.deleted || []) {
        delete (d.kind === 'node' ? ov.deleted.nodes : ov.deleted.edges)[d.id];
      }
      for (const s of after.layoutSlots || []) delete ov.layout[`${s.viewKey}::${s.mode}`];
      for (const n of after.layoutNodes || []) {
        const slot = ov.layout[`${n.viewKey}::${n.mode}`];
        if (slot) for (const id of n.ids) delete slot.nodes[id];
      }
      return;
    }
    default:
      // view.switch 之类的浏览事件不改变状态
      return;
  }
}

/**
 * 版本化迁移。
 * 新库直接跑全量 SCHEMA（永远是最新结构）；老库按版本号逐级补差量。
 * 每次加表都要：把 DDL 抽成常量（SCHEMA 与补差量分支共用）、补一条版本分支、
 * SCHEMA_VERSION 加一。
 *
 * 整段包在事务里：SQLite 的 DDL 是事务性的，中途失败会整体回滚，
 * user_version 不会被提前改写，下次启动还能从原版本重来。表都用
 * IF NOT EXISTS，所以就算不包事务也是幂等的，但事务能保证「要么全成、要么全无」。
 */
function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get() || {};
  const cur = Number(row.user_version ?? 0);
  if (cur >= SCHEMA_VERSION) return cur;

  db.exec('BEGIN');
  try {
    if (cur < 1) {
      db.exec(SCHEMA); // 全量建表，含最新加的表
    } else {
      // v1 → v2：书签
      if (cur < 2) db.exec(BOOKMARK_DDL);
    }
    // v2 → v3：时间轴按 id 倒序翻页的索引。
    // 原来的 (project_id, ts, seq) 对「id < ? ORDER BY id DESC」帮不上忙，
    // 多工程共用一库时会退化成扫全表。
    // 放在 else 外面：cur=0 时 SCHEMA 已建过（IF NOT EXISTS 是空操作），
    // cur=1/2 的老库靠这一句补上。
    if (cur < 3) {
      db.exec('CREATE INDEX IF NOT EXISTS event_by_project_id ON event(project_id, id DESC);');
    }
    if (cur < 4 && !db.prepare('PRAGMA table_info(bookmark)').all().some((c) => c.name === 'expansions')) {
      db.exec("ALTER TABLE bookmark ADD COLUMN expansions TEXT NOT NULL DEFAULT '[]'");
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* 回滚失败时保留原始异常 */
    }
    throw err;
  }
  return SCHEMA_VERSION;
}

export function openStore({ dbPath, userData } = {}) {
  const file = resolveDbPath({ explicit: dbPath, userData });
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  // WAL：读写不互相阻塞，进程被强杀时也不会留下半截事务
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // 默认 busy_timeout 是 0——撞上写锁立刻抛 SQLITE_BUSY 而不是等一等。
  // Electron 切工程时会「杀旧子进程 → 立刻起新进程」，两个进程短暂同时持有库，
  // 没有这个等待窗口就是启动即崩。5s 足够覆盖一次正常写入。
  db.exec('PRAGMA busy_timeout = 5000');
  const version = migrate(db);

  /**
   * 事务包装：回调抛错就回滚，避免事件写了而状态没写这种半截状态。
   * 可重入——已经在事务里时直接执行，由最外层提交。这样调用方可以放心把
   * 「改状态 + 记事件」包成一个事务，而不必关心内部方法自己是否也开了事务。
   */
  let txDepth = 0;
  const tx = (fn) => {
    if (txDepth > 0) return fn();
    txDepth++;
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* 回滚失败时保留原始异常 */
      }
      throw err;
    } finally {
      txDepth--;
    }
  };

  // 动态 SQL（时间轴过滤条件组合太多，没法全写成固定语句），按 SQL 文本缓存 prepare 结果
  const stmtCache = new Map();
  const prep = (sql) => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  };

  const buildEventQuery = (kind, projectId, { beforeId = 0, ops = [], q: query = '', limit = 50 } = {}) => {
    const where = ['project_id = ?'];
    const params = [projectId];
    // 游标和 limit 都在这里再兜一次：调用方传进 NaN 的话，绑定到 SQL 里会变成
    // datatype mismatch（500），或者被当成 NULL 变成「不限条数」
    const cursor = Number(beforeId);
    if (kind === 'select' && Number.isFinite(cursor) && cursor > 0) {
      where.push('id < ?');
      params.push(cursor);
    }
    if (ops.length) {
      where.push(`op IN (${ops.map(() => '?').join(',')})`);
      params.push(...ops);
    }
    if (query) {
      // target 是函数 id / 视图 key，after 是 JSON 文本：两个 LIKE 够用了，
      // 真要做全文检索再上 FTS，现在没必要
      where.push('(target LIKE ? OR after LIKE ?)');
      params.push(`%${query}%`, `%${query}%`);
    }
    const body = where.join(' AND ');
    const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.trunc(Number(limit))) : 50;
    if (kind === 'count') {
      return { sql: `SELECT COUNT(*) AS c FROM event WHERE ${body}`, params };
    }
    return {
      sql: `SELECT * FROM event WHERE ${body} ORDER BY id DESC LIMIT ?`,
      params: [...params, safeLimit],
    };
  };

  const q = {
    projectByPath: db.prepare('SELECT * FROM project WHERE path = ? COLLATE NOCASE'),
    projectById: db.prepare('SELECT * FROM project WHERE id = ?'),
    projectByFingerprint: db.prepare('SELECT * FROM project WHERE fingerprint = ? ORDER BY opened_at DESC'),
    projectInsert: db.prepare(
      `INSERT INTO project (path, name, fingerprint, git_remote, git_commit, created_at, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ),
    projectTouch: db.prepare('UPDATE project SET opened_at = ?, fingerprint = COALESCE(?, fingerprint) WHERE id = ?'),
    projectList: db.prepare('SELECT * FROM project WHERE opened_at > 0 ORDER BY pinned DESC, opened_at DESC LIMIT ?'),
    projectRename: db.prepare('UPDATE project SET name = ? WHERE id = ?'),
    projectRemove: db.prepare('UPDATE project SET opened_at = 0 WHERE id = ?'),

    annList: db.prepare('SELECT target_id, data FROM annotation WHERE project_id = ? AND target_kind = ?'),
    annAll: db.prepare('SELECT target_kind, target_id, data FROM annotation WHERE project_id = ?'),
    annGet: db.prepare(
      'SELECT data FROM annotation WHERE project_id = ? AND target_kind = ? AND target_id = ?'
    ),
    annPut: db.prepare(
      `INSERT INTO annotation (project_id, target_kind, target_id, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(project_id, target_kind, target_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ),
    annDel: db.prepare('DELETE FROM annotation WHERE project_id = ? AND target_kind = ? AND target_id = ?'),

    delList: db.prepare('SELECT target_id FROM deleted WHERE project_id = ? AND target_kind = ?'),
    delAll: db.prepare('SELECT target_kind, target_id FROM deleted WHERE project_id = ?'),
    delPut: db.prepare(
      'INSERT OR IGNORE INTO deleted (project_id, target_kind, target_id) VALUES (?, ?, ?)'
    ),
    delDel: db.prepare('DELETE FROM deleted WHERE project_id = ? AND target_kind = ? AND target_id = ?'),
    delClear: db.prepare('DELETE FROM deleted WHERE project_id = ?'),

    layoutList: db.prepare('SELECT view_key, mode, nodes, edges, manual FROM layout WHERE project_id = ?'),
    layoutGet: db.prepare('SELECT nodes, edges, manual FROM layout WHERE project_id = ? AND view_key = ? AND mode = ?'),
    layoutPut: db.prepare(
      `INSERT INTO layout (project_id, view_key, mode, nodes, edges, manual, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, view_key, mode) DO UPDATE SET
         nodes = excluded.nodes, edges = excluded.edges, manual = excluded.manual, updated_at = excluded.updated_at`
    ),
    layoutDel: db.prepare('DELETE FROM layout WHERE project_id = ? AND view_key = ? AND mode = ?'),

    eventInsert: db.prepare(
      `INSERT INTO event (project_id, ts, seq, actor, op, target, before, after, ctx)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    eventList: db.prepare('SELECT * FROM event WHERE project_id = ? ORDER BY ts DESC, seq DESC LIMIT ?'),
    eventUpTo: db.prepare('SELECT * FROM event WHERE project_id = ? AND id <= ? ORDER BY id ASC'),
    eventMax: db.prepare('SELECT MAX(id) AS id FROM event WHERE project_id = ?'),
    eventAnchor: db.prepare("SELECT id FROM event WHERE project_id = ? AND op = 'baseline' LIMIT 1"),
    eventDump: db.prepare('SELECT * FROM event WHERE project_id = ? ORDER BY id ASC LIMIT ?'),

    settingGet: db.prepare('SELECT value FROM setting WHERE key = ?'),
    settingPut: db.prepare(
      'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),

    cacheGet: db.prepare('SELECT model FROM parse_cache WHERE fingerprint = ?'),
    cachePut: db.prepare(
      `INSERT INTO parse_cache (fingerprint, created_at, stats, model) VALUES (?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET created_at = excluded.created_at, stats = excluded.stats, model = excluded.model`
    ),
    cacheDel: db.prepare('DELETE FROM parse_cache WHERE fingerprint = ?'),
    cachePrune: db.prepare(
      'DELETE FROM parse_cache WHERE fingerprint NOT IN (SELECT fingerprint FROM parse_cache ORDER BY created_at DESC LIMIT ?)'
    ),

    bmList: db.prepare('SELECT * FROM bookmark WHERE project_id = ? ORDER BY updated_at DESC'),
    bmByName: db.prepare('SELECT * FROM bookmark WHERE project_id = ? AND name = ?'),
    bmUpsert: db.prepare(
      `INSERT INTO bookmark (project_id, name, roots, up, down, grouped, vars, expansions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, name) DO UPDATE SET
         roots = excluded.roots, up = excluded.up, down = excluded.down,
         grouped = excluded.grouped, vars = excluded.vars, expansions = excluded.expansions,
         updated_at = excluded.updated_at`
    ),
    bmDelete: db.prepare('DELETE FROM bookmark WHERE project_id = ? AND id = ?'),
  };

  let seqInMs = 0;
  let lastTs = 0;

  const api = {
    file,
    version,
    db,
    /**
     * 把多个写操作合成一个事务（可嵌套）。
     * 调用方用它保证「状态 + 事件」同时落库：否则进程在两次提交之间退出，
     * 状态进了库、事件没进，回放出来的历史就和现状对不上，restore 会静默丢改动。
     */
    transaction: tx,

    /** 同一毫秒内的多条事件用 seq 排先后，保证时间轴顺序稳定 */
    nextStamp() {
      const ts = nowMs();
      seqInMs = ts === lastTs ? seqInMs + 1 : 0;
      lastTs = ts;
      return { ts, seq: seqInMs };
    },

    upsertProject({ path: projectPath, name, fingerprint, gitRemote, gitCommit }) {
      const abs = path.resolve(projectPath);
      // Windows 路径大小写不敏感，但 TEXT 的 UNIQUE 区分大小写：
      // 用户从资源管理器（S:\）和命令行（s:\）各打开一次，会得到两个工程、两套标注。
      // 查已有工程时用 COLLATE NOCASE 认成同一个，避免重复入库。
      const existing = q.projectByPath.get(abs);
      const ts = nowMs();
      if (existing) {
        q.projectTouch.run(ts, fingerprint ?? null, existing.id);
        return {
          ...existing,
          fingerprint: fingerprint ?? existing.fingerprint,
          opened_at: ts,
          isNew: false,
          // 上次会话记录的指纹：用来判断「代码在你上次打开之后变过没有」
          prevFingerprint: existing.fingerprint,
        };
      }
      const info = q.projectInsert.run(
        abs,
        name || path.basename(abs),
        fingerprint ?? null,
        gitRemote ?? null,
        gitCommit ?? null,
        ts,
        ts
      );
      return { ...q.projectById.get(info.lastInsertRowid), isNew: true, prevFingerprint: null };
    },

    getProject(id) {
      return q.projectById.get(id) || null;
    },

    /** 路径变了但内容没变时用来认亲（第一阶段只提供查询，UI 后续接） */
    findByFingerprint(fp) {
      return fp ? q.projectByFingerprint.all(fp) : [];
    },

    listProjects(limit = 50) {
      return q.projectList.all(limit);
    },

    renameProject(id, name) {
      const clean = typeof name === 'string' ? name.trim() : '';
      if (!clean || clean.length > 80 || /[\x00-\x1f\x7f]/.test(clean)) throw new Error('工程名需为 1～80 个字符，不能含控制字符');
      q.projectRename.run(clean, id);
      return api.getProject(id);
    },

    /** opened_at 为 0 表示移出最近列表；再次打开路径时恢复，标注和历史全部保留。 */
    removeProject(id) {
      q.projectRemove.run(id);
    },

    loadOverlay(projectId) {
      const ov = emptyOverlay();
      for (const r of q.annList.all(projectId, 'node')) ov.nodes[r.target_id] = parse(r.data, {});
      for (const r of q.annList.all(projectId, 'edge')) ov.edges[r.target_id] = parse(r.data, {});
      for (const r of q.delList.all(projectId, 'node')) ov.deleted.nodes[r.target_id] = 1;
      for (const r of q.delList.all(projectId, 'edge')) ov.deleted.edges[r.target_id] = 1;
      for (const r of q.layoutList.all(projectId)) {
        ov.layout[`${r.view_key}::${r.mode}`] = {
          nodes: parse(r.nodes, {}),
          edges: parse(r.edges, {}),
          manual: parse(r.manual, []),
        };
      }
      return ov;
    },

    /** 读单条标注（库里没有就是空对象）。写事件时用它取真实的 before，别信内存镜像 */
    getAnnotation(projectId, kind, targetId) {
      return parse((q.annGet.get(projectId, kind, targetId) || {}).data, {});
    },

    /**
     * 写节点/边标注。data 里传 null 的字段表示清除该字段，
     * 传 undefined 表示不动——与旧接口「只 merge 传进来的键」保持一致。
     */
    setAnnotation(projectId, kind, targetId, data) {
      return tx(() => {
        const prev = parse((q.annGet.get(projectId, kind, targetId) || {}).data, {});
        const merged = { ...prev, ...data };
        for (const k of Object.keys(merged)) {
          if (merged[k] === null) delete merged[k];
        }
        merged.updatedAt = new Date().toISOString();
        q.annPut.run(projectId, kind, targetId, str(merged), nowMs());
        return merged;
      });
    },

    /** 删除 / 恢复函数与连线：只记 id，不动源码 */
    setDeleted(projectId, { nodes = [], edges = [] }, restore = false) {
      return tx(() => {
        for (const id of nodes) {
          if (restore) q.delDel.run(projectId, 'node', id);
          else q.delPut.run(projectId, 'node', id);
        }
        for (const k of edges) {
          if (restore) q.delDel.run(projectId, 'edge', k);
          else q.delPut.run(projectId, 'edge', k);
        }
        return {
          nodes: q.delList.all(projectId, 'node').length,
          edges: q.delList.all(projectId, 'edge').length,
        };
      });
    },

    clearDeleted(projectId) {
      q.delClear.run(projectId);
    },

    /** 读一个布局槽位；不存在时返回空槽，调用方不用判空 */
    getLayout(projectId, viewKey, mode) {
      const r = q.layoutGet.get(projectId, viewKey, mode);
      if (!r) return { nodes: {}, edges: {}, manual: [] };
      return { nodes: parse(r.nodes, {}), edges: parse(r.edges, {}), manual: parse(r.manual, []) };
    },

    /**
     * 写布局槽位。clear=true 清空该槽位；否则按字段 merge，
     * manual 是整体替换（它表示「当前视图里所有手工边」的完整集合）。
     */
    saveLayout(projectId, viewKey, mode, patch = {}) {
      return tx(() => {
        const slot = api.getLayout(projectId, viewKey, mode);
        if (patch.clear) {
          q.layoutDel.run(projectId, viewKey, mode);
          return { nodes: {}, edges: {}, manual: [] };
        }
        if (patch.nodes) Object.assign(slot.nodes, patch.nodes);
        if (patch.edges) Object.assign(slot.edges, patch.edges);
        if (patch.manual) slot.manual = patch.manual;
        q.layoutPut.run(projectId, viewKey, mode, str(slot.nodes), str(slot.edges), str(slot.manual), nowMs());
        return slot;
      });
    },

    appendEvent(projectId, { op, target = null, before = null, after = null, ctx = null, actor = 'user' }) {
      const { ts, seq } = api.nextStamp();
      const info = q.eventInsert.run(
        projectId,
        ts,
        seq,
        actor,
        op,
        target,
        before === null ? null : str(before),
        after === null ? null : str(after),
        ctx === null ? null : str(ctx)
      );
      return Number(info.lastInsertRowid);
    },

    listEvents(projectId, limit = 200) {
      return q.eventList.all(projectId, limit).map(toEvent);
    },

    /**
     * 时间轴列表：分页 + 按类型/关键词过滤，默认**不返回 before/after**。
     *
     * 之前一次性返回 300 条完整事件，每条都带布局坐标这种几 KB 的载荷，
     * 服务端要 JSON.parse 全部再序列化发出去，操作一多面板就卡。
     * 现在只回一个 brief（变更分类、备注、条数这类几十字节的摘要），
     * 需要完整载荷时（回放）走 eventsUpTo。
     */
    listEventsPage(projectId, { limit = 50, beforeId = 0, ops = [], q: query = '', withPayload = false } = {}) {
      const { sql, params } = buildEventQuery('select', projectId, { beforeId, ops, q: query, limit });
      return prep(sql)
        .all(...params)
        .map((r) => {
          const e = toEvent(r);
          return {
            id: e.id,
            ts: e.ts,
            seq: e.seq,
            actor: e.actor,
            op: e.op,
            target: e.target,
            brief: briefOf(e),
            ...(withPayload ? { before: e.before, after: e.after } : {}),
          };
        });
    },

    countEvents(projectId, { ops = [], q: query = '' } = {}) {
      const { sql, params } = buildEventQuery('count', projectId, { ops, q: query });
      const r = prep(sql).get(...params);
      return Number(r?.c || 0);
    },

    /** 导出会话用：按 id 升序取全部事件（含完整载荷） */
    dumpEvents(projectId, limit = 5000) {
      return q.eventDump.all(projectId, limit).map(toEvent);
    },

    /** 时间轴回放用：按 id 升序取到某个事件为止 */
    eventsUpTo(projectId, eventId) {
      return q.eventUpTo.all(projectId, eventId).map(toEvent);
    },

    latestEventId(projectId) {
      const r = q.eventMax.get(projectId);
      return Number(r?.id || 0);
    },

    /** 有没有「可信起点」：只有 baseline 保证携带全量状态（import 的载荷可能只是摘要） */
    hasAnchor(projectId) {
      return !!q.eventAnchor.get(projectId);
    },

    /**
     * 把 overlay 重放到指定事件之后的状态。
     * 从空状态开始按 id 顺序应用，遇到 baseline / restore_point / import 这类
     * 携带全量状态的节点就整体替换——它们标志着一份「可信起点」。
     * 比它更早的事件在语义上已经被覆盖，所以不需要特殊处理。
     */
    overlayAt(projectId, eventId) {
      const ov = emptyOverlay();
      for (const e of api.eventsUpTo(projectId, eventId)) applyEvent(ov, e);
      return ov;
    },

    /** 整体替换：恢复到此 / 导入时用。写库和事件分开，调用方决定要不要记事件 */
    replaceOverlay(projectId, next) {
      return tx(() => {
        db.prepare('DELETE FROM annotation WHERE project_id = ?').run(projectId);
        db.prepare('DELETE FROM deleted WHERE project_id = ?').run(projectId);
        db.prepare('DELETE FROM layout WHERE project_id = ?').run(projectId);
        const ts = nowMs();
        for (const [id, data] of Object.entries(next.nodes || {})) {
          q.annPut.run(projectId, 'node', id, str(data), ts);
        }
        for (const [k, data] of Object.entries(next.edges || {})) {
          q.annPut.run(projectId, 'edge', k, str(data), ts);
        }
        for (const id of Object.keys((next.deleted || {}).nodes || {})) q.delPut.run(projectId, 'node', id);
        for (const k of Object.keys((next.deleted || {}).edges || {})) q.delPut.run(projectId, 'edge', k);
        for (const [key, slot] of Object.entries(next.layout || {})) {
          const idx = key.lastIndexOf('::');
          if (idx < 0) continue;
          q.layoutPut.run(
            projectId,
            key.slice(0, idx),
            key.slice(idx + 2),
            str(slot.nodes || {}),
            str(slot.edges || {}),
            str(slot.manual || []),
            ts
          );
        }
      });
    },

    getSetting(key, fallback = null) {
      const r = q.settingGet.get(key);
      return r ? parse(r.value, fallback) : fallback;
    },

    setSetting(key, value) {
      q.settingPut.run(key, str(value));
    },

    /** 书签：把「入口集合 + 深度 + 模式」存成一个名字，一键跳回去 */
    listBookmarks(projectId) {
      return q.bmList.all(projectId).map(toBookmark);
    },

    /** 按名字找书签：保存时用来取「覆盖前」的旧值，写进时间轴的 before */
    findBookmark(projectId, name) {
      const r = q.bmByName.get(projectId, String(name || '').trim());
      return r ? toBookmark(r) : null;
    },

    /**
     * 保存书签。同名视为覆盖（UNIQUE(project_id,name) + upsert），
     * 用户不用先删再存；返回是否覆盖，前端据此提示。
     */
    saveBookmark(projectId, { name, roots = [], up = 1, down = 1, group = true, vars = [], expansions = [] }) {
      const clean = String(name || '').trim();
      if (!clean) throw new Error('书签名称不能为空');
      if (!Array.isArray(roots)) throw new Error('roots 必须是数组');
      const existed = !!q.bmByName.get(projectId, clean);
      const ts = nowMs();
      q.bmUpsert.run(
        projectId,
        clean,
        str(roots),
        Number(up) || 0,
        Number(down) || 0,
        group ? 1 : 0,
        str(Array.isArray(vars) ? vars : []),
        str(normalizeExpansions(expansions)),
        ts,
        ts
      );
      return { bookmark: toBookmark(q.bmByName.get(projectId, clean)), overwritten: existed };
    },

    deleteBookmark(projectId, id) {
      const r = q.bmDelete.run(projectId, Number(id));
      return r.changes > 0;
    },

    /**
     * 取解析缓存。命中时返回「纯数据模型」，_index 需要调用方 rebuildIndex 重建。
     * 读不出来（损坏 / 老版本格式）就当没命中，顺手删掉这条坏记录。
     */
    getCachedModel(key) {
      const r = q.cacheGet.get(key);
      if (!r || !r.model) return null;
      try {
        return deserialize(gunzipSync(Buffer.from(r.model)));
      } catch {
        q.cacheDel.run(key);
        return null;
      }
    },

    /**
     * 缓存完整分析结果，原生保留 Map / Set。按压缩后的落盘大小限制，
     * 避免大工程仅因展开后的 token 较大就永远无法命中缓存。
     */
    putCachedModel(key, model, { maxBytes = 40 * 1024 * 1024, keep = 12 } = {}) {
      // _index 里全是对象引用，存下来只会变成两份互不相干的副本
      const { _index, _dfPending, ...plain } = model;
      let packed;
      try {
        packed = serialize(plain);
      } catch {
        return { cached: false, reason: 'serialize' };
      }
      const gz = gzipSync(packed, { level: 1 });
      if (gz.length > maxBytes) return { cached: false, reason: 'too-large', bytes: gz.length };
      q.cachePut.run(key, nowMs(), null, gz);
      q.cachePrune.run(keep);
      return { cached: true, rawBytes: packed.length, gzBytes: gz.length };
    },

    pruneCache(keep = 12) {
      q.cachePrune.run(keep);
    },

    /** 全量导出本工程存下来的目标，供孤儿标注检测使用 */
    listAllTargets(projectId) {
      return {
        annotations: q.annAll
          .all(projectId)
          .map((r) => ({ kind: r.target_kind, id: r.target_id, data: parse(r.data, {}) })),
        deleted: q.delAll.all(projectId).map((r) => ({ kind: r.target_kind, id: r.target_id })),
        layouts: q.layoutList.all(projectId).map((r) => ({
          viewKey: r.view_key,
          mode: r.mode,
          nodes: parse(r.nodes, {}),
        })),
      };
    },

    /**
     * 删除失效条目。只删传进来的这些，不做「顺手清理」——
     * 判断哪些该删是调用方（服务端按当前模型算）的事，存储层不猜。
     */
    purgeTargets(projectId, { annotations = [], deleted = [], layoutSlots = [], layoutNodes = [] } = {}) {
      return tx(() => {
        for (const a of annotations) q.annDel.run(projectId, a.kind, a.id);
        for (const d of deleted) q.delDel.run(projectId, d.kind, d.id);
        for (const s of layoutSlots) q.layoutDel.run(projectId, s.viewKey, s.mode);
        for (const n of layoutNodes) {
          const slot = api.getLayout(projectId, n.viewKey, n.mode);
          let touched = false;
          for (const id of n.ids) {
            if (Object.prototype.hasOwnProperty.call(slot.nodes, id)) {
              delete slot.nodes[id];
              touched = true;
            }
          }
          if (!touched) continue;
          // 节点全清空且没有手工边时，整个槽位没意义了
          if (!Object.keys(slot.nodes).length && !slot.manual.length) {
            q.layoutDel.run(projectId, n.viewKey, n.mode);
          } else {
            q.layoutPut.run(projectId, n.viewKey, n.mode, str(slot.nodes), str(slot.edges), str(slot.manual), nowMs());
          }
        }
        return {
          annotations: annotations.length,
          deleted: deleted.length,
          layoutSlots: layoutSlots.length,
          layoutNodes: layoutNodes.reduce((s, n) => s + n.ids.length, 0),
        };
      });
    },

    close() {
      try {
        db.close();
      } catch {
        /* 已关闭时忽略 */
      }
    },
  };

  return api;
}

/**
 * 旧 out/overlay.json 一次性导入。
 * 只在库里还没有该工程任何标注时执行，避免反复覆盖用户后来的修改。
 */
export function importLegacyOverlay(store, projectId, legacy) {
  if (!legacy || typeof legacy !== 'object') return { imported: false, reason: 'empty' };
  const hasData =
    Object.keys(legacy.nodes || {}).length ||
    Object.keys(legacy.edges || {}).length ||
    Object.keys((legacy.deleted || {}).nodes || {}).length ||
    Object.keys((legacy.deleted || {}).edges || {}).length ||
    Object.keys(legacy.layout || {}).length;
  if (!hasData) return { imported: false, reason: 'nothing' };

  const current = store.loadOverlay(projectId);
  const already =
    Object.keys(current.nodes).length ||
    Object.keys(current.edges).length ||
    Object.keys(current.deleted.nodes).length ||
    Object.keys(current.deleted.edges).length ||
    Object.keys(current.layout).length;
  if (already) return { imported: false, reason: 'exists' };

  // 整段导入放一个事务：中途失败就整体回滚。
  // 以前是逐条提交，失败后库里留下半份数据，下次再进来 `already` 判定为真，
  // 于是永远停在「导入了一半」的状态，而且源文件也不会被改名留底。
  return store.transaction(() => {
    let n = 0;
    for (const [id, data] of Object.entries(legacy.nodes || {})) {
      store.setAnnotation(projectId, 'node', id, data);
      n++;
    }
    for (const [k, data] of Object.entries(legacy.edges || {})) {
      store.setAnnotation(projectId, 'edge', k, data);
      n++;
    }
    const delNodes = Object.keys((legacy.deleted || {}).nodes || {});
    const delEdges = Object.keys((legacy.deleted || {}).edges || {});
    if (delNodes.length || delEdges.length) store.setDeleted(projectId, { nodes: delNodes, edges: delEdges });
    for (const [key, slot] of Object.entries(legacy.layout || {})) {
      const idx = key.lastIndexOf('::');
      if (idx < 0) continue;
      store.saveLayout(projectId, key.slice(0, idx), key.slice(idx + 2), {
        nodes: slot.nodes || {},
        edges: slot.edges || {},
        manual: slot.manual || [],
      });
    }
    // 事件里带上全量状态：时间轴回放要靠它确定「可信起点」，
    // 只记「导入了 2 条」是无法重建当时画面的
    store.appendEvent(projectId, {
      op: 'import',
      target: 'out/overlay.json',
      after: store.loadOverlay(projectId),
      actor: 'system',
    });
    return { imported: true, annotations: n, deletedNodes: delNodes.length, deletedEdges: delEdges.length };
  });
}
