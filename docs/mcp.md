# 内置 MCP 服务（AI 访问）

项目内置 MCP（Model Context Protocol）服务。AI 可读取工程源码与调用图、筛选函数并更新用户画布、
写入标签，以及导出 SVG、Excel 或 HTML。画布和标注的变更通过 SSE 实时同步到已打开的页面。

## 形态与连接

- **传输**：Streamable HTTP，挂在主服务的 `/mcp` 路径，无会话模式（每个 POST 独立处理）
- **端点**：`http://127.0.0.1:5173/mcp`（端口即 `npm run serve` / 桌面版实际端口）
- **零新依赖**：协议层为进程内实现（`src/mcp.js`），不引入 MCP SDK
- **只监听本机**：主服务绑定 `127.0.0.1`，外部网络无法访问

### 客户端配置示例

WorkBuddy / Claude Desktop / Cursor 等支持 Streamable HTTP 的客户端，在 MCP 配置里加：

```json
{
  "mcpServers": {
    "tcu-callgraph": {
      "type": "http",
      "url": "http://127.0.0.1:5173/mcp"
    }
  }
}
```

连接前请先启动应用（`启动.bat` / `npm run serve`），MCP 端点随主服务一起提供。
顶栏「AI 访问」里会显示实际端点，并提供「复制 MCP 配置 JSON」和三条工作指令。

## 权限控制（三档）

| 档位 | 能力 |
| --- | --- |
| `off` | 禁用：AI 无法访问任何数据（协议握手保留，工具列表为空） |
| `readonly`（默认） | 只读 + 导出。读取工程源码、调用图、数据流与时间轴，导出 SVG / Excel / HTML |
| `readwrite` | 另可更新画布、写标签和标注、隐藏或恢复函数与连线、保存布局、切换工程 |

**优先级**：环境变量 `CALLGRAPH_MCP` > 界面设置（存库 `setting` 表 `mcp.access`）> 默认 `readonly`。

两种改法：

1. **界面**：顶栏「AI 访问」按钮 → 选择档位 → 保存。每个 MCP 请求都会重新读权限，**改完立即生效，不用重启**。
2. **环境变量**（测试 / 无头场景）：启动前设置 `CALLGRAPH_MCP=readwrite`。设置后界面修改会被拒绝并提示，避免两边打架。

运行时查询：`GET /api/mcp-config` 返回 `{ level, source }`（source ∈ env / setting / default）。

### 访问来源限制

`/mcp` 与其他写接口共用同一道守卫：

- **Origin**：带了 Origin 且不是 `http(s)://127.0.0.1` / `localhost` 的请求一律 403；
- **Content-Type**：必须是 `application/json`，`text/plain` 之类的「简单请求」一律 415。

这两条是防 CSRF 的：浏览器发跨站请求一定带 Origin，而 `text/plain` 的 POST 不触发预检，
不挡的话任意网页都能借用户开着的本地服务调用工具（`readwrite` 下等于能改标注、删节点）。
命令行 / MCP 客户端（Claude Desktop 等）不带 Origin、发 `application/json`，不受影响。

服务本身只监听 `127.0.0.1`，不对局域网开放。

## 实时同步（页面即时刷新）

用户通常开着一个页面看图。AI 的写操作落库后，服务端通过 `GET /api/stream`（SSE）广播
`change` 事件（`{ op, actor, ts }`），页面（`web/lib/live.js`）收到后自动重拉视图并保留视角：

- 只响应 `actor=ai` 的广播。用户自己的写操作界面已就地处理，若也跟着刷新，
  重复刷新会打断用户正在进行的拖拽；
- AI 连续多个写操作合并成一次刷新（400ms 防抖）；用户正在拖拽时推迟到松手后；
- `view.compose` 携带新的入口、局部展开、深度、变量、选中项和筛选理由。回看历史时显示提示，回到最新后应用组图；
- `project.switch`（AI 切工程）触发页面整体重载，并带工程名提示。

配套的 `cg_page` 工具读取「用户正在看什么」：入口函数、展开深度、布局模式、选中的节点/连线、
是否在回看历史。页面状态变化后上报 `POST /api/page`，最新的普通工程视图按工程保存。
AI 组图会另记一条 `view.compose` 事件。可使用画布返回键恢复上一个视图，使用时间轴恢复历史标注。

## 工具清单

前缀 `cg_`。所有写操作在时间轴里以 `actor=ai` 记录，与人工改动可区分、可恢复；
时间轴界面上 AI 的事件带紫色「AI」徽标。

### 读
| 工具 | 说明 |
| --- | --- |
| `cg_stats` | 工程统计：函数 / 调用 / 宏 / 函数指针表 / 环 / 已删除数量 |
| `cg_project` / `cg_projects` | 当前工程身份 / 最近工程列表 |
| `cg_page` | 用户页面当前视图：入口、深度、模式、选中项、是否回看历史 |
| `cg_tree` | 文件树（目录层级 + 每文件函数清单） |
| `cg_search` | 按函数名搜索，拿函数 id |
| `cg_detect_tasks` | 服务端扫源码找 TASK 周期 / コール順 建议（带证据，不落库） |
| `cg_view` | 取视图：带坐标的节点 + 路由后的连线 + 分组框（与界面同一份数据） |
| `cg_node` | 单函数详情：签名、入出边、已有标注 |
| `cg_source` | 读取当前工程的源码片段。按函数 ID 查询时附带任务周期、调用边和全局变量读写 |
| `cg_vars` / `cg_shared_vars` | 全局变量清单 / 多函数共享的变量 |
| `cg_dataflow` | 数据流分析（dir=in/out） |
| `cg_orphans` | 失效标注清单 |
| `cg_events` | 时间轴事件（含 actor=ai 的记录） |

### 写（需要 readwrite）
| 工具 | 说明 |
| --- | --- |
| `cg_switch` | 切换工程（按 id 或路径） |
| `cg_compose_view` | 精选入口、函数和全局变量，替换或追加到当前画布 |
| `cg_apply_task_labels` | 批量写 TASK、コール順 或 結合点 标签，默认保留其他类型的标签 |
| `cg_annotate` | 节点/连线标注：note、color（**固定四色** #CCFFCC/#FFFF99/#FFCCFF/#BFBFBF，即既存/変更/追加/削除，非法值拒收）、tag、change(既存/変更/追加/削除)、labels（**一线多条**连线标签数组，整组替换；结合点编号不给自动分配，note=第二行说明小字） |
| `cg_delete` | 隐藏/恢复函数与连线（不动源码）；clear=true 全部恢复 |
| `cg_save_layout` | 保存手工连线（节点与路径由 ELK 排版） |

### 导出（readonly 即可用）
| 工具 | 说明 |
| --- | --- |
| `cg_export_svg` | 当前视图导出 SVG（按查询参数生成布局，使用固定配色，不读取浏览器自定义主题），root 空则自动挑入口 |
| `cg_export_xlsx` | 全工程调用关系 Excel |
| `cg_export_html` | 指定入口的交互式 HTML 图页 |

导出文件统一落在项目的 `out/` 目录，`out` 参数只允许相对文件名（拒绝绝对路径与 `..`）。

## AI 组图与标注

1. 先用 `cg_page` 对齐当前画布，再用 `cg_source` 核实实际 C 代码。`cg_node`、`cg_dataflow` 和 `cg_detect_tasks` 可辅助确认调用关系、周期和数据流。
2. 用 `cg_compose_view` 筛选核心函数和相关全局变量，通常选 5–40 个函数。提交前核对 ID。
3. 用 `cg_apply_task_labels` 写标签。TASK 文字带周期，如 `10ms TASK`，`note` 写源码文件、行号和依据。每个调用方按核实过的执行顺序从 `コール順1` 连续编号。遇到执行顺序不明的分支或表达式，只写有依据的标签。
4. 节点分类遵循固定语义。`existing` 为既存绿，`modified` 为変更黄，`added` 为追加粉，`deleted` 为削除灰。

### 参数和服务端校验

| 工具 | 参数与校验 |
| --- | --- |
| `cg_source` → `GET /api/source` | 传 `{ id }` 或 `{ file, startLine, endLine }`。行号从 1 开始，每次最多返回 250 行，超出部分用 `truncated` 提示。只允许当前工程内已索引的源码文件，解析后的实际路径也必须位于工程根目录内。按 ID 查询时返回 `taskPeriods`、`calls` 和 `varAccess`。 |
| `cg_compose_view` → `POST /api/mcp-compose` | 传 `mode: "replace"` 或 `"add"`，可选 `roots`、`functionIds`、`up`、`down`、`vars`、`selected` 和 `reason`。`roots` 与 `functionIds` 合计提交 1–80 项，深度必须为 0–5 的整数。服务端校验所有传入 ID，拒绝外部虚拟节点，并返回无效 ID 列表。 |
| `cg_apply_task_labels` → `POST /api/mcp-task-labels` | 传 `{ items, merge? }`，每条含 `edgeKey`、`preset`，可带 `text`、`order`、`note`。`from->to` 会解析为画布采用的真实边，给出 `:line` 可指定具体调用。TASK 文字必填，样式取自预设。コール順 接受正整数 `order` 或 `コール順N`，同一调用方的批内或已有可见标签重号时整批拒绝。`merge: false` 会替换本批涉及的边上的整组标签。 |

画布更新及标签变更以 `actor: "ai"` 写入时间轴。标注摘要显示实际标签文字，重复提交相同的标注不会产生新事件。

## 架构说明

```
AI 客户端 ──Streamable HTTP──▶ /mcp (src/mcp.js)
                                 │  权限检查（每请求重读）
                                 ▼
                          进程内 fetch 127.0.0.1
                                 │
                                 ▼
                          现有 /api/* 路由（src/server.js）
                                 │
                    校验 / 事件(actor=ai) / SQLite 持久化
                                 │
                                 ▼ broadcastChange (SSE)
                          打开着的页面 (web/lib/live.js)
                                 │  actor=ai → 保留视角刷新画面 + 提示
                                 ▼
                          /api/view 重拉（与手动刷新同一份数据）
```

工具实现不绕开 HTTP 层：MCP 工具桥接到与浏览器 UI 完全相同的 `/api/*` 端点，
因此校验规则、时间轴事件、持久化行为天然一致。服务端 SVG 导出
（`src/core/export-svg.js` + `POST /api/export/svg`）是本次为 MCP 补齐的端点，
样式与前端 `web/lib/svg.js` 手工同步——改绘制样式时两个文件都要动。

## 相关文件

- `src/mcp.js` —— MCP 协议层 + 工具定义 + 权限
- `src/server.js` —— `/mcp`、`/api/mcp-config`、`/api/export/svg`、`/api/stream`（SSE 广播）、`/api/page` 路由；写端点透传 actor
- `src/core/export-svg.js` —— 服务端 SVG 生成
- `web/lib/live.js` —— 页面侧：SSE 监听、AI 改动自动刷新、视图状态上报
- `web/lib/ai-settings.js` —— 界面「AI 访问」设置面板
- `test/mcp.test.js` —— 协议单元测试 + 端到端链路测试
- `test/live.test.js` —— SSE 广播 / cg_page / 实时同步链路测试
