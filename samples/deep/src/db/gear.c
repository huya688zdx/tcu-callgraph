#include "gear.h"
#include "config.h"
#include "can.h"
#include "adc.h"

GearCtx g_gearCtx;

static int Gear_Retry(unsigned char target);

void EnterCritical(void)
{
    /* 关中断 */
}

void ExitCritical(void)
{
    /* 开中断 */
}

void Gear_Init(void)
{
    g_gearCtx.current   = GEAR_N;
    g_gearCtx.target    = GEAR_N;
    g_gearCtx.shift_cnt = 0u;
}

int Gear_CheckSpeed(unsigned int rpm, unsigned int speed)
{
    unsigned int limit = READ_ADC(0);      /* 宏调用 -> Adc_Read */

    if (speed > limit) {
        return 0;
    }
    if (rpm > 6500u) {
        return 0;
    }
    return 1;
}

static int Gear_Retry(unsigned char target)
{
    static unsigned char tries = 0u;

    if (++tries > MAX_RETRY) {
        tries = 0u;
        return -3;
    }
    return Gear_Apply(target, &g_gearCtx); /* 回边：构成调用环 */
}

int Gear_Apply(unsigned char target, GearCtx *ctx)
{
    if (ctx == 0) {
        return -1;
    }
    if (!Gear_CheckSpeed(Can_GetRpm(), Can_GetSpeed())) {
        return Gear_Retry(target);         /* 环的另一半 */
    }
    ctx->target = target;
    ctx->shift_cnt++;
    Can_SendGearStatus(target);
    return 0;
}

void Gear_ShiftUp(void)
{
    if (g_gearCtx.current < GEAR_D) {
        SET_GEAR(g_gearCtx.current + 1);   /* 宏调用 -> Gear_Apply */
    }
}

void Gear_ShiftDown(void)
{
    if (g_gearCtx.current > GEAR_N) {
        SET_GEAR_SAFE(g_gearCtx.current - 1); /* 嵌套宏 -> EnterCritical + Gear_Apply + ExitCritical */
    }
}
