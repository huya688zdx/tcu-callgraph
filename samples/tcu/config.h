#ifndef TCU_CONFIG_H
#define TCU_CONFIG_H

/* ---- 车型配置开关：会造成不同的调用图 ---- */
#define CONFIG_4WD
#define CONFIG_SPORT_MODE

#define ADC_TIMEOUT_MS   5u
#define GEAR_NEUTRAL     2
#define GEAR_DRIVE       3
#define MAX_RETRY        3u

/* ---- 宏体里藏着真实调用 ---- */
#define SET_GEAR(g)       Gear_Apply((g), &g_gearCtx)
#define READ_ADC(ch)      Adc_Read((ch), ADC_TIMEOUT_MS)

/* ---- 嵌套宏：一次展开产生三个调用 ---- */
#define SET_GEAR_SAFE(g)  do { EnterCritical(); SET_GEAR(g); ExitCritical(); } while (0)

/* ---- 宏参数本身就是被调函数 ---- */
#define CALL(fn)          fn()

/* ---- 经函数指针表间接调用 ---- */
#define INVOKE(ops, m)    ((ops)->m())

#endif
