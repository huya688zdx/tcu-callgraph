# 层级布局与文字占位优化实施计划

> **For agentic workers:** 本计划在隔离分支内顺序执行，按任务逐步验证。每个实现任务先写失败用例，再写最小实现。

**目标：** 在紧凑分组布局中用函数、文件、目录标题的完整占位优化节点与容器的位置，并对所有非祖先框强制保持间距，同时让大图的加权连接继续影响容器排布。

**架构：** `src/core/layout.js` 提供文字占位、分层矩形约束、有限的候选评分与层级几何验证；`src/server.js` 只应用不破坏文件框边界的手工坐标，并对最终视图重复验证。小图继续按函数折线路由评分，大图改用有界的组对加权边摘要。

**技术栈：** Node.js ES modules、`node:assert/strict`、现有 `layoutGrouped` 与正交 `routeEdges`。

---

### 任务 1：建立标题和层级矩形的失败回归用例

**文件：**
- 创建：`scripts/verify-layout-constraints.mjs`
- 参考：`scripts/verify-collision.mjs`
- 被测：`src/core/layout.js`

- [ ] **步骤 1：先建立合成分层图并断言文字占位**

创建一个包含长根目录名、长目录名、长文件名、至少 8 个函数节点和跨文件扇出的固定图；调用 `layoutGrouped(nodes, edges, { rootLabel })`。用 `textWidth()` 检查每个函数名、文件标题、目录标题和根标题的宽度都在对应框内。文件标题要求 `group.w >= textWidth(group.label) + 24`；目录标题要求 `container.w >= textWidth(container.label) + 28`；根标题要求 `root.w >= textWidth(root.label) + 44`；函数名要求 `node.w >= textWidth(node.name + '()') + 18`。

测试的几何断言使用以下真实矩形关系，`isAncestor` 对根框特殊处理，其它关系只按带 `/` 的路径段前缀判断：

```js
const contains = (a, b) =>
  b.x >= a.x - 0.5 && b.y >= a.y - 0.5 &&
  b.x + b.w <= a.x + a.w + 0.5 &&
  b.y + b.h <= a.y + a.h + 0.5;

const ancestor = (a, b) => a.root || (!b.root && b.id.startsWith(a.id + '/'));
const separated = (a, b, gap = 12) =>
  a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x ||
  a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;

for (let i = 0; i < boxes.length; i++) {
  for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (ancestor(a, b)) assert(contains(a, b), `${a.id} must contain ${b.id}`);
    else if (ancestor(b, a)) assert(contains(b, a), `${b.id} must contain ${a.id}`);
    else assert(separated(a, b), `${a.id} intersects ${b.id}`);
  }
}
```

- [ ] **步骤 2：断言完整层级几何**

将 `laid.groups` 与非根 `laid.containers` 合并成普通框；祖先关系仅由目录路径段前缀决定，根容器是所有框的祖先。断言每个祖先完整包含后代；任意非祖先框必须至少相隔 12px（X 轴或 Y 轴满足其一）；任意两个函数节点不得相交；所有边至少有两个点且每一段严格水平或垂直。

- [ ] **步骤 3：运行并确认当前实现因长标题失败**

运行：`node scripts/verify-layout-constraints.mjs`

预期：FAIL，失败项指出文件或目录标题超出框边界；不能因异常或导入失败而失败。

### 任务 2：让所有可见标题参与尺寸计算

**文件：**
- 修改：`src/core/layout.js` 的 `layoutGrouped()`、`layoutDir()`、根容器尺寸计算
- 测试：`scripts/verify-layout-constraints.mjs`

- [ ] **步骤 1：根据失败断言修复最小宽度**

文件框在取得组内布局结果后，令宽度至少为 `textWidth(fileName) + 24`。目录框在子框分区完成后，令宽度至少为 `textWidth(directoryName) + 28`；扩大目录右边缘，不移动其已完成的子布局。根框宽度至少为 `textWidth(rootLabel) + 44`。保持现有标题锚点、颜色和字号。

在 `layoutGrouped()` 的文件框构造处使用 `Math.max(laid.width, textWidth(fileName) + 24)`；在 `layoutDir()` 写回目录宽度处使用 `Math.max(laid.width, textWidth(node.name) + 28)`；构造根框时使用 `Math.max(x1 - x0 + RING.side * 2, textWidth(rootLabel) + 44)`。所有尺寸在父级调用 `layoutPartitioned()` 之前确定。

- [ ] **步骤 2：重跑标题和几何回归**

运行：`node scripts/verify-layout-constraints.mjs`

预期：PASS，所有标题边界断言通过；节点、文件框与目录框没有违反层级约束。

### 任务 3：把非相交作为候选硬约束并安全处理手工坐标

**文件：**
- 修改：`src/core/layout.js` 的 `layoutPartitioned()` 与 `layoutGrouped()`
- 修改：`src/server.js` 保存坐标应用、`fitGroups()` / `fitContainers()` 调用顺序
- 测试：`scripts/verify-layout-constraints.mjs` 与 `scripts/verify-collision.mjs`

- [ ] **步骤 1：为候选布局添加矩形可行性检查**

候选可行性检查应对同一父目录的直接子矩形（含标题区与外边距）逐对检查；重叠或小于 12px 间距的候选不可评分。祖先只允许完全包含后代，不参与非祖先碰撞判断。若评分候选均不可行，回退到单列确定性摆放。

在 `layoutPartitioned()` 的 `placeUnits(R)` 返回候选后，用每个 `candidate.pos` 与 `wOf` / `hOf` 形成矩形；两框不相交且有 12px 间距的判定是：

```js
function separated(a, b, gap = 12) {
  return a.x + a.w + gap <= b.x || b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y || b.y + b.h + gap <= a.y;
}
```

对 `items` 每一对矩形都要求 `separated(a, b)`；失败时跳过该候选，不计算 `scorePlacement`。

- [ ] **步骤 2：让保存坐标不能扩张并撞到兄弟框**

保存的节点坐标只在完整节点矩形严格位于自动文件框内且不与其他节点相交时应用；否则保留自动坐标。不要用容差接受出框坐标后再扩张框。仍调用 `fitGroups()` / `fitContainers()` 作为自动布局兜底，但不得扩张造成非祖先框相交。

- [ ] **步骤 3：增加最终几何验证**

每个分组视图在响应前检查：所有节点在各自文件框内；所有直接子框在父框内；所有非祖先框至少相隔 12px；兄弟文件框/目录框没有交叠。发现违反时，从导致扩框的保存坐标回退到 `_autoX` / `_autoY`，重算容器和边；若自动候选自身仍违反约束则返回确定性单列摆放。

- [ ] **步骤 4：重跑全量碰撞样本**

运行：`node scripts/verify-collision.mjs samples/deep`、`node scripts/verify-collision.mjs samples/tcu`、`node scripts/verify-collision.mjs samples/large` 与 `node scripts/verify-layout-constraints.mjs`。

预期：每个脚本以 0 退出；统计的文件框、目录容器、节点和正交边都满足相应断言。

### 任务 4：让大图加权连接参与有限的容器位置搜索

**文件：**
- 修改：`src/core/layout.js` 中 `layoutGrouped()` 的 `scorePlacement` 与 `layoutPartitioned()` 候选循环
- 测试：`scripts/verify-layout-constraints.mjs`

- [ ] **步骤 1：先加入超过旧门槛的连接偏好用例**

在合成图中生成至少 161 条跨文件函数边，其中一组兄弟文件间有明确多数扇出；用相同矩形和反转后的边权生成两次布局，断言被加权的组对优先相邻/共用走廊，并且两个结果都满足矩形约束。运行回归脚本，确认旧实现未能体现强扇出偏好。

- [ ] **步骤 2：生成有界的跨框加权边摘要**

按当前目录的直接子项把函数边聚合成 `{ from, to, weight, fanout }`。保持最多 512 条摘要边，优先保留权重高的组对；同权时按 `from`、`to` 字典序稳定排序。对摘要边路由一次，线长按 `1 + log2(weight)` 加权，共线重用给予现有共享长度折扣，交叉与折点分别加硬惩罚；该评分不能使几何不可行候选入选。

聚合和上限选择采用确定性排序：

```js
const byPair = new Map();
for (const e of crossingFunctionEdges) {
  const from = childOfFile.get(fileOfId.get(e.from));
  const to = childOfFile.get(fileOfId.get(e.to));
  if (!from || !to || from === to) continue;
  const key = `${from}\0${to}`;
  const item = byPair.get(key) || { from, to, weight: 0, targets: new Set() };
  item.weight++;
  item.targets.add(e.to);
  byPair.set(key, item);
}
const summaryEdges = [...byPair.values()]
  .map(({ targets, ...e }) => ({ ...e, fanout: targets.size }))
  .sort((a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to))
  .slice(0, 512);
```

- [ ] **步骤 3：限制候选数且保留小图精确评分**

小于等于 160 个函数节点且跨组边小于等于 160 时保留函数级精确评分。超过任一门槛时用加权摘要评分。分区候选 R 不超过 32 个：单位数 `m <= 32` 时穷举 `R=1..m`；否则取 `R=1..m` 上均匀分布的 32 个去重整数值并额外包含 `R=m`。同一输入与节点/边顺序变化必须得到相同结果。

- [ ] **步骤 4：运行大图评分和几何回归**

运行：`node scripts/verify-layout-constraints.mjs` 与前述三个 `verify-collision` 命令。

预期：161 条以上跨文件边仍会改变容器候选偏好；全部层级约束通过；连续重复运行布局结果完全一致。

### 任务 5：检查实际画布输出

**文件：**
- 创建：`scripts/render-grouped-svg.mjs`
- 创建：`out/layout-constraints.svg`
- 参考：`scripts/render-svg.mjs`
- 验证：`scripts/verify-layout-constraints.mjs`

- [ ] **步骤 1：为分组视图导出 SVG**

新建 `scripts/render-grouped-svg.mjs`，加载 `samples/deep`，选择 `SysTick_Handler` 的 `{ up: 1, down: 3 }` 子图并调用 `layoutGrouped(..., { rootLabel: 'deep' })`。绘制目录容器、文件框标题、正交连线和函数节点，写到 `out/layout-constraints.svg`，不要覆盖 `bus-after.svg`。

- [ ] **步骤 2：检查布局的可读性与层级**

确认所有长标题留在框内；目录父子层次明确；同父兄弟文件/目录间有可见间距；连接较多的文件落在能减少加权总线长/交叉的位置；没有边穿过函数节点。对比运行前后的 SVG 尺寸和 `verify-layout-constraints.mjs` 几何断言。

- [ ] **步骤 3：交付分支与验证摘要**

检查 `git diff --check`、`node --check src/core/layout.js`、`node --check src/server.js` 和所有布局回归命令；提交实现与 SVG 到 `codex/hierarchical-layout-constraints`，不推送，除非用户另行要求。

---
