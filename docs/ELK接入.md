# ELK 布局

正常运行 `启动.bat` 即使用 ELK 0.12.0 排版，无需试用开关。界面与命令行导出也使用该引擎。首次安装依赖运行 `npm install`。

ELK 负责文件、目录、函数的层级摆放和初始正交布线。每次打开默认自动排版，不恢复旧的固定坐标。“ELK 自动布局”按钮直接重新排版，不再切换固定模式。旧存档保留，历史书签仍可恢复其固定视图。

节点可在文件框内拖动；优先保留已有走廊，只调整端部，碰撞时才重新寻路。四个边中点、撤销与手工改线沿用现有交互。“重置布局”会重新生成 ELK 布局。

`启动-ELK试用.bat` 仍可打开独立存档的窗口，使用相同实现。旧的正常存档不受该入口影响。

当前仍有局限：大图不保证接近正方形，不同样式的连线可能有共线段。接入 ELK 不代表这些排版要求已经全部解决。

## 第三方许可

elkjs 使用双重许可，本项目选择 EPL-2.0。项目通过 npm 使用未经修改的 elkjs，许可原文随依赖附于 `node_modules/elkjs/LICENSE.md`；分发时保留该许可和版权声明，并提供对应源代码的获取地址。

- 项目及源代码：https://github.com/kieler/elkjs
- 许可：https://github.com/kieler/elkjs/blob/master/LICENSE.md
- 算法文档：https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html

复现比较：`node scripts/evaluate-elk.mjs tcu-main-d3`，结果写入 `out/elk-evaluation/`。
