# 全局代码质量审查报告

- 项目：`tcu-callgraph` v0.2.0（汽车变速箱 TCU 的 C 语言调用关系流程图工具）
- 审查时间：2026-10-21
- 审查方式：5 个子进程并行审查，按模块切分，交叉核对后汇总
- 代码规模：~11.5k 行 JS（src 15 文件 / web 17 文件 / scripts 12 / test 1 / electron 1）
- 基线：`node --check` 全部通过（无语法错误）；`node --test` 仅 2 个用例，`npm test` 未定义

## 一、结论速览

| 级别 | 数量 | 含义 |
|---|---|---|
| P0 | 4 | 确定性崩溃 / 数据被破坏，已复现 |
| P1 | 15 | 常见输入下出错、明显性能问题、安全面缺口 |
| P2 | 22 | 隐患、错误处理缺失、规格不符、可维护性 |
| P3 | 8 | 死代码、风格、优化建议 |

**三个最该先修的东西**：

1. `src/server.js:602` —— 一个畸形 HTTP 请求就能让整个服务进程退出（Electron 侧白屏且不重启）。
2. `web/lib/history.js:69` —— 按一次 Ctrl+Z 会把全图连线永久固化成「手工折线」写回服务端，用户的自动布局从此失效。
3. `src/core/dot.js` + `src/core/index.js:464` —— 输入 `.dot` 文件时启动即崩（仓库自带的 `samples/tcu.dot` 就能复现）。

## 二、P0：已复现的确定性缺陷

### P0-1 畸形 URL 让服务进程直接退出

- 位置：`src/server.js:602`
- 现象：`const u = new URL(req.url, ...)` 写在 `try` 之外。任何客户端发 `GET //[ HTTP/1.1` 都会抛 `TypeError: Invalid URL`，冒泡成未捕获异常，进程退出。Electron 主进程只打印 `exited with 1`，窗口白屏且不自动重启（`electron/main.cjs:44`）。
- 验证：等价最小服务实测 → `UNCAUGHT: Invalid URL`，退出码 7。
- 修复：

```js
let u;
try { u = new URL(req.url, `http://127.0.0.1:${PORT}`); }
catch { res.writeHead(400); return res.end('bad request'); }
```

  另加 `server.on('clientError', (e, socket) => socket.destroy())` 兜底。

### P0-2 撤销一次 = 全图连线固化为手工折线

- 位置：`web/lib/history.js:69`，配合 `:110`
- 现象：`applySnapshot()` 末尾调用 `saveLayout(true)`，`full=true` 使 `(full || e.custom)` 恒真 → **所有**边都以 `{custom:true, points}` 提交。服务端从此不再自动布线；每次 undo/redo 还额外 POST 全图节点+边。同文件 `:128-131` 的注释已写明「不走 saveLayout(full)：那会把每条连线都标成手工折线」，属漏改。
- 修复：改为 `savePositionsOnly()`，或给 `saveLayout` 加 `{ positionsOnly: true }`。另：`:120` 用 `state.root`、`:138` 用 `roots.join('+')`，多入口视图会存到错误 key，需统一。

### P0-3 `.dot` 输入启动即崩

- 位置：`src/core/index.js:464`，`src/core/dot.js:349-364`
- 现象：`modelFromDot()` 返回的 model 没有 `variables` 字段，而 `stats()` 无条件读 `model.variables.length`。`server.js:39` 启动时必调 `stats`，`cli/export.js` 也走同一条路。
- 验证：`node -e "loadModel('samples/tcu.dot') → stats()"` → `TypeError: Cannot read properties of undefined (reading 'length')`。
- 修复：`modelFromDot()` 补 `variables: []`；`stats()` 内改用 `model.variables?.length ?? 0` 防御。

### P0-4 外绕兜底会从源/目标节点框体内穿过

- 位置：`src/core/routing.js:234`、`249-254`、`1139-1152`
- 现象：`routeAroundNodes` 只按「图外四 X + 四 Y 车道」枚举候选，**不判断端口朝向**：从右侧出线的端口会先向左跑到 `minX` 车道，整段横线穿过源节点本体。而最终校验的 `skip` 含 `a.id/b.id`，永远查不出来。
- 实测：`samples/tcu` 中 `main.c::main -> main.c::Task_100ms` 折线 `[[407,442],[269,442],...]`，源框 x=287..407，第一段从右边界向左穿过整个框；deep 5/378、tcu 2/378、large 55/5664 条边命中。
- 修复：候选生成按端口法向过滤车道（`DIR[sa][0] < 0` 时禁用 `maxX` 车道）；stub 段单独用「只含对端」的 skip 校验。

## 三、P1：按模块

### 服务端 / 导出

| # | 位置 | 问题 |
|---|---|---|
| 1 | `core/export.js:309,353,361` | 导出 HTML 把 `JSON.stringify` 直接塞进 `<script>`；宏体/函数名含 `</script>` 会截断脚本并注入 HTML。需转义 `<` → `\u003c`、U+2028/2029；DOM 侧统一 `escHtml()` |
| 2 | `server.js:46,57,792,823` | `overlay.json` 非原子写（`writeFileSync` 直覆盖）+ 解析失败静默回落空对象 → 标注可能整体丢失且无告警。改为写临时文件 + `renameSync`，损坏文件备份 |
| 3 | `server.js:896` | `listen(PORT)` 未指定 host → 绑定 `0.0.0.0`，同网段可访问；三个写接口无 Origin/Content-Type 校验，任意网页可 POST 覆盖布局存档。改 `listen(PORT,'127.0.0.1')` + Origin 白名单 |
| 4 | `server.js:736,766,885` | `createReadStream().pipe(res)` 无 `error` 监听；`out/callgraph.xlsx` 被 Excel 占用时进程崩溃。加 `rs.on('error')`，导出文件名带随机后缀 |
| 5 | `core/dataflow.js:38,116` | `buildDataflowIndex` 失败后把 rejected promise 永久缓存在 `_dfPending`，数据流面板此后一直 500 直到重启 |

### 解析 / 索引

| # | 位置 | 问题 |
|---|---|---|
| 6 | `core/lexer.js:116-130` | 字符串续行 `i += 2` 只跳 `\`+1 字符：CRLF 时提前截断（实测 `puts("a\<CRLF>calc(x)")` 产生伪调用边），LF 时漏 `line++` 导致后续行号整体少 1 |
| 7 | `core/index.js:225,233,295` | 宏表跨文件全局共享，a.c 的 `#define` 泄漏到 b.c 产生假边；结果依赖文件遍历顺序。每文件用 `new Map(macros)` 快照 |
| 8 | `core/extract.js:59-77` | 带 `__attribute__`/`__declspec` 的函数定义被整体丢弃（`{` 前必须是 `)`）；汽车电子代码常见 → 函数连同其体内所有调用一起消失 |
| 9 | `core/extract.js:60-62` | K&R 风格（`{` 前是 `;`）完全识别不到，老工程调用图全空 |
| 10 | `core/index.js:245-262` | `#if/#else` 各定义一次同名函数 → 两个相同 `fn.id`，`byId` 后者覆盖前者、`stats` 偏大、前端按 id 建索引时一条被吞掉、其边悬空 |
| 11 | `core/index.js:229-236` | `parseFile` 里 `readFileSync` 裸调，任一文件被占用/无权限/扫描中被删 → 整个索引失败且 `server.js:31` 无 try/catch，进程退出。需 try/catch + 大小上限 + 二进制跳过 |
| 12 | `core/extract.js:251-263` | 函数指针形参 `cb(v)` 被解析成 `ext::cb` 伪外部符号，`run(real,1)` 的间接关系丢失；回调在 TCU 代码里很密集，图里会堆假节点 |

### 布局 / 路由

| # | 位置 | 问题 |
|---|---|---|
| 13 | `core/layout.js:530-531,562-564,599-612` | `layoutGrouped` 在 80 节点/180 边临界规模耗时 **5473ms**，而 90 节点因 `nodes.length > 80` 提前 return 只要 94ms —— 小图比大图慢 58 倍，服务端同步阻塞。需给试算加硬预算（≤120 次或 30ms 截止） |
| 14 | `core/layout.js:1076-1087,1326-1375` | 文件框/目录框/根框尺寸完全不含标题宽度（`textWidth` 只用于函数节点）。实测 39 字符文件名溢出 9px，违反规格验收 #1 |
| 15 | `core/routing.js:1139-1152` | 找不到安全路径时 `points = []` 静默丢边（deep 1/322、随机稠密图 59/3189），箭头消失但统计仍算一条，用户无从得知 |

### 前端

| # | 位置 | 问题 |
|---|---|---|
| 16 | `web/lib/render.js:146` | flash 高亮的 rAF 自链没去重：拖拽时每次 `pointermove` 新开一条重绘链，拖一下能攒出上百条并发全量重绘 |
| 17 | `web/lib/render.js:340,412-419` | 选中节点后每帧 O(N×E)：`isNeighbor` 对每个节点扫全表边，5000 节点/10000 边时约 5×10⁷ 次比较/帧 |
| 18 | `web/lib/interact.js:230-287` | 只有 `pointerdown/move/up`，无 `pointercancel`/`lostpointercapture` 收尾 → 系统手势或切窗口后拖拽态永久卡住（回页面鼠标一动节点就跟着跑） |
| 19 | `web/lib/history.js:14-27,62-63` | 撤销快照白名单缺 `kind/change/typeText/tag/dfVar/dfPeer` → undo 后变量节点变回函数、变更分类颜色全丢 |

### Electron / 工程

| # | 位置 | 问题 |
|---|---|---|
| 20 | `electron/main.cjs:65-68` | `setWindowOpenHandler` 对任意 URL 直接 `shell.openExternal`，含 `file:`/`ms-msdt:` 等协议；无 `will-navigate` 限制；`index.html` 无 CSP |
| 21 | `scripts/test-*.mjs` | Node 22 默认测试发现规则匹配 `**/test-*.mjs`，`node --test` 会执行 3 个 E2E 脚本并 POST 改写真实 `out/overlay.json`（本次审查中已实际发生，已还原） |
| 22 | `scripts/verify-*.mjs` | 除 `verify-partition.mjs:146` 外全部失败仍退出 0，CI 永远绿 |

## 四、规格 vs 实现差异（布局/路由）

对照 `docs/superpowers/specs/` 两份设计文档：

1. **标题宽度参与框尺寸** —— 未实现。`textWidth` 只服务函数节点，文件/目录/根框尺寸不含标题。
2. **统一几何校验 + 失败后确定性重排** —— 生产代码里不存在这个函数。只有开发脚本 `verify-collision.mjs` 覆盖部分约束，且不查标题、不查边正交与端点、无重排路径。
3. **保存坐标的统一验证** —— 只做了一半：`fitGroups`（`server.js:142`）只扩不缩，没有「扩框后非祖先框是否仍分离」的校验，正是规格明令禁止的做法。
4. **大图候选评分含轴向项与移动代价** —— `scorePlacement` 在 `>160` 节点时置 `null`，带 `fanoutAxisPenalty` 的轴向评分只存在于小图闭包；`candidateScore` 也没有并行拥挤度项。

## 五、P2/P3 摘要（不逐条展开）

- **解析层**：自递归不计入环统计（`index.js:476`）；`preprocess` 逐 token 复制对象 + 现算条件串，25 万 token 约 95→156ms、233 字节/token；`treeCache` 无上限且用「文件长度」当版本号（改长度不变的内容会命中旧 AST），`clearParseCache()` 全仓无调用者；DOT 端口语法 `a:p -> b:q` 产生伪节点与错边。
- **路由层**：`hLineBlocked(y,x1,x2,...)` 三处调用参数顺序写反（`:711,:727,:805`）；同一行重复调用的平行边共用同一个 `points` 数组，整体平移被应用两次（实测偏离 98px）；自定义折线被遮挡后换成自动路由却仍标 `custom`，会被当手工路径存盘；找回边用递归 DFS 无深度上限（12000 节点链直接 `RangeError`）。
- **服务端**：`startsWith(WEB)` 静态校验未 realpath、缺 `path.sep`（当前不可穿越但属脆弱防线）；POST body 字符串累加无上限、多字节中文跨分片会被截断、无 schema 校验；导出走固定文件名且是 GET 副作用；`server.js` 900 行里混了约 480 行布局几何，3 份重复的 body 解析样板，`export.js:13-164` 有 150 行死代码（`exportXlsxLegacy` 还 `await import('exceljs')` 一个未声明的依赖）。
- **前端**：详情面板/搜索无请求序号，慢响应会覆盖新选择；数据流叠加层按对象身份删除，undo 后残留幽灵边；历史栈 60 份全量 JSON（3000 节点约 60~180MB）；`esc()` 不转义单引号（当前所有 `innerHTML` 用双引号属性故不可利用，但 SVG 导出的 `fill="${n.color}"` 未转义）；i18n 有 6 处硬编码中文 + 6 个死 key；`state` 上 `dfFocus/panMoved/last` 三个字段未声明（拼错只表现为功能静默失效）。
- **死代码**：`layerBottom`（只写不读）、`rectHitsPoint`（全仓无引用）、`widthOf/heightOf` 两份重复公式、`roundedPathD(pts, r)` 的 `r` 完全未使用但注释写着「二次贝塞尔圆角」。
- **工程**：`package.json` 缺 `test`/`lint`/`start`/`engines`/`private`；`out/overlay.json` 被 git 跟踪（运行时状态入库）；`samples/large/big.c` 生成物入库；`导出.bat` 判断的是 `electron.exe` 却提示「Node.js is required」，错误码被吞；锁文件全部指向 npmmirror。

## 六、做得好的地方

1. **词法/结构分析走 token 流**：注释和字符串里的括号天然不干扰括号配对，从设计上规避了这类工具最容易踩的坑。
2. **双环境真的干净**：`routing.js` 零 import、`layout.js` 只 import routing，无 `document`/`window`/`node:fs`，前后端共用同一份实现，没有为兼容性分叉。
3. **退化输入很稳**：200 组随机图 + 120 组随机布局（空图/单节点/自环/平行边/稠密环）无异常、无 NaN、无负坐标；3189 条边 0 条斜段、0 条穿过**非端点**节点。
4. **注入面基本封死**：7 处 `innerHTML` 全部过 `esc()`，菜单用 `el.onclick` 赋值而非拼内联事件字符串，文件树完全用 `textContent`。
5. **Electron 安全默认值正确**：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，无 preload 暴露面；`fork(server.js, [target,'0'])` 用参数数组，无 shell 注入。
6. **xlsx 手写实现扎实**：全部文本走 `t="inlineStr"` 天然免疫公式注入，`escXml` 处理 XML 非法控制字符，ZIP 头 UTF-8 标志位正确。

## 七、建议修复顺序

**第 1 批（半天，止血）**
1. `server.js:602` URL 解析移入 try + `clientError` 兜底
2. `history.js:69` 改 `savePositionsOnly()`
3. `dot.js` 补 `variables: []`
4. `scripts/test-*.mjs` 改名 `e2e-*.mjs`，`package.json` 加 `"test": "node --test test/*.test.js"`
5. `git rm --cached out/overlay.json`

**第 2 批（1~2 天，正确性）**
6. `routing.js` 外绕候选按端口法向过滤 + `hLineBlocked` 三处参数改正
7. `layoutGrouped` 试算加硬预算（当前 80 节点 5.5 秒）
8. `lexer.js` 续行处理与 preproc 分支对齐
9. `extract.js` 支持 `__attribute__` 与 K&R
10. `index.js` 宏表按文件快照 + 函数 id 去重
11. `history.js` 快照补字段

**第 3 批（1 周，工程化）**
12. 加 `npm test`（5 个用例见下）+ ESLint flat config（先只开 `no-unused-vars`/`no-undef`/`no-floating-promises`）
13. `scripts/lib/cdp.mjs` 统一 E2E harness，所有 verify 脚本补 `process.exitCode`
14. `server.js` 拆出 `src/view/build.js`，抽 `readJson`/`sendFile`/`saveOverlay`
15. `listen(PORT,'127.0.0.1')` + 写接口 Origin 校验 + Electron `will-navigate`/`openExternal` 白名单 + CSP

**最该补的 5 个测试**

1. `layoutGrouped()` —— 6 节点跨 3 目录：节点在 group 内、group 互不相交、父容器包住子级、宽高有限。
2. `subgraph(model, rootId, {down, maxNodes})` —— `down:0/1/2` 与 `maxNodes:2` 边界、未知 root 返回空不抛。
3. `routeEdges` 自环 —— `points.length >= 4`、每段严格正交、首尾落在节点边界、`back === true`。
4. `routeEdges` 幂等 + 不穿越 —— 同一输入调两次 `points` 深比较相等；每段不与**非端点**节点相交。
5. `loadModel('samples/tcu')` 金标 —— `functions/edges/files` 固定计数，且至少各 1 条 `kind === 'macro'` 与 `'fnptr'` 边。

## 八、审查过程说明

- 全部子进程均为只读审查，未修改仓库源码。
- 审查期间有一次 `node --test` 触发了 `scripts/test-*.mjs`，POST 改写了 `out/overlay.json`；已 `git checkout --` 还原到 HEAD 版本。
- 子进程遗留的临时脚本 `scripts/_t.cjs` 已删除。
- 当前工作区仍有 16 个文件处于已修改未提交状态（`src/core/dataflow.js`、`layout.js`、`server.js`、`web/*` 等），均为审查前已有的开发中改动，本次未触碰。
