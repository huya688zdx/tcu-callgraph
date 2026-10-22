# 持久化与历史回溯设计（草案）

## 目标

把当前的「一个全局 `out/overlay.json`」升级成一套可切换工程、可回溯任意时刻状态的本地存储：下次打开能选择历史工程，能看到自己每一步操作，能回到某个时间点的完整状态。

## 当前基础

- 唯一持久化文件 `out/overlay.json`，路径在 `src/server.js:53` 写死，**与所选工程无关**。
- 结构：`nodes`（change/note/tag/color）、`edges`（change）、`deleted`（黑名单）、`layout`（按 `roots::mode` 分槽的坐标/折线/手工边）。
- 三个写接口：`POST /api/layout`、`/api/overlay`、`/api/delete`；`guardWrite` 校验 Origin 与 Content-Type。
- 写入是 `tmp + rename` 原子写，读坏时备份成 `overlay.corrupt-<ts>.json`。
- 前端零 localStorage；撤销栈是**内存里的整视图 JSON 快照**（`web/lib/history.js`，上限 60 条），刷新即丢。
- 源码解析结果不缓存，每次启动重新 `loadModel`。

## 设计

### 1. 存储选型：SQLite（`node:sqlite`）

已验证：Electron 44.9.0 内嵌 Node 24.22.0，`require('node:sqlite')` 可直接建表读写；系统 Node 22.22 也可用（带 experimental 警告）。零依赖、同步 API、单文件、WAL 并发，不需要 `electron-rebuild`。

对比：

| 方案 | 优点 | 代价 |
|---|---|---|
| **`node:sqlite`（推荐）** | 零依赖、事务、索引、单文件、跨工程查询 | 官方标 experimental，API 可能微调（只用 exec/prepare/run/all，风险可控） |
| `better-sqlite3` | 最成熟 | 原生模块，要按 Electron ABI 重编译，多平台打包成本高 |
| JSONL 追加日志 | 实现最简单、天然 append-only | 多工程管理、时间轴筛选、跨工程检索都要自己写；文件多了难压缩 |

数据量估算：一次拖动/标注算一条事件，按每天 300–500 条、每条 200–400 字节，一年几十 MB，SQLite 完全够用，不需要分库。

### 2. 数据分层：只存「输入」，不存「派生」

这是整个设计的核心原则。视图 = 源码解析结果 + 视图参数 + overlay 三者算出来的，属于派生数据。所以历史里**不存视图快照**，只存改变输入的意图：

- 存：标注变更、删除/恢复、手动坐标、手工连线、视图参数切换
- 不存：自动布局算出的坐标、路由算出的折线、文件框/目录容器几何

好处是历史体积小一个量级，而且布局算法以后改版，旧历史仍然能正确重放——存派生快照的话，算法一升级，回看旧快照就是一堆过期坐标。

### 3. 表结构

```sql
CREATE TABLE project (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,   -- 规范化绝对路径
  name TEXT NOT NULL,
  fingerprint TEXT,            -- 文件清单 + size + mtime 的 hash
  git_remote TEXT, git_commit TEXT,
  created_at INTEGER, opened_at INTEGER,
  pinned INTEGER DEFAULT 0, note TEXT, cover TEXT  -- cover: 缩略图文件名
);

CREATE TABLE annotation (      -- 节点/边标注（当前值，覆盖式）
  project_id INTEGER, target_kind TEXT, target_id TEXT,
  data TEXT, updated_at INTEGER,
  PRIMARY KEY (project_id, target_kind, target_id)
);

CREATE TABLE deleted (         -- 删除黑名单
  project_id INTEGER, target_kind TEXT, target_id TEXT,
  PRIMARY KEY (project_id, target_kind, target_id)
);

CREATE TABLE layout (          -- 每个视图槽位的手工布局
  project_id INTEGER, view_key TEXT, mode TEXT,
  nodes TEXT, edges TEXT, manual TEXT, updated_at INTEGER,
  PRIMARY KEY (project_id, view_key, mode)
);

CREATE TABLE view_state (      -- 上次看的位置，用于「恢复现场」
  project_id INTEGER PRIMARY KEY,
  roots TEXT, up INTEGER, down INTEGER, grouped INTEGER,
  zoom REAL, pan_x REAL, pan_y REAL, selected TEXT, updated_at INTEGER
);

CREATE TABLE event (           -- append-only 操作日志
  id INTEGER PRIMARY KEY,
  project_id INTEGER, ts INTEGER, seq INTEGER,
  actor TEXT,                  -- user / agent / system
  op TEXT,                     -- node.change / node.note / edge.change / delete /
                               -- restore / layout.move / layout.edge / view.switch /
                               -- undo / redo / snapshot / restore_point
  target TEXT, before TEXT, after TEXT,
  ctx TEXT                     -- 当时的 roots/up/down/group，用于还原「他看到的那屏」
);
CREATE INDEX event_by_project ON event(project_id, ts, seq);

CREATE TABLE snapshot (        -- 加速回溯，避免从头重放
  id INTEGER PRIMARY KEY, project_id INTEGER, ts INTEGER,
  label TEXT, kind TEXT,       -- auto / manual / milestone
  event_id INTEGER, state BLOB -- gzip(JSON) 的 overlay 全量
);

CREATE TABLE parse_cache (     -- 可选：源码没变就跳过重解析
  fingerprint TEXT PRIMARY KEY, created_at INTEGER, stats TEXT, model BLOB
);

CREATE TABLE setting ( key TEXT PRIMARY KEY, value TEXT );
```

### 4. 时间轴与回溯

- 时间轴 = `event` 按 `(ts, seq)` 排序，按天分组，每条带可读摘要（「把 Gear_Apply 标成新增」）。
- 回到某时刻 = 取 `ts <= T` 的最近快照，再重放其后的事件。事件是幂等的 patch，重放结果是确定的。
- 快照策略：每 200 条事件自动打一个，或每 10 分钟一次；手动命名快照（「评审前」）永久保留；自动快照只留最近 50 个。
- **撤销也写事件**（`op=undo` 指向被撤销的那条），而不是从日志里删记录。这样时间轴永远完整，也顺带有了审计能力。
- 回看旧状态时进入只读预览，顶部一条「你正在看 2026-10-20 14:32 的状态」+ 一个「恢复到此」按钮。恢复 = 追加一条 `restore_point` 事件，不做分叉，保持线性历史。
- 源码变了怎么办：快照只存 overlay，回放时用当前源码。被删掉的函数，它的标注会变成「孤儿标注」，单独列一个面板让用户批量清理或保留。

### 5. 需要保存的信息（按优先级）

必须有：

1. 工程路径 + 内容指纹 —— 用来判断「这份快照对应的是不是现在这份代码」
2. 最近打开列表、置顶、别名、缩略图封面
3. 视图参数（入口 roots / 上下深度 / 是否分组 / 缩放平移）—— 下次打开回到上次那一屏
4. 现有 overlay 全部内容（标注 / 删除 / 手工布局）
5. 事件日志 + 快照

建议有：

6. **保存的视图（书签）**：给常用入口组合起名，比如「换挡链路」「ADC 采集」，一键跳回
7. 解析统计与耗时、文件清单快照 —— 能 diff「两天前到现在代码改了哪几个文件」
8. git 分支 / commit（有 `.git` 时）—— 快照自动挂到代码版本上
9. 搜索历史、最近定位记录
10. 导出记录（导了什么格式、存到哪）
11. 用户偏好（语言、默认深度、是否固定布局、主题）
12. 解析诊断（失败文件、缺失头文件）—— 换机器打开时能解释为什么图不一样

可选，先不做：

13. 两个快照的可视化 diff
14. 快照导出成文件，发给同事做评审
15. 标注全文检索（跨工程搜「这个函数谁标过问题」）

### 6. 工程切换与启动页

启动时读 `project` 表，按 `opened_at` 倒序出卡片：名称、路径、最后打开时间、函数数/边数、封面缩略图、置顶标记。点击直接进上次的视图状态。

没有记录时走现有的选择文件夹对话框。`pinned` 的排最前，`path` 已不存在的卡片置灰并提供「移除记录」。

### 7. 数据位置与迁移

- Electron：`app.getPath('userData')/callgraph.db`（Windows 是 `%APPDATA%/tcu-callgraph/`）。多工程共用一库，重装不丢，不污染源码目录。
- Web 版（`node src/server.js`，没有 electron）：回落到平台默认数据目录，**与 Electron 的 userData 是同一个位置**（Windows `%APPDATA%/tcu-callgraph`、macOS `~/Library/Application Support/tcu-callgraph`、Linux `~/.config/tcu-callgraph`）。两边各存一份库会导致「命令行标的注，桌面版打开就没了」，所以必须对齐。可用 `CALLGRAPH_DB` 覆盖。
- 交接/归档：提供「导出工程会话」→ 单个 `.cgx`（SQLite 或 zip+json），可放回工程目录 `.callgraph/` 一起入库。
- 首次启动检测到旧 `out/overlay.json`，弹一次「导入到哪个工程」，导入后写成一条 `import` 事件 + 初始快照。

### 8. 一致性与并发

- SQLite 开 WAL，写操作走事务。
- 同一工程被两个窗口打开：`project` 表加 `revision`，写冲突返回 409，前端提示「另一窗口已修改，是否重新加载」。
- Electron 侧加 `requestSingleInstanceLock()`，第二实例直接把已有窗口拉到前台并切换工程。
- 事件写入合并：一次拖拽只在松手时落一条，不要每帧写。

## 非目标

- 不做多用户协作、云同步。
- 不做 git 式分支历史，历史保持线性。
- 不存源码副本（只存指纹和文件清单），避免库体积失控。
- 不存自动布局/路由的派生结果。

## 分期实施

1. **第一阶段**：SQLite 落地 + 多工程隔离（解决现在跨工程串味）+ 旧数据迁移。此时用户已经能选择工程，标注不再互相污染。
2. **第二阶段**：事件日志 + 撤销改走事件 + 时间轴面板（只读回看 + 恢复到此）。
3. **第三阶段**：快照（自动/手动）、保存的视图、解析缓存、封面缩略图。
4. **第四阶段**：导出 `.cgx`、孤儿标注清理、快照 diff。

## 已定决策

1. **存储引擎**：`node:sqlite`。零依赖，Electron 44.9.0 内嵌 Node 24.22 已验证可用。接受 experimental 警告，只使用 `DatabaseSync` / `prepare` / `run` / `all` 这层最稳定的 API。
2. **数据位置**：全局 `userData` 目录，多工程共用一个库。Web 版回落到同一个平台默认目录，不做两套。
3. **历史粒度**：每次操作都记。时间轴按天分组、按 op 类型筛选，避免刷屏。浏览类事件（切入口、缩放）只存参数，编辑类存完整 before/after。

## 第一阶段：SQLite 落地与多工程隔离

改动清单：

1. 新增 `src/core/store.js`：封装 `node:sqlite`。负责打开库、建表、版本化迁移（`PRAGMA user_version`）、以及 `annotation` / `deleted` / `layout` / `view_state` / `project` 的读写。
2. `src/server.js`：
   - 删掉全局 `overlay` 对象与 `saveOverlay()`，改由 store 提供；
   - 启动时按规范化路径 `upsert` 一条 `project`，拿到 `project_id`；
   - `/api/view` 读 overlay 时带上 `project_id`；
   - `/api/layout`、`/api/overlay`、`/api/delete` 写入改为事务内的 upsert/delete；
   - 新增 `GET /api/project` 返回当前工程信息，`GET /api/projects` 返回最近列表。
3. 数据库路径解析：优先 `process.env.CALLGRAPH_DB`，其次 Electron 注入的 `app.getPath('userData')`，最后平台默认数据目录（与 Electron userData 一致）。`electron/main.cjs` 通过 `env` 把 userData 路径传给 fork 的子进程。
4. 旧数据迁移：启动时若库里还没有该工程记录、且 `out/overlay.json` 存在，导入成初始状态并打一条 `op=import` 事件；导入后把原文件改名为 `overlay.imported.json` 留底，不删。
5. 测试：新增 `test/store.test.js`（临时目录建库，覆盖建表、upsert 幂等、多工程隔离、迁移）。现有 `test/*.test.js` 必须全绿。

验收：

- 用 `samples/tcu` 标注 `main.c::main` 后，切到 `samples/demo`，同名函数**不再**继承该标注。
- 两个工程的布局槽位互不干扰，`out/overlay.json` 不再被写入。
- 旧 `out/overlay.json` 能完整迁移，标注、删除记录、手工坐标一条不少。
- `npm test` 全绿。

### 实施记录（第一阶段已完成）

落地文件：

| 文件 | 改动 |
|---|---|
| `src/core/store.js` | 新增。建表、版本化迁移、9 张表的读写、事件追加、旧数据导入 |
| `src/server.js` | 去掉 `OVERLAY_PATH` / `saveOverlay()`；启动时 upsert 工程并加载 overlay 到内存镜像；三个写接口改为落库 + 追加事件；新增 `/api/project`、`/api/projects` |
| `electron/main.cjs` | fork 子进程时通过 `CALLGRAPH_USER_DATA` 传 userData 路径 |
| `scripts/lib/server.mjs` | 每个 E2E 实例分配临时库（`CALLGRAPH_DB`），跑完删掉 |
| `test/store.test.js` | 新增 12 个用例 |

两个实现期的坑：

1. **迁移必须和临时库隔离。** E2E 夹具会 fork 真实 `src/server.js`，如果迁移逻辑无条件执行，测试会把用户真实的 `out/overlay.json` 导入到临时库、然后连库一起删掉，源文件还被改名。所以迁移只在**没有显式 `CALLGRAPH_DB`** 时执行——显式指定库等于声明「这是临时环境」。
2. **`app.getPath('userData')` 只有主进程拿得到。** 解析跑在 fork 出来的子进程里，路径必须经环境变量传下去，否则打包后两边各算各的，症状是「标注保存了但重启就没了」。

当前库：`~/.tcu-callgraph/callgraph.db`（CLI）/ `%APPDATA%/tcu-callgraph/callgraph.db`（Electron），`PRAGMA user_version = 1`。
旧 `out/overlay.json` 已导入并改名为 `out/overlay.imported-<ts>.json` 留底。


## 第二阶段：工程切换与时间轴（已完成）

### 会话状态可切换

`src/server.js` 里把 `root` / `ROOT_LABEL` / `MODEL` / `S` / `PROJECT` / `overlay` 从 `const` 改成 `let`，抽出 `openTarget(path)` 负责「解析 → upsert 工程 → 载入 overlay → 替换全部绑定」。切工程不需要重启进程，`POST /api/switch` 调一次就行。

处理器都是在请求到达时才读这些绑定，所以不需要给每个 handler 传参。

### 时间轴

- 事件写入（第一阶段已埋点）在第二阶段变成可读：`GET /api/events` 返回倒序列表。
- 回看走 `GET /api/view?...&at=<eventId>`：服务端用 `store.overlayAt()` 重放到该时刻，再把结果当作 `viewOverlay` 传给 `buildView`，视图构建逻辑一行没改。
- `buildView` 因此多了第 9 个参数 `viewOverlay`（默认当前 overlay）。
- 「恢复到此」= `overlayAt(at)` → `replaceOverlay()` → 追加一条 `restore_point` 事件。历史是线性的，不做分叉。
- 回看是**只读**的：`state.at > 0` 时 `api.js` 拦掉 `overlay` / `del` / `layout` 三个写接口，并派发 `cg:review-blocked` 事件，时间轴横幅抖一下提示。

### 可信起点（baseline）

回放必须从一份「携带全量状态」的事件开始。`baseline` 事件在工程第一次被打开时写入，载荷就是当时的整个 overlay；`restore_point` 同理。`import` 事件的载荷可能只是摘要（早期版本就是这样），所以判定可信起点时只认 `baseline`。

### 界面

| 文件 | 内容 |
|---|---|
| `web/lib/modal.js` | 遮罩 + 居中面板原语，统一转义函数 |
| `web/lib/projects.js` | 工程面板：最近列表、当前标记、手动输入路径；顶栏按钮显示当前工程名，代码指纹变了会加 `*` |
| `web/lib/timeline.js` | 时间轴面板：按天分组、事件翻译成人话、点击回看、横幅上的「恢复到此 / 回到最新」 |
| `web/lib/api.js` | 新增 `project` / `projects` / `switchProject` / `events` / `restore`；写接口加回看守卫 |
| `web/app.js` | `loadView` 带上 `state.at`；新增 `hooks.reloadAll` 供换工程后整体重载 |

Electron：无参数启动时先读本地库，回到最近打开的工程；有多个历史工程则自动展开工程面板。菜单加了「切换工程…」（Ctrl+P）。

### 又一个坑：两套数据目录

第一阶段 CLI 回落到 `~/.tcu-callgraph/`，Electron 用 `app.getPath('userData')`（`%APPDATA%/tcu-callgraph/`）——两边不是同一个地方。症状是命令行里标的注，桌面版打开就没了。现在 `defaultDataDir()` 按平台对齐 userData 的位置，两边读写同一份库。

### 验收

- `npm test` 37/37。
- `scripts/e2e-session.mjs`：11 项全过（工程列表、切到 demo、切回 tcu、时间轴出现标注、回看起点、回看模式拦截删除、恢复到起点后标注消失）。
- `e2e-menu` / `e2e-interact` / `e2e-delete` 全绿。

## 第三阶段（其一）：解析缓存（已完成）

真实 TCU 工程动辄几千个文件，每次启动、每次切工程都全量重解析代价太高。现在源码没变就直接反序列化模型。

### key 的设计

`cacheKey(files, focus)` = `rel + bytes + mtimeMs + isHeader` 的 sha1，聚焦单文件时再拼上 `focus`。

- **必须带 mtime**。只按 `rel + bytes` 算的话，「大小没变的改写」会一直命中旧缓存，图永远停在改动前。mtime 让这种情况必然失效。
- **工程指纹（`fingerprintFiles`）故意不带 mtime**。它用来在界面上标「代码已变更」的星号，git checkout / 复制目录会整体刷新时间戳，带上就会天天误报。两个 hash 服务两个目的，不要合并。
- **focus 必须参与**。同一个目录下聚焦不同的 `.c` 文件，模型里的 `focusFile` 不一样，但文件清单完全相同——不区分就会串。

### 序列化的两个坑

1. **`_index` 不能存。** 里面全是 Map 和对象引用，JSON 存下来再读回来，`byId` 里的函数和 `functions` 数组会变成两份互不相干的副本。之后任何一处改字段另一处都看不到，而且内存翻倍。所以缓存只存纯数据，读回来调 `rebuildIndex()` 重建。
2. **`fnptrTables[].map` 是 Map。** `JSON.stringify` 会把它变成 `{}`，静默丢数据。用 `{__map: [...]}` 做 replacer / reviver 往返。

### 其他约束

- `.dot` / `.gv` 走另一套模型（没有文件清单），不参与缓存。
- 序列化后超过 40MB 的不缓存，直接放弃——大工程的 token 数组可能有几十 MB，塞进库会让备份和启动都变慢。
- 只保留最近 12 份（`ORDER BY created_at DESC LIMIT 12`），换工程多了自动淘汰。
- 反序列化失败当未命中处理，顺手删掉坏记录。
- 命中时 `model.elapsedMs` 覆盖成实际加载耗时，启动日志会带「（解析缓存）」标记，避免把旧的解析时间当成这次的时间。

### 效果（samples/tcu）

| | 耗时 | 日志 |
|---|---|---|
| 首次 | 15–19 ms | `耗时 16ms` |
| 命中 | 6 ms | `耗时 6ms（解析缓存）` |
| 改文件（同大小） | 16 ms | `耗时 16ms` |

样例工程太小看不出收益，收益随文件数线性放大——省掉的是每个文件的词法 + 预处理 + 语法分析。

### 验收

- `npm test` 44/44（新增 `test/cache.test.js` 7 项：key 稳定性、mtime 敏感、往返后统计与子图一致、`_index` 共享同一批对象、坏 blob 清理、超限不缓存、淘汰策略）。
- 四个 e2e 全绿。

## 第四阶段（其一）：孤儿标注清理（已完成）

源码删掉一个函数后，它的标注还留在库里，图上永远看不到，也没法清理。时间一长库越来越脏，还会在回放时混进已经不存在的东西。

### 判定口径

`GET /api/orphans` 用**当前模型**比对库里存下来的所有目标，分四类：

| 类型 | 判定 |
|---|---|
| 节点标注 | id 不在 `MODEL._index.byId` 且不在 `MODEL.variables` 里 |
| 连线标注 | `${from}->${to}:${line}` 不在 `MODEL.edges` 的键集合里 |
| 删除记录 | 同上，节点 / 连线分别判定 |
| 布局槽位 | `viewKey` 拆成入口集合，**全部**入口都不存在 → 整个槽位作废 |
| 布局节点 | 槽位还有效，但里面某些节点 id 已经不存在 → 只删这些键 |

判定逻辑抽在 `src/core/orphans.js`（`collectOrphans(model, targets)`），不塞在 server.js 里——这段规则容易出错，需要能直接拿真实模型写单测。

两个容易搞错的地方：

- **变量也是节点，而且不止一个来源。** `_index.byId` 只装函数和外部符号；`MODEL.variables` 只有正则版索引认得的白名单类型；像 `ShiftOps const` 和 `GearCtx` 这类 typedef 变量，**只在 AST 数据流索引 `MODEL._df.byId` 里**。
  第一版只查了前两个，结果真实库里 `var::g_ops_4at` / `var::g_gearCtx` 被误报成孤儿（`/api/orphans` 返回 2）。现在三个来源都并进去。
- **入口全丢才删槽位。** 多选入口里少了一个不算孤儿——剩下的入口还能用这个槽位，只清掉死节点就够了。`viewKey` 为空（默认视图）时不做整槽判定。

### 清理

`POST /api/orphans/purge` 先重算一遍再删，不信任前端传的列表（前端只用来显示）。支持 `{dry:true}` 预演，返回 `wouldRemove`。

清理会写一条 `orphan.purge` 事件，`after` 里带着完整清单，时间轴里能看到「清理失效标注」，回放时也按它把这些键删掉。

删完重载内存镜像，避免当前进程还拿着旧 overlay。

### 界面

入口在工程面板底部：有失效条目时才出现一条琥珀色提示，显示数量、说明和前 4 个示例 id，右侧一个「清理」按钮。清理后提示消失，同时整体重载一次（视图里可能有刚被清掉的标注）。

没做成启动弹窗——用户打开工程是为了看图，不是为了处理数据卫生问题，主动弹出来会烦。

### 验收

- `npm test` 52/52（`store.test.js` 新增 3 项：目标汇总、只删传入条目、空槽位回收；`orphans.test.js` 新增 5 项，其中一条是变量误判的真实回归）。
- `e2e-session.mjs` 新增测试 7：造一条失效标注 → 面板出现提示 → 点清理 → 提示消失且 `/api/orphans` 归零。
- 服务端实测：造节点标注 + 连线标注 + 失效入口槽位共 3 条，`dry` 不动库，清理后正常标注（`main.c::main`）保留。

## 第三阶段（其二）：视图书签（已完成）

把「入口集合 + 上下深度 + 分组/固定模式 + 勾选的变量」存成一个名字，下次一键跳回。TCU 这种图每次找入口要点好几下文件树，书签解决的是这个。

### 表结构

`bookmark(project_id, name, roots, up, down, grouped, fixed, vars, created_at, updated_at)`，`UNIQUE(project_id, name)`。

同名保存走 `ON CONFLICT DO UPDATE`，等于覆盖，用户不用先删再存；接口返回 `overwritten` 让前端提示「已覆盖同名书签」。

### schema 版本化（v1 → v2）

这是第一次真的需要增量迁移——线上库已经是 v1 了。`migrate()` 改成：

- `cur < 1`：跑全量 `SCHEMA`（永远是最新结构，新库一步到位）
- `cur === 1`：只补 `bookmark` 的 DDL
- 最后统一写 `user_version = 2`

加表时必须同步三处：`SCHEMA` 里的 DDL（给新库）、`ALTER` 分支（给老库）、`SCHEMA_VERSION` 加一。漏掉中间那步就是典型的「新装的能用、老用户报 no such table」。

### 接口与界面

- `GET /api/bookmarks`、`POST /api/bookmarks`、`POST /api/bookmarks/delete`
- 保存 / 删除都记事件（`bookmark.save` / `bookmark.delete`），时间轴里显示「保存书签「换挡链路」」
- `web/lib/bookmarks.js`：顶栏「书签」按钮 → 面板，底部输入名字保存当前视图；点条目跳回，悬停出现删除
- 跳回时同步更新工具栏的深度下拉、分组勾选、固定布局按钮，否则界面和实际视图会对不上
- 书签也是写操作，回看模式下同样被 `api.js` 拦掉

### 验收

- `npm test` 55/55（新增 3 项：书签按工程隔离且同名覆盖、空名与跨工程删除校验、v1 老库自动补表且数据不丢）。
- `e2e-session.mjs` 新增测试 8：保存「换挡链路」→ 把深度改成 1 层 → 点书签跳回 → 深度和入口都还原 → 删除成功。
- 真实库已从 v1 升到 v2，`bookmark` 表就位，原有标注 / 布局 / 事件一条没丢。
