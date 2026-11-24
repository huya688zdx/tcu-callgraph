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
普通工程的 AI 组图会另记一条 `view.compose` 事件。可使用画布返回键恢复上一个视图，使用时间轴恢复历史标注。比较组图保存在当前比较会话中，退出比较可恢复原画布。

## 工具清单

工具名使用 `cg_` 前缀。写入普通工程的画布和标注变更在时间轴以 `actor=ai` 记录，界面显示紫色「AI」徽标。

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
| `cg_node` / `cg_source` | 查看函数详情或源码。按函数 ID 查询时附带上游 TASK / ISR 入口与调用链 |
| `cg_trace_to_task` | 沿工程已解析的调用关系反向查找 TASK / ISR。每个可达入口提供一条最短证据链，可分页 |
| `cg_changes` | 已应用目录或 Git 比较时读取该比较的变更分类。普通 Git 工程默认比较 HEAD 与工作区 |
| `cg_vars` / `cg_shared_vars` | 全局变量清单 / 多函数共享的变量 |
| `cg_dataflow` | 数据流分析（dir=in/out） |
| `cg_orphans` | 失效标注清单 |
| `cg_events` | 时间轴事件（含 actor=ai 的记录） |

### 写（需要 readwrite）
| 工具 | 说明 |
| --- | --- |
| `cg_switch` | 切换工程（按 id 或路径） |
| `cg_compose_view` | 精选入口、函数和全局变量，或用 `changedFunctionIds` 将修改函数及其入口路径加入当前画布 |
| `cg_apply_task_labels` | 批量写 TASK、コール順 或 結合点 标签，默认保留其他类型的标签 |
| `cg_annotate` | 用 `change` 标注节点四态或连线三态，用 `note` 说明依据。连线的 `labels` 整组替换，TASK、結合点与コール順使用各自预设的边框和文字色 |
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

1. 先用 `cg_page` 确认画布，用 `cg_changes` 读取变更及比较基准。当前模型中的修改函数用 `cg_trace_to_task` 回溯，读取 `upstreamTasks` 和 `upstreamChains`。尚未入图的 Git 快照用 `cg_changes({ snapshotId, id })` 回溯，同样的入口与路径位于结果的 `trace` 内。每个入口对应一条从 TASK / ISR 到目标的最短路径，路径内保留中间函数。
2. 在比较中，用 `version` 分别回溯函数实际存在的 `before` 和 `after` 版本，再用同版本的 `cg_source` 对照调度定义和各段调用的文件、行号。多个周期可达同一函数时逐个报告。缺少入口、间接调用目标待核实，或 `traceTruncated` 提示结果受限时，说明证据边界。普通无调用方函数只能作为回溯线索。
3. 用 `cg_compose_view` 的 `changedFunctionIds` 提交修改函数。比较模式按前后版本各自的调用图补齐入口路径，共用节点只显示一次。直接新增或删除的调用、变量读写关系也会补齐另一端。可再用 `vars` 指定其余所需的全局变量。向已有画面追加时传 `mode: "add"`。比较会话内的组图只作用于该比较画布。
   在普通 Git 工程，从 `cg_changes` 取 `snapshotId`，将它连同 `mode: "replace"` 和 `changedFunctionIds` 传给 `cg_compose_view`。这会在临时比较画布显示该快照计算的节点与连线状态，包括已删除的关系。退出比较即可恢复普通工程画布。
4. 按变更证据独立判断节点与连线。节点自身定义未变用既存绿 `#CCFFCC`，定义实质修改用黄 `#FFFF99`，新增用粉 `#FFCCFF`，删除用灰 `#BFBFBF`。连线按调用或变量读写关系的前后差异分类，既有用黑 `#2C2C2A`，新增用红 `#D9303E`，删除用黑线加 ✕。调用画实线，变量访问画虚线。例如只改被调函数中的运算时，该函数为黄色，上游未改的 TASK 仍为绿色，两者间既有调用仍为黑线。
5. 用 `cg_apply_task_labels` 写入有证据的调度周期。TASK 文字含周期，如 `10ms TASK`，`note` 写文件、行号和依据。同一调用方按已确认的执行顺序从 `コール順1` 连续编号，未知周期、条件分支或顺序在说明中列出。TASK 用黑框黑字，結合点用红框红字，コール順 用无框黑字。

### 参数和服务端校验

| 工具 | 参数与校验 |
| --- | --- |
| `cg_source` → `GET /api/source` | 传 `{ id }` 或 `{ file, startLine, endLine }`。行号从 1 开始，每次最多 250 行，超出用 `truncated` 提示。仅可读取当前工程或比较版本中已索引的源码。按 ID 查询还返回 `taskPeriods`、`calls`、`varAccess` 及上游回溯结果。 |
| `cg_trace_to_task` → `GET /api/trace-to-task` | 传函数 `id`，用 `offset` 和 `limit` 翻页。比较中可用 `version` 指定 `before` 或 `after`。默认查 `after`，已删除的函数查 `before`。每次回溯只使用一个版本的边。 |
| `cg_changes` → `GET /api/mcp-changes` | 首次可传 Git 的 `baseRef`、`targetRef`。后续带 `snapshotId` 和 `offset` 从同一快照继续读变更。查询指定函数时，`trace.nextOffset` 对应下一次请求的 `traceOffset`。状态字段 `detectedChange` 给出自动判断，`change` 包含比较中已有的人工调整。 |
| `cg_compose_view` → `POST /api/mcp-compose` | `roots`、`functionIds`、`changedFunctionIds` 合计提交 1–80 项，可指定 `snapshotId`、`vars`、`selected`、`reason`。额外展开深度 `up`、`down` 取 0–5 的整数。自动加入的完整入口链超过 80 个函数时，按入口分批显式提交所选 `functionIds` 并传 `changedFunctionIds: []`。 |
| `cg_apply_task_labels` → `POST /api/mcp-task-labels` | 传 `{ items, merge? }`，每条含 `edgeKey`、`preset`，可带 `text`、`order`、`note`。`from->to` 会解析为画布采用的真实边，给出 `:line` 可指定具体调用。TASK 文字必填，样式取自预设。コール順 接受正整数 `order` 或 `コール順N`，同一调用方的批内或已有可见标签重号时整批拒绝。`merge: false` 会替换本批涉及的边上的整组标签。 |

标注事件的摘要显示实际标签文字，重复提交相同的标注不会产生新事件。

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
