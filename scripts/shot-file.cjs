// 兼容入口：截图 + 控制台诊断，从 json 读配置
// 用法: electron scripts/shot-file.cjs <config.json>
// 已合并进 scripts/shot.cjs（支持 --config <config.json>），本文件只是别名
require('./lib/shot.cjs').runShotCli(process.argv.slice(2));
