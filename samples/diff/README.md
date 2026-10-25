# C 工程差分样例

打开应用，点击左上角工程按钮 → “工程比较”，分别浏览选择本目录下的 `before` 和 `after`，再点“开始比较”。浏览器版可以直接填写这两个目录的绝对路径。两侧目录结构和相对文件名保持一致。

比较图沿用现有四色与连线规则，点击函数或变量可查看两侧位置及变更原因。比较模式只供查看，点击“退出比较”可回到 after 普通工程及其原有标注。

## 预期差异

| 对象 | before / after | 预期 |
| --- | --- | --- |
| `Normalize`、`Monitor_Read`、`main` | 定义相同 | 既存（3 个函数） |
| `Sensor_Update` | 源码相同，`SCALE` 从 10 变为 20 | 宏展开变化，修改 |
| `Control_Read` | 超限时调用 `Legacy_Log` / `Diagnostics` | 修改；旧调用删除、新调用新增 |
| `Legacy_Log` / `Diagnostics` | 仅 before / 仅 after | 删除 / 新增 |
| `g_rpm` | 两侧初始化均为 0 | 既存（1 个变量） |
| `g_limit` | 初始化从 100 变为 120 | 修改（1 个变量） |
| `g_legacy` / `g_fault` | 仅 before / 仅 after | 删除 / 新增 |

预期函数并集：既存 3、修改 2、新增 1、删除 1（共 7 个）。预期变量并集：既存 1、修改 1、新增 1、删除 1（共 4 个）。

`Sensor_Update` 与 `Monitor_Read` 没有调用关系，但前者写入、后者读取共享变量 `g_rpm`，用于检查共享变量带来的潜在影响。`main.c` 两侧相同，分别调用 `Sensor_Update`、`Control_Read` 并返回 `Monitor_Read` 的结果。
