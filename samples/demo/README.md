# demo 测试样本

比 `samples/tcu` 更贴近真实工程，用来验证这几件事（括号内为实测值）：

- **目录层级**：`app/` `bsw/` `hal/` 三个子目录 + 根目录文件，共 10 个文件、4 层容器
- **变量面板**：25 个变量/常量（14 个全局共享 + 11 个 `static` 文件私有），类型涵盖
  - `typedef` 结构体（`GearCtx g_gear`、`SensorState g_sensor`、`NvmBlock g_nvm`）
  - 无初始化的声明、数组（`unsigned char g_rxBuf[64]`）
  - `const` 常量表（`g_shiftTable[4]`、`g_dtcTable[8]`）
  - `volatile`（`g_tick`）
- **跨模块数据流**：`g_gear` 被 6 个文件里的 10 个函数写、5 个文件里的 9 个函数读，
  但 `app/control.c` 与 `bsw/can.c` 之间**没有直接调用**——用来验证「数据流分析」
  能挖出调用图上看不到的隐式耦合
- **调用关系**：49 个函数、103 条调用关系（106 次调用），其中
  - 宏调用：`SET_GEAR` 展开后产生到 `Gear_Apply` 的 macro 边
    （宏体里必须含函数调用，纯值宏如 `MAX_RETRY`/`CLAMP` 不产生调用边）
  - 函数指针表：`g_gearOps` 用带指定初始化的形式定义，配合 `INVOKE` 宏调用，
    解析出 `g_gearOps.up` → `Shift_Up`、`g_gearOps.down` → `Shift_Down` 两条 fnptr 边
  - 外部符号：`g_diagHook` 是单个函数指针变量（不是表），当前解析器把它识别为外部符号
- **无环**：`Gear_Apply → Gear_Retry` 是单向的；有环样本见 `samples/tcu`

打开方式：

```bat
启动.bat samples\demo
```

或者

```bat
node src/server.js samples\demo
```
