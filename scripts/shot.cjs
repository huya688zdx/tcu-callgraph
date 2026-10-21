// 截图小工具：electron scripts/shot.cjs <url> <out.png> [宽] [高] [等待ms]
// 也可以从 json 读配置：electron scripts/shot.cjs --config <config.json>
// 沙箱里命令行带 http:// 会静默失败时用 --config
// 具体实现见 scripts/lib/shot.cjs（shot-file.cjs 也共用它）
require('./lib/shot.cjs').runShotCli(process.argv.slice(2));
