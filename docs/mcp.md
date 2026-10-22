# 内置 MCP 服务（AI 访问）

项目内置了一个 MCP（Model Context Protocol）服务器，AI 客户端可以直接获取调用图数据、
自主绘制调整（标注 / 删除 / 布局）并导出 SVG / Excel / HTML。

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

## 权限控制（三档）

| 档位 | 能力 |
| --- | --- |
| `off` | 禁用：AI 无法访问任何数据（协议握手保留，工具列表为空） |
| `readonly`（默认） | 只读 + 导出：查看调用图 / 数据流 / 时间轴，导出 SVG / Excel / HTML |
| `readwrite` | 全量：另加写标注、删除/恢复函数与连线、保存布局、切换工程 |

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

## 工具清单（19 个）

前缀 `cg_`。所有写操作在时间轴里以 `actor=ai` 记录，与人工改动可区分、可恢复。

### 读
| 工具 | 说明 |
| --- | --- |
| `cg_stats` | 工程统计：函数 / 调用 / 宏 / 函数指针表 / 环 / 已删除数量 |
| `cg_project` / `cg_projects` | 当前工程身份 / 最近工程列表 |
| `cg_tree` | 文件树（目录层级 + 每文件函数清单） |
| `cg_search` | 按函数名搜索，拿函数 id |
| `cg_view` | 取视图：带坐标的节点 + 路由后的连线 + 分组框（与界面同一份数据） |
| `cg_node` | 单函数详情：签名、入出边、已有标注 |
| `cg_vars` / `cg_shared_vars` | 全局变量清单 / 多函数共享的变量 |
| `cg_dataflow` | 数据流分析（dir=in/out） |
| `cg_orphans` | 失效标注清单 |
| `cg_events` | 时间轴事件（含 actor=ai 的记录） |

### 写（需要 readwrite）
| 工具 | 说明 |
| --- | --- |
| `cg_switch` | 切换工程（按 id 或路径） |
| `cg_annotate` | 节点/连线标注：note、color(#RRGGBB)、tag、change(既存/変更/追加/削除) |
| `cg_delete` | 隐藏/恢复函数与连线（不动源码）；clear=true 全部恢复 |
| `cg_save_layout` | 保存手动布局（坐标表 / 连线折线 / 手工连线） |

### 导出（readonly 即可用）
| 工具 | 说明 |
| --- | --- |
| `cg_export_svg` | 当前视图导出 SVG（与界面同布局同配色），root 空则自动挑入口 |
| `cg_export_xlsx` | 全工程调用关系 Excel |
| `cg_export_html` | 指定入口的交互式 HTML 图页 |

导出文件统一落在项目的 `out/` 目录，`out` 参数只允许相对文件名（拒绝绝对路径与 `..`）。

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
```

工具实现不绕开 HTTP 层：MCP 工具桥接到与浏览器 UI 完全相同的 `/api/*` 端点，
因此校验规则、时间轴事件、持久化行为天然一致。服务端 SVG 导出
（`src/core/export-svg.js` + `POST /api/export/svg`）是本次为 MCP 补齐的端点，
样式与前端 `web/lib/svg.js` 手工同步——改绘制样式时两个文件都要动。

## 相关文件

- `src/mcp.js` —— MCP 协议层 + 工具定义 + 权限
- `src/core/export-svg.js` —— 服务端 SVG 生成
- `src/server.js` —— `/mcp`、`/api/mcp-config`、`/api/export/svg` 路由；写端点透传 actor
- `web/lib/ai-settings.js` —— 界面「AI 访问」设置面板
- `test/mcp.test.js` —— 协议单元测试 + 端到端链路测试
